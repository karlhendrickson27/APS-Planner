// Sync connection: the WebSocket connection lifecycle and its status
// indicator — initSyncIndicator/setSyncIndicator/
// scheduleOfflineEscalation/cancelOfflineEscalation/isBusyEditing/
// handleRoomOpen/handleRoomClose/handleRoomSocketError/
// handleRoomSocketMessageEvent/setupRoomSync.
//
// Deliberately does NOT include handleRoomMessage() itself — the
// function handleRoomSocketMessageEvent() dispatches to — where the
// actual incoming-snapshot merge/conflict-resolution logic lives; see
// src/sync/inbound.ts.
//
// pendingWrites/sendRoomMessage/armStuckWriteWatch/clearPendingWrite/
// queueSharedSync/flushPendingRoomPush/pushRoomState (the OUTBOUND
// half of sync — sending local changes out) live in src/sync/outbound.ts
// instead — this file is scoped to the connection's own lifecycle and
// status, not what flows over it once open.
//
// isBusyEditing() reads barMoveState/tickResizeState/barResizeState/
// calDragState (Gantt/Calendar's own drag-in-progress flags, in
// src/views/gantt.ts and src/views/calendar.ts) and draggedCardId/
// draggedColId (Board's own, in src/views/board.ts).
import { sendPresenceUpdate } from './presence';
import { setStoredSessionToken } from '../auth/session';
import { reauthenticateOnce, buildRoomWsUrl, getSessionToken } from '../auth/login';
import ReconnectingWebSocket from 'reconnecting-websocket';

// Ambient globals this file shares verbatim with other src/ files
// (roomSocket, roomEverConnected, pendingWrites, draggedCardId,
// draggedColId, etc.) are declared once in src/shared-globals.d.ts, not
// repeated here.
declare global {
  function handleRoomMessage(msg: unknown): void;
}

// Small labeled pill, bottom-right (roadmap B3; it used to be an unlabeled
// dot). The label says the state in a word or two: "Live", "Connecting…",
// "Reconnecting…", "Offline", "Offline: 3 changes waiting", "Not saved".
// The longer reason is the native tooltip on hover, and a click or tap
// expands the pill to show it inline (phones have no hover). Styles are the
// SYNC INDICATOR block in index.html. The element keeps the id syncDot.
let syncDotEl: HTMLElement | null = null;
let syncLabelEl: HTMLElement | null = null;
let syncDetailEl: HTMLElement | null = null;
let syncState = 'ok';
let syncTooltip = '';
let syncOffline = false;
let offlineSince: number | null = null;
let offlineEscalateTimer: ReturnType<typeof setTimeout> | null = null;

function initSyncIndicator(): void {
  const pill = document.createElement('button');
  pill.type = 'button';
  pill.id = 'syncDot';
  pill.className = 'sync-pill';
  pill.setAttribute('aria-live', 'polite');
  pill.innerHTML = '<span class="sync-pill-dot" aria-hidden="true"></span><span class="sync-pill-label"></span><span class="sync-pill-detail"></span>';
  pill.addEventListener('click', function () {
    pill.classList.toggle('expanded');
    pill.setAttribute('aria-expanded', String(pill.classList.contains('expanded')));
  });
  document.body.appendChild(pill);
  syncDotEl = pill;
  syncLabelEl = pill.querySelector('.sync-pill-label');
  syncDetailEl = pill.querySelector('.sync-pill-detail');
}

function pendingChangesText(): string {
  const n = typeof pendingWrites !== 'undefined' ? pendingWrites.size : 0;
  return n === 0 ? '' : n === 1 ? '1 change waiting' : n + ' changes waiting';
}

function renderSyncIndicator(): void {
  if (!syncDotEl || !syncLabelEl || !syncDetailEl) return;
  let label: string;
  if (syncState === 'ok') label = 'Live';
  else if (syncState === 'connecting') label = syncTooltip || 'Connecting…';
  else if (syncOffline) label = pendingChangesText() ? 'Offline: ' + pendingChangesText() : 'Offline';
  else label = 'Not saved';
  const detail = syncTooltip || (syncState === 'ok' ? 'Connected. Changes save as you make them.' : '');
  syncDotEl.dataset.state = syncState;
  syncDotEl.title = syncState === 'ok' ? 'Live' : detail;
  syncLabelEl.textContent = label;
  syncDetailEl.textContent = detail && detail !== label ? detail : '';
}

