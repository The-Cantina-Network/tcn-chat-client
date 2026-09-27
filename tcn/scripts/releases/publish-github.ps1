# SPDX-License-Identifier: AGPL-3.0-or-later
# This script intentionally requires an explicit apply switch and repository.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $Repository,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string] $SourceRevision,
    [Parameter(Mandatory)][string] $SourceArchive,
    [Parameter(Mandatory)][string] $CandidateDirectory,
    [Parameter(Mandatory)][string] $AcceptanceReceipt,
    [Parameter(Mandatory)][string] $SignerThumbprint,
    [switch] $Apply
)
. "$PSScriptRoot/common.ps1"

function Get-ReleaseOrAbsent([string] $Tag) {
    $response = & gh api "repos/$Repository/releases/tags/$Tag" --include 2>$null
    $exitCode = $LASTEXITCODE
    $text = $response -join "`n"
    if ($text -notmatch '^HTTP/\S+\s+([0-9]{3})') { throw 'Could not verify remote release state.' }
    $status = [int]$Matches[1]
    if ($status -eq 404) { return $null }
    if ($exitCode -ne 0 -or $status -ne 200) { throw 'Remote release lookup failed; do not infer absence.' }
    $bodyStart = $text.IndexOf("`n`n")
    if ($bodyStart -lt 0) { throw 'Unexpected GitHub response framing.' }
    return ($text.Substring($bodyStart + 2) | ConvertFrom-Json)
}
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $Repository -match '(^|/)fluxer(?:app)?(/|$)') { throw 'An explicit TCN-owned GitHub repository is required.' }
& "$PSScriptRoot/assert-release.ps1" -CandidateDirectory $CandidateDirectory -AcceptanceReceipt $AcceptanceReceipt -SignerThumbprint $SignerThumbprint
$candidate = Get-Content -LiteralPath (Join-Path $CandidateDirectory 'candidate.json') -Raw | ConvertFrom-Json
$identity = Get-TcnReleaseIdentity $candidate.channel $candidate.version
$expectedFeed = "https://github.com/$Repository/releases/download/$($identity.feedTag)"
if ($candidate.releaseConfig.schema -cne 'tcn-desktop-release/v1' -or $candidate.releaseConfig.feedUrl.TrimEnd('/') -cne $expectedFeed) { throw 'Compiled update feed does not match the explicit publication target.' }
$downloadPage = [Uri]$candidate.releaseConfig.downloadPageUrl
if ($downloadPage.Scheme -cne 'https' -or $downloadPage.Host -cne 'github.com' -or $downloadPage.UserInfo -or $downloadPage.Query -or $downloadPage.Fragment -or ($downloadPage.AbsolutePath -cne "/$Repository/releases" -and $downloadPage.AbsolutePath -cne "/$Repository/releases/latest")) { throw 'Compiled download page does not match the TCN repository.' }

