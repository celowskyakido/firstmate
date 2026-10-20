# Chat radar producer

A scheduled job that fills the dashboard's chat radar (see [`../README.md`](../README.md) "Chat radar") with real Slack and Teams items.
Each pass runs one headless `claude -p` session that reads Slack and an already-open Teams web tab read-only, writes one small result per source, and then `merge.js` folds both into `FM_HOME/data/radar.json` in the `fm-radar.v1` contract.
Slack and Teams are equal, independent sources: each reports its own health, and a failed source keeps its earlier items with its earlier read time instead of hiding or faking anything.

## Files

- `run.sh` - one pass: lock, working-hours check, `prepare.js`, `claude -p` under a hard timeout, `merge.js`, log line.
- `prepare.js` - reads the private config and the backlog, renders `prompt.md`, and builds the `claude` arguments.
- `prompt.md` - the producer's instructions (rules below); every operator-specific value is filled in at run time.
- `teams-read.js` - the single script the producer runs in the Teams tab: it scrolls the left rail and reads the page's own local cache, with no clicks, typing, or network calls.
- `merge.js` - validates each source's result, carries `firstSeen` and `state` forward by id, drops items older than the lookback, and writes `radar.json` with a temp file and rename after checking it with the dashboard's own parser.
- `com.firstmate.radar-producer.plist.example` - a macOS LaunchAgent that runs `run.sh` every 30 minutes.
- Tests: [`../tests/radar-producer.test.js`](../tests/radar-producer.test.js), run with the rest of the dashboard tests.

## Rules

An item is flagged when any rule matches; its `why` is built from the rule and the matched token, never from message text.

1. Direct mentions of the operator.
2. DMs and group DMs from someone else with no later message from the operator.
3. Replies from others in threads the operator is in, newer than the operator's own last message there.
4. References to tracked work: Jira-style keys found in open (not Done) items of `FM_HOME/data/backlog.md`, each linked to its task ids so the task card gets a chat badge (Slack only; the Teams read never looks at message text).

Teams contributes its own unread mentions, replies, DMs, group chats, and followed channels from the open tab.
The operator's own messages, bots, the deny list, and anything older than `lookbackHours` are left out.

## Limits

- Read only: the session may only use Slack search and thread read, the browser's page list and script evaluation, and writes to its two result files; every Slack and browser action tool is explicitly denied, and anything else is refused without prompting (`--permission-mode dontAsk`).
- Teams is read only from a tab that is already open; the producer never opens or navigates Teams, because loading Teams reopens the last chat, and never opens the Activity app.
  With no Teams tab, Teams reads as failed with `no Teams tab open`.
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
  "tools": { "slack": "mcp__plugin_slack_slack", "chrome": "mcp__chrome-devtools" },
  "chromeMcp": { "type": "stdio", "command": "npx", "args": ["-y", "chrome-devtools-mcp@latest", "--autoConnect"] }
}
```

- `deny.channels` matches a Slack channel id or a channel or chat name; `deny.senders` matches a display name.
- `maxAgeMinutes` is how old a source's last read may be before the dashboard marks it out of date.
- `hours` is local time, `end` exclusive, `days` 0 = Sunday; `run.sh --any-time` ignores it.
- `tools` are the MCP tool-name prefixes of the Slack server and the browser server in the operator's Claude Code setup.
- `chromeMcp` is optional: when set, it is added as a dedicated browser server for the producer (and replaces `tools.chrome`), for example `--autoConnect` to reach the operator's own running Chrome where the Teams tab lives.
  Without it, the producer uses whatever browser the `tools.chrome` server controls, which must have the Teams tab open.

## Install

1. Create `FM_HOME/config/radar.json` as above, sign in to the Slack MCP once in an interactive Claude Code session, and keep a Teams web tab open in the browser the producer reaches.
2. Run one pass by hand and read the result: `FM_HOME=/path/to/home webview/radar-producer/run.sh --any-time`, then `tail FM_HOME/state/radar-producer.log`.
3. Copy the plist to `~/Library/LaunchAgents/com.firstmate.radar-producer.plist`, replace its placeholders (the `PATH` must reach `node` and `claude`), and load it: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.firstmate.radar-producer.plist`.
4. To stop it: `launchctl bootout gui/$(id -u)/com.firstmate.radar-producer`.

Each pass logs one start line and one result line, such as `done: slack ok 7; teams unavailable 0 (no Teams tab open)`, to `FM_HOME/state/radar-producer.log`; a pass that finds another still running, or runs outside working hours, logs a skip and exits.
Working files (the rendered prompt and the per-source results) live in `FM_HOME/state/radar-producer/`.
