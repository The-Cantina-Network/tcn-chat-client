# SPDX-License-Identifier: AGPL-3.0-or-later
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $CandidateDirectory,
    [Parameter(Mandatory)][string] $AcceptanceReceipt,
    [Parameter(Mandatory)][string] $SignerThumbprint
)
. "$PSScriptRoot/common.ps1"
$directory = (Resolve-Path -LiteralPath $CandidateDirectory).Path
$candidate = Get-Content -LiteralPath (Join-Path $directory 'candidate.json') -Raw | ConvertFrom-Json
if ($candidate.schema -cne 'tcn-desktop-candidate/v1' -or $candidate.unsignedTest -ne $false -or $candidate.signatureVerified -ne $true -or $candidate.signerThumbprint -ne $SignerThumbprint) { throw 'Unsigned or unverified candidates cannot be published.' }
$identity = Get-TcnReleaseIdentity $candidate.channel $candidate.version
if ($candidate.channel -eq 'stable' -and $candidate.version.Contains('-')) { throw 'Stable publication requires a non-prerelease version.' }
if ($candidate.packageId -cne $identity.packageId -or $candidate.architecture -cne 'x64' -or $candidate.velopackVersion -cne '1.2.0') { throw 'Unsupported candidate identity/toolchain.' }
$releases = Join-Path $directory 'releases'
$seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($artifact in $candidate.artifacts) {
    if (-not $seen.Add($artifact.name) -or $artifact.name -cne [IO.Path]::GetFileName($artifact.name)) { throw 'Duplicate/unsafe artifact name.' }
    $actual = Get-TcnFileDigest (Assert-TcnChildPath $releases $artifact.name)
    if ($actual.size -ne $artifact.size -or $actual.sha256 -cne $artifact.sha256) { throw "Frozen release artifact changed: $($artifact.name)" }
}
$nupkg = Assert-TcnFeed $releases $identity
$setups = @($candidate.artifacts | Where-Object name -Like '*-Setup.exe')
if ($setups.Count -ne 1 -or -not $seen.Contains('releases.win.json') -or -not $seen.Contains('RELEASES') -or -not $seen.Contains([IO.Path]::GetFileName($nupkg)) -or $seen.Count -ne 4) { throw 'Candidate artifact allowlist mismatch.' }
if ((Get-TcnFileDigest $nupkg).sha256 -cne $candidate.nupkgSha256 -or $setups[0].sha256 -cne $candidate.installerSha256) { throw 'Candidate digest inconsistency.' }
Assert-TcnSignature (Join-Path $releases $setups[0].name) $SignerThumbprint
# Validate the payload from the frozen nupkg again, not a retained staging copy.
$verification = Join-Path ([IO.Path]::GetTempPath()) ('tcn-release-verify-' + [Guid]::NewGuid().ToString('N'))
$payload = Expand-TcnPackage $nupkg $verification $identity
$inspectionFile = Join-Path $directory 'payload-inspection.json'
if ((Get-TcnFileDigest $inspectionFile).sha256 -cne $candidate.payloadInspectionSha256) { throw 'Payload inspection receipt changed.' }
$inspection = Get-Content -LiteralPath $inspectionFile -Raw | ConvertFrom-Json
if (($inspection.releaseConfig | ConvertTo-Json -Compress) -cne ($candidate.releaseConfig | ConvertTo-Json -Compress) -or $null -eq $candidate.releaseConfig -or $candidate.releaseConfig.channel -cne $identity.channel) { throw 'Compiled release policy is missing or inconsistent.' }
if ($null -eq $candidate.sourceProvenance -or ($inspection.sourceProvenance | ConvertTo-Json -Depth 30 -Compress) -cne ($candidate.sourceProvenance | ConvertTo-Json -Depth 30 -Compress)) { throw 'Embedded source provenance is missing or inconsistent.' }
foreach ($file in $inspection.files) {
    $actual = Get-TcnFileDigest (Assert-TcnChildPath $payload $file.path)
    if ($actual.sha256 -cne $file.sha256 -or $actual.size -ne $file.size) { throw 'Actual update payload differs from its inspected bytes.' }
}
if (@(Get-ChildItem -LiteralPath $payload -Recurse -File).Count -ne @($inspection.files).Count) { throw 'Unexpected additional files in update payload.' }
Assert-TcnSignature (Join-Path $payload $identity.mainExe) $SignerThumbprint
$updaters = @(Get-ChildItem -LiteralPath $payload -File | Where-Object Name -In @('Update.exe', 'Squirrel.exe'))
if ($updaters.Count -ne 1) { throw 'Expected exactly one installed Velopack updater.' }
Assert-TcnSignature $updaters[0].FullName $SignerThumbprint
$engine = Get-Content -LiteralPath (Join-Path $directory 'update-engine.json') -Raw | ConvertFrom-Json
if ($engine.schema -cne 'tcn-desktop-update-engine/v1' -or -not (Test-TcnTrue $engine.passed) -or $engine.channel -cne $candidate.channel -or $engine.version -cne $candidate.version -or $engine.nupkgSha256 -cne $candidate.nupkgSha256 -or $engine.candidateSha256 -cne (Get-TcnFileDigest (Join-Path $directory 'candidate.json')).sha256) { throw 'Native updater acceptance does not cover this exact candidate.' }
$scenarios = @($engine.cases | ForEach-Object { if (-not (Test-TcnTrue $_.passed)) { throw 'Native updater acceptance contains a failure.' }; $_.scenario })
if (@($scenarios | Sort-Object -Unique).Count -ne 4 -or @('good', 'checksum', 'corrupt', 'unavailable' | Where-Object { $_ -notin $scenarios }).Count) { throw 'Native updater success/checksum/corruption/unavailable cases are required.' }
Assert-TcnNewerVersion $candidate.version $engine.currentVersion
$receipt = Get-Content -LiteralPath $AcceptanceReceipt -Raw | ConvertFrom-Json
Assert-TcnAcceptance $receipt $candidate
Write-Output "Publication gate passed for $($identity.channel) $($identity.version)."
