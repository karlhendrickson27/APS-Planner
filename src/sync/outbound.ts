// Outbound sync: sending this browser's own changes out to the shared
// room. queueSharedSync/flushPendingRoomPush/flushPendingSync/logout/
// sendRoomMessage/armStuckWriteWatch/clearPendingWrite/
// hasPendingWriteForProject/pushProjectToShared/removeProjectFromShared/
// pruneStrayEmptyProjects/deleteFromSharedMap/deleteJobFromShared/
// deleteCardFromShared/deleteCalendarEventFromShared/recordTombstone/
// pushFieldToShared/pushBoardColumnsToShared/pushFieldOptionsToShared/
// pushWorkflowItemsToShared/pushHeaderToShared/logActivity/
// pushRoomState. This is everything that pushes a local change TO
// the server; it deliberately excludes the INBOUND merge/
// conflict-resolution logic (handleRoomMessage, applyRoomSnapshot,
// safeMergeInto, synthesizeJobFromOrphanCard, scheduleOrphanRecovery,
// healOrphanedJobCards & friends), which lives in src/sync/inbound.ts
// instead.
//
// stuckWriteTimer/syncPushTimer/msgSeq are private to this file — every
// reader and writer of them lives in the functions here, so they're
// ordinary module-scoped `let`s below rather than ambient globals.
//
// localActivityLog is a `var` in index.html, since logActivity() below
// reads/writes it from this separately-bundled script.
import { setSyncIndicator, refreshSyncIndicator } from './connection';
import { USERNAME_KEY, DISPLAY_NAME_KEY, getStoredDisplayName, setStoredSessionToken } from '../auth/session';
import { normalizeThemeColor, getSavedThemeColor } from '../app/theme';
import { renderActivityLogSidebar } from '../app/activity-log';

// Ambient globals this file shares verbatim with other src/ files
// (roomSocket, activeProjectId, projects, saveProjects(),
// mergeTombstones(), etc.) are declared once in src/shared-globals.d.ts,
// not repeated here.
declare global {
  // eslint-disable-next-line no-var
  var localActivityLog: { who: string; what: string; when: number }[];
  function getActiveProject(): any;
  function flushAutoSaveJobForm(): void;
  function flushCardAutosave(): void;
}

let stuckWriteTimer: ReturnType<typeof setTimeout> | null = null;
let syncPushTimer: ReturnType<typeof setTimeout> | null = null;

// msgId -> { msg, sentAt } — every outbound write sits here until acked,
// rejected, or errored. Replayed in order on reconnect (see
// src/sync/connection.ts's handleRoomOpen()) since a plain WebSocket has
// no built-in "resend what didn't make it" the way Liveblocks' SDK did.
// Real module-owned export now (moved out of index.html) — only ever
// mutated via .set()/.delete(), never wholesale-reassigned, so
// connection.ts's own read of it (via src/shared-globals.d.ts's ambient
// declaration) stays correctly in sync with this same Map instance.
export const pendingWrites = new Map<string, { msg: Record<string, unknown>; sentAt: number }>();
let msgSeq = 0;

function queueSharedSync(): void {
  clearTimeout(syncPushTimer as ReturnType<typeof setTimeout>);
  syncPushTimer = setTimeout(pushRoomState, 300);
}

// Synchronously pushes any project edit still sitting in the debounced
// room-sync queue, if one is pending — must run before anything
// reassigns activeProjectId (switchProject()/enforceProjectScopeForRole())
// so the still-armed timer can't fire AFTER the flip and misdirect a
// pending edit at the new project instead of the one it was actually for.
// pushRoomState() resolves its target via getActiveProject() at
// FIRE time, with no memory of which project queueSharedSync() was
// originally armed for — left unflushed, an edit made just before a
// switch is silently never pushed to the shared room at all (it stays
// correct in this browser's own localStorage, but the timer that fires
// 300ms later pushes whatever project is active BY THEN instead).
function flushPendingRoomPush(): void {
  if (syncPushTimer) {
    clearTimeout(syncPushTimer);
    syncPushTimer = null;
    pushRoomState();
  }
}

// Without this, a page close/refresh within that 300ms window loses the
// edit entirely: it's already in memory, but the debounced push (and
// the batched local-copy save) never fires. Flush any pending push the moment the tab
// is hidden or about to unload.
function flushPendingSync(): void {
  flushAutoSaveJobForm();
  flushCardAutosave();
  flushPendingRoomPush();
  // Last, after the flushes above have saved any in-progress edit.
  flushProjectsToLocalCache({ closing: true });
}
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'hidden') flushPendingSync();
});
window.addEventListener('pagehide', flushPendingSync);

