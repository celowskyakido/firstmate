#!/usr/bin/env bash
# fm-calls.sh - a terminal view of the captain calls waiting on the captain.
#
# The interactive view is an fzf list of the live captain calls with a preview
# pane holding each call's full question and options. From it the captain can
# answer a call in their own words, defer it to a date, or refresh the list.
# bin/fm-calls-herdr.sh opens it in a dedicated Herdr tab.
#
# Every write goes through bin/fm-captain-hold.sh, which owns the hold, answer,
# release, and defer semantics; this script never edits a backlog record, sends
# a message, or decides anything for the captain. The list comes from
# `bin/fm-bearings-snapshot.sh --json` (its live `decisions_open` rows, never
# prose) and each call's full detail from `bin/fm-tasks-axi.sh show`, whose
# structured fields decide how an answer closes:
#   - a call of kind `captain` is a question, so the answer closes it
#     (`fm-captain-hold.sh answer <id> --decision-file <file>`);
#   - any other kind is held work, so the answer lets it go ahead
#     (`... answer <id> --decision-file <file> --release`);
#   - with no recorded kind the captain picks which.
# A call owned by a second mate's home is shown read-only: only that home can
# record its answer, so the captain tells firstmate in chat.
#
# The captain's words are read raw from the terminal and written straight to a
# private temporary file whose path is the only thing passed on, so quotes,
# backslashes, line breaks, and shell metacharacters reach the record verbatim
# and never pass through a command line or an fzf placeholder.
#
# Usage:
#   fm-calls.sh                       the interactive view (needs fzf and a terminal)
#   fm-calls.sh list                  one tab-separated row per live call: id, owner, label
#   fm-calls.sh show <id> [<owner> [<label>]]   the call's full detail, as the preview shows it
#   fm-calls.sh answer <id> [<owner>] read the captain's answer from stdin and record it
#   fm-calls.sh defer <id> [<owner>]  read a YYYY-MM-DD date from stdin and defer the call to it
#
# `answer` reads lines until a line holding only `.` or end of input, then asks
# for a `y` before recording; `defer` reads one date line. An empty answer or
# date, or anything but `y`, records nothing. Both first confirm through
# `fm-captain-hold.sh open` that the call is still open, so an entry left over
# from an older list cannot be answered twice.
# `list` prints one row whose id is `-` and whose label explains the failure
# when the snapshot cannot be read, and exits 1.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-$FM_ROOT}"
export FM_HOME

SAFE_ID='^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$'
MAIN_OWNER='(main)'
# fm-captain-hold.sh refuses a longer decision file; saying so before the
# confirmation keeps the captain from typing an answer that cannot land.
ANSWER_MAX_BYTES=8192

usage() {
  cat <<'EOF'
usage: fm-calls.sh                       interactive view of the open captain calls
       fm-calls.sh list                  tab-separated rows: id, owner, label
       fm-calls.sh show <id> [<owner> [<label>]]
       fm-calls.sh answer <id> [<owner>] answer from stdin, ending at a lone "." line
       fm-calls.sh defer <id> [<owner>]  a YYYY-MM-DD date from stdin
EOF
}

die() { printf 'fm-calls: %s\n' "$*" >&2; exit 2; }

# The captain is reading this between keystrokes, so every outcome waits for
# Enter before the list redraws over it. A closed stdin returns at once.
pause() { printf '\nPress Enter to return to the list.'; IFS= read -r _ || true; printf '\n'; }

require_id() {  # <id> <owner>
  printf '%s' "$1" | grep -Eq "$SAFE_ID" || die "not a call id this view will pass on: $1"
}

is_main() { [ "${1:-$MAIN_OWNER}" = "$MAIN_OWNER" ]; }

read_only_note() {  # <owner>
  printf 'This call lives in second mate %s'"'"'s home, so it cannot be answered here.\n' "$1"
  printf 'Tell firstmate your answer in chat and it will relay it.\n'
}

# One scalar field of `fm-tasks-axi.sh show`: an indented `name: value` line
# whose value is either bare or a JSON string, so embedded line breaks arrive
# escaped on one physical line. `-` is the empty marker.
show_field() {  # <show-output> <field>
  local value
  value=$(printf '%s\n' "$1" | sed -n "s/^  $2: //p" | head -1)
  case "$value" in
    \"*\") value=$(printf '%s' "$value" | jq -r . 2>/dev/null) || value='' ;;
  esac
  [ "$value" != - ] || value=''
  printf '%s' "$value"
}

task_show() {  # <id>
  "$SCRIPT_DIR/fm-tasks-axi.sh" show "$1" 2>/dev/null
}

# close|release|'' from the call's kind; see the header.
answer_mode() {  # <show-output>
  local kind
  kind=$(show_field "$1" kind)
  case "$kind" in
    '') printf '' ;;
    captain) printf 'close' ;;
    *) printf 'release' ;;
  esac
}

