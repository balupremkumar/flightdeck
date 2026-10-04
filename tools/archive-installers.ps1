#Requires -Version 7
<#
.SYNOPSIS
  Copies release installers into releases\archive\<version>\. Archives are kept
  forever: this script never deletes or overwrites anything.

.DESCRIPTION
  Called by tools/release.ps1 after the build and every gate have passed.
  If releases\archive\<version> already exists it refuses and stops, so an
  archived installer can never be replaced by a rebuild of the same version.

.PARAMETER ReleasesDir
  The releases folder (the one that holds latest.json).

.PARAMETER Version
  X.Y.Z, names the archive subfolder.

.PARAMETER Installer
  Full paths of the installers to archive (stable and canary).

.EXAMPLE
  pwsh tools/archive-installers.ps1 -ReleasesDir .\releases -Version 0.5.5 -Installer a.exe,b.exe -WhatIf
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $true)] [string]$ReleasesDir,
    [Parameter(Mandatory = $true)] [ValidatePattern('^\d+\.\d+\.\d+$')] [string]$Version,
    [Parameter(Mandatory = $true)] [string[]]$Installer
)

$ErrorActionPreference = "Stop"
$dest = Join-Path (Join-Path $ReleasesDir "archive") $Version

if (Test-Path -LiteralPath $dest) {
    throw "Archive for v$Version already exists: $dest. Archived installers are never overwritten or deleted. If this is a genuinely new build, bump the version instead."
}
foreach ($f in $Installer) {
    if (-not (Test-Path -LiteralPath $f)) { throw "Cannot archive, installer not found: $f" }
}

if ($PSCmdlet.ShouldProcess($dest, "Create archive folder and copy $($Installer.Count) installer(s)")) {
    New-Item -ItemType Directory -Path $dest | Out-Null
    foreach ($f in $Installer) {
        $name = Split-Path -Leaf $f
        $target = Join-Path $dest $name
        Copy-Item -LiteralPath $f -Destination $target   # no -Force: never overwrite
        if ((Get-Item -LiteralPath $target).Length -ne (Get-Item -LiteralPath $f).Length) {
            throw "Archive copy is truncated: $target"
        }
        Write-Host "  archived $name -> $dest"
    }
    # SHA256SUMS.txt: revert.ps1 verifies the installer against it before running it.
    & (Join-Path $PSScriptRoot "hash-archive.ps1") -ReleasesDir $ReleasesDir -Version $Version
}
