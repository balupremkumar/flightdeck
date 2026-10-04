# fd-state.ps1 - shared helpers for tools\backup-now.ps1 and tools\revert.ps1.
# Dot-source it: . (Join-Path $PSScriptRoot "fd-state.ps1")
#
# Backup layout (the same one the installer's pre-install hook writes, see
# src-tauri/windows/hooks.nsh):
#
#   %APPDATA%\<identifier>\backups\<version>-<yyyyMMdd-HHmmss>\
#       appdata\        everything in %APPDATA%\<identifier> except worktrees\, logs\, backups\
#       local-storage\  %LOCALAPPDATA%\<identifier>\EBWebView\Default\Local Storage
#
# <identifier> is ai.flightdeck.app (stable) or ai.flightdeck.canary.

$script:FdExcluded = @("worktrees", "logs", "backups")

function Get-FdPaths {
    param(
        [string]$Identifier = "ai.flightdeck.app",
        [string]$AppData,
        [string]$LocalAppData
    )
    if (-not $AppData) { $AppData = $env:APPDATA }
    if (-not $LocalAppData) { $LocalAppData = $env:LOCALAPPDATA }
    if (-not $AppData -or -not $LocalAppData) { throw "APPDATA / LOCALAPPDATA are not set" }
    $roaming = Join-Path $AppData $Identifier
    [pscustomobject]@{
        Identifier   = $Identifier
        Roaming      = $roaming
        Backups      = Join-Path $roaming "backups"
        LocalStorage = Join-Path $LocalAppData "$Identifier\EBWebView\Default\Local Storage"
    }
}

# Version the app last ran as (last-version.txt, written by the app on every
# startup). "unknown" when absent or not a plain version string.
function Get-FdVersionMarker {
    param([Parameter(Mandatory = $true)] [string]$Roaming)
    $f = Join-Path $Roaming "last-version.txt"
    if (-not (Test-Path -LiteralPath $f)) { return "unknown" }
    $v = (Get-Content -LiteralPath $f -Raw -ErrorAction SilentlyContinue)
    if ($null -eq $v) { return "unknown" }
    $v = $v.Trim()
    if ($v -match '^\d+\.\d+\.\d+$') { return $v }
    return "unknown"
}

# Is this flavour of Flightdeck running? The exe is named after the cargo
# crate (projectsactivefd-scaffold.exe) for BOTH flavours, so the two are told
# apart by install path ("Flightdeck Canary" vs "Flightdeck"). A dev build of
# the same crate counts as running for stable: it shares stable's app data.
# -ProcessName overrides the lookup (used by tests).
function Get-FdRunningProcess {
    param([string]$Identifier = "ai.flightdeck.app", [string]$ProcessName)
    if ($ProcessName) {
        return @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)
    }
    $canary = $Identifier -like "*.canary"
    @(Get-Process -Name "projectsactivefd-scaffold", "Flightdeck", "Flightdeck Canary" -ErrorAction SilentlyContinue |
        Where-Object {
            $p = $null
            try { $p = $_.Path } catch { }
            $isCanaryExe = ($p -and $p -like "*Flightdeck Canary*") -or $_.ProcessName -eq "Flightdeck Canary"
            if ($canary) { $isCanaryExe } else { -not $isCanaryExe }
        })
}

function Invoke-FdRobocopy {
    param([string]$Source, [string]$Destination, [string[]]$ExcludeDirs = @())
    $argList = @($Source, $Destination, "/E", "/R:0", "/W:0", "/NFL", "/NDL", "/NJH", "/NJS", "/NP")
    if ($ExcludeDirs.Count -gt 0) { $argList += "/XD"; $argList += $ExcludeDirs }
    & robocopy @argList | Out-Null
    # robocopy: 0-7 are success (bit flags for what was copied), 8+ is failure.
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE): $Source -> $Destination" }
}

# Snapshot current state to $Destination (appdata\ + local-storage\).
function Copy-FdState {
    param([Parameter(Mandatory = $true)] $Paths, [Parameter(Mandatory = $true)] [string]$Destination)
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    $exclude = $script:FdExcluded | ForEach-Object { Join-Path $Paths.Roaming $_ }
    if (Test-Path -LiteralPath $Paths.Roaming) {
        Invoke-FdRobocopy -Source $Paths.Roaming -Destination (Join-Path $Destination "appdata") -ExcludeDirs $exclude
    }
    if (Test-Path -LiteralPath $Paths.LocalStorage) {
        Invoke-FdRobocopy -Source $Paths.LocalStorage -Destination (Join-Path $Destination "local-storage")
    }
}

# Delete current state in place (everything Copy-FdState copies, nothing else:
# worktrees\, logs\ and backups\ are never touched).
function Clear-FdState {
    param([Parameter(Mandatory = $true)] $Paths, [switch]$KeepLocalStorage, [switch]$KeepAppData)
    if (-not $KeepAppData -and (Test-Path -LiteralPath $Paths.Roaming)) {
        Get-ChildItem -LiteralPath $Paths.Roaming -Force |
            Where-Object { $script:FdExcluded -notcontains $_.Name } |
            Remove-Item -Recurse -Force
    }
    if (-not $KeepLocalStorage -and (Test-Path -LiteralPath $Paths.LocalStorage)) {
        Get-ChildItem -LiteralPath $Paths.LocalStorage -Force | Remove-Item -Recurse -Force
    }
}
