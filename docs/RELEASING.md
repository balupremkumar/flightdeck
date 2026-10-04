# Releasing Flightdeck

Flightdeck never updates itself.
You install every release by hand, from outside Flightdeck.
Installing kills every pane, so close Flightdeck first and run the installer from Explorer or a plain PowerShell window.

## Cut a release

Only when you ask for one.

```powershell
pwsh tools\release.ps1 -Version 0.5.5 -Notes "What changed, in a sentence."
```

It bumps the version, runs the gates, builds the stable and canary installers, boots canary against a clone of your real data, then publishes.
Both installers land in `releases\`, and `releases\latest.json` is updated.
Both installers are also copied into `releases\archive\0.5.5\`.
If `releases\archive\0.5.5\` already exists the script stops straight away, so an archived installer can never be replaced.

## Install canary first

1. Close Flightdeck completely.
2. Run `releases\Flightdeck Canary_0.5.5_x64-setup.exe`.
3. Canary installs beside stable with its own data, and copies stable's state on its first start.
4. Do the hand check below.
5. Broken? Uninstall canary. Stable is exactly as you left it.

## Hand check (5 steps)

Placeholder, to be written once the checklist is agreed.

1. TBD
2. TBD
3. TBD
4. TBD
5. TBD

## Install stable over the old one

1. Close Flightdeck completely.
2. Run `releases\Flightdeck_0.5.5_x64-setup.exe`.
3. It replaces the old version in place (same app, same folder), and keeps your data.
4. Just before it copies anything, the installer saves a backup of your data (see below).

Settings > Updates has a "Check for updates" button.
It reads `latest.json` in your releases folder and tells you if a newer version exists.
It only tells you. It never installs anything.

## Revert to an earlier version

Close Flightdeck, open PowerShell 7 in the Flightdeck repo folder, then:

```powershell
pwsh .\tools\revert.ps1 -To 0.5.4
```

Run it with no `-To` to list the archived versions and the backups that exist.
Add `-WhatIf` to see every step without changing anything.

It restores the newest backup of that version, then runs the archived installer for it.
Before restoring, it saves your current data to `backups\pre-revert-<timestamp>\`, so the revert can itself be undone.
To use a specific backup, add `-Backup <folder>`.
To install the old version and keep your current data as it is, add `-NoRestore`.

## Backups and safety

Backups happen at install time, by the installer's pre-install hook.
Close Flightdeck first: if it is still running, webview files are locked and the backup comes out partial.
A clean backup has a `complete.txt` (version and timestamp) in its folder.
A partial one has none, the installer prints a warning, and `revert.ps1` refuses to restore it unless you pass `-Force`.
`backup-now.ps1` and the `pre-revert-<timestamp>` copy follow the same rule.

Backups are never pruned.
They grow with every install, so delete old ones by hand.

`releases\` is gitignored and lives on this disk only.
Copy `releases\archive` somewhere else occasionally.

The installer allows downgrades, so any old installer double-clicked will install over a newer version.
The pre-install backup is the safety net.

Every archive folder has a `SHA256SUMS.txt`.
`revert.ps1` checks the installer against it and refuses on a mismatch.
Older folders get one from `pwsh tools\hash-archive.ps1 -ReleasesDir .\releases`.

`-Force` on `revert.ps1` is the escape hatch for two refusals: a backup with no `complete.txt`, and an archive with no `SHA256SUMS.txt`.
It prints a loud warning and never overrides a hash mismatch.

## Where things live

| What | Where |
| --- | --- |
| Installers, current | `releases\` |
| Installers, every version, kept forever | `releases\archive\<version>\` |
| Data backups | `%APPDATA%\ai.flightdeck.app\backups\<version>-<yyyyMMdd-HHmmss>\` |
| Canary data backups | `%APPDATA%\ai.flightdeck.canary\backups\...` |
| Saved just before a revert | `%APPDATA%\ai.flightdeck.app\backups\pre-revert-<timestamp>\` |

Each backup holds `appdata\` (everything in the app data folder except `worktrees\`, `logs\` and `backups\`) and `local-storage\` (your UI settings).
The installer makes one automatically before every install.
To take one yourself, run `pwsh tools\backup-now.ps1`.

The releases folder is a setting (Settings > Updates > Releases folder).
A dev build suggests the repo's `releases\` folder, and any build also honours the `FLIGHTDECK_RELEASES_DIR` environment variable.
The revert script uses the same order, then falls back to `releases\` in the repo.
