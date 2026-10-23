#!/usr/bin/env bash
# Behavior tests for bin/fm-calls.sh and bin/fm-calls-herdr.sh: a fixture
# bearings snapshot and backlog read go in, and the exact fm-captain-hold.sh
# invocations, decision-file bytes, and Herdr CLI calls come out. Nothing here
# writes a real captain hold or reaches a real Herdr server.
set -u

# shellcheck source=tests/lib.sh
# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

command -v jq >/dev/null 2>&1 || { echo "skip: jq not found"; exit 0; }

TMP_ROOT=$(fm_test_tmproot fm-calls)
TOMORROW=$(perl -MPOSIX=strftime -e 'print strftime("%Y-%m-%d", gmtime(time + 86400))')
YESTERDAY=$(perl -MPOSIX=strftime -e 'print strftime("%Y-%m-%d", gmtime(time - 86400))')

# --- fm-calls.sh world --------------------------------------------------------
# A private bin/ holding the real fm-calls.sh beside recording stand-ins for the
# three scripts it drives, so every call it makes is observable.
make_world() {  # <name>
  local world="$TMP_ROOT/$1"
  mkdir -p "$world/bin" "$world/home/state" "$world/log" "$world/tmp"
  cp "$ROOT/bin/fm-calls.sh" "$world/bin/"
  cat > "$world/bin/fm-bearings-snapshot.sh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_LOG/bearings.args"
[ -z "${FAKE_BEARINGS_FAIL:-}" ] || { printf '\nbearings: %s\n' "$FAKE_BEARINGS_FAIL" >&2; exit 3; }
printf 'FM_BEARINGS_DECISIONS=%s\n' "${FM_BEARINGS_DECISIONS:-}" >> "$FAKE_LOG/bearings.env"
cat "$FAKE_LOG/../snapshot.json"
SH
  cat > "$world/bin/fm-tasks-axi.sh" <<'SH'
#!/usr/bin/env bash
[ "$1" = show ] || exit 9
[ -f "$FAKE_LOG/../show.$2" ] || { echo "error: no such task $2" >&2; exit 1; }
cat "$FAKE_LOG/../show.$2"
SH
  cat > "$world/bin/fm-captain-hold.sh" <<'SH'
#!/usr/bin/env bash
n=1
while [ -e "$FAKE_LOG/call.$n" ]; do n=$((n + 1)); done
printf '%s\n' "$@" > "$FAKE_LOG/call.$n"
printf 'FM_HOME=%s\n' "$FM_HOME" > "$FAKE_LOG/env.$n"
case "$1" in
  open) exit "${FAKE_OPEN_STATUS:-0}" ;;
  answer) cp "$4" "$FAKE_LOG/decision.$n"; printf '%s\n' "$4" > "$FAKE_LOG/decision-path.$n" ;;
esac
exit "${FAKE_HOLD_STATUS:-0}"
SH
  chmod +x "$world/bin/"*.sh
  cat > "$world/snapshot.json" <<'JSON'
{"schema":"fm-bearings.v1","decisions_open":[
  {"id":"pick-db","key":"pick-db","verb":"captain-hold","summary":"Pick the database: (A) keep MySQL (B) move to Postgres","owner":"(main)"},
  {"id":"ship-gate","key":"ship-gate","verb":"captain-hold","summary":"Ship gate: approve the rollout","owner":"(main)"},
  {"id":"orders/sm-call","key":"sm-call","verb":"captain-hold","summary":"Second mate call","owner":"orders"}
]}
JSON
  # tasks-axi's show shape: two-space fields, JSON-quoted strings, `-` empty.
  cat > "$world/show.pick-db" <<'TOON'
task:
  id: pick-db
  title: Pick the database
  state: queued
  held: yes
  hold_reason: "Which database?\n(A) keep MySQL\n(B) move to Postgres \"now\""
  hold_kind: captain
  hold_until: "-"
  kind: captain
  repo: service-orders
TOON
  cat > "$world/show.ship-gate" <<'TOON'
task:
  id: ship-gate
  title: Ship the rollout
  state: queued
  held: yes
  hold_reason: Approve the rollout
  hold_kind: captain
  hold_until: "-"
  kind: ship
  repo: firstmate
