#!/usr/bin/env bash
# One chat radar producer pass: prepare.js renders the prompt, one headless `claude -p` run reads Slack and the
# open Teams tab read-only and writes per-source results, then merge.js folds them into FM_HOME/data/radar.json.
# Usage: FM_HOME=<firstmate home> run.sh [--any-time]   (--any-time ignores the working-hours window)
# Skips when another pass is still running or outside working hours; logs to FM_HOME/state/radar-producer.log.
set -euo pipefail

: "${FM_HOME:?FM_HOME must name the firstmate home}"
here=$(cd "$(dirname "$0")" && pwd)
out="$FM_HOME/state/radar-producer"
lock="$out.lock"
log="$FM_HOME/state/radar-producer.log"
mkdir -p "$out"
say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$log"; }

if ! mkdir "$lock" 2>/dev/null; then
  holder=$(cat "$lock/pid" 2>/dev/null || true)
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    say "skip: pass $holder still running"
    exit 0
  fi
  rm -rf "$lock"
  mkdir "$lock"
fi
echo $$ >"$lock/pid"
trap 'rm -rf "$lock"' EXIT

rc=0
node "$here/prepare.js" "$FM_HOME" "$@" >"$out/argv" 2>>"$log" || rc=$?
if [ "$rc" = 3 ]; then
  say "skip: outside working hours"
  exit 0
fi
if [ "$rc" != 0 ]; then
  say "error: prepare failed (exit $rc); check config/radar.json"
  exit 1
fi
args=()
while IFS= read -r -d '' a; do args+=("$a"); done <"$out/argv"
timeout_s=${args[0]}

# Stale results from an earlier pass must never be merged as this pass's reads.
rm -f "$out/slack.json" "$out/teams.json" "$out/timeout"
say "start"
(cd "$out" && exec claude "${args[@]:1}" <prompt.txt >>"$log" 2>&1) &
pid=$!
(sleep "$timeout_s" && kill -TERM "$pid" 2>/dev/null && echo timeout >"$out/timeout") &
watchdog=$!
wait "$pid" && rc=0 || rc=$?
kill "$watchdog" 2>/dev/null && wait "$watchdog" 2>/dev/null || true
if [ -e "$out/timeout" ]; then
  rm -f "$out/timeout"
  say "claude stopped after the ${timeout_s}s timeout"
elif [ "$rc" != 0 ]; then
  say "claude exited $rc"
fi

if summary=$(node "$here/merge.js" "$FM_HOME" 2>&1); then say "done: $summary"; else say "$summary"; exit 1; fi