// A full reload rather than a manual in-place reset of every module-level
// global (currentUserRole, currentAssignedProjectId, roomSocket,
// pendingWrites, activeProjectId, ...) — reusing the app's own already-
// proven fresh-boot path is safer than hand-rolling a teardown that has to
// remember every one of them.
function logout(): void {
  if (!window.confirm('Log out of TeamSync?')) return;
  flushPendingSync();
  if (roomSocket) { try { roomSocket.close(); } catch (e) { /* already closed/closing */ } }
  setStoredSessionToken(null);
  localStorage.removeItem(USERNAME_KEY);
  localStorage.removeItem(DISPLAY_NAME_KEY);
  window.location.reload();
}

// ---- Outbound: send a message, track it until acked ----
function sendRoomMessage(msg: Record<string, unknown>): string {
  msg.msgId = 'm' + (++msgSeq) + '-' + Date.now();
  pendingWrites.set(msg.msgId as string, { msg: msg, sentAt: Date.now() });
  armStuckWriteWatch();
  refreshSyncIndicator();
  if (roomSocket && roomSocket.readyState === 1) {
    try { roomSocket.send(JSON.stringify(msg)); } catch (err) { console.error('Failed to send room message', err); }
  }
  // If the socket isn't open, the message just waits in pendingWrites —
  // the 'open' handler (src/sync/connection.ts's handleRoomOpen) replays
  // everything still pending once (re)connected, so nothing needs to
  // happen here in that case.
  return msg.msgId as string;
}

function armStuckWriteWatch(): void {
  if (stuckWriteTimer) return;
  stuckWriteTimer = setTimeout(function () {
    stuckWriteTimer = null;
    if (pendingWrites.size > 0) {
      console.error('Room sync stuck — ' + pendingWrites.size + ' change(s) not yet confirmed by the server after 8+ seconds.');
      setSyncIndicator('problem', 'Last change may not have saved — try reloading if this persists.');
    }
  }, 8000);
}
function clearPendingWrite(msgId: string): void {
  pendingWrites.delete(msgId);
  if (pendingWrites.size === 0) {
    if (stuckWriteTimer) { clearTimeout(stuckWriteTimer); stuckWriteTimer = null; }
    // Only reached via an ack/rejection, meaning the connection is
    // currently healthy — resolves a stuck-write indicator if one was
    // showing, back to the default silent state.
    setSyncIndicator('ok');
  }
}

// True while this project has a local change not yet confirmed by the
// server — either already sent and awaiting an ack (pendingWrites), or
// still sitting in the 300ms queueSharedSync() debounce and not even
// sent yet (syncPushTimer). Both windows matter: a snapshot broadcast can
// be triggered by anything in the room (another user's edit, this
// project's own earlier push) and doesn't guarantee it reflects a change
// just made locally — applying it blindly during either window can race
// an optimistic local add/edit and wipe it back out before it ever
// reaches the server (caught during staging testing: a just-added job
// vanishing). pushRoomState() (what the debounce timer calls) only
// ever pushes the active project, so the timer only implicates that one.
// Used by src/sync/inbound.ts's applyRoomSnapshot().
function hasPendingWriteForProject(projectId: string): boolean {
  if (syncPushTimer && projectId === activeProjectId) return true;
  for (const entry of pendingWrites.values()) {
    if (entry.msg && entry.msg.projectId === projectId) return true;
  }
  return false;
}

// ===== What's already in sync with the server =====
// Per project and per kind, the JSON of each job/card/event as last sent
// to or received from the server (updatedAt excluded). An item whose
// current JSON differs is "dirty": it has a local change the server
// doesn't have yet. pushProjectToShared() sends only dirty items, and
// src/sync/inbound.ts's delta merge never overwrites a dirty item.
//
// This replaces re-sending EVERY item with a fresh updatedAt on every
// save. Besides the cost (the whole project uploaded per keystroke-save),
// that let an out-of-date copy of a job someone else had just edited win
// on timestamp and silently overwrite their change. Now an item is only
// ever sent — and only ever gets a new updatedAt — when this browser
// actually changed it.
type SyncKind = 'jobs' | 'boardCards' | 'calendarEvents';
const SYNC_KINDS: SyncKind[] = ['jobs', 'boardCards', 'calendarEvents'];
const syncedJson: Record<string, Record<SyncKind, Map<string, string>>> = {};
const lastSentHeaderJson: Record<string, string> = {};