effect_of() {  # <mode>
  case "$1" in
    close) printf 'Records your words and closes the question.' ;;
    release) printf 'Records your words and lets the held work go ahead.' ;;
    *) printf 'Records your words; you choose whether to close the question or let the held work go ahead.' ;;
  esac
}

command_list() {
  local snapshot err
  err=$(mktemp "${TMPDIR:-/tmp}/fm-calls-list.XXXXXX") || die "could not create a temporary file"
  # Every live call, not the digest's default page of them.
  if snapshot=$(FM_BEARINGS_DECISIONS=${FM_CALLS_LIMIT:-1000} "$SCRIPT_DIR/fm-bearings-snapshot.sh" --json 2>"$err") \
    && printf '%s' "$snapshot" | jq -e '.decisions_open | type == "array"' >/dev/null 2>&1; then
    rm -f "$err"
    printf '%s' "$snapshot" | jq -r --arg main "$MAIN_OWNER" '
      .decisions_open[]
      | select(.verb == "captain-hold")
      | [.id, (.owner // $main),
         (if (.owner // $main) == $main then .summary else "[\(.owner)] \(.summary)" end)]
      | @tsv'
    return 0
  fi
  printf -- '-\t%s\tcould not read the open calls: %s\n' "$MAIN_OWNER" \
    "$(grep -v '^[[:space:]]*$' "$err" | head -1 | tr '\t' ' ')"
  rm -f "$err"
  return 1
}

command_show() {  # <id> [<owner> [<label>]]
  local id=${1:-} owner=${2:-$MAIN_OWNER} label=${3:-} show reason
  [ -n "$id" ] || die "show needs a call id"
  if [ "$id" = - ]; then
    printf '%s\n\nPress Ctrl-R to try again.\n' "$label"
    return 0
  fi
  if ! is_main "$owner"; then
    printf '%s\n\n' "$label"
    read_only_note "$owner"
    return 0
  fi
  require_id "$id"
  show=$(task_show "$id") || { printf 'Could not read call %s; it may have just been closed. Press Ctrl-R to refresh.\n' "$id"; return 0; }
  reason=$(show_field "$show" hold_reason)
  printf '%s\n' "$(show_field "$show" title)"
  printf 'call: %s   repo: %s   kind: %s\n' "$id" "$(show_field "$show" repo)" "$(show_field "$show" kind)"
  [ -z "$(show_field "$show" hold_until)" ] || printf 'deferred until: %s\n' "$(show_field "$show" hold_until)"
  printf '\n%s\n\n' "${reason:-(no question recorded)}"
  printf 'Enter: %s\n' "$(effect_of "$(answer_mode "$show")")"
}

# 0 when <id> is still an open captain call; otherwise say why and fail.
still_open() {  # <id>
  local status=0
  "$SCRIPT_DIR/fm-captain-hold.sh" open "$1" >/dev/null 2>&1 || status=$?
  case "$status" in
    0) return 0 ;;
    1) printf 'Call %s is no longer waiting on you; the list will refresh.\n' "$1" ;;
    *) printf 'Could not tell whether call %s is still open, so nothing was recorded.\n' "$1" ;;
  esac
  return 1
}

command_answer() {  # <id> [<owner>]
  local id=${1:-} owner=${2:-$MAIN_OWNER} show mode choice line file dir bytes confirm status=0
  local -a release=()
  [ -n "$id" ] && [ "$id" != - ] || { printf 'Nothing to answer.\n'; pause; return 0; }
  if ! is_main "$owner"; then read_only_note "$owner"; pause; return 0; fi
  require_id "$id"
  still_open "$id" || { pause; return 0; }
  show=$(task_show "$id") || { printf 'Could not read call %s, so nothing was recorded.\n' "$id"; pause; return 0; }
  mode=$(answer_mode "$show")
  command_show "$id"
  if [ -z "$mode" ]; then
    printf '\nShould your answer close the question (c) or let the held work go ahead (r)? '
    IFS= read -r choice || choice=''
    case "$choice" in
      c|C) mode=close ;;
      r|R) mode=release ;;
      *) printf 'Nothing was recorded.\n'; pause; return 0 ;;
    esac
  fi
  dir=$(mktemp -d "${TMPDIR:-/tmp}/fm-calls-answer.XXXXXX") || die "could not create a temporary directory"
  chmod 700 "$dir"
  # shellcheck disable=SC2064  # bind this call's own directory now
  trap "rm -rf '$dir'" EXIT
  file="$dir/decision.txt"
  : > "$file"
  printf '\nType your answer. Finish with a line holding only "." or press Ctrl-D; Ctrl-C cancels.\n'
  while IFS= read -r line || [ -n "$line" ]; do
    [ "$line" != . ] || break
    printf '%s\n' "$line" >> "$file"
  done
  if ! grep -q '[^[:space:]]' "$file"; then
    printf 'Your answer was empty, so nothing was recorded.\n'; pause; return 0
  fi
  bytes=$(wc -c < "$file" | tr -d '[:space:]')
  if [ "$bytes" -gt "$ANSWER_MAX_BYTES" ]; then
    printf 'Your answer is %s bytes; the most a call can record is %s. Nothing was recorded.\n' "$bytes" "$ANSWER_MAX_BYTES"
    pause; return 0
  fi
  printf '\nYour answer:\n'
  sed 's/^/  | /' "$file"
  printf '\n%s Record it? [y/N] ' "$(effect_of "$mode")"
  IFS= read -r confirm || confirm=''
  case "$confirm" in
    y|Y) ;;
    *) printf 'Nothing was recorded.\n'; pause; return 0 ;;
  esac
  [ "$mode" != release ] || release=(--release)
  "$SCRIPT_DIR/fm-captain-hold.sh" answer "$id" --decision-file "$file" ${release[@]+"${release[@]}"} || status=$?
  if [ "$status" -eq 0 ]; then
    printf 'Recorded.\n'
  else
    printf 'The answer was not recorded (fm-captain-hold.sh exited %s).\n' "$status"
  fi
  pause
  return 0
}

