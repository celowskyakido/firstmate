#!/usr/bin/env node
// Radar producer prepare step: renders prompt.md from the home's private config and backlog,
// writes it to FM_HOME/state/radar-producer/prompt.txt, and prints the claude argv NUL-separated
// (first field: the hard timeout in seconds). Exit 3 means outside the working-hours window.
// Usage: node prepare.js <FM_HOME> [--any-time]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./merge');

const SLACK_READ = ['slack_search_public_and_private', 'slack_read_thread'];
const SLACK_WRITE = ['slack_send_message', 'slack_send_message_draft', 'slack_schedule_message', 'slack_add_reaction', 'slack_create_canvas',
  'slack_update_canvas', 'slack_create_conversation', 'slack_create_list', 'slack_update_list', 'slack_add_list_record', 'slack_update_list_record',
  'slack_get_file_upload_url', 'slack_complete_file_upload'];
const CHROME_READ = ['list_pages', 'evaluate_script'];
const CHROME_WRITE = ['click', 'drag', 'fill', 'fill_form', 'type_text', 'press_key', 'hover', 'navigate_page', 'new_page', 'close_page',
  'select_page', 'upload_file', 'handle_dialog', 'emulate', 'resize_page'];
const MAX_TRACKED = 10;

const isWorkingHours = ({ start, end, days }, date = new Date()) => days.includes(date.getDay()) && date.getHours() >= start && date.getHours() < end;

// Jira-style keys from the open (not Done) backlog items, each mapped to the task ids that mention it.
const trackedWork = (backlog) => {
  const open = backlog.split(/^## /m).filter((s) => !/^Done\b/.test(s)).slice(1).join('\n');
  const map = new Map();
  let task = null;
  for (const line of open.split('\n')) {
    task = line.match(/^- (?:\[.\] )?([A-Za-z0-9][\w.-]*)/)?.[1] ?? (/^\S/.test(line) ? null : task);
    for (const key of task ? line.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? [] : []) map.set(key, [...new Set([...(map.get(key) ?? []), task])]);
  }
  return [...map].slice(0, MAX_TRACKED).map(([key, taskIds]) => ({ key, taskIds }));
};

const claudeArgs = (config, outDir) => {
  const slack = (t) => `${config.tools.slack}__${t}`;
  const chrome = (t) => `${chromeTool(config)}__${t}`;
  // File permission rules are Edit(...) rules; they cover the Write tool too. ToolSearch loads deferred MCP tools.
  const allowed = [...SLACK_READ.map(slack), ...CHROME_READ.map(chrome), `Edit(/${outDir}/slack.json)`, `Edit(/${outDir}/teams.json)`];
  return ['-p', '--model', config.model, '--permission-mode', 'dontAsk', '--tools', 'Write,ToolSearch', '--allowedTools', allowed.join(','),
    '--disallowedTools', [...SLACK_WRITE.map(slack), ...CHROME_WRITE.map(chrome)].join(','),
    ...(config.chromeMcp ? ['--mcp-config', path.join(outDir, 'mcp.json')] : []),
    '--no-session-persistence', '--disable-slash-commands', '--output-format', 'text'];
};

// chromeMcp, when set, is a dedicated MCP server definition for the browser that holds the Teams tab.
const chromeTool = (config) => (config.chromeMcp ? 'mcp__radar-chrome' : config.tools.chrome);

const render = (template, values) => template.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in values ? values[k] : m));

const prepare = (home, { now = new Date(), anyTime = false } = {}) => {
  const config = loadConfig(home);
  if (!anyTime && !isWorkingHours(config.hours, now)) return null;
  const outDir = path.join(home, 'state', 'radar-producer');
  let backlog = '';
  try { backlog = fs.readFileSync(path.join(home, 'data', 'backlog.md'), 'utf8'); } catch { /* no backlog: rule 4 has no keys */ }
  const tracked = trackedWork(backlog);
  const after = Math.floor(now.getTime() / 1000) - config.lookbackHours * 3600;
  const prompt = render(fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8'), {
    SLACK_USER_ID: config.slackUserId, AFTER_UNIX: String(after), LOOKBACK_HOURS: String(config.lookbackHours),
    DENY_CHANNELS: JSON.stringify(config.deny.channels), DENY_SENDERS: JSON.stringify(config.deny.senders),
    TRACKED: tracked.length ? tracked.map((t) => `- ${t.key} -> taskIds ${JSON.stringify(t.taskIds)}`).join('\n') : '- (none)',
    SLACK_OUT: path.join(outDir, 'slack.json'), TEAMS_OUT: path.join(outDir, 'teams.json'), TEAMS_SCRIPT: path.join(__dirname, 'teams-read.js'),
    SLACK_TOOL: config.tools.slack, CHROME_TOOL: chromeTool(config),
  });
  const mcp = config.chromeMcp ? { mcpServers: { 'radar-chrome': config.chromeMcp } } : null;
  return { prompt, mcp, args: claudeArgs(config, outDir), timeoutSeconds: config.timeoutSeconds, outDir };
};

if (require.main === module) {
  try {
    const plan = prepare(process.argv[2] ?? process.env.FM_HOME, { anyTime: process.argv.includes('--any-time') });
    if (!plan) process.exit(3);
    fs.mkdirSync(plan.outDir, { recursive: true });
    fs.writeFileSync(path.join(plan.outDir, 'prompt.txt'), plan.prompt);
    if (plan.mcp) fs.writeFileSync(path.join(plan.outDir, 'mcp.json'), JSON.stringify(plan.mcp));
    process.stdout.write([plan.timeoutSeconds, ...plan.args].map((a) => `${a}\0`).join(''));
  } catch (e) {
    console.error(`radar prepare failed: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { isWorkingHours, trackedWork, claudeArgs, prepare };
