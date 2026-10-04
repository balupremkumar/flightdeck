#Requires -Version 7
<#
.SYNOPSIS
  Writes SHA256SUMS.txt into releases\archive\<version>\ folders that lack one.

.DESCRIPTION
  revert.ps1 verifies an archived installer against SHA256SUMS.txt before it
  runs it. archive-installers.ps1 writes the manifest for new archives; run
  this once to backfill the older folders. It only ever ADDS a file: an
  existing SHA256SUMS.txt is left alone and no installer is touched.
  Format: "<sha256>  <file name>" per line (sha256sum style).

.PARAMETER ReleasesDir
  The releases folder (the one that holds archive\).

.PARAMETER Version
  Only this version's folder (default: every X.Y.Z folder).

.EXAMPLE
  pwsh tools\hash-archive.ps1 -ReleasesDir .\releases
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $true)] [string]$ReleasesDir,
    [ValidatePattern('^\d+\.\d+\.\d+$')] [string]$Version
)

$ErrorActionPreference = "Stop"
$root = Join-Path $ReleasesDir "archive"
if (-not (Test-Path -LiteralPath $root)) { throw "No archive folder: $root" }

$dirs = @(Get-ChildItem -LiteralPath $root -Directory | Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' })
if ($Version) { $dirs = @($dirs | Where-Object { $_.Name -eq $Version }) }
foreach ($d in $dirs) {
    $manifest = Join-Path $d.FullName "SHA256SUMS.txt"
    if (Test-Path -LiteralPath $manifest) { Write-Host "  $($d.Name): SHA256SUMS.txt exists, left alone"; continue }
    $exes = @(Get-ChildItem -LiteralPath $d.FullName -File -Filter "*.exe")
    if ($exes.Count -eq 0) { Write-Host "  $($d.Name): no installers, skipped"; continue }
    if ($PSCmdlet.ShouldProcess($manifest, "Write SHA256SUMS.txt for $($exes.Count) installer(s)")) {
        $lines = foreach ($e in $exes) { "{0}  {1}" -f (Get-FileHash -LiteralPath $e.FullName -Algorithm SHA256).Hash.ToLower(), $e.Name }
        Set-Content -LiteralPath $manifest -Value $lines
        Write-Host "  $($d.Name): wrote SHA256SUMS.txt"
        $lines | ForEach-Object { Write-Host "      $_" }
    }
}
