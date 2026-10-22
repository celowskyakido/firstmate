# Firstmate web view (fork-only)

A localhost-only dashboard over the fleet and the machine it runs on.
It adds no fleet logic: it caches `bin/fm-fleet-snapshot.sh --json` and renders it.

- The Board is the main view: a KPI strip with sparklines above a kanban of seven columns (Needs your decision, Aging decisions, Blocked, Working, Waiting on review, Ready to land, Done (recent)), with search, a project filter, and column counts.
- Each card shows its title, project, age, PR badge (a deep link to the PR), and status colour; selecting it opens a detail drawer with the full decision or blocker text, what it is waiting on, the PR, the update history, the instructions sent, and how to resolve it: the reply to give firstmate and the command firstmate would run, each with a Copy button.
- The keyboard works throughout: `/` focuses search, arrow keys move between cards, Enter opens a card, and Esc closes the drawer and returns focus to the card.
- The Machine page reads only the machine, so it, the sessions list, and the stray-helper controls work while the fleet snapshot is still loading or failing; the other pages say they are waiting for the snapshot.
- The Charts page shows every card by state, open work by project, how long waiting items have sat, and machine trends; the Machine page holds machine figures, trends, Claude sessions, and stray helpers, with a header health badge and plain-language machine alerts.
- Light and dark themes follow the operating system by default; the header toggle cycles system, light, and dark and remembers the choice in `localStorage`.
- Apart from stopping stray helpers on the Machine page, cancelling outdated items and acting on decisions (both below), and dismissing or snoozing chat radar items, the page only reads: it never otherwise holds, merges, or sends anything.

## Cancelling outdated decisions and tasks

- A held captain decision, or a queued or held backlog task with no worker, shows a Cancel button on its card and in its drawer; a card for live work, a task with a PR firstmate is watching, or a second mate's decision never does.
- The confirm dialog shows the title, says what will happen, and requires a reason: Outdated, Already handled, or Other with a short note (one line, at most 200 characters).
- A held decision is closed with `bin/fm-captain-hold.sh answer <id> --decision-file <file>` (no `--release`), the file holding `Cancelled from the dashboard: <reason>` and the note; a queued task is closed with `bin/fm-tasks-axi.sh done <id> --note <the same text>`.
  Both run with `FM_HOME` set and an argument array; the page never edits the backlog itself.
- A successful cancel hides the card at once and the next snapshot drops it; a refusal or script failure is shown with its reason and the script's output.
- Every attempt, refused or not, appends one JSON line (`at`, `id`, `reason`, `note`, `outcome`) to `$FM_HOME/state/webview-cancel.log`, which is captain-private like the rest of `state/`.
- Closing several at once, and undo, live on the Decisions tab (below); the Board's Cancel stays one item at a time.

## Acting on decisions

The Decisions tab (`#/decisions`, between Board and Radar, with a badge counting what waits on you) lists every decision once and lets you act on it without going back to chat.
The Board is unchanged and still shows every card.

- One entry per decision, sorted by priority and then oldest first: decisions a running worker is blocked on come first, then your own held questions, then second mates' decisions.
  Twin records of one decision collapse into one entry, for example a second mate's own hold and the parent's relayed `captain-hold-<id>` copy; the page says how many were folded, in total and on the entry.
- Each entry spells out what a click will do, beside its button, and says plainly when it cannot be undone.
- The result shows under the entry as soon as the script answers: plain words on success, the exact reason and the script's own output on failure.
  A decision stays answerable after a failure, and a success leaves it dimmed until the next snapshot drops it.
  If a snapshot taken after the action still lists it, the page treats the action as not having taken effect and makes it actionable again.
- Recent actions keeps this page session's results, newest first, until the page is reloaded.

What each button does:

| Button | Script run | Undo |
| --- | --- | --- |
| Send answer, on a held question (`captain` kind) | `bin/fm-captain-hold.sh answer <id> --decision-file <file>` | No: the answer is recorded and the question closes. |
| Send answer, on held work (any other kind, or a hold on a running task) | `bin/fm-captain-hold.sh answer <id> --decision-file <file> --release` | No: the work goes ahead. |
| Send answer, on a hold of unknown kind | Either of the two above, by a choice the page makes you take | No. |
| Send to the worker, on a worker's open `needs-decision` | `bin/fm-send.sh <task> --resolve-key <key> <text>` | No: the text is in the worker's inbox and its question closes. |
| Defer | `bin/fm-captain-hold.sh hold <id> --reason <the hold's own reason> --until <date>` | Yes, one step, while the server keeps running: the same `hold` without `--until`, which keeps the original hold time. |
| Close as settled | `bin/fm-captain-hold.sh answer <id> --decision-file <file>` through `cancel.js` (Outdated, Already handled, or Other with a note) | No. |

