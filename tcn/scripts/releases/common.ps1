# SPDX-License-Identifier: AGPL-3.0-or-later
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-TcnReleaseIdentity([string] $Channel, [string] $Version) {
    if ($Channel -notin @('stable', 'canary')) { throw 'Channel must be stable or canary.' }
    if ($Version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$') { throw 'A canonical three-part SemVer version is required.' }
    if ($Version.Contains('-')) {
        foreach ($identifier in $Version.Substring($Version.IndexOf('-') + 1).Split('.')) {
            if ($identifier -match '^0[0-9]+$') { throw 'Numeric prerelease identifiers must not have leading zeros.' }
        }
    }
    $canary = $Channel -eq 'canary'
    return [pscustomobject]@{
        channel = $Channel; version = $Version
        packageId = $(if ($canary) { 'tcn_chat_desktop_canary' } else { 'tcn_chat_desktop' })
        title = $(if ($canary) { 'TCN Chat Canary' } else { 'TCN Chat' })
        mainExe = $(if ($canary) { 'TCN Chat Canary.exe' } else { 'TCN Chat.exe' })
        aumid = $(if ($canary) { 'TCN.Chat.Canary' } else { 'TCN.Chat' })
        feedTag = "desktop-$Channel"
        releaseTag = "desktop-$Channel-v$Version"
    }
}

function Assert-TcnNewerVersion([string] $Candidate, [string] $Current) {
    $null = Get-TcnReleaseIdentity 'canary' $Candidate
    $null = Get-TcnReleaseIdentity 'canary' $Current
    if ([System.Management.Automation.SemanticVersion]::Parse($Candidate) -le [System.Management.Automation.SemanticVersion]::Parse($Current)) { throw 'Channel feeds must only advance to a newer version.' }
}

function Assert-TcnFreshDirectory([string] $Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if (Test-Path -LiteralPath $full) { throw "Output already exists; use a new candidate directory: $full" }
    return $full
}

function Assert-TcnChildPath([string] $Root, [string] $Relative) {
    if ([IO.Path]::IsPathRooted($Relative) -or $Relative -match '(^|[\\/])\.\.([\\/]|$)|:') { throw 'Unsafe relative artifact path.' }
    $prefix = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $full = [IO.Path]::GetFullPath([IO.Path]::Combine($Root, $Relative))
    if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Artifact escapes its root.' }
    return $full
}

function Get-TcnFileDigest([string] $Path) {
    $file = Get-Item -LiteralPath $Path
    if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Expected a regular artifact file.' }
    return [pscustomobject]@{ name = $file.Name; size = $file.Length; sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
}

function Assert-TcnSignature([string] $Path, [string] $Thumbprint) {
    if ($Thumbprint -notmatch '^[A-Fa-f0-9]{40}$') { throw 'An explicit signing certificate SHA1 thumbprint is required.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or $signature.SignerCertificate.Thumbprint -ne $Thumbprint) { throw "Expected valid TCN Authenticode signature: $([IO.Path]::GetFileName($Path))" }
}

function Write-TcnJson([string] $Path, $Value) {
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 30) + "`n", [Text.UTF8Encoding]::new($false))
}

function Expand-TcnPackage([string] $Package, [string] $Destination, $Identity) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $destinationPath = Assert-TcnFreshDirectory $Destination
    $zip = [IO.Compression.ZipFile]::OpenRead($Package)
    try {
        $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        $nuspecs = @($zip.Entries | Where-Object { $_.FullName -match '^[^/\\]+\.nuspec$' })
        if ($nuspecs.Count -ne 1) { throw 'Expected one root nuspec.' }
        $reader = [IO.StreamReader]::new($nuspecs[0].Open())
        try { [xml]$xml = $reader.ReadToEnd() } finally { $reader.Dispose() }
        $metadata = $xml.SelectSingleNode('/*[local-name()="package"]/*[local-name()="metadata"]')
        foreach ($pair in @(@('id', $Identity.packageId), @('version', $Identity.version), @('title', $Identity.title))) {
            $node = $metadata.SelectSingleNode("*[local-name()='$($pair[0])']")
            if ($null -eq $node -or $node.InnerText -cne $pair[1]) { throw "Package identity mismatch: $($pair[0])" }
        }
        New-Item -ItemType Directory -Path $destinationPath | Out-Null
        $payloadCount = 0
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if (-not $names.Add($name)) { throw 'Duplicate case-insensitive ZIP path.' }
            $null = Assert-TcnChildPath $destinationPath $name
            if (($entry.ExternalAttributes -shr 16 -band 0xF000) -eq 0xA000) { throw 'Symlinks are forbidden in release packages.' }
            if ($name -match '(^|/)(\.git|\.env(?:\..*)?|profiles?|fixtures|tests?|backups?|logs?|settings\.json|servers\.json)(/|$)' -or $name -match '\.(pfx|pem|key)$') { throw 'Forbidden runtime, test or secret file in package.' }
            if ($name -notmatch '^lib/app/(.+)$' -or $name.EndsWith('/')) { continue }
            $relative = $Matches[1]
            if ($relative -match '(^|/)(\.git|\.env(?:\..*)?|profiles?|fixtures|tests?|backups?|logs?|settings\.json|servers\.json)(/|$)' -or $relative -match '\.(pfx|pem|key)$') { throw 'Forbidden runtime, test or secret file in package.' }
            $targetPath = Assert-TcnChildPath $destinationPath $relative
            New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($targetPath)) -Force | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $targetPath, $false)
            $payloadCount++
        }
        if ($payloadCount -eq 0 -or -not (Test-Path -LiteralPath (Join-Path $destinationPath $Identity.mainExe))) { throw 'Missing TCN application payload.' }
        return $destinationPath
    } finally { $zip.Dispose() }
}

