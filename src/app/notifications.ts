// In-app notifications (roadmap A4): the bell in the top bar (#notifyBtn)
// and its panel (#notifyPanel). Nothing is sent to anyone: each person's app
// works out their own notifications from the shared schedule it already
// has, across every project they can open:
//   - assigned: a checklist item assigned to you, or you added to a job's
//     team (PM, Foreman or Members)
//   - due / overdue: a job you're on is due tomorrow, or past its due date
//     and not finished
//   - mention: a comment or reply with "@Your Name" (the @ picker below
//     fills names in)
//   - comment: a new comment or reply on a job you're on, or a reply to
//     your own comment
// Comments carry their own time. Assignments and due dates don't, so the
// first time any of your devices sees one is its time ("seen"); a due date
// key includes the date, so a new due date counts as new. Your own edits are
// recorded as already seen (noteMyEdit()), so assigning yourself doesn't
// ping you. Read marks, "Mark all read" and which kinds you want are kept
// per person on the server (worker/src/notifications.ts) so they follow
// you between phone and desktop; a copy stays in this browser for offline.
import { postUsersEndpoint } from './worker-client';
import { getStoredUsername, getStoredDisplayName } from '../auth/session';
import { hasMinTier } from '../auth/permissions';
import { escapeHtml } from '../utils/html';
import { formatDate } from '../utils/date';
import { switchProject } from './project';
import { editJob } from '../views/job-form';
import { closeHelp, isHelpOpen } from '../views/help';
import { closeSettingsMenu } from './settings-menu';

export type NotifyKind = 'assigned' | 'due' | 'overdue' | 'mention' | 'comment';
export const NOTIFY_KINDS: { kind: NotifyKind; label: string }[] = [
  { kind: 'assigned', label: 'Assigned to me' },
  { kind: 'due', label: 'Due tomorrow' },
  { kind: 'overdue', label: 'Overdue' },
  { kind: 'mention', label: '@mentions of me' },
  { kind: 'comment', label: 'New comments on my jobs' },
];

export interface NotifyFact {
  key: string;
  kind: NotifyKind;
  when: number;          // 0 = no time of its own (uses "seen")
  title: string;
  detail: string;
  projectId: string;
  jobId: string;
  phaseId: string | null;
}

export interface NotifyState {
  since: number;
  seen: Record<string, number>;
  read: Record<string, number>;
  readUpTo: number;
  off: string[];
}

interface Me { username: string; displayName: string; seeAllJobs: boolean; onlyProjectId: string | null }

const DAY = 24 * 60 * 60 * 1000;
const SHOW_DAYS = 30;
const BASE_KEY = '_base';

