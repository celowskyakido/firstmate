#!/usr/bin/env bash
# Regression test for fm-spawn.sh worker copy seeding: a captain-private
# config/worktree-include/<project> manifest turns the worker-copy acquisition
# into `treehouse get --include-file <manifest>` (docs/configuration.md
# "Worker copy seeding"), refuses an installed treehouse older than 3.0.0, and
# leaves the acquisition untouched when no manifest exists.
set -u

# shellcheck source=tests/fixtures.sh
. "$(dirname "${BASH_SOURCE[0]}")/fixtures.sh"

SPAWN="$ROOT/bin/fm-spawn.sh"
TMP_ROOT=$(fm_test_tmproot fm-spawn-worktree-include)

# make_include_case <dir> <id> <treehouse-version> builds a home, a project with
# a real worktree the fake pane settles into, and a fakebin whose tmux records
# each send-keys text line to $dir/sent and whose treehouse prints <version>.
make_include_case() {
  local dir=$1 id=$2 version=$3 fakebin
  fakebin=$(fm_fakebin "$dir/fake")
  cat > "$fakebin/tmux" <<'SH'
#!/usr/bin/env bash
set -u
case "$*" in
  *"#{pane_current_path}"*) printf '%s\n' "$FM_FAKE_PANE_PATH"; exit 0 ;;
esac
case "${1:-}" in
  display-message) printf 'firstmate\n' ;;
  send-keys) [ "${5:-}" != Enter ] || printf '%s\n' "$4" >> "$FM_FAKE_SENT" ;;
esac
exit 0
SH
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" %q\n' "$version" > "$fakebin/treehouse"
  chmod +x "$fakebin/tmux" "$fakebin/treehouse"
  mkdir -p "$dir/home/data/$id" "$dir/home/projects" "$dir/home/state" "$dir/home/config"
  printf 'codex\n' > "$dir/home/config/crew-harness"
  fm_git_worktree "$dir/project" "$dir/wt" "wt-$id"
  printf '# Task\n## Captain'"'"'s intent\nSeed %s.\n\n## Firstmate spec\nNone.\n' "$id" > "$dir/home/data/$id/brief.md"
  touch "$dir/home/state/.last-watcher-beat"
}

run_include_spawn() { # <dir> <id>
  local dir=$1
  FM_ROOT_OVERRIDE='' FM_HOME="$dir/home" \
    FM_STATE_OVERRIDE="$dir/home/state" FM_DATA_OVERRIDE="$dir/home/data" \
    FM_PROJECTS_OVERRIDE="$dir/home/projects" FM_CONFIG_OVERRIDE="$dir/home/config" \
    FM_SPAWN_NO_GUARD=1 TMUX="fake,1,0" FM_FAKE_PANE_PATH="$dir/wt" FM_FAKE_SENT="$dir/sent" \
    PATH="$dir/fake/fakebin:$PATH" \
    "$SPAWN" "$2" "$dir/project" --mode no-mistakes --yolo off 2>&1
}

# acquisition_words <dir> parses the first treehouse line the pane received
# the way the pane's shell would, one word per line.
acquisition_words() {
  local line
  line=$(grep -m 1 '^treehouse get' "$1/sent") || return 1
  eval "set -- $line"
  printf '%s\n' "$@"
}

test_no_manifest_keeps_plain_acquisition() {
  local dir="$TMP_ROOT/plain" id=include-plain-z1 out
  make_include_case "$dir" "$id" v2.0.1
  out=$(run_include_spawn "$dir" "$id") || fail "spawn without a manifest failed"$'\n'"$out"
  [ "$(grep -m 1 '^treehouse get' "$dir/sent")" = 'treehouse get' ] ||
    fail "acquisition without a manifest changed: $(cat "$dir/sent")"
  pass "no manifest keeps the plain treehouse get, even on an old treehouse"
}

test_manifest_adds_include_file() {
  local dir="$TMP_ROOT/with space's \"q\"" id=include-manifest-z2 out expected
  make_include_case "$dir" "$id" v3.1.2
  mkdir -p "$dir/home/config/worktree-include"
  printf '.env.local\n' > "$dir/home/config/worktree-include/project"
  out=$(run_include_spawn "$dir" "$id") || fail "spawn with a manifest failed"$'\n'"$out"
  expected=$(printf '%s\n' treehouse get --include-file "$dir/home/config/worktree-include/project")
  [ "$(acquisition_words "$dir")" = "$expected" ] ||
    fail "acquisition did not pass the manifest as one quoted word: $(cat "$dir/sent")"
  pass "a manifest adds --include-file with its absolute path, quoted for the pane"
}

test_old_treehouse_refuses_with_manifest() {
  local dir="$TMP_ROOT/old" id=include-old-z3 out status
  make_include_case "$dir" "$id" v2.9.9
  mkdir -p "$dir/home/config/worktree-include"
  printf '.env.local\n' > "$dir/home/config/worktree-include/project"
  out=$(run_include_spawn "$dir" "$id")
  status=$?
  [ "$status" -ne 0 ] || fail "spawn launched with a manifest treehouse 2.9.9 cannot honor"
  assert_contains "$out" "$dir/home/config/worktree-include/project" "refusal did not name the manifest"
  assert_contains "$out" "treehouse >= 3.0.0" "refusal did not name the required version"
  [ ! -e "$dir/sent" ] || fail "refused spawn still drove a pane: $(cat "$dir/sent")"
  [ ! -e "$dir/home/state/$id.meta" ] || fail "refused spawn published task metadata"
  pass "a manifest with treehouse below 3.0.0 refuses before launching anything"
}

test_no_manifest_keeps_plain_acquisition
test_manifest_adds_include_file
test_old_treehouse_refuses_with_manifest

echo "# all fm-spawn-worktree-include tests passed"
