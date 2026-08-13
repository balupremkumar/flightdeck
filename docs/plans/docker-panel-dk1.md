# Docker container panel for Flightdeck (v1)

## Context

Balu wants VS Code Docker-extension-style capability in Flightdeck: see containers, start/stop/restart them, view logs, open a shell inside one.
Nothing Docker-related exists in the codebase today (only a transitive `is-docker` crate and a fake demo transcript line).
The research specs rejected Docker only as an *agent sandbox* (flightdeck-build-plan.md:221) — a container manager panel is a different feature and doesn't reverse that ruling.
The app already has perfect templates: the Explorer side panel (src/Explorer.tsx) and the calm-failure shell-out pattern (src-tauri/src/gitstatus.rs).
The webview CSP (`connect-src 'self' ipc:`, tauri.conf.json:26) means all docker access goes through Rust commands driving the docker CLI — no daemon HTTP, no new Tauri plugin, no capability/ACL changes.

## Scope (v1)

Containers list + actions (start/stop/restart/remove), images list (read-only), logs as a pane, shell-into-container as a pane.
Out of scope, noted in BACKLOG: compose UI, volumes/networks, image actions, container stats, Windows-container shells, "Start Docker Desktop" button.

## Key design decisions

1. **Container identity rides in a parameterized vendor id**: `docker-exec:<ref>` and `docker-logs:<ref>`.
   `vendors::find()` (vendors.rs:871) gains a prefix branch before the registry scan that constructs a `DockerExec(ref)` / `DockerLogs(ref)` adapter; invalid refs fall through to the existing Pwsh fallback.
   This costs one branch, avoids the staged-args race in usage.rs (keyed on vendor+cwd with 20s TTL — two shell clicks in one workspace would collide), and gets session restore for free because `PaneModel.vendor` is already persisted.
   These adapters are NOT in `registry()` (vendors.rs:852-859), so they never appear in vendor pickers or Settings.
2. **Logs open as a Flightdeck pane** running `docker logs -f --tail 500 <ref>` — scrollback, search, persistence, restart all come free from the pane model. No in-panel log viewer.
3. **Poll only while the panel is open**, interval driven by last status: ok → 5s, no-daemon → 15s (auto-recovers when Docker Desktop finishes booting), no-cli → polling off (Retry button only). Images fetched on section expand, never polled. Panel closed = zero docker.exe spawns.
4. **Every docker CLI call is time-bounded** (std-only: piped-reader threads + `try_wait` loop + kill on deadline) — a half-up daemon hangs `docker ps` otherwise. CREATE_NO_WINDOW only, never DETACHED_PROCESS (machine-specific: detached hidden processes die here).

## Implementation steps

### Backend

1. **New `src-tauri/src/docker.rs`** (~340 lines + tests), modeled on gitstatus.rs:
   - `run_docker(args, timeout_ms)` bounded runner: `Command::new(docker_exe())`, stdin null, `creation_flags(0x08000000)` under `#[cfg(windows)]`, reader threads on both pipes, deadline kill. Returns `NoCli | Timeout | Done{ok, stdout, stderr}`.
   - `docker_exe()`: `vendors::which("docker")` (promote `which` at vendors.rs:75 to `pub(crate)`), fallback `C:\Program Files\Docker\Docker\resources\bin\docker.exe`, then `docker.exe`.
   - Pure helpers, all unit-tested: `valid_container_ref` (`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`), `classify_failure` (maps daemon-down stderr strings → `no-daemon`), `state_from`, `short_ports`, `first_name`, `parse_ps`, `parse_images`. Parsing is line-per-JSON from `--format "{{json .}}"`, bad lines skipped, `#[serde(default)]` on every field.
   - Four commands, serde camelCase (mirroring `VendorInfo` at vendors.rs:46), all returning calm structs, never `Err`:
     `docker_status` (`docker --version` then `docker ps -q` — separates not-installed from daemon-down), `docker_containers` (`ps -a`, envelope status `ok|no-cli|no-daemon|timeout|error`), `docker_images`, `docker_container_action(id, action)` (allowlist start/stop -t 5/restart/pause/unpause/rm, ref validated before spawn, action mapped through a `match` to fixed argv — never interpolated).
   - Timeouts: version 4s, ps 6s, images 8s, action 30s.
2. **`src-tauri/src/vendors.rs`** (~40 lines): `DockerExec(String)` + `DockerLogs(String)` adapters after `Wsl` (:497); `kind "shell"`, `quiet_seconds 2`, `root_exe "docker.exe"`; exec command is `docker exec -it <ref> sh -c "if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi"` (alpine-safe). Prefix branch in `find()` at :871. Verified non-issues: shellmarks only wraps bare pwsh; `usage::take_launch_args` returns empty for these ids.
3. **`src-tauri/src/lib.rs`**: `mod docker;` near :10; four handler entries after `gitstatus::git_status` at :657.

### Frontend