// state: 'ok' (quiet "Live" — connected, nothing wrong, the default/happy
// state most of the time), 'connecting' (amber, e.g. initial connect or a
// fresh disconnect that might recover in a second or two), 'problem' (red,
// pulsing dot — offline long enough to matter, or a write that hasn't
// confirmed in 8+ seconds).
function setSyncIndicator(state: string, tooltip?: string): void {
  syncState = state;
  syncTooltip = tooltip || '';
  if (state === 'ok') syncOffline = false;
  renderSyncIndicator();
}

// Keeps "Offline: N changes waiting" current as changes queue up or get
// confirmed (called from src/sync/outbound.ts).
function refreshSyncIndicator(): void {
  renderSyncIndicator();
}

// Mirrors the old banner's debounce: a one-second wifi blip shouldn't
// escalate to the red/pulsing state, only a connection that's actually
// stayed down for a bit.
function scheduleOfflineEscalation(): void {
  if (offlineEscalateTimer !== null) clearTimeout(offlineEscalateTimer);
  if (!offlineSince) offlineSince = Date.now();
  offlineEscalateTimer = setTimeout(function () {
    syncOffline = true;
    setSyncIndicator('problem', "You're offline — changes aren't syncing. Try reloading once you're back online.");
  }, 8000);
}
function cancelOfflineEscalation(): void {
  if (offlineEscalateTimer !== null) clearTimeout(offlineEscalateTimer);
  offlineEscalateTimer = null;
  offlineSince = null;
}

function isBusyEditing(): boolean {
  const openModal = ['cardModal', 'themeModal', 'manageFieldsModal', 'deleteModal', 'calendarEventModal', 'manageColumnChecklistModal'].some(function (id) {
    const el = document.getElementById(id);
    return el && el.classList.contains('show');
  });
  if (openModal) return true;

  // A Gantt/Calendar bar drag or resize in progress is just as disruptable
  // by a mid-gesture remote refresh as typing in a form field is: a remote
  // update replaces `jobs` with freshly-parsed objects and renderGantt()/
  // renderCalendar() tear down and rebuild every bar element — while the
  // in-progress drag's state (barMoveState.bar, task references, etc.)
  // still points at the pre-refresh DOM/objects. Left unguarded, dropping
  // the drag after that lands on stale objects instead of the fresh ones,
  // which can end up mutating the wrong task's dates entirely.
  // draggedCardId/draggedColId are the Board's own drag-in-progress flags
  // (set/cleared by handleCardDragStart/End, handleColumnDragStart/End) —
  // same idiom as the Gantt/Calendar flags above, added here so a remote
  // snapshot mid-drag can't rebuild the board out from under the user the
  // same way it already can't for a Gantt/Calendar drag.
  if (barMoveState || tickResizeState || barResizeState || calDragState || draggedCardId || draggedColId) return true;

  const active = document.activeElement as HTMLElement | null;
  if (active) {
    if (active.isContentEditable) return true;
    const tag = active.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      // Only block if the focused input is actually inside the job form
      // (or the comments panel beside it, so a mid-draft comment isn't
      // disrupted by a remote refresh either)
      if (active.closest && (active.closest('#jobForm') || active.closest('#jobCommentsPanel'))) return true;
    }
  }
  return false;
}

function handleRoomOpen(): void {
  socketOpenedSinceLastClose = true;
  refusedConnects = 0;
  setSyncIndicator('ok');
  cancelOfflineEscalation();
  // Replay anything that didn't get confirmed before the connection
  // dropped — the server will just re-apply/re-ack it (upserts are
  // idempotent by id; a delete/tombstone replay is a harmless no-op if it
  // already landed; a stale whole-value replay gets correctly rejected +
  // re-synced the same as any other stale write).
  pendingWrites.forEach(function (entry) {
    // Unlike its fire-and-forget siblings elsewhere in this file, this is
    // resending real unsaved user data — armStuckWriteWatch()'s 8s timer
    // remains the actual safety net either way, but a silent failure here
    // shouldn't also be a silent one in the console.
    try { roomSocket!.send(JSON.stringify(entry.msg)); } catch (e) { console.error('Failed to resend pending write on reconnect', entry.msg, e); }
  });
  sendPresenceUpdate();
}