$source = Get-TcnFileDigest $SourceArchive
if ($source.name -cne "tcn-chat-client-$($identity.version)-source.zip") { throw 'A versioned corresponding-source archive is required.' }
& node (Join-Path $PSScriptRoot 'lineage.mjs') check-publication --candidate (Join-Path $CandidateDirectory 'candidate.json') --source-revision $SourceRevision --source-archive $SourceArchive
if ($LASTEXITCODE -ne 0) { throw 'Published source archive/lineage does not match the exact candidate.' }
$repoJson = & gh api "repos/$Repository"
if ($LASTEXITCODE -ne 0) { throw 'Repository identity lookup failed.' }
$repo = $repoJson | ConvertFrom-Json
if ($repo.full_name -cne $Repository -or $repo.archived -eq $true -or $repo.private -eq $true) { throw 'Public active repository identity verification failed.' }
$commitJson = & gh api "repos/$Repository/commits/$SourceRevision"
if ($LASTEXITCODE -ne 0) { throw 'Source revision lookup failed.' }
$commit = $commitJson | ConvertFrom-Json
if ($commit.sha -cne $SourceRevision) { throw 'Source revision is not available in the target repository.' }
$existing = Get-ReleaseOrAbsent $identity.releaseTag
if ($null -ne $existing) { throw 'Immutable version release already exists; never replace published bytes.' }
$marker = "TCN desktop channel feed: $($identity.channel)"
$feedRelease = Get-ReleaseOrAbsent $identity.feedTag
$feedExists = $null -ne $feedRelease
if ($feedExists) {
    if (-not $feedRelease.body.StartsWith($marker, [StringComparison]::Ordinal) -or $feedRelease.draft -eq $true) { throw 'Channel release is not a recognized TCN feed.' }
    $currentFeed = Invoke-RestMethod -Uri "https://github.com/$Repository/releases/download/$($identity.feedTag)/releases.win.json" -Headers @{ 'Cache-Control' = 'no-cache' }
    $currentAssets = @($currentFeed.Assets)
    if ($currentAssets.Count -ne 1 -or $currentAssets[0].PackageId -cne $identity.packageId -or $currentAssets[0].Type -cne 'Full') { throw 'Existing channel identity is invalid.' }
    Assert-TcnNewerVersion $identity.version $currentAssets[0].Version
}
$releases = Join-Path $CandidateDirectory 'releases'
Write-Output "Plan: publish immutable $Repository/$($identity.releaseTag), then advance $($identity.feedTag) after readback."
if (-not $Apply) { Write-Output 'Dry run only. No remote changes.'; return }
# A durable, atomic local attempt record survives partial remote completion.
# Only authoritative readback advances a phase; a command acknowledgment does not.
$attemptPath = Join-Path $CandidateDirectory 'publication-attempt.json'
if (Test-Path -LiteralPath $attemptPath) { throw 'A publication attempt already exists; reconcile it before starting another attempt.' }
$attempt = [ordered]@{
    schema = 'tcn-desktop-publication-attempt/v1'; repository = $Repository
    sourceRevision = $SourceRevision; channel = $identity.channel; version = $identity.version
    releaseTag = $identity.releaseTag; feedTag = $identity.feedTag
    nupkgSha256 = $candidate.nupkgSha256; installerSha256 = $candidate.installerSha256
    incomplete = $true; phase = 'locally-validated'; operationInProgress = $null
    history = @(); updatedUtc = [DateTime]::UtcNow.ToString('o')
}
function Save-PublicationAttempt {
    $attempt.updatedUtc = [DateTime]::UtcNow.ToString('o')
    $temporary = Join-Path $CandidateDirectory ('publication-attempt-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($attempt | ConvertTo-Json -Depth 20) + "`n")
    $stream = [IO.FileStream]::new($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    [IO.File]::Move($temporary, $attemptPath, $true)
}
function Start-PublicationOperation([string] $Operation) {
    $attempt.operationInProgress = $Operation
    Save-PublicationAttempt
}
function Confirm-PublicationPhase([string] $Phase, $Readback) {
    $attempt.phase = $Phase
    $attempt.operationInProgress = $null
    $attempt.history += [ordered]@{ phase = $Phase; verifiedUtc = [DateTime]::UtcNow.ToString('o'); readback = $Readback }
    Save-PublicationAttempt
}
Save-PublicationAttempt
$notes = Join-Path $CandidateDirectory 'release-notes.txt'
[IO.File]::WriteAllText($notes, "TCN Chat $($identity.version) ($($identity.channel)), Windows x64.`nSource: $SourceRevision`nInstalled upgrade and staging acceptance cover the attached exact artifacts.`n", [Text.UTF8Encoding]::new($false))
Start-PublicationOperation 'create-version-draft'
& gh release create $identity.releaseTag --repo $Repository --target $SourceRevision --title "$($identity.title) $($identity.version)" --notes-file $notes --draft
if ($LASTEXITCODE -ne 0) { throw 'Draft release creation failed.' }
$versionRelease = Get-ReleaseOrAbsent $identity.releaseTag
if ($null -eq $versionRelease -or $versionRelease.draft -ne $true -or $versionRelease.tag_name -cne $identity.releaseTag -or $versionRelease.target_commitish -cne $SourceRevision) { throw 'Draft release authoritative readback failed.' }
$versionReleaseId = $versionRelease.id
Confirm-PublicationPhase 'draft-created' @{ releaseId = $versionReleaseId; draft = $true; tag = $versionRelease.tag_name; sourceRevision = $versionRelease.target_commitish }

$upload = @($candidate.artifacts | ForEach-Object { Join-Path $releases $_.name }) + @((Join-Path $releases 'SHA256SUMS'), (Join-Path $CandidateDirectory 'candidate.json'), (Join-Path $CandidateDirectory 'payload-inspection.json'), (Join-Path $CandidateDirectory 'update-engine.json'), $AcceptanceReceipt, $SourceArchive)
Start-PublicationOperation 'upload-and-verify-version-assets'
& gh release upload $identity.releaseTag @upload --repo $Repository
if ($LASTEXITCODE -ne 0) { throw 'Draft upload failed; channel feed remains unchanged.' }
# Read every uploaded release asset back before exposing the version.
$readback = Join-Path $CandidateDirectory ('remote-readback-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $readback | Out-Null
& gh release download $identity.releaseTag --repo $Repository --dir $readback
if ($LASTEXITCODE -ne 0) { throw 'Draft asset readback failed; channel feed remains unchanged.' }
foreach ($file in $upload) {
    if ((Get-TcnFileDigest $file).sha256 -cne (Get-TcnFileDigest (Join-Path $readback ([IO.Path]::GetFileName($file)))).sha256) { throw 'Remote version asset readback mismatch.' }
}
$versionRelease = Get-ReleaseOrAbsent $identity.releaseTag
if ($null -eq $versionRelease -or $versionRelease.id -ne $versionReleaseId -or $versionRelease.draft -ne $true) { throw 'Draft identity changed during asset verification.' }
Confirm-PublicationPhase 'version-assets-verified' @{ releaseId = $versionReleaseId; draft = $true; assets = @($upload | ForEach-Object { Get-TcnFileDigest $_ }) }
Start-PublicationOperation 'publish-version'
& gh release edit $identity.releaseTag --repo $Repository --draft=false --prerelease=$(if ($identity.channel -eq 'canary') { 'true' } else { 'false' })
if ($LASTEXITCODE -ne 0) { throw 'Version publication failed; channel feed remains unchanged.' }
$versionRelease = Get-ReleaseOrAbsent $identity.releaseTag
if ($null -eq $versionRelease -or $versionRelease.id -ne $versionReleaseId -or $versionRelease.draft -ne $false) { throw 'Version publication authoritative readback failed.' }
Confirm-PublicationPhase 'version-published' @{ releaseId = $versionReleaseId; draft = $false; url = $versionRelease.html_url; tag = $versionRelease.tag_name }

if (-not $feedExists) {
    Start-PublicationOperation 'create-channel-release'
    & gh release create $identity.feedTag --repo $Repository --target $SourceRevision --title "$($identity.title) update feed" --notes "$marker`nMutable feed metadata; immutable version packages are retained in version releases." --prerelease
    if ($LASTEXITCODE -ne 0) { throw 'Version published, but channel feed creation failed.' }
    $feedRelease = Get-ReleaseOrAbsent $identity.feedTag
    if ($null -eq $feedRelease -or $feedRelease.draft -ne $false -or $feedRelease.tag_name -cne $identity.feedTag -or -not $feedRelease.body.StartsWith($marker, [StringComparison]::Ordinal)) { throw 'Channel release creation authoritative readback failed.' }
    Confirm-PublicationPhase 'channel-release-created' @{ releaseId = $feedRelease.id; draft = $false; tag = $feedRelease.tag_name }

}
# Upload the versioned payload first. Never clobber an existing payload.
$nupkg = Assert-TcnFeed $releases $identity
Start-PublicationOperation 'upload-and-verify-channel-package'
& gh release upload $identity.feedTag $nupkg --repo $Repository
if ($LASTEXITCODE -ne 0) { throw 'Version published, channel payload upload failed. Reconcile before retrying.' }
$feedReadback = Join-Path $CandidateDirectory ('feed-readback-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $feedReadback | Out-Null
& gh release download $identity.feedTag --repo $Repository --pattern ([IO.Path]::GetFileName($nupkg)) --dir $feedReadback
if ($LASTEXITCODE -ne 0 -or (Get-TcnFileDigest $nupkg).sha256 -cne (Get-TcnFileDigest (Join-Path $feedReadback ([IO.Path]::GetFileName($nupkg)))).sha256) { throw 'Channel payload readback failed; metadata remains unchanged.' }
$feedRelease = Get-ReleaseOrAbsent $identity.feedTag
if ($null -eq $feedRelease -or $feedRelease.draft -ne $false -or -not $feedRelease.body.StartsWith($marker, [StringComparison]::Ordinal)) { throw 'Channel release identity changed during package verification.' }
Confirm-PublicationPhase 'channel-package-verified' @{ releaseId = $feedRelease.id; tag = $feedRelease.tag_name; package = (Get-TcnFileDigest $nupkg) }
Start-PublicationOperation 'advance-and-verify-channel-feed'
& gh release upload $identity.feedTag (Join-Path $releases 'releases.win.json') (Join-Path $releases 'RELEASES') --repo $Repository --clobber
if ($LASTEXITCODE -ne 0) { throw 'Channel metadata update incomplete; reconcile the public feed.' }
$readbackFeed = Invoke-WebRequest -Uri "https://github.com/$Repository/releases/download/$($identity.feedTag)/releases.win.json" -Headers @{ 'Cache-Control' = 'no-cache' }
$expected = [IO.File]::ReadAllText((Join-Path $releases 'releases.win.json'))
if ($readbackFeed.Content -cne $expected) { throw 'Public channel metadata readback differs; reconcile before declaring completion.' }
$readbackLegacy = Invoke-WebRequest -Uri "https://github.com/$Repository/releases/download/$($identity.feedTag)/RELEASES" -Headers @{ 'Cache-Control' = 'no-cache' }
if ($readbackLegacy.Content -cne [IO.File]::ReadAllText((Join-Path $releases 'RELEASES'))) { throw 'Public legacy feed readback differs; reconcile before declaring completion.' }
Confirm-PublicationPhase 'channel-feed-verified' @{ feedUrl = "$expectedFeed/releases.win.json"; metadata = @((Get-TcnFileDigest (Join-Path $releases 'releases.win.json')), (Get-TcnFileDigest (Join-Path $releases 'RELEASES'))); nupkgSha256 = $candidate.nupkgSha256 }

Write-TcnJson (Join-Path $CandidateDirectory 'publication.json') ([ordered]@{ schema = 'tcn-desktop-publication/v1'; repository = $Repository; sourceRevision = $SourceRevision; releaseTag = $identity.releaseTag; feedTag = $identity.feedTag; nupkgSha256 = $candidate.nupkgSha256; verifiedUtc = [DateTime]::UtcNow.ToString('o') })
$attempt.incomplete = $false
Confirm-PublicationPhase 'complete' @{ publicationReceiptSha256 = (Get-TcnFileDigest (Join-Path $CandidateDirectory 'publication.json')).sha256 }
Write-Output "Published and verified $Repository/$($identity.releaseTag) and $($identity.feedTag)."