TOON
  sed -e 's/^  kind: ship$/  kind: "-"/' -e 's/ship-gate/no-kind/' "$world/show.ship-gate" > "$world/show.no-kind"
  printf '%s\n' "$world"
}

calls() {  # <world> <args...>  (stdin passes through)
  local world=$1
  shift
  FAKE_LOG="$world/log" FM_HOME="$world/home" TMPDIR="$world/tmp" "$world/bin/fm-calls.sh" "$@"
}

hold_calls() {  # <world>: every non-`open` fm-captain-hold.sh call, one argv per block
  local n=1
  while [ -f "$1/log/call.$n" ]; do
    [ "$(head -1 "$1/log/call.$n")" = open ] || { cat "$1/log/call.$n"; printf -- '--\n'; }
    n=$((n + 1))
  done
}

answer_path() { cat "$1"/log/decision-path.*; }  # <world>
answer_copy() { printf '%s\n' "$1"/log/decision.[0-9]*; }  # <world>

# --- list -------------------------------------------------------------------

world=$(make_world list)
out=$(calls "$world" list) || fail "list exits 0 on a readable snapshot"
expected=$(printf 'pick-db\t(main)\tPick the database: (A) keep MySQL (B) move to Postgres\nship-gate\t(main)\tShip gate: approve the rollout\norders/sm-call\torders\t[orders] Second mate call')
assert_equals "$expected" "$out" "list prints one id/owner/label row per live call"
assert_equals "--json" "$(cat "$world/log/bearings.args")" "list reads the structured bearings JSON"
assert_equals "FM_BEARINGS_DECISIONS=1000" "$(cat "$world/log/bearings.env")" "list asks for every live call, not the default page"
pass "list projects bearings decisions_open rows"

out=$(FAKE_BEARINGS_FAIL='away window active' calls "$world" list) && fail "list exits nonzero when the snapshot fails"
assert_equals "$(printf -- '-\t(main)\tcould not read the open calls: bearings: away window active')" "$out" \
  "a failed snapshot becomes one explanatory row"
pass "list reports an unreadable snapshot as a row"

# --- show -------------------------------------------------------------------

out=$(calls "$world" show pick-db)
assert_contains "$out" "Pick the database" "show prints the title"
assert_contains "$out" $'Which database?\n(A) keep MySQL\n(B) move to Postgres "now"' "show prints the full decoded question with its options"
assert_contains "$out" "closes the question" "show states a question's answer closes it"
out=$(calls "$world" show ship-gate)
assert_contains "$out" "lets the held work go ahead" "show states a work item's answer releases it"
out=$(calls "$world" show orders/sm-call orders '[orders] Second mate call')
assert_contains "$out" "[orders] Second mate call" "show of a second mate's call prints its label"
assert_contains "$out" "Tell firstmate" "show of a second mate's call says where to answer"
pass "show renders the full call"

# --- answer: a question, with hostile text -----------------------------------

world=$(make_world answer-question)
canary="$world/canary"
# Quotes, backslashes, command substitution, backticks, globs, a tab, a blank
# line, and a line that is only a dot inside other text must all arrive verbatim.
answer_text=$(printf '%s\n' \
  "Option (B) - \"Postgres\" isn't 'optional'" \
  "\$(touch $canary) \`touch $canary\` \${HOME} * ; | & > <" \
  'back\slash \n literal' \
  '' \
  $'\ttabbed . line')
printf '%s\n.\ny\n' "$answer_text" | calls "$world" answer pick-db '(main)' > "$world/out" \
  || fail "answer exits 0"
assert_absent "$canary" "no part of the answer was executed"
assert_equals "$(printf 'answer\npick-db\n--decision-file\n%s\n--' "$(answer_path "$world")")" \
  "$(hold_calls "$world")" "a question is answered with exactly answer <id> --decision-file <file>"
assert_equals "$answer_text" "$(cat "$(answer_copy "$world")")" "the decision file holds the captain's words byte for byte"
assert_equals "$(printf '%s\n' "$answer_text" | wc -c)" "$(wc -c < "$(answer_copy "$world")")" "the decision file ends with exactly one newline"
assert_equals "open" "$(head -1 "$world/log/call.1")" "answer first checks the call is still open"
assert_equals "FM_HOME=$world/home" "$(cat "$world"/log/env.2)" "fm-captain-hold.sh addresses this home"
assert_absent "$(answer_path "$world")" "the temporary decision file is removed afterwards"
assert_contains "$(cat "$world/out")" "Recorded." "answer confirms the recorded answer"
pass "answer passes hostile free text only through the decision file"

