#!/usr/bin/env bash
# fm-calls-herdr.sh - open or focus the `calls` tab running bin/fm-calls.sh.
#
# Usage: fm-calls-herdr.sh
#
# The tab lives in this home's own Herdr workspace (`firstmate`, or
# `2ndmate-<id>` in a second mate's home; bin/backends/herdr.sh's
# fm_backend_herdr_workspace_label owns the label) in the session
# fm_backend_herdr_session resolves. The workspace is found or created through
# fm_backend_herdr_workspace_ensure, so a duplicate home label refuses rather
# than guessing.
# An existing tab labeled `calls` there is focused, never duplicated.
# Otherwise a new focused `calls` tab is created and runs the view with this
# home's FM_HOME; the view is exec'd, so quitting it closes the tab and the next
# launch starts a fresh one.
#
# This only adds and focuses a tab: it never starts, stops, or restarts a Herdr
# server, and refuses when the session's server is not running.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=bin/fm-backend.sh
. "$SCRIPT_DIR/fm-backend.sh"
export FM_HOME

TAB_LABEL=calls

die() { printf 'fm-calls-herdr: %s\n' "$*" >&2; exit 1; }

case "${1:-}" in
  '') ;;
  -h|--help) printf 'usage: fm-calls-herdr.sh   (open or focus the calls tab)\n'; exit 0 ;;
  *) printf 'usage: fm-calls-herdr.sh\n' >&2; exit 2 ;;
esac

fm_backend_source herdr || die "could not load the Herdr backend"
fm_backend_herdr_version_check || exit 1
session=$(fm_backend_herdr_session)
[ "$(fm_backend_herdr_server_running_state "$session")" = running ] \
  || die "no running Herdr server for session '$session'; start Herdr first"

# A plain statement: the ensure reports through globals a subshell would drop.
fm_backend_herdr_workspace_ensure "$session" "$FM_HOME" home >/dev/null \
  || die "could not find or create workspace '$(fm_backend_herdr_workspace_label)' in session '$session'"
workspace=$FM_BACKEND_HERDR_WS_ID
seeded_tab=$FM_BACKEND_HERDR_WS_SEEDED_TAB_ID

tabs=$(fm_backend_herdr_cli "$session" tab list --workspace "$workspace") \
  || die "could not list the tabs of workspace $workspace"
existing=$(printf '%s' "$tabs" | jq -r --arg want "$TAB_LABEL" \
  'first(.result.tabs[]? | select(.label == $want) | .tab_id) // empty') \
  || die "could not read the tab list of workspace $workspace"
if [ -n "$existing" ]; then
  fm_backend_herdr_cli "$session" tab focus "$existing" >/dev/null || die "could not focus tab $existing"
  printf 'focused the %s tab (%s:%s)\n' "$TAB_LABEL" "$session" "$existing"
  exit 0
fi

out=$(fm_backend_herdr_cli "$session" tab create --workspace "$workspace" --cwd "$FM_HOME" --label "$TAB_LABEL" --focus) \
  || die "could not create the $TAB_LABEL tab in workspace $workspace"
tab=$(printf '%s' "$out" | jq -r '.result.tab.tab_id // empty' 2>/dev/null)
pane=$(printf '%s' "$out" | jq -r '.result.root_pane.pane_id // empty' 2>/dev/null)
[ -n "$tab" ] && [ -n "$pane" ] || die "could not read the new tab's ids from Herdr's reply"
fm_backend_herdr_workspace_prune_seeded_default_tab "$session" "$workspace" "$seeded_tab"
# The pane's shell inherits the server's environment, not this one, so the home
# travels on the command line.
fm_backend_herdr_cli "$session" pane run "$pane" \
  "$(printf 'exec env FM_HOME=%q %q' "$FM_HOME" "$SCRIPT_DIR/fm-calls.sh")" >/dev/null \
  || die "could not start the view in pane $pane"
printf 'opened the %s tab (%s:%s)\n' "$TAB_LABEL" "$session" "$tab"
