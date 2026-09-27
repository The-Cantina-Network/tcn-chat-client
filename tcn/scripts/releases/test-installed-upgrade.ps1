#requires -Version 7.0
# SPDX-License-Identifier: AGPL-3.0-or-later
<#
Run only on a disposable Windows user/runner: Velopack writes HKCU uninstall
registration and shortcuts even with --installto. This script never treats a
custom installation directory as user isolation. Existing profiles/installations
cause a refusal. No operator credentials, real sessions or visible app are used.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $CandidateDirectory,
    [Parameter(Mandatory)][string] $PreviousInstallerPath,
    [Parameter(Mandatory)][string] $PreviousVersion,
    [Parameter(Mandatory)][string] $OutputDirectory,
    [switch] $DisposableEnvironment,
    [string] $ElectronPath
)
. "$PSScriptRoot/common.ps1"
if (-not $IsWindows) { throw 'Installer acceptance requires Windows.' }
$hostedRunner = $env:GITHUB_ACTIONS -eq 'true' -and $env:RUNNER_ENVIRONMENT -eq 'github-hosted' -and $env:RUNNER_OS -eq 'Windows'
if (-not $hostedRunner -and -not $DisposableEnvironment) { throw 'Refusing installation: use an ephemeral GitHub-hosted Windows runner or explicitly acknowledge a disposable Windows user/VM with -DisposableEnvironment.' }
if ($env:FLUXER_PORTABLE -or $env:FLUXER_SKIP_NATIVE_PREFLIGHT) { throw 'Portable mode or native preflight overrides are forbidden during installer acceptance.' }

function Quote-NativeArgument([string] $Argument) {
    if ($Argument.Contains('"') -or $Argument.Contains("`r") -or $Argument.Contains("`n") -or $Argument.Contains([char]0)) { throw 'Unsupported native argument.' }
    # All supplied arguments are simple options or canonical Windows paths. Double
    # trailing backslashes so the Windows command-line parser retains the quote.
    return '"' + [regex]::Replace($Argument, '(\\+)$', '$1$1') + '"'
}

function Invoke-HiddenProcess([string] $Executable, [string[]] $Arguments, [string] $LogName, [int] $TimeoutSeconds = 180) {
    $argumentLine = ($Arguments | ForEach-Object { Quote-NativeArgument $_ }) -join ' '
    $process = Start-Process -FilePath $Executable -ArgumentList $argumentLine -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $output "$LogName.stdout.log") -RedirectStandardError (Join-Path $output "$LogName.stderr.log")
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        # Only terminate the process started by this invocation, never by app name.
        $process.Kill($true)
        $process.WaitForExit()
        throw "Timed out during $LogName."
    }
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw "$LogName exited with code $($process.ExitCode); inspect its captured logs." }
}

function Read-InstalledIdentity([string] $ExpectedVersion) {
    $manifest = Join-Path $installRoot 'current/sq.version'
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { throw 'Missing installed Velopack manifest.' }
    [xml]$xml = Get-Content -LiteralPath $manifest -Raw
    $metadata = $xml.SelectSingleNode('/*[local-name()="package"]/*[local-name()="metadata"]')
    foreach ($pair in @(@('id', $identity.packageId), @('version', $ExpectedVersion), @('mainExe', $identity.mainExe))) {
        $item = $metadata.SelectSingleNode("*[local-name()='$($pair[0])']")
        if ($null -eq $item -or $item.InnerText -cne $pair[1]) { throw "Installed identity mismatch: $($pair[0])." }
    }
    $exe = Join-Path $installRoot "current/$($identity.mainExe)"
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $installRoot 'Update.exe') -PathType Leaf)) { throw 'Installed executable/updater is missing.' }
    $versionInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe)
    if ($versionInfo.FileVersion -cne $ExpectedVersion) { throw 'Installed executable file version does not match its manifest.' }
    return [pscustomobject]@{ packageId = $identity.packageId; version = $ExpectedVersion; fileVersion = $versionInfo.FileVersion; productVersion = $versionInfo.ProductVersion; manifestSha256 = (Get-TcnFileDigest $manifest).sha256 }
}