function itemSyncJson(item: any): string {
  const copy = Object.assign({}, item);
  delete copy.updatedAt;
  return JSON.stringify(copy);
}
function syncedMaps(projectId: string): Record<SyncKind, Map<string, string>> {
  if (!syncedJson[projectId]) syncedJson[projectId] = { jobs: new Map(), boardCards: new Map(), calendarEvents: new Map() };
  return syncedJson[projectId];
}

// Everything in this project now matches the server (called after a full
// snapshot is merged in).
function resetSyncedFromProject(projectId: string, proj: any): void {
  const maps = { jobs: new Map<string, string>(), boardCards: new Map<string, string>(), calendarEvents: new Map<string, string>() };
  SYNC_KINDS.forEach(function (kind) {
    (proj[kind] || []).forEach(function (item: any) { if (item && item.id !== undefined) maps[kind].set(String(item.id), itemSyncJson(item)); });
  });
  syncedJson[projectId] = maps;
}
function markItemSynced(projectId: string, kind: SyncKind, item: any): void {
  syncedMaps(projectId)[kind].set(String(item.id), itemSyncJson(item));
}
function forgetSyncedItem(projectId: string, kind: SyncKind, id: string | number): void {
  syncedMaps(projectId)[kind].delete(String(id));
}
function isItemDirty(projectId: string, kind: SyncKind, item: any): boolean {
  return syncedMaps(projectId)[kind].get(String(item.id)) !== itemSyncJson(item);
}

// True if any job/card/event in the project differs from what the server
// has. After merging remote data the app normalizes it (fills in missing
// ids/tasks, creates a job's board card, moves a card to its
// date-derived stage) — those local-only changes must be pushed promptly,
// or the delta merge would keep treating the items as "mid-edit" and hold
// back teammates' changes to them.
function hasDirtyItems(projectId: string): boolean {
  const proj = projects[projectId];
  if (!proj) return false;
  return SYNC_KINDS.some(function (kind) {
    return (proj[kind] || []).some(function (item: any) { return item && isItemDirty(projectId, kind, item); });
  });
}

// Ids of items this browser has sent in a batch the server hasn't
// acknowledged yet — the delta merge leaves those alone too, until the
// server's answer (ack + echo, or a rejection + fresh snapshot) arrives.
function pendingItemIds(projectId: string, kind: SyncKind): Set<string> {
  const ids = new Set<string>();
  pendingWrites.forEach(function (entry) {
    const m = entry.msg as any;
    if (m && m.projectId === projectId && Array.isArray(m[kind])) m[kind].forEach(function (it: any) { if (it) ids.add(String(it.id)); });
  });
  return ids;
}

// Pushes a project's routine, frequently-changing fields (jobs/cards/
// calendar events/header) as one batch — only the items that changed
// (see syncedJson above); nothing at all if nothing did. Pass
// {full: true} to send every item regardless (first push into an empty
// room). Deliberately does NOT touch boardColumns/fieldOptions/
// workflowItems — those go through pushFieldToShared() instead, fired
// only from the exact functions that intentionally change them, since
// (unlike jobs/cards/events, which are per-id maps) they're whole-array/
// object fields with no per-item id to diff against a teammate's own
// concurrent change.
function pushProjectToShared(projectId: string, headerOverride?: any, opts?: { full?: boolean }): void {
  const proj = projects[projectId];
  if (!proj) return;
  const header = headerOverride || proj.header;
  const full = !!(opts && opts.full);
  const now = Date.now();

  const msg: Record<string, unknown> = { type: 'upsertProjectBatch', projectId: projectId, name: proj.name };
  let itemCount = 0;
  SYNC_KINDS.forEach(function (kind) {
    const changed = (proj[kind] || []).filter(function (item: any) { return item && (full || isItemDirty(projectId, kind, item)); });
    msg[kind] = changed.map(function (item: any) { return Object.assign({}, item, { updatedAt: now }); });
    changed.forEach(function (item: any) { markItemSynced(projectId, kind, item); });
    itemCount += changed.length;
  });
  const headerValue: Record<string, unknown> = { title: header.title || proj.name, subtitle: header.subtitle || '', theme: normalizeThemeColor(header.theme) };
  // Board logo and archived flag (src/app/projects-admin.ts), when set.
  if (typeof header.logo === 'string') headerValue.logo = header.logo;
  if (typeof header.archived === 'boolean') headerValue.archived = header.archived;
  const headerJson = JSON.stringify(headerValue) + '|' + proj.name;
  const headerChanged = lastSentHeaderJson[projectId] !== headerJson;
  msg.header = headerValue;
  if (!full && !itemCount && !headerChanged) return;
  lastSentHeaderJson[projectId] = headerJson;
  sendRoomMessage(msg);
}