function startOfDay(d: Date): number { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
function isoDay(t: number): string {
  const d = new Date(t);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function snippet(text: unknown): string {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > 90 ? s.slice(0, 88) + '…' : s;
}
function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function mentionsMe(text: unknown, me: { username: string; displayName: string }): boolean {
  const names = [me.displayName, me.username].filter(Boolean);
  return names.some((n) => new RegExp('(^|[^\\w@])@' + escapeRe(n) + '(?![\\w])', 'i').test(String(text || '')));
}

function isFinished(proj: any, colId: string): boolean {
  const col = (proj.boardColumns || []).find((c: any) => c.id === colId);
  if (!col) return false;
  if (col.isFinished !== undefined) return !!col.isFinished;
  return col.id === 'complete' || col.id === 'invoiced';
}

function teamRole(card: any, username: string): string | null {
  const f = (card && card.customFields) || {};
  if (f.pm === username) return 'PM';
  if (f.foreman === username) return 'Foreman';
  if (Array.isArray(f.members) && f.members.indexOf(username) !== -1) return 'a member';
  return null;
}

// Every notification-worthy fact for this person in the given projects.
// Pure (no DOM, no globals) so it's easy to test.
export function collectNotificationFacts(allProjects: Record<string, any>, me: Me, now: number): NotifyFact[] {
  const facts: NotifyFact[] = [];
  const today = startOfDay(new Date(now));
  const tomorrow = isoDay(today + DAY + DAY / 2);
  const projectIds = Object.keys(allProjects || {}).filter((pid) => !me.onlyProjectId || pid === me.onlyProjectId);
  const isMine = (c: any) => c.by ? c.by === me.username : (!!me.displayName && c.author === me.displayName);

  projectIds.forEach((pid) => {
    const proj = allProjects[pid] || {};
    const cards: any[] = Array.isArray(proj.boardCards) ? proj.boardCards : Object.values(proj.boardCards || {});
    const jobList: any[] = Array.isArray(proj.jobs) ? proj.jobs : Object.values(proj.jobs || {});
    const cardsByJob: Record<string, any[]> = {};
    cards.forEach((c) => { if (c && c.jobId) (cardsByJob[c.jobId] = cardsByJob[c.jobId] || []).push(c); });
    const colLabel = (id: string) => { const c = (proj.boardColumns || []).find((x: any) => x.id === id); return c ? c.label : id; };

    jobList.forEach((job) => {
      if (!job || job.archived || job.isLinkedReference) return;
      const jobCards = cardsByJob[job.id] || [];
      const phases = Array.isArray(job.phases) && job.phases.length ? job.phases : [{ id: null, name: job.name }];
      const phaseName = (phaseId: string | null) => { const p = phases.find((x: any) => (x.id || null) === (phaseId || null)); return phases.length > 1 && p ? p.name : ''; };
      const cardFor = (phaseId: string | null) => jobCards.find((c) => (c.phaseId || null) === (phaseId || null));
      const primary = cardFor(phases[0].id || null);
      // Same rule as isJobVisibleToMe(): below Project Admin you only see
      // jobs whose first card lists you as a member.
      const visible = me.seeAllJobs || !!(primary && primary.customFields && Array.isArray(primary.customFields.members) && primary.customFields.members.indexOf(me.username) !== -1);
      if (!visible) return;
      const onTeam = jobCards.some((c) => !!teamRole(c, me.username));
      const where = (phaseId: string | null) => job.name + (phaseName(phaseId) ? ' — ' + phaseName(phaseId) : '');
      const base = { projectId: pid, jobId: job.id };

      jobCards.forEach((card) => {
        const phaseId = card.phaseId || null;
        const role = teamRole(card, me.username);
        if (role) {
          facts.push({ ...base, phaseId, key: 'team|' + pid + '|' + card.id, kind: 'assigned', when: 0,
            title: 'You were added to ' + where(phaseId), detail: 'As ' + role });
        }
        Object.keys(card.checklists || {}).forEach((colId) => {
          (card.checklists[colId] || []).forEach((item: any) => {
            if (!item || item.done || item.removed) return;
            const who = Array.isArray(item.assignee) ? item.assignee : (item.assignee ? [item.assignee] : []);
            if (who.indexOf(me.username) === -1) return;
            facts.push({ ...base, phaseId, key: 'asg|' + pid + '|' + card.id + '|' + colId + '|' + item.id, kind: 'assigned', when: 0,
              title: 'Checklist item assigned to you', detail: '“' + snippet(item.text) + '” · ' + where(phaseId) + ', ' + colLabel(colId) });
          });
        });
        if (role && card.due && /^\d{4}-\d{2}-\d{2}$/.test(card.due) && !isFinished(proj, card.column)) {
          const dueAt = new Date(card.due + 'T00:00:00').getTime();
          const dueLabel = formatDate(new Date(dueAt), { month: 'short', day: 'numeric' });
          if (card.due === tomorrow) {
            facts.push({ ...base, phaseId, key: 'due|' + pid + '|' + card.id + '|' + card.due, kind: 'due', when: 0,
              title: where(phaseId) + ' is due tomorrow', detail: 'Due ' + dueLabel });
          } else if (dueAt < today) {
            facts.push({ ...base, phaseId, key: 'over|' + pid + '|' + card.id + '|' + card.due, kind: 'overdue', when: 0,
              title: where(phaseId) + ' is overdue', detail: 'Was due ' + dueLabel });
          }
        }
      });

      (Array.isArray(job.comments) ? job.comments : []).forEach((c: any) => {
        if (!c || !c.id) return;
        const mineComment = isMine(c);
        const entries = [{ obj: c, key: c.id, reply: false }].concat(
          (Array.isArray(c.replies) ? c.replies : []).filter((r: any) => r && r.id).map((r: any) => ({ obj: r, key: c.id + '|' + r.id, reply: true })));
        entries.forEach((e) => {
          const o = e.obj;
          if (!o.when || isMine(o)) return;
          const author = o.author || 'Someone';
          const k = pid + '|' + job.id + '|' + e.key;
          if (mentionsMe(o.text, me)) {
            facts.push({ ...base, phaseId: null, key: 'men|' + k, kind: 'mention', when: o.when,
              title: author + ' mentioned you on ' + job.name, detail: snippet(o.text) });
          } else if (onTeam || (e.reply && mineComment)) {
            facts.push({ ...base, phaseId: null, key: 'cmt|' + k, kind: 'comment', when: o.when,
              title: author + (e.reply ? (mineComment ? ' replied to your comment on ' : ' replied on ') : ' commented on ') + job.name, detail: snippet(o.text) });
          }
        });
      });
    });
  });
  return facts;
}

export interface ShownNotification extends NotifyFact { at: number; unread: boolean }

// Which facts show in the panel, newest first. New "seen" times for facts
// that have none yet are written into `newSeen` (key -> time).
export function pickNotifications(facts: NotifyFact[], state: NotifyState, now: number, newSeen: Record<string, number>): ShownNotification[] {
  const out: ShownNotification[] = [];
  facts.forEach((f) => {
    let at = f.when;
    if (!at) {
      if (f.key in state.seen) at = state.seen[f.key];
      else if (f.key in newSeen) at = newSeen[f.key];
      else { newSeen[f.key] = now; at = now; }
      if (!at) return;   // 0: was already there when notifications started
    }
    if (at <= state.since || now - at > SHOW_DAYS * DAY) return;
    if (state.off.indexOf(f.kind) !== -1) return;
    out.push({ ...f, at, unread: !(f.key in state.read) && at > state.readUpTo });
  });
  out.sort((a, b) => b.at - a.at);
  return out;
}

// ---- State: loaded from the server, cached here, changes sent in batches ----

let state: NotifyState | null = null;
let pending: { seen: Record<string, number>; read: Record<string, number>; readUpTo?: number; off?: string[] } = { seen: {}, read: {} };
let sendTimer: ReturnType<typeof setTimeout> | null = null;
let loading = false;
let loadedFor = '';
let lastLoadAt = 0;
let shown: ShownNotification[] = [];
let settingsOpen = false;

function cacheKey(): string { return 'teamsync_notify_v1_' + getStoredUsername(); }
function saveCache(): void {
  try { if (state) localStorage.setItem(cacheKey(), JSON.stringify({ state, pending })); } catch (e) { /* storage full or blocked */ }
}
function readCache(): void {
  try {
    const raw = localStorage.getItem(cacheKey());
    if (!raw) return;
    const c = JSON.parse(raw);
    if (c && c.state) { state = c.state; pending = c.pending || { seen: {}, read: {} }; }
  } catch (e) { /* ignore */ }
}

function hasPending(): boolean {
  return Object.keys(pending.seen).length > 0 || Object.keys(pending.read).length > 0 || pending.readUpTo !== undefined || pending.off !== undefined;
}

function queueSend(): void {
  saveCache();
  if (sendTimer) clearTimeout(sendTimer);
  sendTimer = setTimeout(sendPending, 1500);
}

async function sendPending(): Promise<void> {
  sendTimer = null;
  if (!hasPending() || !getStoredUsername()) return;
  const patch = pending;
  pending = { seen: {}, read: {} };
  try {
    const data = await postUsersEndpoint('notifications/state', { patch });
    if (data && data.state) { state = mergeLocal(data.state); saveCache(); render(); }
  } catch (e) {
    // Offline or signed out: keep the changes for the next try.
    pending = { seen: { ...patch.seen, ...pending.seen }, read: { ...patch.read, ...pending.read },
      readUpTo: pending.readUpTo !== undefined ? pending.readUpTo : patch.readUpTo, off: pending.off !== undefined ? pending.off : patch.off };
    saveCache();
  }
}

// Server state plus anything still waiting to be sent.
function mergeLocal(server: NotifyState): NotifyState {
  return {
    since: server.since,
    seen: { ...pending.seen, ...server.seen },
    read: { ...server.read, ...pending.read },
    readUpTo: Math.max(server.readUpTo || 0, pending.readUpTo || 0),
    off: pending.off !== undefined ? pending.off : (server.off || []),
  };
}

export async function loadNotificationState(): Promise<void> {
  const username = getStoredUsername();
  if (loading || !username) return;
  if (loadedFor !== username) { state = null; pending = { seen: {}, read: {} }; loadedFor = username; lastLoadAt = 0; readCache(); }
  // Runs whenever the sign-in is re-checked; once a minute is plenty.
  if (Date.now() - lastLoadAt < 60000) return;
  lastLoadAt = Date.now();
  loading = true;
  refreshNotifications();
  try {
    const data = await postUsersEndpoint('notifications/state', hasPending() ? { patch: pending } : undefined);
    pending = { seen: {}, read: {} };
    if (data && data.state) state = data.state;
    saveCache();
  } catch (e) { /* offline: the cached copy is used */ }
  loading = false;
  refreshNotifications();
}

function currentMe(): Me | null {
  const username = viewAsUsername ? '' : getStoredUsername();
  if (!username) return null;
  const rosterName = (cachedUserRoster || []).find((u) => u.username === username);
  return {
    username,
    displayName: (rosterName && rosterName.displayName) || getStoredDisplayName(),
    seeAllJobs: hasMinTier('projectAdmin'),
    onlyProjectId: currentUserRole !== 'admin' && currentAssignedProjectId ? currentAssignedProjectId : null,
  };
}

// Re-reads the schedule. `mine` = called right after this person's own
// edit, so anything new is theirs and is recorded as already seen.
export function refreshNotifications(opts?: { mine?: boolean }): void {
  const me = currentMe();
  if (!me || !state) { shown = []; render(); return; }
  const now = Date.now();
  const facts = collectNotificationFacts(projects || {}, me, now);
  const newSeen: Record<string, number> = {};
  // First time ever (and only once the server's copy of the schedule is
  // in): everything already there is "old", so people don't start with a
  // pile of notifications.
  const baseline = !(BASE_KEY in state.seen);
  if (baseline && !roomEverConnected) { shown = []; render(); return; }
  if (baseline || (opts && opts.mine)) {
    facts.forEach((f) => { if (!f.when && !(f.key in state!.seen)) newSeen[f.key] = 0; });
    if (baseline) newSeen[BASE_KEY] = 0;
  }
  shown = pickNotifications(facts, state, now, newSeen);
  if (Object.keys(newSeen).length) {
    Object.assign(state.seen, newSeen);
    Object.assign(pending.seen, newSeen);
    queueSend();
  }
  render();
}

// Called after this person's own saves (see saveActiveProject()).
export function noteMyEdit(): void { refreshNotifications({ mine: true }); }

function markRead(keys: string[]): void {
  if (!state) return;
  const now = Date.now();
  keys.forEach((k) => { state!.read[k] = now; pending.read[k] = now; });
  queueSend();
}

export function markAllNotificationsRead(): void {
  if (!state) return;
  const now = Date.now();
  state.readUpTo = now;
  pending.readUpTo = now;
  queueSend();
  refreshNotifications();
}

function setKindOn(kind: NotifyKind, on: boolean): void {
  if (!state) return;
  const off = state.off.filter((k) => k !== kind);
  if (!on) off.push(kind);
  state.off = off;
  pending.off = off;
  queueSend();
  refreshNotifications();
}

// ---- The bell and its panel ----

function timeAgo(t: number, now: number): string {
  const m = Math.round((now - t) / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + ' hr ago';
  const d = Math.round(h / 24);
  if (d < 7) return d === 1 ? 'Yesterday' : d + ' days ago';
  return formatDate(new Date(t), { month: 'short', day: 'numeric' });
}

const KIND_ICON: Record<NotifyKind, string> = {
  assigned: '<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/>',
  due: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  overdue: '<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4"/><path d="M12 17.5v.1"/>',
  mention: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  comment: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z"/>',
};

export function isNotificationsOpen(): boolean {
  const p = document.getElementById('notifyPanel');
  return !!p && !p.hidden;
}

function render(): void {
  const count = shown.filter((n) => n.unread).length;
  const badge = document.getElementById('notifyCount');
  const btn = document.getElementById('notifyBtn');
  if (badge) { badge.textContent = count > 9 ? '9+' : String(count); badge.hidden = count === 0; }
  if (btn) btn.setAttribute('aria-label', count ? 'Notifications, ' + count + ' unread' : 'Notifications');
  if (isNotificationsOpen()) renderPanel();
}

function renderPanel(): void {
  const panel = document.getElementById('notifyPanel');
  if (!panel) return;
  const now = Date.now();
  const unread = shown.some((n) => n.unread);
  const off = state ? state.off : [];
  const multiProject = Object.keys(projects || {}).length > 1;
  const projName = (pid: string) => (projects[pid] && projects[pid].name) || '';
  const items = shown.map((n, i) =>
    '<li><button type="button" class="notify-item' + (n.unread ? ' unread' : '') + ' notify-' + n.kind + '" data-i="' + i + '">' +
      '<svg class="notify-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + KIND_ICON[n.kind] + '</svg>' +
      '<span class="notify-text"><span class="notify-title">' + escapeHtml(n.title) + '</span>' +
      (n.detail ? '<span class="notify-detail">' + escapeHtml(n.detail) + '</span>' : '') +
      '<span class="notify-when">' + escapeHtml(timeAgo(n.at, now)) + (multiProject && n.projectId !== activeProjectId ? ' · ' + escapeHtml(projName(n.projectId)) : '') + '</span></span>' +
      (n.unread ? '<span class="notify-unread-dot" aria-label="Unread"></span>' : '') +
    '</button></li>').join('');
  const settings = settingsOpen
    ? '<fieldset class="notify-settings"><legend>Show me</legend>' + NOTIFY_KINDS.map((k) =>
        '<label><input type="checkbox" data-kind="' + k.kind + '"' + (off.indexOf(k.kind) === -1 ? ' checked' : '') + '> ' + escapeHtml(k.label) + '</label>').join('') +
      '<p>Only you see your notifications. To @mention someone in a comment, type @ and pick their name.</p></fieldset>'
    : '';
  panel.innerHTML =
    '<div class="notify-head"><h2 id="notifyTitle">Notifications</h2>' +
      '<button type="button" class="notify-link" id="notifyMarkAll"' + (unread ? '' : ' disabled') + '>Mark all read</button>' +
      '<button type="button" class="notify-gear" id="notifySettingsBtn" aria-expanded="' + settingsOpen + '" title="Choose alerts" aria-label="Choose alerts"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg></button>' +
      '<button type="button" class="help-close" id="notifyCloseBtn" aria-label="Close notifications">&times;</button></div>' +
    settings +
    (state
      ? (items ? '<ul class="notify-list">' + items + '</ul>' : '<p class="notify-empty">You’re all caught up. New comments, @mentions, assignments and due dates on your jobs show up here.</p>')
      : '<p class="notify-empty">Notifications show up here once you’re connected.</p>');
}

export function openNotifications(): void {
  const panel = document.getElementById('notifyPanel');
  if (!panel) return;
  closeSettingsMenu();
  if (isHelpOpen()) closeHelp();
  panel.hidden = false;
  document.getElementById('notifyBtn')?.setAttribute('aria-expanded', 'true');
  refreshNotifications();
  renderPanel();
  (panel.querySelector('#notifyCloseBtn') as HTMLElement | null)?.focus({ preventScroll: true });
}

export function closeNotifications(returnFocus?: boolean): void {
  const panel = document.getElementById('notifyPanel');
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  settingsOpen = false;
  const btn = document.getElementById('notifyBtn');
  btn?.setAttribute('aria-expanded', 'false');
  if (returnFocus) btn?.focus();
}

export function toggleNotifications(): void {
  if (isNotificationsOpen()) closeNotifications(); else openNotifications();
}

function openNotification(n: ShownNotification): void {
  markRead([n.key]);
  closeNotifications();
  if (n.projectId !== activeProjectId) switchProject(n.projectId);
  if (n.projectId !== activeProjectId) return;   // switch refused (still signing in)
  editJob(n.jobId, n.phaseId);
}

function onPanelClick(e: Event): void {
  const t = e.target as HTMLElement;
  if (t.closest('#notifyCloseBtn')) { closeNotifications(true); return; }
  if (t.closest('#notifyMarkAll')) { markAllNotificationsRead(); return; }
  if (t.closest('#notifySettingsBtn')) { settingsOpen = !settingsOpen; renderPanel(); (document.getElementById('notifySettingsBtn') as HTMLElement | null)?.focus(); return; }
  const item = t.closest('.notify-item') as HTMLElement | null;
  if (item) { const n = shown[Number(item.dataset.i)]; if (n) openNotification(n); }
}

function onPanelChange(e: Event): void {
  const t = e.target as HTMLInputElement;
  if (t.dataset && t.dataset.kind) setKindOn(t.dataset.kind as NotifyKind, t.checked);
}

export function initNotifications(): void {
  const panel = document.getElementById('notifyPanel');
  if (panel) {
    panel.addEventListener('click', onPanelClick);
    panel.addEventListener('change', onPanelChange);
  }
  document.getElementById('notifyBtn')?.addEventListener('click', toggleNotifications);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isNotificationsOpen()) closeNotifications(true); });
  document.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (isNotificationsOpen() && t.isConnected && !t.closest('#notifyPanel, #notifyBtn')) closeNotifications();
  });
  // Due dates change with the day, and "x min ago" with the minute.
  setInterval(() => refreshNotifications(), 5 * 60 * 1000);
  window.addEventListener('online', () => { if (hasPending()) sendPending(); });
}
