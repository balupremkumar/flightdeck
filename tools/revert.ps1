#Requires -Version 7
<#
.SYNOPSIS
  Go back to an earlier Flightdeck version: restore its data backup, then run
  its archived installer.

.DESCRIPTION
  Run this from OUTSIDE Flightdeck (a plain PowerShell 7 window). Installing
  kills every pane, and the app must be closed so its files are not locked.

  1. Refuses to run while Flightdeck is running.
  2. With no -To, lists the versions in releases\archive and the backups that
     exist, then stops.
  3. Picks the backup: -Backup <folder>, else the newest
     backups\<To>-<timestamp> folder. No such backup is an error unless you
     pass -NoRestore (install the old version, keep current data as it is).
  4. Copies the CURRENT state to backups\pre-revert-<timestamp>\ first, so
     the revert can itself be undone (pass that folder as -Backup later).
  5. Replaces the current state with the chosen backup. worktrees\, logs\
     and backups\ are never touched.
  6. Runs releases\archive\<To>\<installer> (interactive; -Silent adds /S).

  Add -WhatIf to see every step without changing anything.

.PARAMETER To
  Version to go back to, e.g. 0.5.4. Must exist in releases\archive.

.PARAMETER Backup
  A specific backup folder (default: newest for -To).

.PARAMETER NoRestore
  Install the old version without restoring any data.

.PARAMETER Silent
  Run the installer silently (/S).

.PARAMETER Force
  Escape hatch for two refusals: a backup without complete.txt (partial copy),
  and an archive folder without SHA256SUMS.txt. A hash MISMATCH is never
  overridden.

.PARAMETER Identifier
  ai.flightdeck.app (stable, default) or ai.flightdeck.canary.

.PARAMETER ReleasesDir
  Releases folder. Default: $env:FLIGHTDECK_RELEASES_DIR, else <repo>\releases.

.PARAMETER AppData
  Overrides %APPDATA% (for testing against a copy).

.PARAMETER LocalAppData
  Overrides %LOCALAPPDATA% (for testing against a copy).

.PARAMETER ProcessName
  Overrides the running-app lookup (for testing).

.EXAMPLE
  pwsh tools\revert.ps1
  pwsh tools\revert.ps1 -To 0.5.4
  pwsh tools\revert.ps1 -To 0.5.4 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$To,
    [string]$Backup,
    [switch]$NoRestore,
    [switch]$Silent,
    [switch]$Force,
    [ValidateSet('ai.flightdeck.app', 'ai.flightdeck.canary')]
    [string]$Identifier = "ai.flightdeck.app",
    [string]$ReleasesDir,
    [string]$AppData,
    [string]$LocalAppData,
    [string]$ProcessName
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "fd-state.ps1")

if (-not $ReleasesDir) { $ReleasesDir = $env:FLIGHTDECK_RELEASES_DIR }
if (-not $ReleasesDir) { $ReleasesDir = Join-Path (Split-Path -Parent $PSScriptRoot) "releases" }
$archiveRoot = Join-Path $ReleasesDir "archive"
$paths = Get-FdPaths -Identifier $Identifier -AppData $AppData -LocalAppData $LocalAppData
$canary = $Identifier -like "*.canary"
$installerPrefix = if ($canary) { "Flightdeck Canary" } else { "Flightdeck" }

function Get-ArchivedVersions {
    if (-not (Test-Path -LiteralPath $archiveRoot)) { return @() }
    Get-ChildItem -LiteralPath $archiveRoot -Directory |
        Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "${installerPrefix}_$($_.Name)_x64-setup.exe") } |
        Sort-Object { [version]$_.Name } -Descending |
        ForEach-Object { $_.Name }
}

function Get-BackupsFor([string]$Version) {
    if (-not (Test-Path -LiteralPath $paths.Backups)) { return @() }
    # Names are <version>-<yyyyMMdd-HHmmss>, so a plain name sort is newest-last.
    Get-ChildItem -LiteralPath $paths.Backups -Directory |
        Where-Object { $_.Name -match "^$([regex]::Escape($Version))-\d{8}-\d{6}$" } |
        Sort-Object Name -Descending
}

