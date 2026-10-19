# Firstmate web view (fork-only, phase 1)

A read-only, localhost-only status board: what needs the captain (decisions, review-ready PRs, blockers, captain calls), work in flight grouped by project with state and PR links, and recently finished work, plus a per-task detail page, and a resources panel with a header health badge and plain-language machine alerts. It adds no fleet logic: it caches `bin/fm-fleet-snapshot.sh --json` and renders it.

## Run

```sh
FM_HOME=/path/to/your/home node webview/server.js   # http://127.0.0.1:4780/
node --test webview/tests/*.test.js                 # or: cd webview && npm test
```

- `FM_HOME` is required and never guessed; the server exits with status 2 without it.
- Optional: `WEBVIEW_PORT` (default `4780`), `WEBVIEW_POLL_MS` (default `7000`, the pause between one refresh finishing and the next starting), `WEBVIEW_SNAPSHOT_TIMEOUT_MS` (default `180000`), `WEBVIEW_RESOURCES_POLL_MS` (default `5000`).
- Zero dependencies; needs Node 20+ and whatever `bin/fm-fleet-snapshot.sh` needs (`jq`).

## Snapshot cost

`bin/fm-fleet-snapshot.sh` reads current state for every task through `bin/fm-crew-state.sh` (pane, no-mistakes run, and bounded forge reads) plus every secondmate home, so on a busy home one run can take most of a minute. It stays the single source of truth: no cheaper documented source yields the same current state, and re-reading status logs would report stale events as state. The server therefore:

- never overlaps refreshes (the next one is scheduled only after the current one settles) and backs off exponentially after consecutive failures, up to 64x the poll interval;
- kills a run that exceeds the timeout together with its child processes, and reports the real reason (`timed out after N ms`, exit code or signal, stderr tail);
- keeps serving the last good snapshot while refreshing or after a failed refresh, and the page shows its age with a `refreshing` or `last refresh failed: <reason>` banner instead of replacing data with an error;
- before the first snapshot, `GET /api/snapshot` answers `503 {loading: true, refreshing, error}` and the page says it is loading the first snapshot.

## Resources and alerts

`resources.js` reads machine health on macOS and Linux with one `ps -A -ww -o pid=,ppid=,uid=,rss=,etime=,args=` call per refresh, plus `sysctl` and `vm_stat` (macOS) or `/proc/meminfo` and `/proc/self/limits` (Linux), and one `lsof -a -d cwd` for session directories; every command has a short timeout and every read except `ps` may fail without breaking the panel. It uses the same no-overlap, backoff, and stale-while-revalidate poller as the snapshot.

- Machine: load average against core count, free and compressed memory (macOS counts free, inactive, and speculative pages as free; Linux uses `MemAvailable` and has no compressed figure), and your process count against the per-user limit.
- Claude sessions: every process whose command starts with `claude` (except `claude bg-pty-host` and `claude agents`) with its whole process tree, showing working-directory name, memory including helpers, process count, MCP helper count, and age, largest first.
- Orphans: `node`, `npm`, `npx`, `python`, `uv`, or MCP helpers whose parent is init and that are older than an hour.
- Alerts: thresholds live in `LIMITS` at the top of `resources.js` (load above 2x cores, processes above 70% of the limit, a session tree above 300 processes, free memory below 5% or compressed above 50%, a session above 1.5 GB, more than 25 sessions, any orphan). Each alert says what to look at.

## Design

- `GET /api/snapshot` serves the cached snapshot verbatim, with `X-Snapshot-Version`, `X-Snapshot-Fetched-At`, `X-Snapshot-Stale` (set when the latest refresh failed and the last good snapshot is being served), and `X-Snapshot-Refreshing` (set while a refresh runs).
- `GET /api/resources` serves the latest resources reading with the same headers under the `X-Resources-` prefix.
- `GET /api/task/<id>` adds the status-log tail (shown as history, never as current state) and the task's inbox listing. `<id>` must be a task in the current snapshot.
- Pages: the board and task detail. "Needs the captain" uses the snapshot's own `hints.open_decisions`, `hold_bucket == "live"` holds, secondmates' `decisions_open`, and tasks whose current state is `done` with a PR that `bin/fm-crew-state.sh` does not report merged or closed; recently finished is the backlog's Done rows plus `secondmate_landed`. Status logs are never re-folded here (see `docs/architecture.md`, status files are append-only event logs).
- A snapshot whose `schema` is not `fm-fleet-snapshot.v1` is rejected by the server and the page, loudly, rather than rendered.

## Threat model

Binds `127.0.0.1` only; a request whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` is refused (DNS rebinding). Only `GET`/`HEAD` are served: phase 1 has no write endpoints. The snapshot script is run with `spawn` and an argument array, never a shell. Every fleet-derived string reaches the DOM through `textContent`, and a test forbids HTML-injecting sinks in the client code. Do not bind `0.0.0.0`.

## Fork hygiene

This fork is public. Nothing company-specific or containing PHI may ever be committed here: no real hostnames, ticket keys, repo names, project names, person names, or any data drawn from a real `FM_HOME`. Every test fixture, screenshot, and example in this directory uses synthetic placeholder data only (for example `demo-task-1`, `example.invalid`, `ACME-999`). If you need to validate against something that looks real, construct a fixture that looks real; never copy from a live operational home.

All of this lives under `webview/`, so `git merge upstream/main` stays conflict-free; the only upstream-owned file touched is one pointer line in the root `README.md`. `.github/workflows/webview-hygiene.yml` greps PRs that touch `webview/**` for ticket-key-shaped strings, SSN-shaped numbers, and obvious company markers. It is a heuristic net, not a guarantee.
