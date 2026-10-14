# Firstmate web view (fork-only, phase 1)

A read-only, localhost-only page showing every worker and task with live state, its PR, what it is waiting on, and a Decisions inbox. It adds no fleet logic: it caches `bin/fm-fleet-snapshot.sh --json` and renders it.

## Run

```sh
FM_HOME=/path/to/your/home node webview/server.js   # http://127.0.0.1:4780/
node --test webview/tests/*.test.js                 # or: cd webview && npm test
```

- `FM_HOME` is required and never guessed; the server exits with status 2 without it.
- Optional: `WEBVIEW_PORT` (default `4780`), `WEBVIEW_POLL_MS` (default `7000`).
- Zero dependencies; needs Node 20+ and whatever `bin/fm-fleet-snapshot.sh` needs (`jq`).

## Design

- `GET /api/snapshot` serves the cached snapshot verbatim, with `X-Snapshot-Version`, `X-Snapshot-Fetched-At`, and `X-Snapshot-Stale` (set when the latest refresh failed and the last good snapshot is being served).
- `GET /api/task/<id>` adds the status-log tail (shown as history, never as current state) and the task's inbox listing. `<id>` must be a task in the current snapshot.
- Pages: fleet overview, Decisions inbox, task detail. The Decisions inbox uses the snapshot's own `hints.open_decisions`, `hold_bucket == "live"` holds, and secondmates' `decisions_open`; status logs are never re-folded here (see `docs/architecture.md`, status files are append-only event logs).
- A snapshot whose `schema` is not `fm-fleet-snapshot.v1` is rejected by the server and the page, loudly, rather than rendered.

## Threat model

Binds `127.0.0.1` only; a request whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` is refused (DNS rebinding). Only `GET`/`HEAD` are served: phase 1 has no write endpoints. The snapshot script is run with `execFile` and an argument array, never a shell. Every fleet-derived string reaches the DOM through `textContent`, and a test forbids HTML-injecting sinks in the client code. Do not bind `0.0.0.0`.

## Fork hygiene

This fork is public. Nothing company-specific or containing PHI may ever be committed here: no real hostnames, ticket keys, repo names, project names, person names, or any data drawn from a real `FM_HOME`. Every test fixture, screenshot, and example in this directory uses synthetic placeholder data only (for example `demo-task-1`, `example.invalid`, `ACME-999`). If you need to validate against something that looks real, construct a fixture that looks real; never copy from a live operational home.

All of this lives under `webview/`, so `git merge upstream/main` stays conflict-free; the only upstream-owned file touched is one pointer line in the root `README.md`. `.github/workflows/webview-hygiene.yml` greps PRs that touch `webview/**` for ticket-key-shaped strings, SSN-shaped numbers, and obvious company markers. It is a heuristic net, not a guarantee.
