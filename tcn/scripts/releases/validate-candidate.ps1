#requires -Version 7.0
# SPDX-License-Identifier: AGPL-3.0-or-later
# Revalidate frozen vpk output without rebuilding, repacking or changing its bytes.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $Version,
    [Parameter(Mandatory)][ValidateSet('stable', 'canary')][string] $Channel,
    [Parameter(Mandatory)][string] $ReleaseDirectory,
    [Parameter(Mandatory)][string] $OutputDirectory,
    [switch] $UnsignedTest,
    [string] $SignerThumbprint
)
. "$PSScriptRoot/common.ps1"
if (-not $IsWindows) { throw 'Windows candidate validation requires Windows.' }
if (-not $UnsignedTest -and $SignerThumbprint -notmatch '^[0-9a-fA-F]{40}$') { throw 'An explicit signer or unsigned evaluation mode is required.' }
if ($UnsignedTest -and $SignerThumbprint) { throw 'Choose signed or unsigned evaluation mode.' }
$identity = Get-TcnReleaseIdentity $Channel $Version
$output = Assert-TcnFreshDirectory $OutputDirectory
$source = (Resolve-Path -LiteralPath $ReleaseDirectory).Path
$nupkg = Assert-TcnFeed $source $identity
$setups = @(Get-ChildItem -LiteralPath $source -File | Where-Object Name -Like '*-Setup.exe')
if ($setups.Count -ne 1) { throw 'Expected exactly one frozen installer.' }
$names = @('releases.win.json', 'RELEASES', ([IO.Path]::GetFileName($nupkg)), $setups[0].Name)
$digests = @($names | ForEach-Object { Get-TcnFileDigest (Join-Path $source $_) })
$destination = Join-Path $output 'releases'
New-Item -ItemType Directory -Path $destination | Out-Null
foreach ($file in $digests) {
    Copy-Item -LiteralPath (Join-Path $source $file.name) -Destination $destination
    $copied = Get-TcnFileDigest (Join-Path $destination $file.name)
    if ($copied.sha256 -cne $file.sha256 -or $copied.size -ne $file.size) { throw 'Frozen artifact copy readback mismatch.' }
}
Complete-TcnCandidate $output $identity ([bool]$UnsignedTest) $SignerThumbprint
