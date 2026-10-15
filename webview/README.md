# Firstmate web view (fork-only)

A read-only, localhost-only dashboard over the fleet and the machine it runs on.
It adds no fleet logic: it caches `bin/fm-fleet-snapshot.sh --json` and renders it.

- The Board is the main view: a KPI strip with sparklines above a kanban of seven columns (Needs your decision, Aging decisions, Blocked, Working, Waiting on review, Ready to land, Done (recent)), with search, a project filter, and column counts.
- Each card shows its title, project, age, PR badge (a deep link to the PR), and status colour; selecting it opens a detail drawer with the full decision or blocker text, what it is waiting on, the PR, the update history, the instructions sent, and how to resolve it: the reply to give firstmate and the command firstmate would run, each with a Copy button.
- The keyboard works throughout: `/` focuses search, arrow keys move between cards, Enter opens a card, and Esc closes the drawer and returns focus to the card.
- The Charts page shows every card by state, open work by project, how long waiting items have sat, and machine trends; the Machine page holds machine figures, trends, Claude sessions, and stray helpers, with a header health badge and plain-language machine alerts.
- Light and dark themes follow the operating system by default; the header toggle cycles system, light, and dark and remembers the choice in `localStorage`.
- Apart from stopping stray helpers on the Machine page, the page only reads: it never answers a decision, holds, merges, or sends anything.

## Board columns

`cards()` in `public/render.js` classifies from structured snapshot fields only, never by matching free text (the one exception is `bin/fm-crew-state.sh`'s fixed `PR merged` / `PR closed` detail vocabulary):

- A task with an open `needs-decision` record, a live captain hold (`hold_bucket == "live"`), or a second mate's `decisions_open` entry is a decision; it goes to Needs your decision when its age is under 3 days and to Aging decisions, oldest first, after that.
- Decision age is the time since the task's last status event, or since `hold_set` for a hold (`hold_age_days` when `hold_set` is missing).
- Blocked holds tasks with an open `blocked` record, a `blocked` or `failed` current state, or unresolved backlog blockers, plus queued rows waiting on unfinished work; blocked records are never shown as decisions.
- A `done` task with an open PR goes to Ready to land when it ran the no-mistakes pipeline (its review is done and it awaits the merge call) and to Waiting on review when it is a direct PR; a merged or closed PR goes to Done.
- A paused task or one with no live status that has a PR goes to Waiting on review; a `done` local-only task goes to Ready to land; a finished investigation goes to Waiting on review.
- Everything else in flight is Working, with a badge for paused, parked, or no live status; Done (recent) lists the latest 15 backlog Done rows and second-mate landings.

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
- Stray helpers (orphans): `node`, `npm`, `npx`, `python`, `uv`, or MCP helpers whose parent is init and that are older than an hour, never the web view's own process.
  Each of your own has a Kill button, and Kill all strays stops every one; both ask for confirmation first, showing pid, age, parent, memory, and command.
- Alerts: thresholds live in `LIMITS` at the top of `resources.js` (load above 2x cores, processes above 70% of the limit, a session tree above 300 processes, free memory below 5% or compressed above 50%, a session above 1.5 GB, more than 25 sessions, any orphan). Each alert says what to look at.

## Charts and history

- All charts are hand-written inline SVG in `public/charts.js`, with no chart library, font, or network fetch; each chart has a "Show the numbers" table and a hover or keyboard-focus readout.
- State colours are one fixed, ordered set per theme (decisions, blocked, waiting on review, working, ready to land, done) checked for colour-vision separation and 3:1 contrast against the card surface; text never takes a state colour, and every coloured mark sits beside a text label.
- The server keeps trend history in memory only while it runs: one sample per resources reading and one per new snapshot, at most 3 hours, served downsampled to at most 360 points by `GET /api/history`.
  A restart starts the trends empty; nothing is written to disk.
- `public/render.js` shapes every card, count, and list; the server reuses the same functions to sample the headline counts, so the tiles and their sparklines agree.

## Design

- `GET /api/snapshot` serves the cached snapshot verbatim, with `X-Snapshot-Version`, `X-Snapshot-Fetched-At`, `X-Snapshot-Stale` (set when the latest refresh failed and the last good snapshot is being served), and `X-Snapshot-Refreshing` (set while a refresh runs).
- `GET /api/resources` serves the latest resources reading with the same headers under the `X-Resources-` prefix.
- `GET /api/history` returns `{windowMs, fleet, machine}`: timestamped samples of the headline counts and of machine load, memory in use, Claude sessions, MCP helpers, and stray helpers, with `null` for a reading that was not available.
- `GET /api/task/<id>` adds the status-log tail (shown as history, never as current state) and the task's inbox listing. `<id>` must be a task in the current snapshot.
- Pages: the Board with its detail drawer, Charts, card lists behind chart segments, and Machine.
  Status logs are never re-folded here (see `docs/architecture.md`, status files are append-only event logs).
- A snapshot whose `schema` is not `fm-fleet-snapshot.v1` is rejected by the server and the page, loudly, rather than rendered.

## Threat model

- Binds `127.0.0.1` only; a request whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` is refused (DNS rebinding).
  Do not bind `0.0.0.0`.
- Every route is `GET`/`HEAD` only, except one: `POST /api/stray-helpers/<pid>/kill`, which accepts only `POST`.
  There is no generic kill endpoint and no request field names a command or signal.
- A stop request must carry `Origin: http://<the Host it was sent to>`, an `X-Webview-Token` header equal to a random token generated at each launch, and an `application/json` body under 4 KB holding the `command` and `ageSeconds` the page displayed.
  The token is placed in the served page only; other origins cannot read the page, so they cannot send it back.
- `stray-kill.js` re-reads the process table at request time and refuses (409) any pid that is not a current stray, belongs to another user, no longer has parent pid 1, is a Claude session or the web view itself, or has any child process.
  No child of a stray is itself a stray, because a stray must have parent pid 1.
  It also refuses a pid whose command differs or whose process is younger than the page showed, which catches pid reuse.
- The stop is `process.kill(pid, 'SIGTERM')`, a wait of up to 3 seconds, then `SIGKILL` if it is still alive, with no shell and no exec.
  The reply names the outcome: `terminated`, `killed`, `already-gone`, `refused` with a reason, or `failed`, and the server logs every attempt to stderr.
  A pid can still change between the last check and the signal; the window is a few milliseconds and the identity check above narrows it.
- The snapshot script is run with `spawn` and an argument array, never a shell.
- Every fleet-derived string reaches the DOM through `textContent`, and a test forbids HTML-injecting sinks in the client code.

## Fork hygiene

This fork is public. Nothing company-specific or containing PHI may ever be committed here: no real hostnames, ticket keys, repo names, project names, person names, or any data drawn from a real `FM_HOME`. Every test fixture, screenshot, and example in this directory uses synthetic placeholder data only (for example `demo-task-1`, `example.invalid`, `ACME-999`). If you need to validate against something that looks real, construct a fixture that looks real; never copy from a live operational home.

All of this lives under `webview/`, so `git merge upstream/main` stays conflict-free; the only upstream-owned file touched is one pointer line in the root `README.md`. `.github/workflows/webview-hygiene.yml` greps PRs that touch `webview/**` for ticket-key-shaped strings, SSN-shaped numbers, and obvious company markers. It is a heuristic net, not a guarantee.