- Options come from the hold's reason when it has two or more lettered or numbered choices in order, starting at A or 1, such as `(A) keep it (B) drop it` or `1. ship 2. wait`; the option's text, not just its letter, is recorded.
  Anything else is free text, and free text is always available.
- The recorded and relayed words always begin `Answered from the dashboard: `, so a worker's terminal can never read an answer that starts with `/`, `$`, or `--` as a command, and control characters are dropped.
  An answer is at most 2000 characters.
- A decision from a second mate's home, or a worker question the page cannot steer, has no answer button: it shows why and leaves the answer to chat, because the owning home's records are not this page's to write.
- Defer needs a day after today and within a year; Tomorrow, In a week, and In a month fill it in.
- Why only a deferral can be undone: tasks-axi can reopen a closed task, but that leaves the old resolution block in the body and drops the hold's set time, so it is not a clean undo, and a message already in a worker's inbox cannot be taken back.
- Select any decisions that can be closed or deferred (a hold with no worker or pull request on it can be closed; any hold in this home can be deferred), then Close as settled or Defer.
  A dialog states the exact count, lists the titles, and asks for one reason or one day for all.
  The server requires the confirmed count to match, runs them one after another, never stops at a failure, and reports each outcome; a partial result names what was not done and why.
  A selection that mixes in decisions the action cannot apply to says how many are left alone.
- Every attempt that reaches a script appends one JSON line (`at`, `action`, `ref`, `mode`, `outcome`, and for a deferral the date) to `$FM_HOME/state/webview-actions.log`.
  It never holds the words you typed, a title, or a hold reason.

## Board columns