4. **New `src/docker.ts`** (~110 lines, no JSX — the vitest surface): types, `execVendorId`/`logsVendorId`/`parseDockerVendor`, `pollIntervalFor`, `stateChipClass`, `emptyMessage` (all five-state copy in one place), `allowedActions`, `sortContainers`, `listContainers`/`listImages` via `cachedInvoke` (poll.ts:23, TTLs 4s/60s). Must not import vendors.ts (cycle).
5. **`src/vendors.ts`**: `vendorMeta()` (:93-111) gains a `parseDockerVendor` branch synthesizing a descriptor (label "Shell — <ref>" / "Logs — <ref>", kind shell, accent `--ice`) so pane headers, colors, and notifications render properly.
6. **`src/worktrees.ts:53-55`**: `isolationSupported` becomes `vendor !== "wsl" && !parseDockerVendor(vendor)`; the panel also passes `isolate=false` to `spawnPane`. (Terminal.tsx:282 verified: needs no change — posix cwd branch already gated on a Windows-path regex.)
7. **`src/ui.ts`**: `dockerOpen`/`setDockerOpen` mirroring `explorerOpen` exactly (declare near :138, implement near :341, localStorage key `flightdeck-docker-open`, default closed). Panel is docked like Explorer, NOT an overlay — no `useOverlayEsc` for the panel itself; its right-click row menu DOES use it (Explorer.tsx:616 reference).
8. **`src/Icons.tsx`**: `IconContainer` on the shared 20×20/1.6-stroke grid (stacked-crate glyph, not the Docker whale).
9. **New `src/DockerPanel.tsx`** (~380 lines) + **`src/docker.css`** — naming avoids the case-only-collision trap (CLAUDE.md). Copied from Explorer.tsx: props `{wsId, cwd}`, collapse + width resize (key `flightdeck-docker-width`), header status pill, Containers section + Images section (collapsed, lazy), `usePoll(load, interval, [interval], dockerOpen && interval > 0)` + focus refetch (:777-785 pattern), two-consecutive-failure hysteresis before blanking a settled list (Explorer failStreak :549).
   Five UI states: loading skeleton / no-cli (install link, polling off) / no-daemon (message + Retry, 15s poll) / empty ("No containers" + `docker run` hint) / populated.
   Rows: name, image, state chip (`chip-ok/warn/err` from theme.css:491 + `--st-*` tokens), port chips; hover actions Start/Stop/Restart/Logs/Shell; context menu adds Copy ID/name and Remove (only when stopped, behind `requestConfirm` danger).
   Shell/Logs: `spawnPane(wsId, execVendorId(c.id), cwd, false, name)`. Actions: invoke → toast on failure → immediate `load(true)`.
10. **`src/Cockpit.tsx`**: store selectors near :41; `tb-ic` toggle button after the Explorer toggle (:369) with the same `disabled` gate; mount after `<Explorer/>` (:413) gated on `showDocker && active && view === "terminals"`.
11. **`src/CommandPalette.tsx`**: `act:toggle-docker` entry after `act:toggle-explorer` (:243); dep list at :296. No new keybinding (Explorer has none either).

## Tests

- **cargo, docker.rs** (~12): ps/images JSON fixture parsing incl. malformed-line skip, state derivation for old CLIs, port dedupe, failure classification from real Windows stderr strings, action allowlist rejection, ref validation, and a "never errors with or without Docker installed" smoke over all four commands.
- **cargo, vendors.rs** (extend conformance suite :906-948, ~4): exec/logs argv assertions via `CommandBuilder::get_argv()`, invalid ref falls back to pwsh, docker vendors hidden from `registry()`/`detect()`.
- **vitest, src/docker.test.ts** (~10): vendor-id round-trip, `pollIntervalFor` (asserts polling OFF for no-cli), distinct copy for all five states (no-cli ≠ no-daemon text), chip mapping, `allowedActions`, sort order. Plus one-line extensions to vendors.test.ts (`vendorMeta` on a docker id) and worktrees.test.ts (isolation refusal + claude regression).
- **Gates**: tsc, npm run build, vitest (661 → ~680), cargo (197 → ~212). Pane-smoke and boot gate unchanged (panel defaults closed).

## E2E verification (real Docker Desktop on this machine)

1. Daemon stopped: panel shows "Docker Desktop isn't running", 15s poll, no console flash, no lingering docker.exe; panel closed → zero spawns.
2. Start Docker Desktop with panel open → flips to list unaided within ~15s.
3. `docker run -d --name fd-test nginx` → row with chip + port within 5s.
4. Stop/Start/Restart/Remove (confirm dialog) all reflect within one tick.
5. Shell pane: prompt inside container, `hostname` = container id, clean exit; repeat on alpine (sh fallback).
6. Two Shell clicks on two containers within a second → both panes land in the right containers.
7. Logs pane streams live, xterm search works, container stop exits the pane calmly.
8. Quit/relaunch with shell + logs panes open → both restore against the same containers; removed container → docker's own "No such container", no crash.
9. Minimised window: no docker.exe spawns (poll.ts windowActive gate).

## BACKLOG note

Add the out-of-scope list as a BACKLOG.md entry so v2 candidates (compose, volumes, image actions, stats, view-switcher sidebar) are recorded.
