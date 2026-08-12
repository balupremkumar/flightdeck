# boot-gate.ps1 — the release E2E gate (deployment rework, phase 3).
#
# The v0.5.3 cut passed every unit suite and a window-visibility probe, then
# died on the user's machine because it booted against REAL migrated state and
# crashed inside the UI — a state no pre-release check had ever exercised.
# This gate closes that hole: it boots the just-built CANARY binary against a
# fresh clone of stable's real app data (canary clones it on first boot, see
# src-tauri/src/canary.rs) and requires proof of a healthy boot from the
# flight recorder:
#
#   1. the process is still alive after $WaitSeconds,
#   2. the canary log contains the "boot-ok" beacon (Cockpit.tsx writes it
#      only when the UI actually mounted — an ErrorBoundary boot never does),
#   3. the canary log contains no error entries.
#
# Canary app data is wiped before AND after: canary trial state is ephemeral
# per release by design, so the user's next real canary boot re-clones fresh.
# Stable's data is only ever READ (by the clone); the gate refuses to run at
# all unless the built exe really is the canary flavour.
#
# Run standalone: pwsh tools/boot-gate.ps1  (after a canary build)
# Run as part of a cut: tools/release.ps1 calls this after the canary build.

param(
    [int]$WaitSeconds = 12
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

# The binary the canary build just produced. Cargo may or may not rename it to
# the product name depending on tauri version; check both, newest wins.
$candidates = @("projectsactivefd-scaffold.exe", "Flightdeck.exe", "Flightdeck Canary.exe") |
    ForEach-Object { Join-Path $root "src-tauri\target\release\$_" } |
    Where-Object { Test-Path -LiteralPath $_ }
if (-not $candidates) { throw "boot gate: no built app exe in src-tauri\target\release — run the canary build first" }
$exe = ($candidates | Get-Item | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName

# HARD safety gate: the exe must be the canary flavour. A stable-flavoured exe
# would boot against the user's REAL app data and autosave into it.
$product = (Get-Item -LiteralPath $exe).VersionInfo.ProductName
if ($product -ne "Flightdeck Canary") {
    throw "boot gate: built exe's ProductName is '$product', not 'Flightdeck Canary' — the canary build must be the LAST build before the gate. Refusing to boot it."
}

$canaryRoaming = Join-Path $env:APPDATA "ai.flightdeck.canary"
$canaryLocal   = Join-Path $env:LOCALAPPDATA "ai.flightdeck.canary"
$logPath       = Join-Path $canaryRoaming "logs\flightdeck.log"

# Refuse to fight a live canary.
$running = Get-Process -ErrorAction SilentlyContinue | Where-Object {
    try { $_.MainWindowTitle -like "Flightdeck Canary*" } catch { $false }
}
if ($running) { throw "boot gate: a Flightdeck Canary instance is running — close it first" }

function Clear-CanaryState {
    foreach ($d in @($canaryRoaming, $canaryLocal)) {
        if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Clear-CanaryState
Write-Host "boot gate: launching $exe (waiting ${WaitSeconds}s)..."
$proc = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds $WaitSeconds

$alive = $proc -and -not $proc.HasExited
$log = if (Test-Path -LiteralPath $logPath) { Get-Content -Raw -LiteralPath $logPath } else { "" }

if ($alive) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }

# Judge from the evidence, with the log tail printed on any failure.
$failures = @()
if (-not $alive) { $failures += "process exited before ${WaitSeconds}s" }
if ($log -notmatch "boot-ok") { $failures += "no boot-ok beacon in the flight recorder (UI never mounted — ErrorBoundary boot?)" }
$errorLines = ($log -split "`n") | Where-Object { $_ -match "^\d{4}-\d{2}-\d{2}T\S+ E " }
if ($errorLines) { $failures += "error entries in the flight recorder:`n    " + ($errorLines -join "`n    ") }

if ($failures.Count -gt 0) {
    if ($log) {
        Write-Host "boot gate: flight recorder tail:" -ForegroundColor Yellow
        ($log -split "`n" | Select-Object -Last 40) | ForEach-Object { Write-Host "  $_" }
    }
    Clear-CanaryState
    throw "BOOT GATE FAILED: " + ($failures -join "; ")
}

Clear-CanaryState
Write-Host "boot gate: PASSED (booted against cloned stable state, UI mounted, no errors logged)" -ForegroundColor Green
