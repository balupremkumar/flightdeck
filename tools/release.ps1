#Requires -Version 7
<#
.SYNOPSIS
  Flightdeck release ritual — local-file self-update, no signing, no hosting.

.DESCRIPTION
  Bumps the five version sites, runs the full quality gate (tsc, vitest, cargo
  check + cargo test --lib), builds the NSIS installer via `npm run tauri
  build`, drops the installer + an updated releases\latest.json into
  releases\ - the folder the running app's Settings > About "Check for
  updates" button reads from (src-tauri/src/updates.rs) - and then VERIFIES
  what it just published (installer whole, real PE, binary version matches the
  requested version, latest.json parses and agrees with itself, signature
  status reported). Nothing is copied anywhere else; nothing is signed
  (docs/SIGNING.md); nothing touches kove-site.

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

# Pane-mount smoke (the 0.5.3 lesson): vitest mocks xterm and the boot gate
# stalls on the restore prompt before any pane mounts, so neither exercises a
# real terminal construct. This does, in a real browser. Reuses an already
# running dev server on :1420; otherwise starts one and kills its whole tree.
Step "Pane-mount smoke" {
    $ownServer = $null
    $portUp = { (Test-NetConnection -ComputerName localhost -Port 1420 -InformationLevel Quiet -WarningAction SilentlyContinue) }
    if (-not (& $portUp)) {
        # npm is npm.cmd on Windows — Start-Process can't spawn a .cmd shim
        # directly, so go through cmd.exe; taskkill /T below kills the tree.
        $ownServer = Start-Process cmd.exe -ArgumentList "/d", "/c", "npm run dev" -WorkingDirectory $root -WindowStyle Hidden -PassThru
        $deadline = (Get-Date).AddSeconds(60)
        while (-not (& $portUp)) {
            if ((Get-Date) -gt $deadline) { Write-Host "dev server never came up on :1420" -ForegroundColor Red; exit 1 }
            Start-Sleep -Milliseconds 500
        }
    }
    try {
        Push-Location (Join-Path $root "demo")
        node pane-smoke.mjs
        $smokeExit = $LASTEXITCODE
        Pop-Location
    } finally {
        if ($ownServer) { taskkill /T /F /PID $ownServer.Id | Out-Null }
    }
    if ($smokeExit -ne 0) { exit 1 }
}

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

    # sha256 of the exact bytes that were published. Not verified by the app
    # (that would need a hashing crate in updates.rs - see docs/SIGNING.md,
    # "cheap partial wins"); it is here so a suspect installer can be checked
    # by hand: Get-FileHash releases\<name> -Algorithm SHA256.
    $published = Join-Path $releasesDir $installerName
    $sha = (Get-FileHash -LiteralPath $published -Algorithm SHA256).Hash.ToLower()

    $manifest = [ordered]@{
        version   = $Version
        notes     = $Notes
        pub_date  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        installer = $installerName
        sha256    = $sha
    }
    $manifestPath = Join-Path $releasesDir "latest.json"
    ($manifest | ConvertTo-Json -Depth 4) | Set-Content -Path $manifestPath -NoNewline

    Write-Host "  $installerName -> $releasesDir"
    Write-Host "  latest.json updated -> $manifestPath"
    Write-Host "  sha256 $sha"
}