# --- answer: held work is released ------------------------------------------

world=$(make_world answer-work)
printf 'go ahead\n.\ny\n' | calls "$world" answer ship-gate > /dev/null
assert_equals "$(printf 'answer\nship-gate\n--decision-file\n%s\n--release\n--' "$(answer_path "$world")")" \
  "$(hold_calls "$world")" "held work is answered with --release"
assert_equals "go ahead" "$(cat "$(answer_copy "$world")")" "the release records the captain's words"
pass "answer releases a held work item"

# End of input ends the answer just like a lone dot; no trailing newline needed.
world=$(make_world answer-eof)
printf 'last line no newline' | calls "$world" answer ship-gate > "$world/out"
assert_equals "" "$(hold_calls "$world")" "input that ends before a confirmation records nothing"
pass "answer without a confirmation records nothing"

# --- answer: unknown kind asks the captain ----------------------------------

world=$(make_world answer-no-kind)
printf 'r\nresume it\n.\ny\n' | calls "$world" answer no-kind > /dev/null
assert_equals "$(printf 'answer\nno-kind\n--decision-file\n%s\n--release\n--' "$(answer_path "$world")")" \
  "$(hold_calls "$world")" "the captain's r choice releases a call with no recorded kind"
world=$(make_world answer-no-kind-close)
printf 'c\nclose it\n.\ny\n' | calls "$world" answer no-kind > /dev/null
assert_equals "$(printf 'answer\nno-kind\n--decision-file\n%s\n--' "$(answer_path "$world")")" \
  "$(hold_calls "$world")" "the captain's c choice closes a call with no recorded kind"
world=$(make_world answer-no-kind-skip)
printf 'x\nwhatever\n.\ny\n' | calls "$world" answer no-kind > /dev/null
assert_equals "" "$(hold_calls "$world")" "any other choice records nothing"
pass "answer asks how to close a call with no recorded kind"

# --- answer: every refusal records nothing ----------------------------------

world=$(make_world answer-declined)
printf 'my answer\n.\nn\n' | calls "$world" answer pick-db > /dev/null
assert_equals "" "$(hold_calls "$world")" "declining the confirmation records nothing"

world=$(make_world answer-empty)
printf '  \n\n.\ny\n' | calls "$world" answer pick-db > "$world/out"
assert_equals "" "$(hold_calls "$world")" "a blank answer records nothing"
assert_contains "$(cat "$world/out")" "empty" "a blank answer is explained"

world=$(make_world answer-too-long)
{ head -c 9000 /dev/zero | tr '\0' 'x'; printf '\n.\ny\n'; } | calls "$world" answer pick-db > "$world/out"
assert_equals "" "$(hold_calls "$world")" "an answer over the record limit records nothing"
assert_contains "$(cat "$world/out")" "8192" "the record limit is named"

world=$(make_world answer-closed)
printf 'late\n.\ny\n' | FAKE_OPEN_STATUS=1 calls "$world" answer pick-db > "$world/out"
assert_equals "" "$(hold_calls "$world")" "a call that is no longer open is not answered"
assert_contains "$(cat "$world/out")" "no longer waiting" "a closed call is explained"
printf 'late\n.\ny\n' | FAKE_OPEN_STATUS=2 calls "$world" answer pick-db > "$world/out"
assert_equals "" "$(hold_calls "$world")" "an undecidable open check records nothing"

world=$(make_world answer-secondmate)
printf 'mine\n.\ny\n' | calls "$world" answer orders/sm-call orders > "$world/out"
assert_absent "$world/log/call.1" "a second mate's call never reaches fm-captain-hold.sh"
assert_contains "$(cat "$world/out")" "Tell firstmate" "a second mate's call says where to answer"

world=$(make_world answer-bad-id)
printf 'x\n.\ny\n' | calls "$world" answer '-rf;id' 2>/dev/null && fail "an unsafe id is refused"
assert_absent "$world/log/call.1" "an unsafe id never reaches fm-captain-hold.sh"

