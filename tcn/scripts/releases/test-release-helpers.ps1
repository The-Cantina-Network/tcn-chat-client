# SPDX-License-Identifier: AGPL-3.0-or-later
# Run: pwsh -NoProfile -File tcn/scripts/releases/test-release-helpers.ps1
. "$PSScriptRoot/common.ps1"
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('tcn-release-tests-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
$script:passed = 0
function Assert-Test([bool] $Condition, [string] $Name) { if (-not $Condition) { throw "FAILED: $Name" }; $script:passed++ }
function Assert-Rejected([scriptblock] $Action, [string] $Name) {
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true }
    Assert-Test $rejected $Name
}
$stable = Get-TcnReleaseIdentity stable 1.2.3
$canary = Get-TcnReleaseIdentity canary 1.2.4-canary.1
Assert-Test ($stable.packageId -eq 'tcn_chat_desktop' -and $canary.packageId -eq 'tcn_chat_desktop_canary') 'distinct TCN updater identities'
Assert-Test ($stable.feedTag -ne $canary.feedTag -and $stable.mainExe -ne $canary.mainExe) 'channel feed/executable isolation'
Assert-Rejected { Get-TcnReleaseIdentity upstream 1.2.3 } 'unknown channel'
Assert-Rejected { Get-TcnReleaseIdentity stable '1.2.3; injected' } 'shell-like version'
Assert-Rejected { Get-TcnReleaseIdentity stable '01.2.3' } 'noncanonical version'
Assert-Rejected { Get-TcnReleaseIdentity canary '1.2.3-dev.01' } 'leading zero prerelease'
Assert-Rejected { Assert-TcnNewerVersion '1.2.3' '1.2.3' } 'republish same version'
Assert-Rejected { Assert-TcnNewerVersion '1.2.2' '1.2.3' } 'feed downgrade'
Assert-TcnNewerVersion '1.2.3' '1.2.3-canary.1'; $script:passed++
Assert-Rejected { Assert-TcnFreshDirectory $testRoot } 'existing candidate cannot be overwritten'
foreach ($bad in @('../escape', 'sub/../../escape', 'C:\escape', 'file:stream')) {
    Assert-Rejected { Assert-TcnChildPath $testRoot $bad } "unsafe child path $bad"
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
function New-TestPackage([string] $Name, [string[]] $Entries, [string] $Id = 'tcn_chat_desktop') {
    $file = Join-Path $testRoot "$Name.nupkg"
    $zip = [IO.Compression.ZipFile]::Open($file, [IO.Compression.ZipArchiveMode]::Create)
    try {
        $entry = $zip.CreateEntry('test.nuspec')
        $writer = [IO.StreamWriter]::new($entry.Open())
        try { $writer.Write("<package><metadata><id>$Id</id><version>1.2.3</version><title>TCN Chat</title></metadata></package>") } finally { $writer.Dispose() }
        foreach ($name in $Entries) {
            $entry = $zip.CreateEntry($name)
            $writer = [IO.StreamWriter]::new($entry.Open())
            try { $writer.Write('test-only') } finally { $writer.Dispose() }
        }
    } finally { $zip.Dispose() }
    return $file
}
$good = New-TestPackage good @('lib/app/TCN Chat.exe')
$expanded = Expand-TcnPackage $good (Join-Path $testRoot 'good-payload') $stable
Assert-Test (Test-Path -LiteralPath (Join-Path $expanded 'TCN Chat.exe')) 'valid package payload'
$bad = New-TestPackage traversal @('lib/app/TCN Chat.exe', 'lib/app/../../escape')
Assert-Rejected { Expand-TcnPackage $bad (Join-Path $testRoot 'traversal-payload') $stable } 'zip traversal'
$bad = New-TestPackage duplicate @('lib/app/TCN Chat.exe', 'lib/app/tcn chat.exe')
Assert-Rejected { Expand-TcnPackage $bad (Join-Path $testRoot 'duplicate-payload') $stable } 'case-insensitive duplicate zip entry'
$bad = New-TestPackage wrongidentity @('lib/app/TCN Chat.exe') 'fluxer_desktop'
Assert-Rejected { Expand-TcnPackage $bad (Join-Path $testRoot 'identity-payload') $stable } 'upstream package identity'
$bad = New-TestPackage secret @('lib/app/TCN Chat.exe', 'lib/app/.env.production')
Assert-Rejected { Expand-TcnPackage $bad (Join-Path $testRoot 'secret-payload') $stable } 'secret/config payload'
$candidate = [pscustomobject]@{ channel = 'stable'; version = '1.2.3'; nupkgSha256 = 'a' * 64; installerSha256 = 'b' * 64 }
$receipt = [pscustomobject]@{ schema = 'tcn-desktop-acceptance/v1'; channel = 'stable'; version = '1.2.3'; nupkgSha256 = 'a' * 64; installerSha256 = 'b' * 64; staging = [pscustomobject]@{origin = 'https://chat.server60.the-cantina.net'; passed = $true}; freshInstall = [pscustomobject]@{passed = $true}; installedUpgrade = [pscustomobject]@{passed = $true; previousVersion = '1.2.2'; targetVersion = '1.2.3'; profilePreserved = $true; channelIsolated = $true} }
Assert-TcnAcceptance $receipt $candidate
$script:passed++
$receipt.nupkgSha256 = 'c' * 64
Assert-Rejected { Assert-TcnAcceptance $receipt $candidate } 'stale acceptance digest'
$receipt.nupkgSha256 = 'a' * 64
$receipt.installedUpgrade.previousVersion = '1.2.3'
Assert-Rejected { Assert-TcnAcceptance $receipt $candidate } 'same-version test is not upgrade acceptance'
$receipt.installedUpgrade.previousVersion = '1.2.2'; $receipt.staging.origin = 'https://chat.the-cantina.net'
Assert-Rejected { Assert-TcnAcceptance $receipt $candidate } 'production is not staging evidence'
$unsignedDir = Join-Path $testRoot 'unsigned'; New-Item -ItemType Directory -Path $unsignedDir | Out-Null
Write-TcnJson (Join-Path $unsignedDir 'candidate.json') @{ schema = 'tcn-desktop-candidate/v1'; unsignedTest = $true; signatureVerified = $false; signerThumbprint = '' }
Assert-Rejected { & "$PSScriptRoot/assert-release.ps1" -CandidateDirectory $unsignedDir -AcceptanceReceipt 'not-read' -SignerThumbprint ('a' * 40) } 'unsigned release publication gate'
# Exercise only the publisher's local checkpoint functions; no GitHub calls run.
$publisherTokens = $null; $publisherErrors = $null
$publisher = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'publish-github.ps1'), [ref]$publisherTokens, [ref]$publisherErrors)
$checkpointNames = @('Save-PublicationAttempt', 'Start-PublicationOperation', 'Confirm-PublicationPhase')
foreach ($definition in $publisher.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $checkpointNames }, $true)) {
    . ([scriptblock]::Create($definition.Extent.Text))
}
$CandidateDirectory = Join-Path $testRoot 'checkpoint'
New-Item -ItemType Directory -Path $CandidateDirectory | Out-Null
$attemptPath = Join-Path $CandidateDirectory 'publication-attempt.json'
$attempt = [ordered]@{ incomplete = $true; phase = 'locally-validated'; operationInProgress = $null; history = @(); updatedUtc = '' }
Save-PublicationAttempt
Start-PublicationOperation 'create-version-draft'
$stored = Get-Content -LiteralPath $attemptPath -Raw | ConvertFrom-Json
Assert-Test ($stored.phase -eq 'locally-validated' -and $stored.operationInProgress -eq 'create-version-draft' -and $stored.incomplete) 'unverified command preserves prior phase'
Confirm-PublicationPhase 'draft-created' @{ releaseId = 123; draft = $true }
$stored = Get-Content -LiteralPath $attemptPath -Raw | ConvertFrom-Json
Assert-Test ($stored.phase -eq 'draft-created' -and $null -eq $stored.operationInProgress -and $stored.history[0].readback.releaseId -eq 123) 'verified remote phase persisted'
Start-PublicationOperation 'upload-and-verify-version-assets'
$stored = Get-Content -LiteralPath $attemptPath -Raw | ConvertFrom-Json
Assert-Test ($stored.phase -eq 'draft-created' -and $stored.history.Count -eq 1 -and $stored.operationInProgress -eq 'upload-and-verify-version-assets') 'interrupted next phase remains incomplete'
Assert-Test (-not (Test-Path -LiteralPath (Join-Path $CandidateDirectory 'publication.json')) -and @(Get-ChildItem -LiteralPath $CandidateDirectory -Filter '*.tmp').Count -eq 0) 'partial attempt emits no success receipt or partial checkpoint file'
Write-Output "$script:passed release boundary checks passed. Temporary evidence: $testRoot"
