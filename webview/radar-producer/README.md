# Chat radar producer

A scheduled job that fills the dashboard's chat radar (see [`../README.md`](../README.md) "Chat radar") with real Slack and Teams items.
Each pass reads Teams from a dedicated, minimized radar browser (`teams-scan.js`) while one headless `claude -p` session reads Slack, both read-only, each writing one small result; then `merge.js` folds both into `FM_HOME/data/radar.json` in the `fm-radar.v1` contract.
Slack and Teams are equal, independent sources: each reports its own health, and a failed source keeps its earlier items with its earlier read time instead of hiding or faking anything.

## Files

- `run.sh` - one pass: lock, working-hours check, `prepare.js`, then `teams-scan.js` beside `claude -p` (under a hard timeout), `merge.js`, log line.
- `prepare.js` - reads the private config and the backlog, renders `prompt.md`, and builds the `claude` arguments for the Slack read.
- `prompt.md` - the Slack session's instructions (rules below); every operator-specific value is filled in at run time.
- `chrome.js` - the dedicated radar browser: `setup`, `start`, `show`, `status`, and `stop` (see "Radar browser" below).
- `teams-scan.js` - the Teams read: attaches to the radar browser, reuses its one Teams tab, waits until Teams is ready, and runs `teams-read.js` there.
- `teams-read.js` - the script run in the Teams tab: it scrolls the left rail and reads the page's own local cache, with no clicks, typing, or network calls.
- `merge.js` - validates each source's result, carries `firstSeen` and `state` forward by id, drops items older than the lookback, and writes `radar.json` with a temp file and rename after checking it with the dashboard's own parser.
- `com.firstmate.radar-producer.plist.example` - a macOS LaunchAgent that runs `run.sh` every 30 minutes.
- Tests: [`../tests/radar-producer.test.js`](../tests/radar-producer.test.js) and [`../tests/radar-chrome.test.js`](../tests/radar-chrome.test.js), run with the rest of the dashboard tests; neither needs Chrome or an account.

## Rules

An item is flagged when any rule matches; its `why` is built from the rule and the matched token, never from message text.

1. Direct mentions of the operator.
2. DMs and group DMs from someone else with no later message from the operator.
3. Replies from others in threads the operator is in, newer than the operator's own last message there.
4. References to tracked work: Jira-style keys found in open (not Done) items of `FM_HOME/data/backlog.md`, each linked to its task ids so the task card gets a chat badge (Slack only; the Teams read never looks at message text).

Teams contributes its own unread mentions, replies, DMs, group chats, and followed channels from the radar browser's Teams tab.
The operator's own messages, bots, the deny list, and anything older than `lookbackHours` are left out.

## Limits

- Read only: the Slack session may only use Slack search and thread read and write its one result file; every Slack action tool is explicitly denied, and anything else is refused without prompting (`--permission-mode dontAsk`).
- The Teams scan never clicks, types, or navigates inside Teams; it never reads, prints, or stores a credential, and it never drives the sign-in page: 1Password and single sign-on get the readiness window to finish a sign-in on their own.
  It loads Teams only when the radar browser has no Teams tab (first scan, or after the browser or tab was closed), because a load reopens the last view, which could mark one chat read.
- Only the channel or chat name, sender display name, link, time, kind, `why`, and task ids are stored; `merge.js` writes only those fields whatever a result contains.
- The session runs with `--no-session-persistence`, so its transcript (which does see search results) is not saved.

## Configuration: `FM_HOME/config/radar.json`

This file is private to the home and never committed; only `slackUserId` is required.

```json
{
  "slackUserId": "U0123ABCD",
  "deny": { "channels": ["C0123NOISY", "#some-alerts"], "senders": ["Some Bot"] },
  "lookbackHours": 24,
  "maxAgeMinutes": 90,
  "hours": { "start": 8, "end": 19, "days": [1, 2, 3, 4, 5] },
  "model": "sonnet",
  "timeoutSeconds": 900,
  "tools": { "slack": "mcp__plugin_slack_slack" },
  "chrome": { "port": 9333 }
}
```

- `deny.channels` matches a Slack channel id or a channel or chat name; `deny.senders` matches a display name.
- `maxAgeMinutes` is how old a source's last read may be before the dashboard marks it out of date.
- `hours` is local time, `end` exclusive, `days` 0 = Sunday; `run.sh --any-time` ignores it.
- `tools.slack` is the MCP tool-name prefix of the Slack server in the operator's Claude Code setup.
- `chrome` is optional: `port` (default `9333`) is the radar browser's debugging port on 127.0.0.1, `app` (macOS, default `/Applications/Google Chrome.app`) or `binary` (any platform, a Chrome executable) picks the browser.

## Radar browser

The Teams scan uses its own Chrome, never the operator's everyday one: a separate profile in `FM_HOME/state/radar-chrome-profile` (captain-private like the rest of `state/`, created with mode 700), debugging on `127.0.0.1:<chrome.port>` only, with the Teams tab in its own minimized window.
Commands, each with `FM_HOME` set: `node webview/radar-producer/chrome.js setup|start|show|status|stop`.