`cards()` in `public/render.js` classifies from structured snapshot fields only, never by matching free text (the one exception is `bin/fm-crew-state.sh`'s fixed `PR merged` / `PR closed` detail vocabulary):

- A task with an open `needs-decision` record, a live captain hold (`hold_bucket == "live"`), or a second mate's `decisions_open` entry is a decision; it goes to Needs your decision when its age is under 3 days and to Aging decisions, oldest first, after that.
- Each decision ages on its own: a hold from `hold_set` (`hold_age_days` when `hold_set` is missing, including a second mate's holds), and an open status decision, which has no timestamp of its own, from the task's last status event.
  A card's age is its oldest decision, so a 4-day-old hold stays aging even after a fresh worker update; the drawer shows the last update separately.
- A second mate's own decisions are identified by child task id plus key, so two children that both ask for `approval` stay separate, and they replace the parent's relayed status copy of the same key, because the second mate's own record is authoritative.
- A hold's suggested command follows the hold's shape: a `captain`-kind row is a question, answered and closed with plain `answer`; a held ship, scout, or other work row, or a hold on a task already under way, uses `answer --release` so the work resumes; a hold of unknown kind shows both, each labelled.
- A second mate's own decisions keep their owning home: the drawer's command for a second mate's hold is prefixed with that home's `FM_HOME`, and no command is shown when the home is remote or unknown, so a copied command never acts on this home's backlog.
- The drawer looks cards up in a registry of every card any page can show, so finished work older than the board's recent window and queued rows that only appear in lists still open.
- Blocked holds tasks with an open `blocked` record, a `blocked` or `failed` current state, or unresolved backlog blockers, plus queued rows waiting on unfinished work; blocked records are never shown as decisions.
- A `done` task with an open PR goes to Ready to land when it ran the no-mistakes pipeline (its review is done and it awaits the merge call) and to Waiting on review when it is a direct PR; a merged or closed PR goes to Done.
- A paused task or one with no live status that has a PR goes to Waiting on review; a `done` local-only task goes to Ready to land; a finished investigation goes to Waiting on review.
- Everything else in flight is Working, with a badge for paused, parked, or no live status; Done (recent) lists the latest 15 backlog Done rows and second-mate landings.

## Chat radar

A scheduled agent job ([`radar-producer/`](radar-producer/README.md)) reads Slack and Teams and writes `FM_HOME/data/radar.json`; the server cannot call MCP and only reads that file, on every `GET /api/radar`.
Slack and Teams are equal, independent sources: each always gets its own status line, and a failed or out-of-date source never hides the other's items.

- The radar lives on its own Radar tab (`#radar` or `#/radar`), next to the Board tab in the header; the selected tab is in the URL hash, so it survives a reload and the refresh cycle, and the tabs work with the arrow keys, Home, and End.
- Each tab has a badge: Board shows how many items need you, Radar shows its visible items, and a red dot on the Radar badge appears whenever Slack or Teams is failed or out of date, even while the Board tab is open.
- Without `data/radar.json` the API answers `{"present": false}`, the Radar badge reads 0 with no dot, the Radar tab says nothing has written the file yet, and the Board tab looks exactly as before.
- The file must have `"schema": "fm-radar.v1"`, `generatedAt`, both `sources.slack` and `sources.teams` (`health` of `ok`, `degraded`, or `unavailable`, `reason`, `readAt`, `maxAgeMinutes`), and `items`; otherwise the Radar tab shows why it could not be read.
- An item needs `id` (`<source>:` plus 24 hex characters), `source`, `kind` (`mention`, `dm`, `group`, `channel`, `thread`, `new-channel`), `title` (120 characters), `why` (80), `firstSeen`, `lastActivity`, and `state`; an item missing any is dropped and counted in `invalidItems`.
- Only the named fields are passed on (`who`, `where`, `link`, `snoozedUntil`, and optional `taskIds` too), so a message body in the file never reaches the page; a `link` that is not `http` or `https` becomes `null`.
- A source reads as failed when `health` is `unavailable` (for example `Slack radar failed: login needed`) and as out of date when `readAt` is older than `maxAgeMinutes`.
- Items whose `taskIds` name a task get a chat badge on that task's card.

```json
{"schema": "fm-radar.v1", "generatedAt": "2026-07-08T12:00:00Z",
 "sources": {"slack": {"health": "unavailable", "reason": "login needed", "readAt": "2026-07-08T09:00:00Z", "maxAgeMinutes": 60},
             "teams": {"health": "ok", "reason": null, "readAt": "2026-07-08T11:58:00Z", "maxAgeMinutes": 90}},
 "items": [{"id": "teams:000000000000000000000001", "source": "teams", "kind": "mention", "title": "demo-chat",
            "link": "https://teams.example.invalid/m/1", "why": "mentions you", "who": null, "where": null,
            "firstSeen": "2026-07-08T11:50:00Z", "lastActivity": "2026-07-08T11:50:00Z", "state": "new", "taskIds": ["demo-task-1"]}]}
```

`POST /api/radar/<id>/dismiss` (body `{}`) and `POST /api/radar/<id>/snooze` (body `{"for": "4h"}` or `{"for": "1d"}`) record the choice in `FM_HOME/state/radar-dismissed.json`, which maps an item id to `{"until": <ISO time or null>}`; `null` is a dismiss, and expired snoozes are pruned on the next write:

```json
{"slack:000000000000000000000002": {"until": null}, "teams:000000000000000000000001": {"until": "2026-07-08T16:00:00.000Z"}}
```

Hidden items are left out of `GET /api/radar` and counted in `hiddenItems`; the producer's own `dismissed` state and a future `snoozedUntil` hide an item too.

## Agents tab

The Agents tab (`#agents` or `#/agents`) lists every agent process on this machine and opens a read-only log panel for each.
Its badge counts running agents, and a red dot shows while any is stuck or needs input.

- Counters at the top: Active, Needs input, Stuck or stale, and Idle, each with up to six reasons.
- Firstmate workers: one row per `state/*.meta` record in the fleet snapshot, with kind, harness, model and effort (`model=` and `effort=` from the meta), backend and pane target, local copy, start time (from `spawn_gen=`), current state, the latest status line (shown as history), the last tool call, and time since the transcript last changed.
- State comes only from the snapshot's `current_state` (the `bin/fm-crew-state.sh` reconciliation): an open `needs-decision`, a live captain hold, or `parked` is Needs input; `blocked`, `failed`, an open blocked event, a working task whose pane is gone, or one with no transcript output for 30 minutes is Stuck or stale; `working` is Active; anything else is Idle.
- Other agent processes: `claude`, `codex`, `opencode`, `pi`, `omp`, `grok`, `kimi`, `cursor-agent`, `gemini`, `muse`, `devin`, `agy`, `amp`, `aider`, `goose`, `qwen`, `crush`, and `acli rovodev`, also when started through `node`, `bun`, `deno`, or `python`, found with one `ps` call and one `lsof -d cwd` call.
  Each outermost agent is listed with its whole process subtree folded under it, so a headless run a session starts belongs to that session.
- A process whose working folder is inside a worker's local copy is that worker; otherwise it is a no-mistakes pipeline run (a `no-mistakes` ancestor), a supervision host (`claude bg-pty-host`, `agents`, or `daemon`), a headless run (`-p`, `--print`, `--headless`, `exec`, or `run`), background (no terminal), the firstmate session of this home (its folder is `FM_HOME`), or an interactive session.
- What it is doing: CPU across the subtree (2% or more is Active), Claude's own busy or idle flag from `~/.claude/sessions/<pid>.json` when present, the youngest child command, the last tool call, and when the transcript last changed.
- Log panel: the pane through `bin/fm-peek.sh <id> <lines>` (so tmux, herdr, zellij, cmux, orca, and remote second mates use the existing capture), the status log tail, the current no-mistakes step log (`no-mistakes axi status` then `axi logs --step <step>` in the task's local copy, only when the task's state comes from a run), and the session transcript.
  A non-fleet process shows only its transcript.
- Transcripts: Claude's `~/.claude/projects/<folder>/<session>.jsonl` (the session id from the per-pid file, else the newest file for the folder, labelled as a guess when another session shares the folder) and Codex's `~/.codex/sessions/<date>/rollout-*.jsonl` from the last three days whose recorded cwd matches; each record becomes one short line (user, assistant, tool, result).
- The panel has a filter box, 200, 500, or 1000 lines per source, an auto-scroll toggle, and a Copy button for the visible lines; it refreshes every 4 seconds while open, and the overview every 5 seconds while the tab is open (every 30 seconds otherwise, for the badge).
- Anything missing (no snapshot yet, `ps`, `lsof`, `fm-peek`, `no-mistakes`, or a transcript) shows as unavailable with its reason; the rest of the tab keeps working.
- Possible follow-up, deliberately absent: interrupt, exit, or steer controls; this tab never kills, sends keys, or writes anything.

## Run

```sh
FM_HOME=/path/to/your/home node webview/server.js   # http://127.0.0.1:4780/
node --test webview/tests/*.test.js                 # or: cd webview && npm test
```

- `FM_HOME` is required and never guessed; the server exits with status 2 without it.
- Optional: `WEBVIEW_PORT` (default `4780`), `WEBVIEW_POLL_MS` (default `7000`, the pause between one refresh finishing and the next starting), `WEBVIEW_SNAPSHOT_TIMEOUT_MS` (default `180000`), `WEBVIEW_RESOURCES_POLL_MS` (default `5000`).
- Optional source links: a card links to the PR, Jira issue, Slack or Teams thread, and Notion, Confluence, or Google doc found in its backlog title and body lines (put a `Source: <url>` body line on chat-originated work). Jira keys such as `ABC-123` in a title become links only when a Jira base URL is set in `WEBVIEW_JIRA_BASE` or in the home's gitignored `config/webview-links` file as `jira_base=https://your-site.example` (the environment wins; the file is re-read on each page load); without it they stay plain text. Keep that URL out of tracked files.
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
- Pages: the Board with its detail drawer, Radar, Agents, Charts, card lists behind chart segments, and Machine.
  Status logs are never re-folded here (see `docs/architecture.md`, status files are append-only event logs).
- A snapshot whose `schema` is not `fm-fleet-snapshot.v1` is rejected by the server and the page, loudly, rather than rendered.

## Threat model

- Binds `127.0.0.1` only; a request whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` is refused (DNS rebinding).
  Do not bind `0.0.0.0`.
- `GET /api/agents` and `GET /api/agents/log` return process and log data, which can hold secrets or PHI, so they also require the per-launch `X-Webview-Token`, send `Cache-Control: no-store` like every route, and are never cached to disk or written to the server log.
  `agents.js` builds the process allowlist from a process table at most 3 seconds old and the task allowlist from the snapshot: `task` must be a snapshot task id, `pid` must be a current agent process, `lines` is a positive whole number clamped to 1000, and paths are built only from `FM_HOME/state/<id>.status`, fixed `~/.claude` and `~/.codex` roots, a validated session id, and a sanitised folder name.
  `agent-logs.js` runs `ps`, `lsof`, `fm-peek.sh` (with `FM_GUARD_READ_ONLY=1`, so it never consumes firstmate's watcher-down banner), and `no-mistakes` with argument arrays and 3 to 8 second timeouts, and masks AWS keys, bearer and authorization values, GitHub, Slack, and API keys, JWTs, URL passwords, private key blocks, and `password=`-style values before any text leaves the server; the panel says logs may still contain sensitive data.
- Every route is `GET`/`HEAD` only, except four that accept only `POST`: `POST /api/stray-helpers/<pid>/kill`, `POST /api/cancel`, `POST /api/decisions/act` and `POST /api/decisions/bulk`, and `POST /api/radar/<id>/dismiss|snooze`.
  The radar writes carry the same Origin, per-launch token, and JSON-only guards as the stop request below, and accept only a well-formed item id.
  There is no generic kill endpoint and no request field names a command, script, or signal.
- A stop, cancel, or decision request must carry `Origin: http://<the Host it was sent to>`, an `X-Webview-Token` header equal to a random token generated at each launch, and an `application/json` body under 4 KB (16 KB for a decision, which may carry a free-text answer or fifty references): for a stop, the `command` and `ageSeconds` the page displayed; for a cancel, `{id, reason, note}`; for a decision, `{action, ref, ...}` with `action` one of `answer`, `defer`, `undo-defer`, `settle`, or a bulk `{action, refs, count, ...}`.
  The token is placed in the served page only; other origins cannot read the page, so they cannot send it back.
- `stray-kill.js` re-reads the process table at request time and refuses (409) any pid that is not a current stray, belongs to another user, no longer has parent pid 1, is a Claude session or the web view itself, or has any child process.
  No child of a stray is itself a stray, because a stray must have parent pid 1.
  It also refuses a pid whose command differs or whose process is younger than the page showed, which catches pid reuse.
- The stop is `process.kill(pid, 'SIGTERM')`, a wait of up to 3 seconds, then `SIGKILL` if it is still alive, with no shell and no exec.
  Before `SIGKILL` the process table is read again: if the pid is gone, or now belongs to a different owner, command, or a younger process (a reused pid), the reply is `already-gone` and nothing more is sent; if it is the same process but no longer a stray, it is refused without the force stop.
  The reply names the outcome: `terminated`, `killed`, `already-gone`, `refused` with a reason, or `failed`, and the server logs every attempt to stderr.
  A pid can still change between the last check and the signal; the window is a few milliseconds and the identity check above narrows it.
- `cancel.js` refuses (404) an id not in the current snapshot's backlog and (409) one that is finished, has a task record (a worker), has a PR, or is in flight; it also refuses an id whose `state/<id>.meta` appeared after the snapshot, and (400) a missing reason or an Other with no note.
  The id must look like a task id, so it can never reach a script as a flag, and only one cancel runs at a time.
- `act.js` accepts no id, script name, flag, or mode from the page: a request names a `ref` that must be an entry `decisionItems()` in `public/render.js` offers on the server's own latest snapshot, and the server derives the script, the close mode, and the worker target from that entry.
  Ids and keys must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$` before they reach a script, so none can look like a flag.
  The only scripts it runs are `fm-captain-hold.sh` (`answer` and `hold`), `fm-send.sh` (`--resolve-key`), and, through `cancel.js`, `fm-captain-hold.sh answer` and `fm-tasks-axi.sh done`.
  There is no delete, merge, lifecycle-control, or file-editing path.
- Only one state-changing decision or cancel request runs at a time; a second gets `409`.
  The server also remembers what it already did and refuses a repeat (a double click, a retry, or a stale page) until a snapshot taken after the action has been seen.
  A hold that gained a worker since the snapshot is refused, as for cancel.
  Undo works only for a deferral this process made, and it re-uses the reason the server read from its own snapshot, never one from the page.
- The snapshot script is run with `spawn` and an argument array, never a shell.
- Every fleet-derived string reaches the DOM through `textContent`, and a test forbids HTML-injecting sinks in the client code.

## Fork hygiene

This fork is public. Nothing company-specific or containing PHI may ever be committed here: no real hostnames, ticket keys, repo names, project names, person names, or any data drawn from a real `FM_HOME`. Every test fixture, screenshot, and example in this directory uses synthetic placeholder data only (for example `demo-task-1`, `example.invalid`, `ACME-999`). If you need to validate against something that looks real, construct a fixture that looks real; never copy from a live operational home.

All of this lives under `webview/`, so `git merge upstream/main` stays conflict-free; the only upstream-owned file touched is one pointer line in the root `README.md`. `.github/workflows/webview-hygiene.yml` greps PRs that touch `webview/**` for ticket-key-shaped strings, SSN-shaped numbers, and obvious company markers. It is a heuristic net, not a guarantee.