function Assert-InstalledPayload {
    $count = 0
    $expectedFiles = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $null = $expectedFiles.Add('sq.version')
    foreach ($file in Get-ChildItem -LiteralPath $payload -Recurse -File) {
        $relative = [IO.Path]::GetRelativePath($payload, $file.FullName)
        if ($relative -eq 'Squirrel.exe' -or $relative -like '*_ExecutionStub.exe') { continue }
        $null = $expectedFiles.Add($relative)
        $installed = Assert-TcnChildPath (Join-Path $installRoot 'current') $relative
        if (-not (Test-Path -LiteralPath $installed -PathType Leaf) -or (Get-TcnFileDigest $installed).sha256 -cne (Get-TcnFileDigest $file.FullName).sha256) { throw "Installed payload differs from the accepted update package: $relative" }
        $count++
    }
    if ($count -lt 10) { throw 'Incomplete installed payload verification.' }
    $currentRoot = Join-Path $installRoot 'current'
    foreach ($item in Get-ChildItem -LiteralPath $currentRoot -Recurse -Force) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installed payload contains a link.' }
        if (-not $item.PSIsContainer -and -not $expectedFiles.Contains([IO.Path]::GetRelativePath($currentRoot, $item.FullName))) { throw 'Installed payload contains a file outside the exact update package.' }
    }
    $packagedUpdater = Join-Path $payload 'Squirrel.exe'
    if (-not (Test-Path -LiteralPath $packagedUpdater) -or (Get-TcnFileDigest $packagedUpdater).sha256 -cne (Get-TcnFileDigest (Join-Path $installRoot 'Update.exe')).sha256) { throw 'Installed updater differs from the package updater.' }
    return $count
}

function Assert-Sentinels {
    foreach ($sentinel in $sentinels) {
        if (-not (Test-Path -LiteralPath $sentinel.path -PathType Leaf) -or (Get-TcnFileDigest $sentinel.path).sha256 -cne $sentinel.sha256) { throw 'Upgrade changed or removed an isolated profile/settings/session sentinel.' }
    }
}

function Assert-NoTcnRegistration {
    foreach ($id in @('tcn_chat_desktop', 'tcn_chat_desktop_canary')) {
        if (Test-Path -LiteralPath "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$id") { throw 'Existing TCN installer registration found; disposable clean user required.' }
    }
    foreach ($shortcut in $shortcutPaths) { if (Test-Path -LiteralPath $shortcut) { throw 'A TCN shortcut remains outside the test installation.' } }
}