# ---- list mode -------------------------------------------------------------
if (-not $To) {
    $versions = @(Get-ArchivedVersions)
    Write-Host "Archived installers in ${archiveRoot}:"
    if ($versions.Count -eq 0) { Write-Host "  (none)" }
    foreach ($v in $versions) {
        $newest = @(Get-BackupsFor $v) | Select-Object -First 1
        $b = if ($newest) { "newest backup: $($newest.Name)" } else { "no backup of that version's data" }
        Write-Host "  $v   ($b)"
    }
    Write-Host ""
    Write-Host "Pick one:  pwsh tools\revert.ps1 -To <version>"
    return
}

# ---- 1. Flightdeck must be closed ------------------------------------------
$running = @(Get-FdRunningProcess -Identifier $Identifier -ProcessName $ProcessName)
if ($running.Count -gt 0) {
    $msg = "Flightdeck is running (pid $($running[0].Id)). Close it completely, then run this again from a plain PowerShell window. Installing kills every pane."
    if ($WhatIfPreference) { Write-Warning "$msg (continuing only because of -WhatIf)" }
    else { throw $msg }
}

# ---- 2. The installer for -To ----------------------------------------------
$installer = Join-Path (Join-Path $archiveRoot $To) "${installerPrefix}_${To}_x64-setup.exe"
if (-not (Test-Path -LiteralPath $installer)) {
    $have = (@(Get-ArchivedVersions) -join ", ")
    if (-not $have) { $have = "none" }
    throw "No archived installer for $To at $installer. Archived versions: $have."
}
# Integrity: the installer must match SHA256SUMS.txt (written at archive time).
$manifest = Join-Path (Split-Path -Parent $installer) "SHA256SUMS.txt"
if (-not (Test-Path -LiteralPath $manifest)) {
    if (-not $Force) {
        throw "No SHA256SUMS.txt next to $installer, so its integrity cannot be checked. Run tools\hash-archive.ps1 if you trust the archive, or pass -Force."
    }
    Write-Warning "-Force: running $installer WITHOUT an integrity check (no SHA256SUMS.txt)."
} else {
    $leafName = Split-Path -Leaf $installer
    $expected = $null
    foreach ($line in Get-Content -LiteralPath $manifest) {
        if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$' -and $Matches[2] -eq $leafName) { $expected = $Matches[1]; break }
    }
    if (-not $expected) {
        if (-not $Force) { throw "$leafName is not listed in $manifest. Pass -Force to run it unchecked." }
        Write-Warning "-Force: running $installer WITHOUT an integrity check (not listed in manifest)."
    } else {
        $actual = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
        if ($actual -ne $expected) {
            throw "Installer hash MISMATCH for $installer (expected $expected, got $actual). The archived file has changed. Refusing to run it."
        }
        Write-Host "  installer SHA256 verified"
    }
}

