# SPDX-License-Identifier: AGPL-3.0-or-later
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $Version,
    [Parameter(Mandatory)][ValidateSet('stable', 'canary')][string] $Channel,
    [Parameter(Mandatory)][string] $PackageDirectory,
    [Parameter(Mandatory)][string] $VpkPath,
    [Parameter(Mandatory)][string] $OutputDirectory,
    [switch] $UnsignedTest,
    [string] $SignerThumbprint,
    [string] $TimestampUrl = 'https://timestamp.digicert.com'
)
. "$PSScriptRoot/common.ps1"
if (-not $IsWindows) { throw 'Packaging requires Windows.' }
$identity = Get-TcnReleaseIdentity $Channel $Version
$output = Assert-TcnFreshDirectory $OutputDirectory
$package = (Resolve-Path -LiteralPath $PackageDirectory).Path
$vpk = (Resolve-Path -LiteralPath $VpkPath).Path
$desktop = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../fluxer_desktop'))
if (-not $UnsignedTest -and $SignerThumbprint -notmatch '^[0-9a-fA-F]{40}$') { throw 'Signed packages require -SignerThumbprint; unsigned evaluation requires explicit -UnsignedTest.' }
if ($UnsignedTest -and $SignerThumbprint) { throw 'Choose signed or unsigned evaluation mode, not both.' }
if ($TimestampUrl -notmatch '^https://[a-zA-Z0-9.-]+(?:/[a-zA-Z0-9/_-]*)?$') { throw 'Timestamp URL must be a plain HTTPS endpoint.' }
$vpkVersion = & $vpk -h
if ($LASTEXITCODE -ne 0 -or ($vpkVersion -join "`n") -notmatch 'Velopack CLI 1\.2\.0,') { throw 'Pinned Velopack CLI 1.2.0 is required.' }
if (-not (Test-Path -LiteralPath (Join-Path $package $identity.mainExe))) { throw 'TCN package executable does not match selected channel.' }
if (@(Get-ChildItem -LiteralPath $package -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Package tree must not contain links.' }
New-Item -ItemType Directory -Path $output | Out-Null
$work = Join-Path $output 'work'
$releases = Join-Path $output 'releases'
Copy-Item -LiteralPath $package -Destination $work -Recurse
New-Item -ItemType Directory -Path $releases | Out-Null
$oldVersion = $env:TCN_EXPECT_VERSION; $oldChannel = $env:TCN_EXPECT_CHANNEL
try {
    $env:TCN_EXPECT_VERSION = $Version; $env:TCN_EXPECT_CHANNEL = $Channel
    & node (Join-Path $desktop 'scripts/tcn-inspect-package.cjs') $work (Join-Path $output 'input-inspection.json')
    if ($LASTEXITCODE -ne 0) { throw 'Input package inspection failed.' }
    $argsList = @('--yes', '--skip-updates', 'pack', '--packId', $identity.packageId, '--packVersion', $Version, '--packDir', $work, '--mainExe', $identity.mainExe, '--packTitle', $identity.title, '--packAuthors', 'The Cantina Network', '--aumid', $identity.aumid, '--shortcuts', 'Desktop,StartMenu', '--runtime', 'win-x64', '--icon', (Join-Path $desktop 'build_resources/icons-tcn/icon.ico'), '--outputDir', $releases, '--delta', 'None', '--noPortable')
    if (-not $UnsignedTest) { $argsList += @('--signParams', "/sha1 $SignerThumbprint /fd sha256 /tr $TimestampUrl /td sha256") }
    & $vpk @argsList
    if ($LASTEXITCODE -ne 0) { throw 'Velopack packaging failed.' }
    Complete-TcnCandidate $output $identity ([bool]$UnsignedTest) $SignerThumbprint
} finally { $env:TCN_EXPECT_VERSION = $oldVersion; $env:TCN_EXPECT_CHANNEL = $oldChannel }