- `setup` starts the browser and opens one normal window at the 1Password extension page and Teams, and prints the one-time steps (below).
- `start` starts it in the background; every scan does this itself when the browser is down, so it is only needed to warm it up.
- `show` restores the Teams window so you can sign in again; `status` says whether it runs and what the Teams tab shows (`ready`, `loading`, `needs-sign-in`, `interstitial`, `offline`); `stop` quits it.
- The port counts as the radar browser's only when the process listening on it was started with this profile; anything else on the port is refused with a message to set `chrome.port`.

How it stays out of the way (checked on macOS 26 with Chrome 156, 2026-10-22, by sampling the frontmost app every 250 ms through launch and scans):

- The browser is launched with `open -n -g -j` and `--no-startup-window`, so no window exists at launch and Chrome never becomes the active app.
  Without `--no-startup-window`, Chrome activated itself for about a second even under `open -g -j`.
- The Teams tab is created over CDP as `newWindow`, `windowState: "minimized"`, `focus: false`, `background: true`; it stays minimized and unfocused, and the page still renders (visible, animation frames running), helped by the `--disable-backgrounding-occluded-windows` family of flags.
- On macOS the radar browser shows as a second Chrome icon in the Dock; `show` restores its window but macOS does not let it take focus from the active app, so click that icon.

Each scan:

1. Attaches to the radar browser, starting it when it is down (waiting for its port with backoff, up to 20 s).
2. Reuses the remembered Teams tab (its id is kept in `state/radar-producer/teams-tab`), else any Teams tab, else opens one as above.
3. Waits, with backoff from 0.5 s up to 5 s for at most 90 s, until the chat list has rendered, nothing is still loading, and the network has been quiet for 1.5 s; a stuck load gets exactly one reload, a sign-in page never does.
4. Reports a sign-in, MFA, or account page as `needs sign-in`, a dialog as `Teams shows a dialog or prompt`, and an endless load as `Teams did not finish loading`, never as an empty list.
5. Runs `teams-read.js` and writes `teams.json`; the whole scan stops after 240 s.

A failed Teams read keeps the last good Teams items and their `readAt`, and its source in `radar.json` gets `staleSince` (the first failed read since the last good one) and, for a sign-in page, `needsSignIn: true`.
Overlapping passes cannot collide: `run.sh` holds `state/radar-producer.lock` for the whole pass, and a second pass logs a skip.
Every Teams step logs one line such as `teams step=wait state=ready` or `teams step=failed at=tab error="..."` to `state/radar-producer.log`, with states and counts only, never page content.

### One-time setup

1. `FM_HOME=/path/to/home node webview/radar-producer/chrome.js setup` (Node 22 or later, for its built-in WebSocket).
2. In the window it opens, add the 1Password extension from the Chrome Web Store tab and sign in to 1Password once.
3. On the Teams tab, sign in (let 1Password fill it), tick "Stay signed in", and then open Calendar, so a later load reopens there instead of a chat.
4. Close the window; the browser keeps running in the background, and the next scan opens Teams in its own minimized window.

Slack is read through the Slack MCP server, not this browser, so it needs no tab or sign-in here.

### Troubleshooting

- `Teams radar failed: needs sign-in: ...` on the dashboard: run `chrome.js show`, sign in in the restored window, and minimize it; the next pass clears it.
- `127.0.0.1:9333 belongs to another program`: set another `chrome.port` in `config/radar.json`.
- `the radar browser did not open 127.0.0.1:<port> within 20s`: check that `chrome.app` or `chrome.binary` points at Chrome, and run `chrome.js stop` then `chrome.js start`.
- `Teams did not finish loading` or `Teams shows a dialog or prompt`: run `chrome.js show` and look at the tab; `chrome.js status` re-checks it without a full pass.
- To start over, `chrome.js stop` and delete `FM_HOME/state/radar-chrome-profile`, then run `setup` again.

## Install

1. Create `FM_HOME/config/radar.json` as above, sign in to the Slack MCP once in an interactive Claude Code session, and do the radar browser's one-time setup above.
2. Run one pass by hand and read the result: `FM_HOME=/path/to/home webview/radar-producer/run.sh --any-time`, then `tail FM_HOME/state/radar-producer.log`.
3. Copy the plist to `~/Library/LaunchAgents/com.firstmate.radar-producer.plist`, replace its placeholders (the `PATH` must reach `node` 22 or later and `claude`), and load it: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.firstmate.radar-producer.plist`.
4. To stop it: `launchctl bootout gui/$(id -u)/com.firstmate.radar-producer`.

Each pass logs one start line and one result line, such as `done: slack ok 7; teams unavailable 0 (needs sign-in: Teams went to a sign-in page; run chrome.js show and sign in)`, to `FM_HOME/state/radar-producer.log`; a pass that finds another still running, or runs outside working hours, logs a skip and exits.
Working files (the rendered prompt and the per-source results) live in `FM_HOME/state/radar-producer/`.
