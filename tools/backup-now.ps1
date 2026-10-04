#Requires -Version 7
<#
.SYNOPSIS
  Manual snapshot of Flightdeck's data, same layout the installer writes.

.DESCRIPTION
  Copies %APPDATA%\<identifier> (except worktrees\, logs\, backups\) and the
  webview's Local Storage into
  %APPDATA%\<identifier>\backups\<version>-<yyyyMMdd-HHmmss>\ .
  <version> is the version the app last ran as (last-version.txt), else "unknown".
  Close Flightdeck first for a clean copy of localStorage (the webview locks
  some of its files while running; locked files are skipped with a warning).

.PARAMETER Identifier
  ai.flightdeck.app (stable, default) or ai.flightdeck.canary.

.PARAMETER AppData
  Overrides %APPDATA% (for testing against a copy).

.PARAMETER LocalAppData
  Overrides %LOCALAPPDATA% (for testing against a copy).

.PARAMETER ProcessName
  Overrides the running-app lookup (for testing).

.EXAMPLE
  pwsh tools\backup-now.ps1
  pwsh tools\backup-now.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateSet('ai.flightdeck.app', 'ai.flightdeck.canary')]
    [string]$Identifier = "ai.flightdeck.app",
    [string]$AppData,
    [string]$LocalAppData,
    [string]$ProcessName
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "fd-state.ps1")

$paths = Get-FdPaths -Identifier $Identifier -AppData $AppData -LocalAppData $LocalAppData
if (-not (Test-Path -LiteralPath $paths.Roaming)) {
    throw "Nothing to back up: $($paths.Roaming) does not exist."
}

if (Get-FdRunningProcess -Identifier $Identifier -ProcessName $ProcessName) {
    Write-Warning "Flightdeck is running. The snapshot still works, but webview files that are locked are skipped. Close Flightdeck first for a clean copy."
}

$version = Get-FdVersionMarker -Roaming $paths.Roaming
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dest = Join-Path $paths.Backups "$version-$stamp"

if ($PSCmdlet.ShouldProcess($dest, "Snapshot $($paths.Roaming) and Local Storage")) {
    $complete = Copy-FdState -Paths $paths -Destination $dest
    if ($complete) { Write-Host "Backup written: $dest" }
    else { Write-Warning "Backup is PARTIAL (no complete.txt): $dest. Close Flightdeck and run this again." }
}