world=$(make_world answer-failed)
printf 'ok\n.\ny\n' | FAKE_HOLD_STATUS=4 calls "$world" answer pick-db > "$world/out"
assert_contains "$(cat "$world/out")" "not recorded" "a refused answer is reported, not claimed"
pass "answer refusals record nothing"

# --- defer ------------------------------------------------------------------

world=$(make_world defer)
printf '%s\n' "$TOMORROW" | calls "$world" defer pick-db > "$world/out"
assert_equals "$(printf 'hold\npick-db\n--reason\n%s\n--until\n%s\n--' $'Which database?\n(A) keep MySQL\n(B) move to Postgres "now"' "$TOMORROW")" \
  "$(hold_calls "$world")" "defer re-holds with the call's own full reason and the date"
assert_contains "$(cat "$world/out")" "Deferred until $TOMORROW" "defer confirms the date"
pass "defer holds the call until the date"

for bad in '' "$YESTERDAY" 2027-02-30 tomorrow '2027-01-01; rm -rf /'; do
  world=$(make_world "defer-bad-$RANDOM")
  printf '%s\n' "$bad" | calls "$world" defer pick-db > /dev/null
  assert_equals "" "$(hold_calls "$world")" "defer with '$bad' records nothing"
done
world=$(make_world defer-closed)
printf '%s\n' "$TOMORROW" | FAKE_OPEN_STATUS=1 calls "$world" defer pick-db > /dev/null
assert_equals "" "$(hold_calls "$world")" "a call that is no longer open is not deferred"
world=$(make_world defer-secondmate)
printf '%s\n' "$TOMORROW" | calls "$world" defer orders/sm-call orders > /dev/null
assert_absent "$world/log/call.1" "a second mate's call is never deferred here"
pass "defer refuses empty, past, invalid, and unowned dates"

# --- fm-calls-herdr.sh ------------------------------------------------------
# A stand-in herdr that serves a recorded workspace and tab layout and logs
# every call, so the launcher's exact CLI traffic is observable.
make_herdr_world() {  # <name> <workspaces-json> <tabs-json> [server-running]
  local world="$TMP_ROOT/$1" fakebin
  mkdir -p "$world/home" "$world/herdr"
  fakebin=$(fm_fakebin "$world")
  printf '%s\n' "$2" > "$world/herdr/workspaces.json"
  printf '%s\n' "$3" > "$world/herdr/tabs.json"
  printf '%s\n' "${4:-true}" > "$world/herdr/running"
  cat > "$fakebin/herdr" <<'SH'
#!/usr/bin/env bash
s=$FAKE_HERDR
args=()
for a in "$@"; do
  [ "${skip:-}" = 1 ] && { skip=; continue; }
  [ "$a" = --session ] && { skip=1; continue; }
  args+=("$a")
done
printf '%s\n' "${args[*]}" >> "$s/calls"
case "${args[0]} ${args[1]:-}" in
  "status --json") printf '{"client":{"version":"0.9.5","protocol":22},"server":{"running":%s,"compatible":true}}\n' "$(cat "$s/running")" ;;
  "workspace list") jq -c '{result:{workspaces:.}}' "$s/workspaces.json" ;;
  "workspace create")
    printf '{"result":{"workspace":{"workspace_id":"wNew"},"tab":{"tab_id":"tSeed"},"root_pane":{"pane_id":"pSeed"}}}\n'
    printf '[{"tab_id":"tSeed","label":"1"}]\n' > "$s/tabs.json" ;;
  "tab list") jq -c '{result:{tabs:.}}' "$s/tabs.json" ;;
  "tab create")
    jq -c '. + [{"tab_id":"tCalls","label":"calls"}]' "$s/tabs.json" > "$s/tabs.next" && mv "$s/tabs.next" "$s/tabs.json"
    printf '{"result":{"tab":{"tab_id":"tCalls"},"root_pane":{"pane_id":"pCalls"}}}\n' ;;
  "tab focus") printf '{"result":{}}\n' ;;
  "pane list") printf '{"result":{"panes":[{"pane_id":"pSeed","tab_id":"tSeed"},{"pane_id":"pCalls","tab_id":"tCalls"}]}}\n' ;;
  "agent get") printf '{"result":{"agent":{"agent_status":"unknown"}}}\n' ;;
  "pane run") printf '%s' "${args[3]}" > "$s/run-command"; printf '{"result":{}}\n' ;;
  "pane close") printf '{"result":{}}\n' ;;
  *) echo "unexpected herdr call: ${args[*]}" >&2; exit 64 ;;
