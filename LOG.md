# Flightdeck session log

Append-only session history.
STATE.md stays the dashboard; older "Superseded" blocks there predate this file.

## 2026-08-14 — Docker panel planning session (no code)

Balu asked for the latest and whether VS Code-style Docker functionality exists or could be added.
Findings: zero Docker code in the repo; the v1 spec's "no Docker" ruling (flightdeck-build-plan.md:221) rejected containers as an agent sandbox only, so a container manager panel doesn't reverse it.
Scoped with Balu: container manager panel (list, start/stop/restart/remove, logs, shell-into-container).
Explored extension points (Explorer.tsx panel pattern, gitstatus.rs shell-out pattern, VendorAdapter registry) and wrote a full implementation plan: parameterized vendor ids `docker-exec:<ref>`/`docker-logs:<ref>` through `vendors::find()` so logs and shells are ordinary panes; bounded docker CLI calls through a new docker.rs; five-state panel UI; ~26 new tests; E2E checklist.
Balu approved the plan then parked it: filed as BACKLOG.md DK-1, full plan checked in at `docs/plans/docker-panel-dk1.md`.
No code changed. STATE.md's standing next steps (0.5.4 verify list, cut 0.5.5 as the first real in-app updater test) are untouched.
