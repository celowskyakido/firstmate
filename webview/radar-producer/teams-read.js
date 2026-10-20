// Teams radar read for the radar producer: run with chrome-devtools evaluate_script via sourcePath on an already-open Teams tab.
// Read-only: scrolls the left rail and reads the page's own IndexedDB cache. No clicks, no typing, no network.
// Returns radar items without message bodies.
async () => {
  const LOOKBACK_MS = 7 * 24 * 3600e3;
  const now = Date.now(), iso = t => new Date(t).toISOString();
  const sha = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
  const problems = [];

  // 0. Stop on sign-in or any prompt.
  if (!/teams\.(cloud\.microsoft|microsoft\.com)$/.test(location.hostname)) return { health: 'unavailable', reason: 'not on Teams: ' + location.hostname };
  const dialogs = [...document.querySelectorAll('[role=dialog],[role=alertdialog]')].filter(d => d.offsetParent);
  if (dialogs.length) return { health: 'unavailable', reason: 'Teams shows a dialog/prompt; stopped' };

  // 1. Page-title / Activity badge count.
  const titleCount = +((document.title.match(/^\((\d+)\)/) || [])[1] || 0);
  const actBtn = [...document.querySelectorAll('button[aria-label^="Activity"]')][0];
  const badge = actBtn ? +((actBtn.parentElement.querySelector('.fui-Badge') || {}).textContent || 0) : null;

  // 2. Left rail: scroll the virtualised tree, collect unread rows by their shared screen-reader label ids.
  const UNREAD = ['chat_list_unread_text', 'channel-list-unread-text', 'slice-list-unread-text', 'simple_collab_voiceover_unread_message', 'simple_collab_voiceover_badged_chat'];
  const MENTION = { 'channel-list-item-personal-mention': 'personal', 'simple_collab_voiceover_personal_mention_string': 'personal', 'channel-list-item-channel-mention': 'channel', 'channel-list-item-team-mention': 'team', 'simple_collab_voiceover_everyone_mention_string': 'everyone' };
  const SUB = { 'one-on-one-chat-support-text': 'dm', 'chat-group-support-text': 'group', 'chat-meeting-support-text': 'group' };
  const rail = new Map();
  const tree = document.querySelector('[role=tree][aria-label=Teams]');
  if (!tree) problems.push('rail tree not found');
  else {
    const collect = () => tree.querySelectorAll('[role=treeitem][data-item-type]').forEach(it => {
      const type = it.getAttribute('data-item-type');
      if (!/^(chat|muted-chat|channel)$/.test(type)) return;
      const toks = (it.getAttribute('aria-labelledby') || '').trim().split(/\s+/);
      const titleId = toks.find(t => /^title-(chat|channel)-list-item[_-]/.test(t));
      if (!titleId) return;
      const convId = titleId.replace(/^title-(chat|channel)-list-item[_-]/, '');
      const el = document.getElementById(titleId);
      const r = { convId, rowType: type, title: el ? el.textContent.trim() : '', sub: type === 'channel' ? 'channel' : (toks.map(t => SUB[t]).find(Boolean) || 'group'),
        unread: toks.some(t => UNREAD.includes(t)) || (el && +getComputedStyle(el).fontWeight >= 600), mention: toks.map(t => MENTION[t]).find(Boolean) || null };
      const p = rail.get(convId);
      rail.set(convId, p ? { ...p, unread: p.unread || r.unread, mention: p.mention || r.mention } : r);
    });
    const y0 = tree.scrollTop;
    for (let y = 0, i = 0; y <= tree.scrollHeight && i < 40; y += Math.floor(tree.clientHeight * 0.7), i++) {
      tree.scrollTop = y; await new Promise(r => setTimeout(r, 400)); collect();
    }
    tree.scrollTop = y0;
  }

  // 3. IndexedDB cache (local only).
  const dbNames = (await indexedDB.databases()).map(d => d.name);
  const readAll = async (prefix, store) => {
    const name = dbNames.find(n => n.startsWith(prefix)); if (!name) { problems.push('no db ' + prefix); return []; }
    const db = await new Promise((res, rej) => { const q = indexedDB.open(name); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    try { return await new Promise(res => { const q = db.transaction(store, 'readonly').objectStore(store).getAll(); q.onsuccess = () => res(q.result); }); } finally { db.close(); }
  };
  const convs = new Map((await readAll('Teams:conversation-manager:', 'conversations')).map(c => [c.id, c]));
  const feed = await readAll('Teams:activity-manager:', 'feed-items');
  const rcName = dbNames.find(n => n.startsWith('Teams:replychain-manager:'));
  const rcDb = rcName && await new Promise(res => { const q = indexedDB.open(rcName); q.onsuccess = () => res(q.result); });
  const sender = async (thread, chain, msg) => {
    if (!rcDb || !chain) return null;
    const rc = await new Promise(res => { const q = rcDb.transaction('replychains-2', 'readonly').objectStore('replychains-2').get([thread, chain]); q.onsuccess = () => res(q.result); q.onerror = () => res(null); });
    const m = rc && rc.messageMap && rc.messageMap[msg];
    return m ? { who: m.imDisplayName || null, mine: !!m.isSentByCurrentUser } : null;
  };

  const tenant = [...convs.values()].map(c => c.threadProperties && c.threadProperties.tenantid).find(Boolean) || null;
  const q = tenant ? '?tenantId=' + tenant : '';
  const titleOf = id => { const c = convs.get(id); return (rail.get(id) || {}).title || (c && ((c.chatTitle && c.chatTitle.shortTitle) || (c.threadProperties && (c.threadProperties.topic || c.threadProperties.spaceThreadTopic)))) || null; };
  const teamOf = id => { const c = convs.get(id), t = c && c.teamId && convs.get(c.teamId); return t && t.threadProperties ? { groupId: t.threadProperties.groupId || null, name: t.threadProperties.spaceThreadTopic || null } : null; };
  const isChannel = id => /@thread\.(tacv2|skype)$/.test(id) && (convs.get(id) || {}).type !== 'Chat';
  const chatLink = id => 'https://teams.microsoft.com/l/chat/' + encodeURIComponent(id) + '/conversations';
  const channelLink = id => { const t = teamOf(id); return 'https://teams.microsoft.com/l/channel/' + encodeURIComponent(id) + '/' + encodeURIComponent(titleOf(id) || 'channel') + (tenant ? q + (t && t.groupId ? '&groupId=' + t.groupId : '') : ''); };
  const msgLink = (thread, msg, root) => { const t = teamOf(thread); return 'https://teams.microsoft.com/l/message/' + encodeURIComponent(thread) + '/' + msg + (isChannel(thread) ? q + (t && t.groupId ? '&groupId=' + t.groupId : '') + '&parentMessageId=' + (root || msg) : '?context=' + encodeURIComponent('{"contextType":"chat"}')); };

  // 4. Build items. One item per conversation (channel posts use Teams' own "<thread>;messageid=<root>" conversation id).
  const RANK = { mention: 6, dm: 5, group: 4, thread: 3, channel: 2, 'new-channel': 1 };
  const items = new Map();
  const put = async (convKey, it) => {
    const id = 'teams:' + await sha('teams|' + convKey);
    const p = items.get(id);
    if (!p || RANK[it.kind] > RANK[p.kind]) items.set(id, { id, source: 'teams', ...it, lastActivity: p && p.lastActivity > it.lastActivity ? p.lastActivity : it.lastActivity, firstSeen: iso(now), state: 'new' });
    else if (it.lastActivity > p.lastActivity) p.lastActivity = it.lastActivity;
  };
  const trim = s => s.length > 80 ? s.slice(0, 79) + '…' : s;

  for (const a of feed) {
    if (a.isRead || now - a.timestamp > LOOKBACK_MS) continue;
    const t = a.activityType;
    const kind = /^mention/.test(t) ? 'mention' : /^(reply|replyToReply)$/.test(t) ? 'thread' : /^follow$/.test(t) ? 'channel' : null;
    if (!kind) continue; // reactions, meeting updates, app notifications are not radar signal
    const s = await sender(a.sourceThreadId, a.sourceReplyChainId, a.sourceMessageId);
    if (s && s.mine) continue;
    const where = titleOf(a.sourceThreadId) || 'a conversation';
    const who = s && s.who;
    const why = kind === 'mention' ? (a.activitySubtype === 'person' ? 'mentioned you' : '@' + a.activitySubtype + ' mention') + (who ? ' (' + who + ')' : '') + ' in ' + where
      : kind === 'thread' ? 'reply in a thread you are in' + (who ? ' from ' + who : '') + ', ' + where
      : 'new post in followed channel ' + where;
    const chan = isChannel(a.sourceThreadId);
    const conv = chan && kind !== 'channel' && a.sourceReplyChainId ? a.sourceThreadId + ';messageid=' + a.sourceReplyChainId : a.sourceThreadId;
    await put(conv, { kind, title: where, link: msgLink(a.sourceThreadId, a.sourceMessageId, a.sourceReplyChainId), why: trim(why), lastActivity: iso(a.timestamp), who: who || null, where });
  }
  for (const r of rail.values()) {
    if (!r.unread || r.rowType === 'muted-chat') continue;
    const c = convs.get(r.convId);
    const last = c && c.lastMessageTimeUtc ? iso(c.lastMessageTimeUtc) : iso(now);
    const who = c && c.lastMessage && c.lastMessage.imdisplayname || null;
    const kind = r.mention ? 'mention' : r.sub;
    const why = kind === 'mention' ? r.mention + ' @mention in ' + r.title : kind === 'channel' ? 'unread posts in ' + r.title : 'unread ' + (kind === 'dm' ? 'DM' : 'group chat') + (who ? ' from ' + who : '');
    await put(r.convId, { kind, title: r.title, link: kind === 'channel' || (kind === 'mention' && r.sub === 'channel') ? channelLink(r.convId) : chatLink(r.convId), why: trim(why), lastActivity: last, who, where: r.title });
  }
  if (rcDb) rcDb.close();

  const newestCache = Math.max(0, ...[...convs.values()].map(c => c.lastMessageTimeUtc || 0), ...feed.map(a => a.timestamp));
  return {
    generatedAt: iso(now),
    health: problems.length ? 'degraded' : 'ok', reason: problems.join('; ') || null,
    counts: { titleCount, activityBadge: badge, railRows: rail.size, railUnread: [...rail.values()].filter(r => r.unread).length, feedUnread: feed.filter(a => !a.isRead).length, conversations: convs.size },
    cacheNewest: newestCache ? iso(newestCache) : null,
    items: [...items.values()].sort((a, b) => RANK[b.kind] - RANK[a.kind] || b.lastActivity.localeCompare(a.lastActivity))
  };
}
