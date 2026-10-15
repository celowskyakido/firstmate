'use strict';
// Synthetic FM_HOME: placeholder names only (demo-*, example.invalid, ACME-999).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const XSS = '<script>alert(1)</script>';

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'webview-fixture-'));
  const state = path.join(home, 'state');
  for (const d of ['state', 'data', 'projects', 'config']) fs.mkdirSync(path.join(home, d));
  // cmux backend with no worktree on disk keeps the snapshot independent of tmux,
  // so the keyed open-decision fold surfaces.
  fs.writeFileSync(path.join(state, 'demo-task-1.meta'), [
    'backend=cmux', 'window=demo:surface', `worktree=${home}/projects/gone`, 'project=demo',
    'harness=claude', 'kind=ship', 'mode=ship', 'yolo=off', 'pr=https://example.invalid/demo/pull/9',
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(state, 'demo-task-1.status'), [
    'working [at=1700000000]: started ACME-999',
    `needs-decision [at=1700000100] [key=api-shape]: choose ${XSS}`,
    '',
  ].join('\n'));
  fs.mkdirSync(path.join(state, 'demo-task-1.inbox', 'handled'), { recursive: true });
  fs.writeFileSync(path.join(state, 'demo-task-1.inbox', '001.msg'), 'pending steer\n');
  fs.writeFileSync(path.join(state, 'demo-task-1.inbox', 'handled', '000.msg'), 'old steer\n');
  fs.writeFileSync(path.join(home, 'data', 'backlog.md'), [
    '## In flight',
    '- [ ] demo-task-1 - Demo ship task https://example.invalid/demo/pull/9 (repo: demo) (kind: ship) (since 2026-07-07)',
    '',
    '## Queued',
    '- [ ] demo-held - Pick a name (repo: demo) (kind: captain) (hold: choose naming) (hold-kind: captain)',
    '',
    '## Done',
    '- [x] demo-old - Shipped demo widget https://example.invalid/demo/pull/3 (repo: demo) (kind: ship) (done 2026-07-08)',
    '',
  ].join('\n'));
  return home;
}

module.exports = { makeHome, XSS };
