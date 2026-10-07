// Presence: "who else is viewing this project right now" avatar bubbles
// — sendPresenceUpdate/presenceAvatarColor/presenceInitials/
// presenceAnimDelay/renderPresenceAvatars. Purely cosmetic, with zero
// data-mutation risk (worst case of a bug here is a wrong-colored or
// missing avatar, never a corrupted job/task) — unlike src/sync/connection.ts
// and src/sync/inbound.ts, where a bug can silently affect every user in
// a project at once.
//
// roomSocket/activeProjectId/latestPresenceUsers/myPresenceSessionId/
// projects stay in index.html (the actual WebSocket connection, the
// active-project pointer, and the shared project-data map) and are
// referenced below as ambient globals.
import { escapeHtml } from '../utils/html';
import { getStoredUsername } from '../auth/session';

// Ambient globals this file shares verbatim with other src/ files
// (roomSocket, activeProjectId, latestPresenceUsers, projects) are
// declared once in src/shared-globals.d.ts, not repeated here.
declare global {
  // eslint-disable-next-line no-var
  var myPresenceSessionId: string;
}

// Exported so src/sync/inbound.ts's handleRoomMessage() can reuse this
// exact named type for its own identical `latestPresenceUsers` ambient
// declaration, rather than duplicating an inline shape that could
// silently drift out of sync with this one.
export interface PresenceUser {
  sessionId?: string;
  username?: string;
  displayName?: string;
  projectId?: string | null;
  view?: string;
}

function sendPresenceUpdate(): void {
  if (!roomSocket || roomSocket.readyState !== 1) return;
  const tabEl = document.querySelector('#appNavNotch .nav-tab.active');
  const view = tabEl ? tabEl.id.replace('tab-', '') : null;
  try {
    roomSocket.send(JSON.stringify({ type: 'setPresence', view: view, projectId: activeProjectId || null, sessionId: myPresenceSessionId }));
  } catch (e) { /* best-effort — a missed update just means a stale avatar briefly */ }
}
// Periodic re-affirm so the server can prune a ghost presence entry (a tab
// closed without a clean WebSocket close) instead of it lingering as a
// phantom bubble until someone manually finds and closes the stale tab —
// this happened live twice before this heartbeat existed. A stopped tab's
// entry simply stops getting refreshed and ages out server-side; nothing
// special has to happen client-side for cleanup.
setInterval(sendPresenceUpdate, 25000);

const PRESENCE_AVATAR_COLORS = ['#3949ab', '#00897b', '#c62828', '#f0ad4e', '#7e57c2', '#00acc1', '#8d6e63', '#5c6bc0'];
function presenceAvatarColor(key: string | null | undefined): string {
  key = key || '';
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return PRESENCE_AVATAR_COLORS[hash % PRESENCE_AVATAR_COLORS.length];
}
function presenceInitials(displayName: string | null | undefined): string {
  const parts = (displayName || '?').trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
const PRESENCE_VIEW_LABELS: Record<string, string> = { home: 'Home', checklist: 'Checklist', gantt: 'Gantt Chart', board: 'Board', calendar: 'Calendar', reports: 'Reports', jobs: 'Jobs' };

// Deterministic per-user delay (not random-per-render, which would make
// the pulse visibly jitter/restart every time presence re-broadcasts) so
// a row of several avatars breathes at slightly different offsets
// instead of in rigid unison, without ever changing for the same person.
function presenceAnimDelay(key: string | null | undefined): number {
  key = key || '';
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 17 + key.charCodeAt(i)) >>> 0;
  return (hash % 26) / 10; // 0.0s-2.5s
}

// One bubble per OTHER person. Every open tab or device is its own
// connection, so the same account can appear several times in the list:
// all of the viewer's own connections are left out (not just this tab),
// and someone with several tabs open shows once, with each place they're
// looking listed in the tooltip.
function renderPresenceAvatars(): void {
  const el = document.getElementById('presenceAvatars');
  if (!el) return;
  const mine = latestPresenceUsers.find(function (u) { return u.sessionId === myPresenceSessionId; });
  const myUsername = (mine && mine.username) || getStoredUsername();
  const people: { u: PresenceUser; places: string[] }[] = [];
  latestPresenceUsers.forEach(function (u) {
    if (u.sessionId === myPresenceSessionId || (myUsername && u.username === myUsername)) return;
    const proj = u.projectId && projects[u.projectId] ? projects[u.projectId].name : '';
    const view = u.view ? (PRESENCE_VIEW_LABELS[u.view] || u.view) : '';
    const whereLabel = [view, proj].filter(Boolean).join(' — ');
    const existing = u.username ? people.find(function (p) { return p.u.username === u.username; }) : undefined;
    if (existing) {
      if (whereLabel && existing.places.indexOf(whereLabel) === -1) existing.places.push(whereLabel);
      return;
    }
    people.push({ u: u, places: whereLabel ? [whereLabel] : [] });
  });
  el.innerHTML = people.map(function (p) {
    const u = p.u;
    const name = u.displayName || u.username || 'Someone';
    const title = p.places.length ? (name + ' — ' + p.places.join(', ')) : name;
    const delayKey = u.username || u.sessionId || name;
    return '<span class="presence-avatar" style="background:' + presenceAvatarColor(u.username || name) + ';animation-delay:' + presenceAnimDelay(delayKey) + 's;" title="' + escapeHtml(title) + '">' + escapeHtml(presenceInitials(name)) + '</span>';
  }).join('');
}

export {
  sendPresenceUpdate,
  presenceAvatarColor,
  presenceInitials,
  presenceAnimDelay,
  renderPresenceAvatars,
};