// Removes a project's entry entirely — no UI calls this (project
// deletion is still disabled app-wide), but it's a real, wired-up server
// capability now, reachable from a browser console for exactly the kind
// of one-off admin cleanup this was built for: e.g.
// removeProjectFromShared('some-stray-project-id').
function removeProjectFromShared(projectId: string): void {
  sendRoomMessage({ type: 'removeProject', projectId: projectId });
}

// A rare sync race (see the comment above enforceFixedProjectSet()'s
// call in src/app/boot.ts's init() — a stray empty "Untitled Project"
// reached production once already) can leave a genuinely empty,
// still-default-named "Untitled Project" sitting in the shared room.
// This app is fixed to exactly two projects and has no user-facing way to delete one, so
// instead of leaving it to keep syncing down to every client forever,
// prune it automatically on every snapshot: remove it locally AND tell
// the shared room to drop it too (removeProjectFromShared()) so it
// doesn't just reappear on the next one. Deliberately narrow — only ever
// touches a project that's BOTH named exactly the untouched default AND
// has no real data on it, and never the one currently being viewed, so a
// legitimately (if oddly) named or populated project is never at risk.
function pruneStrayEmptyProjects(): void {
  Object.keys(projects).forEach(function (id) {
    const p = projects[id];
    if (!p || p.name !== 'Untitled Project' || id === activeProjectId) return;
    const isEmpty = (!p.jobs || !p.jobs.length) && (!p.boardCards || !p.boardCards.length) && (!p.calendarEvents || !p.calendarEvents.length);
    if (!isEmpty) return;
    console.warn('Pruning a stray empty "Untitled Project" (id ' + id + ')');
    delete projects[id];
    saveProjects();
    removeProjectFromShared(id);
    updateProjectToggle();
  });
}

// Explicit, targeted deletes for one job/card/calendar event — the only
// things that actually remove a key from the shared data, called at the
// exact moment the user deletes something. Also tombstones the id, since
// a stale tab's later routine upsert could otherwise resurrect the very
// thing just deleted here (see the comment above pushProjectToShared()).
function deleteFromSharedMap(projectId: string | null, mapKey: string, id: string | number): void {
  const keyMap: Record<string, string> = { jobsMap: 'jobs', boardCardsMap: 'boardCards', calendarEventsMap: 'calendarEvents' };
  sendRoomMessage({ type: 'deleteFromMap', projectId: projectId, mapKey: keyMap[mapKey] || mapKey, id: id });
  if (projectId) forgetSyncedItem(projectId, (keyMap[mapKey] || mapKey) as SyncKind, id);
  const proj = projects[projectId as string];
  if (proj) proj.deletedIds = mergeTombstones(proj.deletedIds, { [String(id)]: Date.now() });
}
function deleteJobFromShared(projectId: string, jobId: string | number): void { deleteFromSharedMap(projectId, 'jobsMap', jobId); }
// Signatures below match the ambient declarations already made by
// src/views/board.ts/calendar.ts — TypeScript's global declaration
// merging requires this file's real implementation to match exactly.
function deleteCardFromShared(projectId: string | null, cardId: string): void { deleteFromSharedMap(projectId, 'boardCardsMap', cardId); }
function deleteCalendarEventFromShared(projectId: string | null, eventId: string): void { deleteFromSharedMap(projectId, 'calendarEventsMap', eventId); }

// Same tombstone-only bookkeeping, for ids with no top-level map entry of
// their own — like a deleted job phase (nested inside job.phases, which
// rides along inside the whole job object push).
function recordTombstone(projectId: string, id: string | number): void {
  sendRoomMessage({ type: 'recordTombstone', projectId: projectId, id: id });
  const proj = projects[projectId];
  if (proj) proj.deletedIds = mergeTombstones(proj.deletedIds, { [String(id)]: Date.now() });
}