# ---------------------------------------------------------------------------
# 5. Verify what was actually published
#
# A release that is broken in any of these ways would otherwise be discovered
# by the in-app updater, on the user's machine, mid-install. The app's own
# pre-flight (src-tauri/src/updates.rs) re-checks the cheap ones at run time;
# this is where a bad cut is supposed to die.
# ---------------------------------------------------------------------------
Step "Verify release output" {
    $releasesDir  = Join-Path $root "releases"
    $installerName = "Flightdeck_${Version}_x64-setup.exe"
    $published    = Join-Path $releasesDir $installerName
    $source       = Join-Path $root "src-tauri\target\release\bundle\nsis\$installerName"

    # 1. It exists, and the copy landed whole.
    if (-not (Test-Path -LiteralPath $published)) { throw "installer missing from releases\: $published" }
    $pubLen = (Get-Item -LiteralPath $published).Length
    $srcLen = (Get-Item -LiteralPath $source).Length
    if ($pubLen -ne $srcLen) { throw "copy is truncated: releases\ has $pubLen bytes, build output has $srcLen" }
    # updates.rs refuses anything under 512 KB; fail here first, with context.
    if ($pubLen -lt 512KB) { throw "installer is only $pubLen bytes - that is not a real build" }

    # 2. It is a Windows executable (the same MZ probe the app's pre-flight does).
    $head = Get-Content -LiteralPath $published -AsByteStream -TotalCount 2
    if ($head[0] -ne 0x4D -or $head[1] -ne 0x5A) { throw "installer does not start with the MZ header - it is corrupt" }

    # 3. The BINARY really is the version that was asked for - not just the
    #    file name. This is what catches "tauri build no-op'd and re-published
    #    yesterday's exe under today's name", which the app cannot detect
    #    (its own pre-flight can only read the file name).
    $setupInfo = (Get-Item -LiteralPath $published).VersionInfo
    $setupVer  = $setupInfo.FileVersion
    if (-not $setupVer) { $setupVer = $setupInfo.ProductVersion }
    if ($setupVer) {
        if ($setupVer.Trim() -notlike "$Version*") {
            throw "installer's version resource is '$setupVer' but this release claims $Version - a stale build was published"
        }
        Write-Host "  installer version resource: $setupVer"
    } else {
        # No VERSIONINFO on the NSIS wrapper (shouldn't happen - tauri stamps
        # it) - fall back to the built app binary. Cargo names it after the
        # crate, tauri may rename it to productName, so try both.
        $candidates = @("Flightdeck.exe", "projectsactivefd-scaffold.exe") |
            ForEach-Object { Join-Path $root "src-tauri\target\release\$_" } |
            Where-Object { Test-Path -LiteralPath $_ }
        if (-not $candidates) { throw "installer has no version resource and no built app exe was found to check instead" }
        $appVer = (Get-Item -LiteralPath $candidates[0]).VersionInfo.FileVersion
        if (-not $appVer) { throw "neither the installer nor $($candidates[0]) carries a version resource - cannot verify what was built" }
        if ($appVer.Trim() -notlike "$Version*") {
            throw "built app exe is version '$appVer' but this release claims $Version - a stale build was published"
        }
        Write-Host "  app binary version: $appVer (installer carries none)"
    }

    # 4. latest.json parses, agrees with itself, and points at a file that is there.
    $manifestPath = Join-Path $releasesDir "latest.json"
    try { $m = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json }
    catch { throw "latest.json does not parse: $_" }
    if ($m.version -ne $Version) { throw "latest.json says version $($m.version), expected $Version" }
    if ($m.installer -ne $installerName) { throw "latest.json points at $($m.installer), expected $installerName" }
    if ($m.installer -match '[\\/:]' ) { throw "latest.json installer must be a bare file name, got $($m.installer)" }
    if (-not (Test-Path -LiteralPath (Join-Path $releasesDir $m.installer))) { throw "latest.json points at a missing file" }
    if (-not $m.notes) { throw "latest.json has no notes - Settings > About would show an empty what's-new" }
    $reHash = (Get-FileHash -LiteralPath $published -Algorithm SHA256).Hash.ToLower()
    if ($m.sha256 -ne $reHash) { throw "latest.json sha256 does not match the published installer" }
    Write-Host "  latest.json verified (version, installer, notes, sha256)"

    # 5. Signing status. Not fatal - this project ships unsigned on purpose
    #    today - but it must never be a silent fact. See docs/SIGNING.md.
    $sig = $null
    try { $sig = Get-AuthenticodeSignature -LiteralPath $published } catch { }
    if (-not $sig) {
        Write-Host "  signature: could not be checked on this host (Microsoft.PowerShell.Security unavailable)." -ForegroundColor Yellow
    } elseif ($sig.Status -eq "Valid") {
        Write-Host "  signature: Valid ($($sig.SignerCertificate.Subject))" -ForegroundColor Green
    } else {
        Write-Host "  signature: $($sig.Status) - this installer is UNSIGNED." -ForegroundColor Yellow
        Write-Host "    Windows Defender can block the silent (/S) install with no visible error." -ForegroundColor Yellow
        Write-Host "    The app now reports that on the next launch; see docs/SIGNING.md for the fix." -ForegroundColor Yellow
    }
}