command_defer() {  # <id> [<owner>]
  local id=${1:-} owner=${2:-$MAIN_OWNER} show reason until today status=0
  [ -n "$id" ] && [ "$id" != - ] || { printf 'Nothing to defer.\n'; pause; return 0; }
  if ! is_main "$owner"; then read_only_note "$owner"; pause; return 0; fi
  require_id "$id"
  still_open "$id" || { pause; return 0; }
  show=$(task_show "$id") || { printf 'Could not read call %s, so nothing was deferred.\n' "$id"; pause; return 0; }
  # Holding again needs the hold's own reason; the date is the only change.
  reason=$(show_field "$show" hold_reason)
  [ -n "$reason" ] || { printf 'Call %s has no recorded hold reason, so it cannot be held again with a date.\n' "$id"; pause; return 0; }
  printf 'Defer "%s" until which date (YYYY-MM-DD)? Leave it empty to cancel: ' "$(show_field "$show" title)"
  IFS= read -r until || until=''
  [ -n "$until" ] || { printf 'Nothing was deferred.\n'; pause; return 0; }
  if ! printf '%s' "$until" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' \
    || ! perl -MTime::Local=timegm -e 'my ($y, $m, $d) = split /-/, shift; timegm(0, 0, 0, $d, $m - 1, $y)' "$until" 2>/dev/null; then
    printf '%s is not a YYYY-MM-DD date, so nothing was deferred.\n' "$until"; pause; return 0
  fi
  today=$(date -u +%Y-%m-%d)
  if [[ ! "$until" > "$today" ]]; then
    printf '%s is not after today (%s), so nothing was deferred.\n' "$until" "$today"; pause; return 0
  fi
  "$SCRIPT_DIR/fm-captain-hold.sh" hold "$id" --reason "$reason" --until "$until" >/dev/null || status=$?
  if [ "$status" -eq 0 ]; then
    printf 'Deferred until %s.\n' "$until"
  else
    printf 'The call was not deferred (fm-captain-hold.sh exited %s).\n' "$status"
  fi
  pause
  return 0
}

command_view() {
  local status=0
  command -v fzf >/dev/null 2>&1 || die "fzf is not installed; it is required for the interactive view"
  command -v jq >/dev/null 2>&1 || die "jq is not installed"
  [ -t 1 ] || die "the interactive view needs a terminal; use 'list' or 'show' for a plain read"
  # The bindings name this script through the environment so no path is ever
  # spliced into fzf's command strings, and fzf runs them under bash.
  FM_CALLS_SELF="$SCRIPT_DIR/fm-calls.sh"
  export FM_CALLS_SELF
  # shellcheck disable=SC2016  # fzf's own bash expands $FM_CALLS_SELF
  "$FM_CALLS_SELF" list | SHELL=$(command -v bash) fzf \
    --delimiter=$'\t' --with-nth=3 --layout=reverse --no-multi --no-sort \
    --prompt='captain calls> ' \
    --header='Enter: answer   Ctrl-T: defer to a date   Ctrl-R: refresh   Esc: quit' \
    --preview='"$FM_CALLS_SELF" show {1} {2} {3}' \
    --preview-window='right,60%,wrap' \
    --bind='enter:execute("$FM_CALLS_SELF" answer {1} {2})+reload-sync("$FM_CALLS_SELF" list)' \
    --bind='ctrl-t:execute("$FM_CALLS_SELF" defer {1} {2})+reload-sync("$FM_CALLS_SELF" list)' \
    --bind='ctrl-r:reload-sync("$FM_CALLS_SELF" list)' || status=$?
  # Esc and Ctrl-C both leave fzf with 130, which is the ordinary way out.
  [ "$status" -ne 130 ] || status=0
  return "$status"
}

case "${1:-}" in
  '') command_view ;;
  list) shift; command_list "$@" ;;
  show) shift; command_show "$@" ;;
  answer) shift; command_answer "$@" ;;
  defer) shift; command_defer "$@" ;;
  -h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
