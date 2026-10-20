'use strict';
// Source-link classification over synthetic cards. Every host and key is fake (example.*, ACME-*).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('../public/render');
const { readLinkConfig } = require('../server');

const SLACK = 'https://demo.slack.com/archives/C000/p111';
const TEAMS = 'https://teams.microsoft.com/l/message/demo';
const JIRA = 'https://demo.atlassian.net/browse/ACME-7';
const NOTION = 'https://www.notion.so/demo-page';
const GH_PR = 'https://github.com/demo/repo/pull/12';
const BASE = 'https://jira.example.com';
const kinds = (list) => list.map((s) => [s.kind, s.label, s.url]);

test('URLs classify by hostname into PR, Jira, chat, and doc; anything else is ignored', () => {
  const cases = [
    [GH_PR, ['pr', 'PR 12']], [JIRA, ['jira', 'ACME-7']], [SLACK, ['chat', 'Slack']], [TEAMS, ['chat', 'Teams']],
    ['https://teams.cloud.microsoft/l/chat/demo', ['chat', 'Teams']], [NOTION, ['doc', 'Doc']],
    ['https://demo.atlassian.net/wiki/spaces/X', ['doc', 'Doc']],
    ['https://github.com/demo/repo/issues/3', null], ['https://example.com/archives/x', null],
    ['https://evil.example/?u=https://demo.slack.com/archives/C1', null], ['https://slack.com.evil.example/archives/C1', null],
  ];
  for (const [url, want] of cases) assert.deepEqual(R.classifySource(url) && [R.classifySource(url).kind, R.classifySource(url).label], want, url);
});

test('non-web URLs never become links', () => {
  for (const url of ['javascript:alert(1)//demo.slack.com/archives/x', 'file:///etc/passwd', 'data:text/html,x', 'ftp://demo.slack.com/archives/x']) {
    assert.equal(R.classifySource(url), null, url);
    assert.deepEqual(R.sourceLinks({ title: 'x', prUrl: url, sourceUrls: [url] }, { jiraBase: BASE }), [], url);
  }
  assert.deepEqual(R.sourceLinks({ title: 'ACME-1' }, { jiraBase: 'javascript:alert(1)' }), [], 'a non-web Jira base is ignored');
});

test('sources come in fixed order, each URL once; the card footer keeps the first of each kind', () => {
  const c = { title: 'Fix it', prUrl: 'https://example.invalid/demo/pull/9', sourceUrls: [NOTION, TEAMS, SLACK, JIRA, GH_PR, SLACK] };
  assert.deepEqual(kinds(R.sourceLinks(c)), [
    ['pr', 'PR 9', 'https://example.invalid/demo/pull/9'], ['pr', 'PR 12', GH_PR], ['jira', 'ACME-7', JIRA],
    ['chat', 'Teams', TEAMS], ['chat', 'Slack', SLACK], ['doc', 'Doc', NOTION]]);
  assert.deepEqual(R.cardSources(c).map((s) => s.label), ['PR 9', 'ACME-7', 'Teams', 'Doc']);
});

test('Jira keys in the title link only when a base URL is configured', () => {
  const c = { title: 'ACME-12: fix the thing (see ACME-13)', sourceUrls: [] };
  assert.deepEqual(R.sourceLinks(c), [], 'no config: keys stay plain text');
  assert.deepEqual(R.sourceLinks(c, { jiraBase: null }), []);
  assert.deepEqual(kinds(R.sourceLinks(c, { jiraBase: `${BASE}/` })), [
    ['jira', 'ACME-12', `${BASE}/browse/ACME-12`], ['jira', 'ACME-13', `${BASE}/browse/ACME-13`]]);
});

test('a card with no recorded source has no source links', () => {
  assert.deepEqual(R.sourceLinks({ title: 'Plain task' }), []);
  assert.deepEqual(R.cardSources({ title: 'Plain task', prUrl: null, sourceUrls: [] }, { jiraBase: BASE }), []);
});

test('cards collect URLs from the backlog title links and body lines', () => {
  const snapshot = {
    schema: R.SCHEMA, generated: '2026-07-08T12:00:00Z', tasks: [],
    backlog: { records: [
      { id: 'demo-held', state: 'queued', title: 'ACME-5 pick', hold_bucket: 'live', links: [], body_lines: [`Source: ${SLACK}.`, 'Notes: javascript:alert(1)'] },
      { id: 'demo-done', state: 'done', title: 'Shipped', pr_url: GH_PR, links: [GH_PR], body_lines: [`Doc ${NOTION}`] },
    ] },
  };
  const all = R.cards(snapshot);
  const held = all.find((c) => c.id === 'demo-held');
  assert.deepEqual(kinds(R.sourceLinks(held)), [['chat', 'Slack', SLACK]], 'trailing punctuation is dropped, non-web text ignored');
  assert.deepEqual(R.sourceLinks(held, { jiraBase: BASE }).map((s) => s.label), ['ACME-5', 'Slack']);
  assert.deepEqual(R.cardSources(all.find((c) => c.id === 'demo-done')).map((s) => s.label), ['PR 12', 'Doc'], 'the PR is not listed twice');
});

test('the Jira base comes from the environment first, then the home config file', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'webview-links-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.deepEqual(readLinkConfig(home, {}), { jiraBase: null }, 'absent file and env: no base');
  fs.mkdirSync(path.join(home, 'config'));
  fs.writeFileSync(path.join(home, 'config', 'webview-links'), `# private\njira_base=${BASE}\n`);
  assert.deepEqual(readLinkConfig(home, {}), { jiraBase: BASE });
  assert.deepEqual(readLinkConfig(home, { WEBVIEW_JIRA_BASE: 'https://other.example.com' }), { jiraBase: 'https://other.example.com' });
  assert.deepEqual(readLinkConfig(home, { WEBVIEW_JIRA_BASE: 'javascript:alert(1)' }), { jiraBase: null }, 'a non-web base is refused');
});