# ---------------------------------------------------------------------------
# 6. Canary flavour (deployment rework, phase 2): same code, different
#    identity ("Flightdeck Canary" / ai.flightdeck.canary), so it installs
#    SIDE BY SIDE with stable instead of overwriting it. This is the build
#    that gets trialled first; stable is only installed once canary proves
#    out. latest.json never references it (canary never self-updates).
# ---------------------------------------------------------------------------
Step "npm run tauri build (canary)" { npm run tauri build -- --config src-tauri/tauri.canary.conf.json }

Step "Publish + verify canary installer" {
    $nsisDir       = Join-Path $root "src-tauri\target\release\bundle\nsis"
    $canaryName    = "Flightdeck Canary_${Version}_x64-setup.exe"
    $canarySrc     = Join-Path $nsisDir $canaryName
    if (-not (Test-Path -LiteralPath $canarySrc)) {
        throw "Expected canary installer not found: $canarySrc (check $nsisDir for what the build named it)"
    }
    $releasesDir = Join-Path $root "releases"
    Copy-Item -LiteralPath $canarySrc -Destination $releasesDir -Force
    $published = Join-Path $releasesDir $canaryName

    if ((Get-Item -LiteralPath $published).Length -lt 512KB) { throw "canary installer is implausibly small" }
    $head = Get-Content -LiteralPath $published -AsByteStream -TotalCount 2
    if ($head[0] -ne 0x4D -or $head[1] -ne 0x5A) { throw "canary installer does not start with the MZ header" }
    $ver = (Get-Item -LiteralPath $published).VersionInfo.FileVersion
    if ($ver -and $ver.Trim() -notlike "$Version*") { throw "canary installer version resource is '$ver', expected $Version" }
    Write-Host "  $canaryName -> $releasesDir"
}

# ---------------------------------------------------------------------------
# 7. Boot gate: the canary binary must boot AGAINST A CLONE OF REAL STATE and
#    prove a healthy UI mount via the flight recorder. This is the check that
#    would have caught the v0.5.3 launch failure before it shipped. Runs on
#    the canary flavour by construction (its own identifier), so the user's
#    stable app data is never touched.
# ---------------------------------------------------------------------------
Step "Boot gate (canary vs cloned real state)" { & (Join-Path $root "tools\boot-gate.ps1") }

Write-Host ""
Write-Host "== Release v$Version ready ==" -ForegroundColor Green
Write-Host "  releases\Flightdeck_${Version}_x64-setup.exe          (stable - the promotion artifact)"
Write-Host "  releases\Flightdeck Canary_${Version}_x64-setup.exe   (canary - install THIS first)"
Write-Host "  releases\latest.json"
Write-Host ""
Write-Host "Manual next steps:" -ForegroundColor Yellow
Write-Host "  1. Install the CANARY installer - it lands beside the stable install, never over it,"
Write-Host "     and on first boot clones a copy of stable's state (worktrees excluded by design)."
Write-Host "  2. Trial canary. Broken? Delete it; stable was never touched. Good? Promote:"
Write-Host "     install stable v$Version by hand, or let the running stable offer it (Settings > About)."
Write-Host "  3. Commit the version bump (package.json, Cargo.toml, Cargo.lock, tauri.conf.json, Settings.tsx, version.ts)."
Write-Host "  4. If a stable in-app update fails, the installer is in releases\ and runs by hand (docs/SIGNING.md)."