function Assert-TcnFeed([string] $Directory, $Identity) {
    $feed = Get-Content -LiteralPath (Join-Path $Directory 'releases.win.json') -Raw | ConvertFrom-Json
    $assets = @($feed.Assets)
    if ($assets.Count -ne 1) { throw 'A fresh release must have exactly one full update asset.' }
    $asset = $assets[0]
    if ($asset.PackageId -cne $Identity.packageId -or $asset.Version -cne $Identity.version -or $asset.Type -cne 'Full') { throw 'Feed identity/version/type mismatch.' }
    $name = [string]$asset.FileName
    if ($name -cne [IO.Path]::GetFileName($name) -or -not $name.EndsWith('-full.nupkg')) { throw 'Feed must reference a local versioned full package.' }
    $package = Assert-TcnChildPath $Directory $name
    $item = Get-Item -LiteralPath $package
    if ($item.Length -ne $asset.Size -or (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash -ne $asset.SHA256 -or (Get-FileHash -LiteralPath $package -Algorithm SHA1).Hash -ne $asset.SHA1) { throw 'Feed package digest or size mismatch.' }
    return $package
}

function Test-TcnTrue($Value) { return ($Value -is [bool] -and $Value -eq $true) }

function Assert-TcnAcceptance($Receipt, $Candidate) {
    if ($Receipt.schema -cne 'tcn-desktop-acceptance/v1' -or $Receipt.channel -cne $Candidate.channel -or $Receipt.version -cne $Candidate.version -or $Receipt.nupkgSha256 -cne $Candidate.nupkgSha256 -or $Receipt.installerSha256 -cne $Candidate.installerSha256) { throw 'Acceptance receipt does not cover this exact release.' }
    if ($Receipt.staging.origin -cne 'https://chat.server60.the-cantina.net' -or -not (Test-TcnTrue $Receipt.staging.passed)) { throw 'Exact candidate staging acceptance is required.' }
    if (-not (Test-TcnTrue $Receipt.freshInstall.passed) -or -not (Test-TcnTrue $Receipt.installedUpgrade.passed) -or $Receipt.installedUpgrade.previousVersion -eq $Candidate.version -or [string]::IsNullOrWhiteSpace($Receipt.installedUpgrade.previousVersion) -or $Receipt.installedUpgrade.targetVersion -cne $Candidate.version) { throw 'Fresh install and installed upgrade acceptance are required.' }
    if (-not (Test-TcnTrue $Receipt.installedUpgrade.profilePreserved) -or -not (Test-TcnTrue $Receipt.installedUpgrade.channelIsolated)) { throw 'Installed upgrade must preserve profiles and channel isolation.' }
}

function Complete-TcnCandidate([string] $OutputDirectory, $Identity, [bool] $UnsignedTest, [string] $SignerThumbprint) {
    $output = [IO.Path]::GetFullPath($OutputDirectory)
    $releases = Join-Path $output 'releases'
    $Version = $Identity.version; $Channel = $Identity.channel
    $desktop = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../fluxer_desktop'))
    foreach ($name in @('candidate.json', 'payload-inspection.json', 'verified-payload')) {
        if (Test-Path -LiteralPath (Join-Path $output $name)) { throw 'Validation output already exists; use a fresh candidate directory.' }
    }
    $oldVersion = $env:TCN_EXPECT_VERSION; $oldChannel = $env:TCN_EXPECT_CHANNEL
    try {
        $env:TCN_EXPECT_VERSION = $Version; $env:TCN_EXPECT_CHANNEL = $Channel
    $nupkg = Assert-TcnFeed $releases $identity
    $setups = @(Get-ChildItem -LiteralPath $releases -File | Where-Object Name -Like '*-Setup.exe')
    if ($setups.Count -ne 1) { throw 'Expected exactly one Velopack installer.' }
    $payload = Expand-TcnPackage $nupkg (Join-Path $output 'verified-payload') $identity
    & node (Join-Path $desktop 'scripts/tcn-inspect-package.cjs') $payload (Join-Path $output 'payload-inspection.json')
    if ($LASTEXITCODE -ne 0) { throw 'Actual installer/update payload inspection failed.' }
    $payloadInspection = Get-Content -LiteralPath (Join-Path $output 'payload-inspection.json') -Raw | ConvertFrom-Json
    if (-not $UnsignedTest -and $null -eq $payloadInspection.releaseConfig) { throw 'Signed distribution requires compiled TCN release configuration.' }
    if (-not $UnsignedTest) {
        if ($null -eq $payloadInspection.sourceProvenance) { throw 'Signed distribution requires embedded source provenance.' }
        $sourceReceipt = Join-Path $output 'source.json'
        Write-TcnJson $sourceReceipt $payloadInspection.sourceProvenance
        & node (Join-Path $PSScriptRoot 'lineage.mjs') check-receipt --receipt $sourceReceipt --version $Version --channel $Channel --source-revision $payloadInspection.sourceProvenance.sourceRevision --require-release
        if ($LASTEXITCODE -ne 0) { throw 'Signed candidate source lineage is not accepted.' }
        Assert-TcnSignature $setups[0].FullName $SignerThumbprint
        Assert-TcnSignature (Join-Path $payload $identity.mainExe) $SignerThumbprint
        $updaters = @(Get-ChildItem -LiteralPath $payload -File | Where-Object Name -In @('Update.exe', 'Squirrel.exe'))
        if ($updaters.Count -ne 1) { throw 'Expected exactly one Velopack updater.' }
        Assert-TcnSignature $updaters[0].FullName $SignerThumbprint
    }
    $artifacts = @('releases.win.json', 'RELEASES', ([IO.Path]::GetFileName($nupkg)), $setups[0].Name) | ForEach-Object { Get-TcnFileDigest (Join-Path $releases $_) }
    $candidate = [ordered]@{
        schema = 'tcn-desktop-candidate/v1'; channel = $Channel; version = $Version; packageId = $identity.packageId
        velopackVersion = '1.2.0'; architecture = 'x64'; unsignedTest = [bool]$UnsignedTest
        signerThumbprint = $SignerThumbprint; signatureVerified = (-not $UnsignedTest)
        nupkgSha256 = (Get-TcnFileDigest $nupkg).sha256; installerSha256 = (Get-TcnFileDigest $setups[0].FullName).sha256
        releaseConfig = $payloadInspection.releaseConfig; sourceProvenance = $payloadInspection.sourceProvenance
        payloadInspectionSha256 = (Get-TcnFileDigest (Join-Path $output 'payload-inspection.json')).sha256
        artifacts = @($artifacts); createdUtc = [DateTime]::UtcNow.ToString('o')
    }
    Write-TcnJson (Join-Path $output 'candidate.json') $candidate
    $lines = $artifacts | ForEach-Object { "$($_.sha256)  $($_.name)" }
    [IO.File]::WriteAllLines((Join-Path $releases 'SHA256SUMS'), $lines, [Text.UTF8Encoding]::new($false))
    Write-Output "Validated $Channel $Version installer and full update package. Unsigned evaluation: $UnsignedTest"
    } finally { $env:TCN_EXPECT_VERSION = $oldVersion; $env:TCN_EXPECT_CHANNEL = $oldChannel }
}