esac
SH
  chmod +x "$fakebin/herdr"
  printf '%s\n' "$world"
}

launch() {  # <world>
  env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID -u HERDR_SOCKET_PATH \
    -u FM_BACKEND_HERDR_BIN -u FM_BACKEND_HERDR_CLIENT_SESSION \
    PATH="$1/fakebin:$PATH" FAKE_HERDR="$1/herdr" HERDR_SESSION=fm-calls-test FM_HOME="$1/home" \
    "$ROOT/bin/fm-calls-herdr.sh"
}

world=$(make_herdr_world open '[{"workspace_id":"wOther","label":"~"},{"workspace_id":"wFm","label":"firstmate"}]' \
  '[{"tab_id":"t1","label":"fm-task"}]')
out=$(launch "$world") || fail "the launcher opens a tab: $out"
assert_grep "tab create --workspace wFm --cwd $world/home --label calls --focus" "$world/herdr/calls" \
  "the calls tab is created, focused, in this home's firstmate workspace"
assert_grep "pane run pCalls" "$world/herdr/calls" "the view is started in the new tab's own pane"
assert_equals "$(printf 'exec env FM_HOME=%q %q' "$world/home" "$ROOT/bin/fm-calls.sh")" "$(cat "$world/herdr/run-command")" \
  "the pane runs the view with this home"
assert_no_grep "workspace create" "$world/herdr/calls" "an existing home workspace is reused"
assert_no_grep "pane close" "$world/herdr/calls" "no tab is closed when the workspace already existed"
assert_contains "$out" "opened the calls tab" "the launcher reports the new tab"
pass "launcher opens a calls tab in the home workspace"

world=$(make_herdr_world focus '[{"workspace_id":"wFm","label":"firstmate"}]' \
  '[{"tab_id":"t1","label":"fm-task"},{"tab_id":"tOld","label":"calls"}]')
out=$(launch "$world") || fail "the launcher focuses an existing tab: $out"
assert_grep "tab focus tOld" "$world/herdr/calls" "an existing calls tab is focused"
assert_no_grep "tab create" "$world/herdr/calls" "an existing calls tab is never duplicated"
assert_no_grep "pane run" "$world/herdr/calls" "nothing is typed into an existing calls tab"
pass "launcher focuses an existing calls tab"

world=$(make_herdr_world create '[{"workspace_id":"wOther","label":"~"}]' '[]')
out=$(launch "$world") || fail "the launcher creates the home workspace: $out"
assert_grep "workspace create --cwd $world/home --label firstmate --no-focus" "$world/herdr/calls" \
  "a missing home workspace is created"
assert_grep "tab create --workspace wNew" "$world/herdr/calls" "the calls tab goes in the new workspace"
assert_grep "pane close pSeed" "$world/herdr/calls" "the seeded default tab is pruned once the calls tab exists"
pass "launcher creates the home workspace when it is missing"

world=$(make_herdr_world stopped '[{"workspace_id":"wFm","label":"firstmate"}]' '[]' false)
launch "$world" > /dev/null 2>&1 && fail "the launcher refuses without a running server"
assert_no_grep "server" "$world/herdr/calls" "the launcher never starts a Herdr server"
assert_no_grep "tab create" "$world/herdr/calls" "nothing is created without a running server"
pass "launcher refuses when the Herdr server is not running"

world=$(make_herdr_world duplicate '[{"workspace_id":"wA","label":"firstmate"},{"workspace_id":"wB","label":"firstmate"}]' '[]')
launch "$world" > /dev/null 2>&1 && fail "the launcher refuses two home workspaces"
assert_no_grep "tab create" "$world/herdr/calls" "an ambiguous home workspace gets no tab"
pass "launcher refuses an ambiguous home workspace"
