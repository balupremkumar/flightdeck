#Requires -Version 7
<#
.SYNOPSIS
  Flightdeck release ritual — local-file self-update, no signing, no hosting.

.DESCRIPTION
  Bumps the five version sites, runs the full quality gate (tsc, vitest, cargo
  check + cargo test --lib), builds the NSIS installer via `npm run tauri
  build`, then drops the installer + an updated releases\latest.json into
  releases\ — the folder the running app's Settings > About "Check for
  updates" button reads from (src-tauri/src/updates.rs). Nothing is copied
  anywhere else; nothing is signed; nothing touches kove-site.

  Hard-fails on the first gate that doesn't pass. Run this yourself when
  cutting a release — it is NOT invoked by any agent.

.PARAMETER Version
  New version, e.g. 0.3.1. Applied to package.json, src-tauri/Cargo.toml,
  src-tauri/tauri.conf.json, src/Settings.tsx APP_VERSION, src/version.ts
  APP_VERSION.

.PARAMETER Notes
  Release notes, shown in Settings > About when this version is offered.

.EXAMPLE
  pwsh tools/release.ps1 -Version 0.3.1 -Notes "Fixes the worktree GC race."
#>
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Version,

    [Parameter(Mandatory = $true)]
    [string]$Notes
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($name, [scriptblock]$body) {
    Write-Host ""
    Write-Host "== $name ==" -ForegroundColor Cyan
    & $body
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
        Write-Host "FAILED: $name (exit $LASTEXITCODE)" -ForegroundColor Red
        exit 1
    }
}

function Set-VersionField([string]$path, [string]$pattern, [string]$replacement) {
    # Idempotent: already-at-target is success; only a missing pattern is fatal.
    $raw = Get-Content -Raw $path
    if ($raw -notmatch $pattern) { throw "version pattern not found in $path" }
    $updated = $raw -replace $pattern, $replacement
    if ($updated -ne $raw) { Set-Content -Path $path -Value $updated -NoNewline }
}

function Set-JsonVersion([string]$path, [string]$version) {
    # Only the top-level "version": "..." field — tauri.conf.json also has
    # nested config that must not be touched by a blind replace.
    Set-VersionField $path '(?m)^(\s*"version"\s*:\s*)"[^"]+"' "`${1}`"$version`""
}

function Set-CargoVersion([string]$path, [string]$version) {
    Set-VersionField $path '(?m)^version = "[^"]+"' "version = `"$version`""
}

function Set-TsAppVersion([string]$path, [string]$version) {
    Set-VersionField $path 'export const APP_VERSION = "[^"]+";' "export const APP_VERSION = `"$version`";"
}

Write-Host "Flightdeck release: v$Version" -ForegroundColor Green
Write-Host $Notes

# ---------------------------------------------------------------------------
# 1. Bump the five version sites
# ---------------------------------------------------------------------------
Step "Bump versions" {
    Set-JsonVersion  "package.json"                  $Version
    Set-CargoVersion "src-tauri/Cargo.toml"           $Version
    Set-JsonVersion  "src-tauri/tauri.conf.json"      $Version
    Set-TsAppVersion "src/Settings.tsx"               $Version
    Set-TsAppVersion "src/version.ts"                 $Version
    Write-Host "  package.json, Cargo.toml, tauri.conf.json, Settings.tsx, version.ts -> $Version"
}

# ---------------------------------------------------------------------------
# 2. Full quality gate — hard fail on any of these
# ---------------------------------------------------------------------------
Step "tsc --noEmit" { npx tsc --noEmit }
Step "vitest" { npx vitest run }

$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
Step "cargo check" { cargo check --manifest-path src-tauri/Cargo.toml }
Step "cargo test --lib" { cargo test --manifest-path src-tauri/Cargo.toml --lib }

# ---------------------------------------------------------------------------
# 3. Build — no signing env, this is a local-only installer
# ---------------------------------------------------------------------------
Step "npm run tauri build" { npm run tauri build }

# ---------------------------------------------------------------------------
# 4. Locate the NSIS installer, drop it + latest.json in releases\
# ---------------------------------------------------------------------------
Step "Publish to releases\" {
    $nsisDir = Join-Path $root "src-tauri\target\release\bundle\nsis"
    $installerName = "Flightdeck_${Version}_x64-setup.exe"
    $installerSrc = Join-Path $nsisDir $installerName
    if (-not (Test-Path $installerSrc)) {
        throw "Expected installer not found: $installerSrc (tauri build succeeded but named the artifact differently — check $nsisDir)"
    }

    $releasesDir = Join-Path $root "releases"
    New-Item -ItemType Directory -Force -Path $releasesDir | Out-Null
    Copy-Item -Path $installerSrc -Destination $releasesDir -Force

    $manifest = [ordered]@{
        version   = $Version
        notes     = $Notes
        pub_date  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        installer = $installerName
    }
    $manifestPath = Join-Path $releasesDir "latest.json"
    ($manifest | ConvertTo-Json -Depth 4) | Set-Content -Path $manifestPath -NoNewline

    Write-Host "  $installerName -> $releasesDir"
    Write-Host "  latest.json updated -> $manifestPath"
}

Write-Host ""
Write-Host "== Release v$Version ready ==" -ForegroundColor Green
Write-Host "  releases\Flightdeck_${Version}_x64-setup.exe"
Write-Host "  releases\latest.json"
Write-Host ""
Write-Host "Manual next steps:" -ForegroundColor Yellow
Write-Host "  1. Smoke-test the installer (it upgrades in place over the currently installed copy)."
Write-Host "  2. Commit the version bump (package.json, Cargo.toml, Cargo.lock, tauri.conf.json, Settings.tsx, version.ts) if this repo is under git."
Write-Host "  3. Any other running Flightdeck install on this machine will offer v$Version next time it checks (startup or Settings > About)."