# ---- 3. Which backup --------------------------------------------------------
$restoreFrom = $null
if (-not $NoRestore) {
    if ($Backup) {
        if (-not (Test-Path -LiteralPath $Backup -PathType Container)) { throw "Backup folder not found: $Backup" }
        $restoreFrom = (Resolve-Path -LiteralPath $Backup).Path.TrimEnd('\', '/')
        # Must be a DIRECT child of this flavour's backups\ folder: that alone
        # rules out Roaming itself, anything else inside Roaming, and Local Storage.
        $backupsRoot = [System.IO.Path]::GetFullPath($paths.Backups).TrimEnd('\', '/')
        $parent = (Split-Path -Parent $restoreFrom).TrimEnd('\', '/')
        if (-not $parent.Equals($backupsRoot, [StringComparison]::OrdinalIgnoreCase)) {
            throw "-Backup must be a folder directly inside $backupsRoot (got $restoreFrom)."
        }
        if ((Get-Item -LiteralPath $restoreFrom -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "-Backup must not be a junction or symlink: $restoreFrom"
        }
    } else {
        $newest = @(Get-BackupsFor $To) | Select-Object -First 1
        if (-not $newest) {
            throw "No backup of version $To in $($paths.Backups). Pass -Backup <folder> to choose one, or -NoRestore to install $To and keep your current data as it is."
        }
        $restoreFrom = $newest.FullName
    }
    if (-not (Test-Path -LiteralPath (Join-Path $restoreFrom "appdata")) -and
        -not (Test-Path -LiteralPath (Join-Path $restoreFrom "local-storage"))) {
        throw "$restoreFrom has neither appdata\ nor local-storage\ - not a backup folder."
    }
    if (-not (Test-Path -LiteralPath (Join-Path $restoreFrom "complete.txt"))) {
        if (-not $Force) {
            throw "$restoreFrom has no complete.txt: it was a partial copy (files were locked) or predates the marker. Restoring it could lose data. Pass -Force to use it anyway."
        }
        Write-Warning "-Force: restoring $restoreFrom even though it has no complete.txt. It may be INCOMPLETE."
    }
}

Write-Host "Reverting $Identifier to $To"
Write-Host "  installer: $installer"
Write-Host "  restore:   $(if ($restoreFrom) { $restoreFrom } else { '(none, -NoRestore)' })"

# ---- 4+5. Move current state aside, restore the backup ---------------------
if ($restoreFrom) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $aside = Join-Path $paths.Backups "pre-revert-$stamp"
    if ($PSCmdlet.ShouldProcess($aside, "Save current state here, then replace it with $restoreFrom")) {
        # Copy first and only delete once the copy is verified complete and
        # non-empty: if anything is off before Clear-FdState, current data is untouched.
        $savedOk = Copy-FdState -Paths $paths -Destination $aside
        if (-not $savedOk -or -not (Test-FdBackupNonEmpty -Folder $aside) -or
            -not (Test-Path -LiteralPath (Join-Path $aside "complete.txt"))) {
            throw "Could not save a complete copy of the current state to $aside (files locked or nothing to copy). Nothing was deleted and the installer was not run."
        }
        Write-Host "  current state saved to $aside"

        $hasApp = Test-Path -LiteralPath (Join-Path $restoreFrom "appdata")
        $hasLs  = Test-Path -LiteralPath (Join-Path $restoreFrom "local-storage")
        try {
            Clear-FdState -Paths $paths -KeepAppData:(-not $hasApp) -KeepLocalStorage:(-not $hasLs)
            if ($hasApp) { Invoke-FdRobocopy -Source (Join-Path $restoreFrom "appdata") -Destination $paths.Roaming | Out-Null }
            if ($hasLs)  { Invoke-FdRobocopy -Source (Join-Path $restoreFrom "local-storage") -Destination $paths.LocalStorage | Out-Null }
        } catch {
            Write-Host ""
            Write-Host "REVERT FAILED PART WAY: $($_.Exception.Message)" -ForegroundColor Red
            Write-Host "Your previous state is safe in:" -ForegroundColor Red
            Write-Host "  $aside" -ForegroundColor Red
            Write-Host "To put it back, close Flightdeck and run:" -ForegroundColor Red
            Write-Host "  pwsh tools\revert.ps1 -To $To -Backup '$aside'" -ForegroundColor Red
            throw "Revert aborted before the installer ran."
        }
        if (-not $hasLs) { Write-Warning "That backup has no local-storage\ (UI settings are left as they are now)." }
        Write-Host "  restored $restoreFrom"
    }
}

# ---- 6. Run the archived installer -----------------------------------------
if ($PSCmdlet.ShouldProcess($installer, "Run installer$(if ($Silent) { ' silently' })")) {
    $startArgs = @{ FilePath = $installer; Wait = $true; PassThru = $true }
    if ($Silent) { $startArgs.ArgumentList = "/S" }
    $proc = Start-Process @startArgs
    if ($proc.ExitCode -ne 0) { throw "Installer exited with code $($proc.ExitCode)." }
    Write-Host "Done. Start Flightdeck; it should report $To."
}
