# fd-state.ps1 - shared helpers for tools\backup-now.ps1 and tools\revert.ps1.
# Dot-source it: . (Join-Path $PSScriptRoot "fd-state.ps1")
#
# Backup layout (the same one the installer's pre-install hook writes, see
# src-tauri/windows/hooks.nsh):
#
#   %APPDATA%\<identifier>\backups\<version>-<yyyyMMdd-HHmmss>\
#       appdata\        everything in %APPDATA%\<identifier> except worktrees\, logs\, backups\
#       local-storage\  %LOCALAPPDATA%\<identifier>\EBWebView\Default\Local Storage
#       complete.txt    written only when every robocopy finished cleanly (< 8)
#
# <identifier> is ai.flightdeck.app (stable) or ai.flightdeck.canary.

$script:FdExcluded = @("worktrees", "logs", "backups")

function Get-FdPaths {
    param(
        [ValidateSet('ai.flightdeck.app', 'ai.flightdeck.canary')]
        [string]$Identifier = "ai.flightdeck.app",
        [string]$AppData,
        [string]$LocalAppData
    )
    if (-not $AppData) { $AppData = $env:APPDATA }
    if (-not $LocalAppData) { $LocalAppData = $env:LOCALAPPDATA }
    if (-not $AppData -or -not $LocalAppData) { throw "APPDATA / LOCALAPPDATA are not set" }
    $sep = [System.IO.Path]::DirectorySeparatorChar
    $bases = @{}
    foreach ($pair in @(@("AppData", $AppData), @("LocalAppData", $LocalAppData))) {
        if (-not (Test-Path -LiteralPath $pair[1] -PathType Container)) {
            throw "$($pair[0]) is not an existing directory: $($pair[1])"
        }
        $full = [System.IO.Path]::GetFullPath($pair[1]).TrimEnd($sep)
        if ([System.IO.Path]::GetPathRoot($full + $sep).TrimEnd($sep) -eq $full) {
            throw "$($pair[0]) must not be a drive root: $full"
        }
        $bases[$pair[0]] = $full
    }
    $roaming = [System.IO.Path]::GetFullPath((Join-Path $bases.AppData $Identifier))
    $localStorage = [System.IO.Path]::GetFullPath((Join-Path $bases.LocalAppData "$Identifier\EBWebView\Default\Local Storage"))
    if (-not $roaming.StartsWith($bases.AppData + $sep, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Roaming path escapes AppData: $roaming"
    }
    if (-not $localStorage.StartsWith($bases.LocalAppData + $sep, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Local Storage path escapes LocalAppData: $localStorage"
    }
    [pscustomobject]@{
        Identifier   = $Identifier
        Roaming      = $roaming
        Backups      = Join-Path $roaming "backups"
        LocalStorage = $localStorage
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

# Returns robocopy's exit code. 0-7 are success (bit flags for what was
# copied), 8+ is failure: thrown unless -AllowPartial (caller checks the code).
# /XJ: never follow junctions.
function Invoke-FdRobocopy {
    param([string]$Source, [string]$Destination, [string[]]$ExcludeDirs = @(), [switch]$AllowPartial)
    $argList = @($Source, $Destination, "/E", "/R:0", "/W:0", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/XJ")
    if ($ExcludeDirs.Count -gt 0) { $argList += "/XD"; $argList += $ExcludeDirs }
    & robocopy @argList | Out-Null
    $code = $LASTEXITCODE
    if ($code -ge 8 -and -not $AllowPartial) { throw "robocopy failed ($code): $Source -> $Destination" }
    return $code
}

# Snapshot current state to $Destination (appdata\ + local-storage\).
# Writes complete.txt (version + timestamp) only when every robocopy returned
# < 8. Locked files (app running) make robocopy return 8+: the copy is then
# partial, no marker is written, a warning is printed, and $false is returned.
function Copy-FdState {
    param([Parameter(Mandatory = $true)] $Paths, [Parameter(Mandatory = $true)] [string]$Destination)
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    $exclude = $script:FdExcluded | ForEach-Object { Join-Path $Paths.Roaming $_ }
    $complete = $true
    if (Test-Path -LiteralPath $Paths.Roaming) {
        $c = Invoke-FdRobocopy -Source $Paths.Roaming -Destination (Join-Path $Destination "appdata") -ExcludeDirs $exclude -AllowPartial
        if ($c -ge 8) { $complete = $false }
    }
    if (Test-Path -LiteralPath $Paths.LocalStorage) {
        $c = Invoke-FdRobocopy -Source $Paths.LocalStorage -Destination (Join-Path $Destination "local-storage") -AllowPartial
        if ($c -ge 8) { $complete = $false }
    }
    if ($complete) {
        $version = Get-FdVersionMarker -Roaming $Paths.Roaming
        Set-Content -LiteralPath (Join-Path $Destination "complete.txt") -Value @("version=$version", "timestamp=$(Get-Date -Format o)")
    } else {
        Write-Warning "PARTIAL backup (some files were locked or unreadable): $Destination. No complete.txt written; revert.ps1 will refuse it without -Force."
    }
    return $complete
}

# True when $Folder holds at least one file under appdata\ or local-storage\.
function Test-FdBackupNonEmpty {
    param([Parameter(Mandatory = $true)] [string]$Folder)
    foreach ($sub in "appdata", "local-storage") {
        $d = Join-Path $Folder $sub
        if ((Test-Path -LiteralPath $d) -and
            (Get-ChildItem -LiteralPath $d -Recurse -File -Force -ErrorAction SilentlyContinue | Select-Object -First 1)) { return $true }
    }
    return $false
}

# Delete current state in place (everything Copy-FdState copies, nothing else:
# worktrees\, logs\ and backups\ are never touched).
function Clear-FdState {
    param([Parameter(Mandatory = $true)] $Paths, [switch]$KeepLocalStorage, [switch]$KeepAppData)
    # Belt and braces: never delete unless the paths look exactly like ours.
    $leaf = Split-Path -Leaf $Paths.Roaming
    if (@('ai.flightdeck.app', 'ai.flightdeck.canary') -notcontains $leaf) {
        throw "Refusing to clear: $($Paths.Roaming) is not a Flightdeck data folder."
    }
    if (-not $Paths.LocalStorage.EndsWith("\$leaf\EBWebView\Default\Local Storage", [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clear: $($Paths.LocalStorage) is not a Flightdeck Local Storage folder."
    }
    if (-not $KeepAppData -and (Test-Path -LiteralPath $Paths.Roaming)) {
        Get-ChildItem -LiteralPath $Paths.Roaming -Force |
            Where-Object { $script:FdExcluded -notcontains $_.Name } |
            Remove-Item -Recurse -Force
    }
    if (-not $KeepLocalStorage -and (Test-Path -LiteralPath $Paths.LocalStorage)) {
        Get-ChildItem -LiteralPath $Paths.LocalStorage -Force | Remove-Item -Recurse -Force
    }
}