// Targeted pushes for the whole-array/object project fields that
// pushProjectToShared() deliberately doesn't touch on its routine path —
// fired only from the exact functions that intentionally change these
// (saveBoardColumns()/saveFieldOptions()), each carrying the field's
// current known revision so the server can tell a stale write (from a
// tab that hasn't caught up with someone else's more recent change) from
// a current one, rather than blindly overwriting either way.
function pushFieldToShared(projectId: string, fieldKey: string, value: unknown): void {
  const proj = projects[projectId];
  if (!proj) return;
  const typeByField: Record<string, string> = { boardColumns: 'setBoardColumns', fieldOptions: 'setFieldOptions', header: 'setHeader', workflowItems: 'setWorkflowItems' };
  const msgType = typeByField[fieldKey];
  if (!msgType) return;
  const baseFieldRevision = (proj.fieldRevisions && proj.fieldRevisions[fieldKey]) || 0;
  sendRoomMessage({ type: msgType, projectId: projectId, value: value, baseFieldRevision: baseFieldRevision });
  // Optimistically bump the local revision so a rapid second edit before
  // the ack lands still sends a plausible baseFieldRevision rather than
  // the same now-stale one twice — if this guess is wrong the server's
  // rejection (and the snapshot that immediately follows it) corrects it.
  if (!proj.fieldRevisions) proj.fieldRevisions = { boardColumns: 0, fieldOptions: 0, header: 0, workflowItems: 0 };
  proj.fieldRevisions[fieldKey] = baseFieldRevision + 1;
}
function pushBoardColumnsToShared(projectId: string): void {
  const proj = projects[projectId];
  if (proj) pushFieldToShared(projectId, 'boardColumns', proj.boardColumns);
}
function pushFieldOptionsToShared(projectId: string): void {
  const proj = projects[projectId];
  if (proj) pushFieldToShared(projectId, 'fieldOptions', proj.fieldOptions);
}
function pushWorkflowItemsToShared(projectId: string): void {
  const proj = projects[projectId];
  if (proj) pushFieldToShared(projectId, 'workflowItems', proj.workflowItems);
}
function pushHeaderToShared(projectId: string): void {
  const proj = projects[projectId];
  if (proj) pushFieldToShared(projectId, 'header', proj.header);
}

function logActivity(actionText: string): void {
  const p = getActiveProject();
  if (!p) return;
  const name = getStoredDisplayName() || 'Someone';
  const entry = { who: name, what: actionText, when: Date.now() };

  // Always keep a local copy so it works even when offline
  localActivityLog.push(entry);
  while (localActivityLog.length > 50) localActivityLog.shift();

  sendRoomMessage({ type: 'logActivity', projectId: p.id, who: name, what: actionText, when: entry.when });

  const sidebar = document.getElementById('activitySidebar');
  if (sidebar && !sidebar.classList.contains('collapsed')) {
    renderActivityLogSidebar();
  }
}

function pushRoomState(): void {
  clearTimeout(syncPushTimer as ReturnType<typeof setTimeout>);
  syncPushTimer = null;

  const p = getActiveProject();
  if (!p) return;

  try {
    // Read straight from the DOM for the active project's header, since that's
    // the freshest source (p.header is only updated on blur via saveActiveProject).
    pushProjectToShared(p.id, {
      title: (document.getElementById('headerTitle') as HTMLElement).textContent!.trim(),
      subtitle: (document.getElementById('headerSubtitle') as HTMLElement).textContent!.trim(),
      theme: getSavedThemeColor()
    });
  } catch (e) {
    console.error(e);
    setSyncIndicator('problem', 'Save failed: ' + (e as Error).message);
  }
}

export {
  queueSharedSync,
  flushPendingRoomPush,
  flushPendingSync,
  logout,
  sendRoomMessage,
  armStuckWriteWatch,
  clearPendingWrite,
  hasPendingWriteForProject,
  pushProjectToShared,
  resetSyncedFromProject,
  markItemSynced,
  forgetSyncedItem,
  isItemDirty,
  hasDirtyItems,
  pendingItemIds,
  removeProjectFromShared,
  pruneStrayEmptyProjects,
  deleteFromSharedMap,
  deleteJobFromShared,
  deleteCardFromShared,
  deleteCalendarEventFromShared,
  recordTombstone,
  pushFieldToShared,
  pushBoardColumnsToShared,
  pushFieldOptionsToShared,
  pushWorkflowItemsToShared,
  pushHeaderToShared,
  logActivity,
  pushRoomState,
};