// A connection the server refuses (e.g. this session was signed out by a
// password reset, or the account was removed) just fails: browsers don't
// expose the HTTP 401 behind a failed WebSocket, and the token still looks
// unexpired locally, so the reconnect loop would retry forever. After two
// attempts in a row that never opened, ask an ordinary endpoint whether the
// session is still valid; if it isn't, sign in again. At most once a minute,
// and a network error (plain offline) changes nothing.
let socketOpenedSinceLastClose = false;
let refusedConnects = 0;
let lastSessionCheckAt = 0;
function checkSessionAfterRefusedConnect(): void {
  if (Date.now() - lastSessionCheckAt < 60000) return;
  lastSessionCheckAt = Date.now();
  getSessionToken().then(function (token) {
    return fetch(API_BASE_URL + 'users/roster', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token }) });
  }).then(function (res) {
    if (res.status === 401) {
      setStoredSessionToken(null);
      reauthenticateOnce(true);
    }
  }).catch(function () { /* offline or unreachable: keep retrying as usual */ });
}

function handleRoomClose(event?: { code?: number }): void {
  // Close code 4001 = the server force-closed this connection because an
  // admin changed our role/project assignment (see the Worker's
  // /internal/kick-user, called from handleUsersUpdate/handleUsersRemove).
  // The cached token still encodes the OLD permissions and buildRoomWsUrl()
  // would happily reuse it on a plain reconnect (getSessionToken() only
  // re-authenticates when the cached token is actually expired) — clearing
  // it here forces a fresh interactive login instead, so the reconnect
  // picks up real, current permissions (or correctly fails if removed).
  if (event && event.code === 4001) {
    setStoredSessionToken(null);
    reauthenticateOnce(true);
  } else if (!socketOpenedSinceLastClose && ++refusedConnects >= 2) {
    checkSessionAfterRefusedConnect();
  }
  socketOpenedSinceLastClose = false;
  // Escalate to the offline indicator on ANY close, not just one after a
  // previously-successful connection — a first-connection failure (cold
  // start, brief outage right at page load) used to leave the dot stuck on
  // "Connecting…" forever since roomEverConnected was still false.
  // scheduleOfflineEscalation() already dedupes via offlineSince/
  // clearTimeout, so calling it unconditionally here is safe.
  if (roomEverConnected) {
    setSyncIndicator('connecting', 'Reconnecting…');
  }
  scheduleOfflineEscalation();
}
function handleRoomSocketError(err: unknown): void {
  console.error('Room socket error', err);
}
function handleRoomSocketMessageEvent(event: { data: string }): void {
  try {
    handleRoomMessage(JSON.parse(event.data));
  } catch (err) {
    console.error('handleRoomMessage failed — a remote update may not have fully applied', err);
  }
}

async function setupRoomSync(): Promise<void> {
  initSyncIndicator();
  setSyncIndicator('connecting', 'Connecting…');

  try {

    // Bundled (package.json, pinned) rather than loaded from a CDN at run
    // time, so no third-party code runs in the app.
    roomSocket = new ReconnectingWebSocket(buildRoomWsUrl, [], { maxRetries: Infinity }) as any;
    roomSocket!.addEventListener('open', handleRoomOpen);
    roomSocket!.addEventListener('close', handleRoomClose);
    roomSocket!.addEventListener('error', handleRoomSocketError);
    roomSocket!.addEventListener('message', handleRoomSocketMessageEvent);

    window.addEventListener('offline', function () { scheduleOfflineEscalation(); });

  } catch (err) {
    console.error('Room sync init failed:', err);
    setSyncIndicator('problem', 'Sync failed: ' + (err as Error).message);
  }
}

export {
  initSyncIndicator,
  setSyncIndicator,
  refreshSyncIndicator,
  scheduleOfflineEscalation,
  cancelOfflineEscalation,
  isBusyEditing,
  handleRoomOpen,
  handleRoomClose,
  handleRoomSocketError,
  handleRoomSocketMessageEvent,
  setupRoomSync,
};
