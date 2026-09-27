#requires -Version 7.0
# SPDX-License-Identifier: AGPL-3.0-or-later
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $Version,
    [Parameter(Mandatory)][ValidateSet('stable', 'canary')][string] $Channel,
    [Parameter(Mandatory)][string] $OutputDirectory,
    [string] $ReleaseConfigPath,
    [switch] $RequireReleaseLineage
)
. "$PSScriptRoot/releases/common.ps1"
if (-not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') { throw 'The native release build requires Windows x64.' }
$identity = Get-TcnReleaseIdentity $Channel $Version
$output = Assert-TcnFreshDirectory $OutputDirectory
$desktop = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../fluxer_desktop'))
$repository = [IO.Path]::GetDirectoryName($desktop)
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$npx = (Get-Command npx.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
if (-not (Test-Path -LiteralPath (Join-Path $desktop 'node_modules/electron-builder'))) { throw 'Install the pinned desktop workspace dependencies with the frozen lockfile first.' }
if ($ReleaseConfigPath) { $ReleaseConfigPath = (Resolve-Path -LiteralPath $ReleaseConfigPath).Path }
# Capture source before generated output exists; verify it again after the build.
New-Item -ItemType Directory -Path $output | Out-Null
$sourceReceipt = Join-Path $output 'source.json'
$lineageArguments = @((Join-Path $PSScriptRoot 'releases/lineage.mjs'), 'inspect', '--repository', $repository, '--version', $Version, '--channel', $Channel, '--output', $sourceReceipt)
if ($RequireReleaseLineage) { $lineageArguments += '--require-release' }
& $node @lineageArguments
if ($LASTEXITCODE -ne 0) { throw 'Source provenance verification failed.' }
$source = Get-Content -LiteralPath $sourceReceipt -Raw | ConvertFrom-Json
if (-not $source.dirty) {
    $sourceArchive = Join-Path $output "tcn-chat-client-$Version-source.zip"
    & git -C $repository archive --format=zip "--output=$sourceArchive" HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Exact source archive failed.' }
    $source | Add-Member -NotePropertyName sourceArchive -NotePropertyValue (Get-TcnFileDigest $sourceArchive)
    Write-TcnJson $sourceReceipt $source
}
# Restore every process-local compiler/build setting, including those added by DevShell.
$environmentBefore = @{}
Get-ChildItem Env: | ForEach-Object { $environmentBefore[$_.Name] = $_.Value }
$buildChannelFile = Join-Path $desktop 'src/common/BuildChannel.ts'
$buildChannelBefore = if (Test-Path -LiteralPath $buildChannelFile) { [IO.File]::ReadAllBytes($buildChannelFile) } else { $null }
$locationBefore = Get-Location
try {
    $cargoBin = Join-Path $env:USERPROFILE '.cargo/bin'
    if (Test-Path -LiteralPath $cargoBin) { $env:PATH = "$cargoBin;$env:PATH" }
    if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
        $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
        if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Microsoft C++ Build Tools are required; no toolchain is installed by this script.' }
        $visualStudioLines = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        $visualStudioExit = $LASTEXITCODE
        $visualStudio = @($visualStudioLines | Select-Object -First 1)[0]
        if ($visualStudioExit -ne 0 -or -not $visualStudio) { throw 'An installed Visual Studio C++ workload is required.' }
        Import-Module (Join-Path $visualStudio 'Common7/Tools/Microsoft.VisualStudio.DevShell.dll')
        Enter-VsDevShell -VsInstallPath $visualStudio -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64' | Out-Null
    }
    $null = Get-Command cargo, cl.exe -CommandType Application -ErrorAction Stop
    $env:RUSTUP_TOOLCHAIN = '1.98.1-x86_64-pc-windows-msvc'
    $env:RUSTUP_AUTO_INSTALL = '0'
    $env:VERSION = $Version
    $env:BUILD_VERSION = $Version
    $env:PUBLIC_BUILD_VERSION = $Version
    $env:BUILD_CHANNEL = $Channel
    $env:RELEASE_CHANNEL = $Channel
    $env:PUBLIC_RELEASE_CHANNEL = $Channel
    $env:TCN_RELEASE_CONFIG_PATH = $ReleaseConfigPath
    $env:TCN_SOURCE_RECEIPT_PATH = $sourceReceipt
    $env:ELECTRON_ARCH = 'x64'
    $env:NODE_ENV = 'production'
    $env:FLUXER_DESKTOP_PRODUCTION = 'true'
    $env:FLUXER_SKIP_NATIVE = $null
    $env:FLUXER_SKIP_NATIVE_PREFLIGHT = $null
    $env:ELECTRON_RUN_AS_NODE = $null
    $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
    $env:TCN_EXPECT_VERSION = $Version
    $env:TCN_EXPECT_CHANNEL = $Channel
    if (-not $env:CARGO_BUILD_JOBS) { $env:CARGO_BUILD_JOBS = '4' }
    if (-not $env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = Join-Path $env:LOCALAPPDATA 'TCNBuild/target' }
    Set-Location -LiteralPath $desktop
    & $npx --yes pnpm@11.27.0 exec node scripts/build.mjs
    if ($LASTEXITCODE -ne 0) { throw 'The full native build failed.' }
    & $npx --yes pnpm@11.27.0 exec tsc --noEmit
    if ($LASTEXITCODE -ne 0) { throw 'Desktop typecheck failed.' }
    & $node --test 'src/tcn/*.test.mjs'
    if ($LASTEXITCODE -ne 0) { throw 'TCN unit tests failed.' }
    & $npx --yes pnpm@11.27.0 exec electron-builder --config electron-builder.config.cjs --win --x64 --dir --publish never "--config.directories.output=$output"
    if ($LASTEXITCODE -ne 0) { throw 'Native application packaging failed.' }
    $package = Join-Path $output 'win-unpacked'
    $inspection = Join-Path $output 'inspection.json'
    & $node scripts/tcn-inspect-package.cjs $package $inspection
    if ($LASTEXITCODE -ne 0) { throw 'Packaged native payload inspection failed.' }
    $env:TCN_SMOKE_PACKAGE = Join-Path $package 'resources/app.asar'
    $env:TCN_SMOKE_OUTPUT = Join-Path $output 'native-probe'
    $env:ELECTRON_RUN_AS_NODE = '1'
    $probeScript = Join-Path $desktop 'scripts/tcn-probe-native.cjs'
    $probeProcess = Start-Process -FilePath (Join-Path $package $identity.mainExe) -ArgumentList ('"' + $probeScript + '"') -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $output 'native-probe.stdout.log') -RedirectStandardError (Join-Path $output 'native-probe.stderr.log')
    if ($probeProcess.ExitCode -ne 0) { throw 'The packaged executable cannot load every required native module.' }
    $probe = Get-Content -LiteralPath (Join-Path $env:TCN_SMOKE_OUTPUT 'native-modules.json') -Raw | ConvertFrom-Json
    if ($probe.platform -cne 'win32' -or $probe.arch -cne 'x64' -or @($probe.nativeModules).Count -ne 9 -or @($probe.nativeModules | Where-Object loaded -NE $true).Count) { throw 'Native probe receipt is incomplete.' }
    if ($null -ne $buildChannelBefore) { [IO.File]::WriteAllBytes($buildChannelFile, $buildChannelBefore) }
    & $node (Join-Path $PSScriptRoot 'releases/lineage.mjs') check-unchanged --repository $repository --receipt $sourceReceipt
    if ($LASTEXITCODE -ne 0) { throw 'Source changed during the native build.' }
    $releaseDigest = if ($ReleaseConfigPath) { (Get-TcnFileDigest $ReleaseConfigPath).sha256 } else { $null }
    Write-TcnJson (Join-Path $output 'build.json') ([ordered]@{
        schema = 'tcn-desktop-build/v1'; channel = $Channel; version = $Version; packageId = $identity.packageId
        upstreamRevision = $source.upstream.commit; sourceRevision = $source.sourceRevision
        sourceFingerprint = $source.sourceFingerprint; sourceProvenanceSha256 = (Get-TcnFileDigest $sourceReceipt).sha256
        releaseLineageVerified = $source.releaseReady; releaseConfigSha256 = $releaseDigest
        inspectionSha256 = (Get-TcnFileDigest $inspection).sha256
        nativeProbeSha256 = (Get-TcnFileDigest (Join-Path $env:TCN_SMOKE_OUTPUT 'native-modules.json')).sha256
        completeNativeBuild = $true; createdUtc = [DateTime]::UtcNow.ToString('o')
        limitation = 'Unpacked build verification only; installer, staging and installed upgrade acceptance are separate.'
    })
    Write-Output "Verified native $Channel $Version payload: $package"
} finally {
    Set-Location -LiteralPath $locationBefore
    if ($null -ne $buildChannelBefore) { [IO.File]::WriteAllBytes($buildChannelFile, $buildChannelBefore) }
    foreach ($item in @(Get-ChildItem Env:)) { if (-not $environmentBefore.ContainsKey($item.Name)) { [Environment]::SetEnvironmentVariable($item.Name, $null, 'Process') } }
    foreach ($name in $environmentBefore.Keys) { [Environment]::SetEnvironmentVariable($name, $environmentBefore[$name], 'Process') }
}