function Uninstall-TestApplication([string] $LogName) {
    $null = Read-InstalledIdentity $installedVersion
    $update = Join-Path $installRoot 'Update.exe'
    Invoke-HiddenProcess $update @('--silent', '--rootDir', $installRoot, '--log', (Join-Path $output "$LogName.velopack.log"), 'uninstall') $LogName
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ((Test-Path -LiteralPath (Join-Path $installRoot "current/$($identity.mainExe)")) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
    if (Test-Path -LiteralPath (Join-Path $installRoot "current/$($identity.mainExe)")) { throw 'Uninstaller left the current application executable.' }
    Assert-NoTcnRegistration
}

function Invoke-InstalledStagingSmoke([string] $Phase) {
    $current = Join-Path $installRoot 'current'
    $env:TCN_SMOKE_PACKAGE = Join-Path $current 'resources/app.asar'
    $env:TCN_EXPECT_CHANNEL = $identity.channel
    $env:TCN_EXPECT_VERSION = $identity.version
    $env:TCN_SMOKE_ORIGIN = 'https://chat.server60.the-cantina.net'
    $env:TCN_SMOKE_OFFLINE = $null
    $env:TCN_SMOKE_EXPECT_ERROR = $null
    $env:FLUXER_SKIP_NATIVE_PREFLIGHT = $null
    $env:TCN_SMOKE_OUTPUT = Join-Path $output "$Phase-native"
    $env:ELECTRON_RUN_AS_NODE = '1'
    Invoke-HiddenProcess (Join-Path $current $identity.mainExe) @((Join-Path $desktop 'scripts/tcn-probe-native.cjs')) "$Phase-native"
    $nativeReceipt = Join-Path $env:TCN_SMOKE_OUTPUT 'native-modules.json'
    $native = Get-Content -LiteralPath $nativeReceipt -Raw | ConvertFrom-Json
    if ($native.platform -cne 'win32' -or $native.arch -cne 'x64' -or @($native.nativeModules).Count -ne 9 -or @($native.nativeModules | Where-Object loaded -NE $true).Count) { throw 'Installed native probe receipt is incomplete.' }
    $env:ELECTRON_RUN_AS_NODE = $null
    $env:TCN_SMOKE_OUTPUT = Join-Path $output "$Phase-staging"
    Invoke-HiddenProcess $ElectronPath @((Join-Path $desktop 'scripts/tcn-smoke.cjs')) "$Phase-staging"
    $smokeReceipt = Join-Path $env:TCN_SMOKE_OUTPUT 'receipt.json'
    $smoke = Get-Content -LiteralPath $smokeReceipt -Raw | ConvertFrom-Json
    $asarSha256 = (Get-TcnFileDigest $env:TCN_SMOKE_PACKAGE).sha256
    if ($smoke.passed -ne $true -or $smoke.nativeStartupPassed -ne $true -or $smoke.hostedCompatible -ne $true -or $smoke.chooserPassed -ne $true -or $smoke.exitCode -ne 0 -or @($smoke.errors).Count -ne 0) { throw 'Installed payload failed staging/native startup acceptance.' }
    if ($smoke.origin -cne $env:TCN_SMOKE_ORIGIN -or $smoke.version -cne $identity.version -or $smoke.channel -cne $identity.channel -or $smoke.asarSha256 -cne $asarSha256 -or $smoke.page.info.version -cne $identity.version) { throw 'Staging receipt does not cover the installed candidate.' }
    return [pscustomobject]@{
        passed = $true; origin = $smoke.origin; asarSha256 = $asarSha256
        rendererReceipt = [IO.Path]::GetRelativePath($output, $smokeReceipt); rendererReceiptSha256 = (Get-TcnFileDigest $smokeReceipt).sha256
        nativeReceipt = [IO.Path]::GetRelativePath($output, $nativeReceipt); nativeReceiptSha256 = (Get-TcnFileDigest $nativeReceipt).sha256
        execution = 'Installed executable native loading; installed main/preload under matching external hidden Electron harness with temporary profile.'
    }
}

$output = Assert-TcnFreshDirectory $OutputDirectory
$candidateRoot = (Resolve-Path -LiteralPath $CandidateDirectory).Path
$candidatePath = Join-Path $candidateRoot 'candidate.json'
$candidate = Get-Content -LiteralPath $candidatePath -Raw | ConvertFrom-Json
if ($candidate.schema -cne 'tcn-desktop-candidate/v1' -or $candidate.architecture -cne 'x64' -or $candidate.velopackVersion -cne '1.2.0') { throw 'Unsupported candidate manifest.' }
$identity = Get-TcnReleaseIdentity $candidate.channel $candidate.version
$null = Get-TcnReleaseIdentity $candidate.channel $PreviousVersion
Assert-TcnNewerVersion $identity.version $PreviousVersion
if ($candidate.packageId -cne $identity.packageId) { throw 'Candidate identity mismatch.' }
$releases = Join-Path $candidateRoot 'releases'
foreach ($artifact in @($candidate.artifacts)) {
    $path = Assert-TcnChildPath $releases $artifact.name
    $actual = Get-TcnFileDigest $path
    if ($actual.sha256 -cne $artifact.sha256 -or $actual.size -ne $artifact.size) { throw 'Candidate artifact digest mismatch.' }
}
$nupkg = Assert-TcnFeed $releases $identity
$installerEntries = @($candidate.artifacts | Where-Object name -Like '*-Setup.exe')
if ($installerEntries.Count -ne 1) { throw 'Expected one candidate installer.' }
$installer = Assert-TcnChildPath $releases $installerEntries[0].name
if ((Get-TcnFileDigest $nupkg).sha256 -cne $candidate.nupkgSha256 -or (Get-TcnFileDigest $installer).sha256 -cne $candidate.installerSha256) { throw 'Candidate installer/package mismatch.' }
$previousInstaller = (Resolve-Path -LiteralPath $PreviousInstallerPath).Path
if (-not $candidate.unsignedTest) { Assert-TcnSignature $installer $candidate.signerThumbprint; Assert-TcnSignature $previousInstaller $candidate.signerThumbprint }
$desktop = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../fluxer_desktop'))
if (-not $ElectronPath) { $ElectronPath = Join-Path $desktop 'node_modules/electron/dist/electron.exe' }
$ElectronPath = (Resolve-Path -LiteralPath $ElectronPath).Path
$electronVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($ElectronPath).ProductVersion
$desktopMetadata = Get-Content -LiteralPath (Join-Path $desktop 'package.json') -Raw | ConvertFrom-Json
if ($electronVersion -cne $desktopMetadata.devDependencies.electron) { throw 'Smoke runtime must be the pinned Electron version.' }
$profileNames = @('tcn-chat-desktop', 'tcn-chat-desktop-canary', 'fluxer', 'fluxercanary')
$profileRoots = @($profileNames | ForEach-Object { Assert-TcnChildPath $env:APPDATA $_ })
foreach ($profile in $profileRoots) { if (Test-Path -LiteralPath $profile) { throw 'Existing TCN or Fluxer profile found; this harness requires a clean disposable user.' } }
foreach ($id in @('tcn_chat_desktop', 'tcn_chat_desktop_canary')) { if (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA $id)) { throw 'Existing default TCN installation found.' } }
$programs = Join-Path $env:APPDATA 'Microsoft/Windows/Start Menu/Programs'
$shortcutPaths = @('TCN Chat', 'TCN Chat Canary') | ForEach-Object {
    Join-Path ([Environment]::GetFolderPath('Desktop')) "$_.lnk"
    Join-Path $programs "$_.lnk"
    Join-Path (Join-Path $programs 'The Cantina Network') "$_.lnk"
}
Assert-NoTcnRegistration
$environmentBefore = @{}
Get-ChildItem Env: | ForEach-Object { $environmentBefore[$_.Name] = $_.Value }
$sentinels = [Collections.Generic.List[object]]::new()
$createdProfiles = [Collections.Generic.List[string]]::new()
$installedVersion = $null
$installAttempted = $false
$cleanupPassed = $false
$receipt = $null
New-Item -ItemType Directory -Path $output | Out-Null
$installRoot = Assert-TcnChildPath $output 'installation'
$payload = Expand-TcnPackage $nupkg (Join-Path $output 'expected-payload') $identity
try {
    $env:ELECTRON_RUN_AS_NODE = $null
    $installAttempted = $true
    Invoke-HiddenProcess $installer @('--silent', '--installto', $installRoot, '--log', (Join-Path $output 'fresh-install.velopack.log')) 'fresh-install'
    $installedVersion = $identity.version
    $freshIdentity = Read-InstalledIdentity $installedVersion
    $freshCount = Assert-InstalledPayload
    $freshStaging = Invoke-InstalledStagingSmoke 'fresh'
    Uninstall-TestApplication 'fresh-uninstall'
    $installedVersion = $null
    $installAttempted = $false
    # The installer owns and removes its installation tree. Never recursively
    # delete a failed/unknown installation merely to make the next test proceed.
    if (Test-Path -LiteralPath $installRoot) { throw 'Fresh uninstallation left its installation root; inspect before retrying in a new disposable user.' }
    $installAttempted = $true
    Invoke-HiddenProcess $previousInstaller @('--silent', '--installto', $installRoot, '--log', (Join-Path $output 'previous-install.velopack.log')) 'previous-install'
    $installedVersion = $PreviousVersion
    $previousIdentity = Read-InstalledIdentity $installedVersion
    foreach ($profile in $profileRoots) {
        if (Test-Path -LiteralPath $profile) { throw 'Installer unexpectedly created a profile before test sentinel setup.' }
        New-Item -ItemType Directory -Path $profile | Out-Null
        $createdProfiles.Add($profile)
        $sentinel = Join-Path $profile 'installer-acceptance-sentinel.txt'
        [IO.File]::WriteAllText($sentinel, ([Guid]::NewGuid().ToString()), [Text.UTF8Encoding]::new($false))
        $sentinels.Add([pscustomobject]@{path = $sentinel; sha256 = (Get-TcnFileDigest $sentinel).sha256})
    }
    $selectedProfile = Join-Path $env:APPDATA $(if ($identity.channel -eq 'canary') { 'tcn-chat-desktop-canary' } else { 'tcn-chat-desktop' })
    Write-TcnJson (Join-Path $selectedProfile 'settings.json') @{window_behavior = @{showTrayIcon = $false; closeToTray = $false; useNativeTitleBar = $true}}
    Write-TcnJson (Join-Path $selectedProfile 'servers.json') @{selectedOrigin = 'https://chat.server60.the-cantina.net'; customOrigins = @()}
    foreach ($name in @('settings.json', 'servers.json')) { $path = Join-Path $selectedProfile $name; $sentinels.Add([pscustomobject]@{path = $path; sha256 = (Get-TcnFileDigest $path).sha256}) }
    foreach ($partition in @('tcn-main', 'tcn-staging', 'fluxer-official', ('custom-' + ('a' * 64)))) {
        $directory = Assert-TcnChildPath $selectedProfile "Partitions/$partition"
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
        $path = Join-Path $directory 'installer-acceptance-sentinel.txt'
        [IO.File]::WriteAllText($path, ([Guid]::NewGuid().ToString()), [Text.UTF8Encoding]::new($false))
        $sentinels.Add([pscustomobject]@{path = $path; sha256 = (Get-TcnFileDigest $path).sha256})
    }
    $update = Join-Path $installRoot 'Update.exe'
    Invoke-HiddenProcess $update @('--silent', '--rootDir', $installRoot, '--log', (Join-Path $output 'upgrade.velopack.log'), 'apply', '--norestart', '--package', $nupkg) 'upgrade'
    $installedVersion = $identity.version
    $upgradedIdentity = Read-InstalledIdentity $installedVersion
    $upgradeCount = Assert-InstalledPayload
    Assert-Sentinels
    $upgradeStaging = Invoke-InstalledStagingSmoke 'upgraded'
    Assert-Sentinels
    $receipt = [ordered]@{
        schema = 'tcn-desktop-acceptance/v1'; channel = $identity.channel; version = $identity.version
        nupkgSha256 = $candidate.nupkgSha256; installerSha256 = $candidate.installerSha256
        candidateSha256 = (Get-TcnFileDigest $candidatePath).sha256; createdUtc = [DateTime]::UtcNow.ToString('o')
        environment = $(if ($hostedRunner) { 'ephemeral-github-hosted-windows' } else { 'operator-acknowledged-disposable-windows' })
        unsignedTest = [bool]$candidate.unsignedTest
        freshInstall = @{passed = $true; identity = $freshIdentity; payloadFilesVerified = $freshCount; staging = $freshStaging}
        installedUpgrade = @{passed = $true; previousVersion = $PreviousVersion; targetVersion = $identity.version; previousInstallerSha256 = (Get-TcnFileDigest $previousInstaller).sha256; previousIdentity = $previousIdentity; targetIdentity = $upgradedIdentity; payloadFilesVerified = $upgradeCount; profilePreserved = $true; channelIsolated = $true; sentinelFilesVerified = $sentinels.Count}
        staging = $upgradeStaging
        limitations = @('Profile/session preservation uses synthetic sentinels, not authenticated users.', 'The real Update.exe applies a local verified full package; this does not exercise CDN download, automatic background scheduling or an interactive restart prompt.', 'Native renderer acceptance runs the installed payload through the external hidden harness with OS registration suppressed; authenticated voice/capture/passkey acceptance remains separate.')
    }
} catch {
    Write-TcnJson (Join-Path $output 'failure.json') @{schema = 'tcn-desktop-acceptance-failure/v1'; channel = $identity.channel; version = $identity.version; passed = $false; message = $_.Exception.Message; createdUtc = [DateTime]::UtcNow.ToString('o')}
    throw
} finally {
    try {
        if ($installedVersion) { Uninstall-TestApplication 'final-uninstall'; Assert-Sentinels }
        elseif ($installAttempted) { throw 'An incomplete installation needs disposal of the test user/VM; automatic cleanup cannot verify its identity.' }
        foreach ($profile in $createdProfiles) {
            # Each absolute target was absent at entry and created by this run.
            $expected = Assert-TcnChildPath $env:APPDATA ([IO.Path]::GetFileName($profile))
            if ($expected -cne $profile -or -not $profileRoots.Contains($profile)) { throw 'Refusing cleanup outside the owned profile roots.' }
            if (@(Get-ChildItem -LiteralPath $profile -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Refusing profile cleanup with links.' }
            Remove-Item -LiteralPath $profile -Recurse -Force
        }
        Assert-NoTcnRegistration
        $cleanupPassed = $true
    } finally {
        foreach ($item in @(Get-ChildItem Env:)) { if (-not $environmentBefore.ContainsKey($item.Name)) { [Environment]::SetEnvironmentVariable($item.Name, $null, 'Process') } }
        foreach ($name in $environmentBefore.Keys) { [Environment]::SetEnvironmentVariable($name, $environmentBefore[$name], 'Process') }
    }
}
if ($null -eq $receipt -or -not $cleanupPassed) { throw 'Acceptance did not complete cleanly.' }
$receipt.cleanup = @{passed = $true; installerRemoved = $true; ownedProfilesRemoved = $true}
Assert-TcnAcceptance ([pscustomobject]$receipt) $candidate
Write-TcnJson (Join-Path $output 'acceptance.json') $receipt
Write-Output "Passed exact $($identity.channel) $($identity.version) fresh installation, installed upgrade, profile isolation and staging/native smoke."
