# Code signing, Defender, and the silent-update problem

Status: Flightdeck ships an **unsigned** NSIS installer, and the in-app updater runs it silently.
This document explains what that costs, what the options are, and what changes if a certificate is ever bought.
It is a decision brief, not a recommendation.

Written 2026-08-01, alongside the UPD-1 work that made a blocked install fail loudly instead of silently.

## The failure this is about

Settings > About > "Install & restart" hands `Flightdeck_x.y.z_x64-setup.exe` to a detached PowerShell watcher, which runs it with `/S` (silent) and then relaunches the app.
Silent means no installer UI.
If Windows refuses to run that file, or kills it part-way, there is no window to show an error, and the app has already exited to let the installer overwrite its own exe.

Before UPD-1 that produced the worst possible outcome: the user clicks a button, the app disappears, and either nothing comes back or the same old version does, with no explanation anywhere.

That part is now fixed independently of signing (see `src-tauri/src/updates.rs`).
Every stage is recorded to `update-status.json` in the app data folder, the watcher always relaunches the app even after a failed install, the app reports what happened on the next boot, and if it cannot relaunch at all the watcher puts a native message box on screen.
Success is judged by "are we actually running the new version", not by the installer's exit code, because a quarantine mid-install can still exit 0.

**The manual fallback, which every failure message now names explicitly:** the installer is sitting in `releases\` (by default `D:\Dev\ai\projects\active\flightdeck\releases\`).
Run it by hand.
If Windows Security blocks it, allow it under Windows Security > Virus & threat protection > Protection history, then run it again.

## Why Windows flags it today

Two different mechanisms get confused with each other.
Only one of them is really in play on Balu's machine.

**SmartScreen App Reputation** fires on files carrying a Mark-of-the-Web, i.e. files that arrived from the internet (browser download, email, some network shares).
An installer built locally by `tools/release.ps1` and read from a local folder has **no** MOTW, so SmartScreen usually does not fire on this machine at all.
It absolutely will fire for anyone who downloads the installer from GitHub or a website: unknown publisher, no reputation, "Windows protected your PC".

**Microsoft Defender Antivirus** fires on anything, MOTW or not.
An unsigned, brand-new, low-prevalence exe that silently installs things is exactly the shape of a heuristic/cloud-reputation detection, and NSIS silent installers have a long history of being flagged.
This is the one that can quietly quarantine the file between the update check and the install, or mid-install.

So: signing mainly buys reputation and identity.
It reduces Defender heuristic risk substantially in practice (signed, identifiable publishers are much less likely to be flagged) and removes the SmartScreen problem for anything distributed over the internet.
It is not a guarantee against a false positive from either.

## The options

Costs below are **shapes**, not quotes.
Code-signing pricing moves and varies a lot by reseller; check current prices before deciding.

### 0. Do nothing (today)

Cost: nothing.
Gets: nothing.
Mitigated by: the loud-failure work above, plus the manual fallback, plus the two free actions in the next section.
For a single-machine personal tool this is a defensible position.
It stops being defensible the moment anyone else installs Flightdeck from a download.

### 1. Self-signed certificate

Cost: free, minutes of work (`New-SelfSignedCertificate`).
Gets: **almost nothing.**
SmartScreen ignores it entirely; a self-signed publisher has no reputation and never will.
Defender does not trust it either.
The only real effect is on machines where you have installed your own certificate into Trusted Root: there, the "unknown publisher" UAC banner goes away and the signature validates.
That means installing a root CA you control onto the machine, which is a genuine security trade-off (anything signed with that key is now trusted by that machine).
Honest verdict: useful for testing the signing pipeline, worthless for the actual problem.

### 2. OV (organisation validated) code-signing certificate

Cost shape: low hundreds of USD per year, plus identity validation paperwork, plus a hardware token or cloud HSM.
Since the CA/Browser Forum baseline requirements changed in June 2023, the private key **must** live on FIPS-140-2 Level 2 (or equivalent) hardware or in an approved cloud signing service.
You can no longer just download a `.pfx` and sign on your laptop, which matters for automation: a physical USB token means a human plugs it in, or you pay for the CA's cloud signing add-on.
Gets: a real, identifiable publisher name; the "unknown publisher" prompt goes away; Defender heuristics ease off.
Does **not** get instant SmartScreen reputation - that accrues per publisher over installs and time, so early downloads can still see the warning.
Validation as an individual developer is possible with most CAs but is slower and needs documentary proof of identity.

### 3. EV (extended validation) code-signing certificate

Cost shape: several hundred to around a thousand USD per year, hardware token mandatory, stricter validation (typically a registered legal entity, not an individual).
Gets: historically, **immediate SmartScreen reputation** - the single biggest reason EV exists.
Microsoft's public guidance has softened over time and reputation is increasingly evaluated per publisher rather than granted outright, so treat "immediate" as "far faster and far more reliable than OV", not as a permanent guarantee.
This is the option that makes a downloadable installer behave properly on day one.
It is overkill for a tool that only ever installs on its author's machine.

### 4. Azure Trusted Signing

Cost shape: a monthly Azure subscription in the tens of USD (Basic tier), not a per-certificate purchase, plus Azure setup effort.
This is Microsoft's own signing service: short-lived certificates issued per signing operation, keys held in Azure, signing driven by `signtool` with a dispatcher DLL, so it automates cleanly with no USB token.
Identity validation is required, and the eligibility rules (organisation vs individual, minimum age of the legal entity) have changed more than once - verify current eligibility before budgeting for it.
Gets: the reputation benefits of a properly issued certificate at a fraction of EV's cost, with the best automation story of the four.
If the answer to "should Flightdeck be signed" is ever yes, this is the option most worth pricing first.

## Free things worth doing regardless

- **Submit the installer to Microsoft as a false positive** if Defender ever flags it: <https://www.microsoft.com/en-us/wdsi/filesubmission>.
  Free, usually turned around in days, and fixes it for everyone rather than just this machine.
- **Add a Defender exclusion** for `releases\` and the install directory.
  Blunt, machine-local, and it does weaken protection on those paths - but it is the correct answer for a build output folder you produce yourself.
- **Keep the SHA-256 in `latest.json`** (added by `tools/release.ps1`) so a suspect installer can be checked by hand: `Get-FileHash releases\Flightdeck_x.y.z_x64-setup.exe -Algorithm SHA256`.

## Cheap partial wins, noted but not built

- **Verify the SHA-256 in `updates.rs` before running the installer.**
  `release.ps1` already writes it to `latest.json`.
  The app's pre-flight currently checks existence, size, PE header and the version in the file name, but not the hash, because that would mean adding a hashing crate to `src-tauri`.
  It would catch corruption and tampering at rest; it would not catch AV blocking, which is the actual failure mode here.
- **winget.**
  Publishing to `winget-pkgs` gets you a reviewed manifest with a pinned installer hash and a trusted install client, plus `winget upgrade` as a second update path that does not depend on this app's own updater.
  It does **not** confer trust on an unsigned binary: Defender and SmartScreen evaluate the installer the same way afterwards.
  Worth it for distribution, not for this problem, and it requires a public download URL - which Flightdeck does not have today.

## What changes once a certificate exists

Two unrelated kinds of signing exist in Tauri; do not confuse them.

- **Authenticode** (`bundle.windows.*`) is what Windows, Defender and SmartScreen care about.
  This document is about that.
- **Tauri updater signature** (minisign, `TAURI_SIGNING_PRIVATE_KEY`, `plugins.updater.pubkey`) only proves an update artifact came from the holder of a keypair.
  Flightdeck does not use the updater plugin at all - updates are local files read from `releases\` - so this is not in play, and adding it would not affect Defender in the slightest.

### `src-tauri/tauri.conf.json`

Add a `windows` block under `bundle` (it has none today):

```jsonc
"bundle": {
  "windows": {
    // Token / local store certificate:
    "certificateThumbprint": "<sha1 thumbprint of the cert>",
    "digestAlgorithm": "sha256",
    "timestampUrl": "http://timestamp.digicert.com",
    "tsp": false
    // Cloud signing (Azure Trusted Signing, cloud HSM) instead uses a custom
    // sign command, where %1 is the file to sign:
    // "signCommand": "signtool sign /v /debug /fd sha256 /tr <url> /td sha256 /dlib <dispatcher.dll> /dmdf <metadata.json> %1"
  }
}
```

Timestamping is not optional in practice: without it, every signature expires when the certificate does, and old installers stop validating.

Both the app exe and the NSIS installer get signed by the bundler once this is configured.

### `tools/release.ps1`

- The verification step currently **warns** when `Get-AuthenticodeSignature` returns anything other than `Valid`.
  Once a certificate exists, make that a hard `throw` - publishing an unsigned installer would then be a regression, not the status quo.
- If a USB token is involved, the build step becomes interactive (PIN prompt); if Azure Trusted Signing is used, the build step needs the Azure credentials in the environment.
  Either way, note it in the script header so a release run does not appear to hang.

### `src-tauri/src/updates.rs`

Nothing has to change.
It would become reasonable to *also* check the installer's Authenticode status during pre-flight and refuse to run an installer whose signature does not validate - a stronger guarantee than "the file name says 0.4.1".
That needs `WinVerifyTrust` via `windows-sys`, so it is only worth writing once there is a signature to verify.
