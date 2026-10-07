// Inbound sync: receiving and merging other people's changes in.
// handleRoomMessage/synthesizeJobFromOrphanCard/safeMergeInto/
// scheduleOrphanRecovery/healOrphanedJobCards/healOrphanedPhaseCards/
// healOrphanedCardsForProject/applyRoomSnapshot/
// refreshActiveProjectFromShared, plus the focusout listener that
// catches up a deferred remote refresh. This is the actual
// conflict-resolution code that decides what happens when a remote
// snapshot arrives while a local edit may still be in flight — the one
// place in the whole app where a bug could silently overwrite or lose a
// teammate's work instead of just misbehaving on one screen.
//
// mergeTombstones() (src/app/boot.ts, also read by src/sync/outbound.ts)
// is referenced here as an ambient global rather than imported — no
// natural single owner among the sync files.
import { isBusyEditing } from './connection';
import { renderPresenceAvatars, PresenceUser } from './presence';
import { clearPendingWrite, queueSharedSync, pushProjectToShared, pushRoomState, pruneStrayEmptyProjects, deleteCardFromShared, hasPendingWriteForProject, resetSyncedFromProject, markItemSynced, forgetSyncedItem, isItemDirty, hasDirtyItems, pendingItemIds } from './outbound';
import { renderGantt, isGanttReorderAnimating, GANTT_REORDER_MS } from '../views/gantt';
import { renderBoard } from '../views/board';
import { renderCalendar, ensureCalendarEventIds } from '../views/calendar';
import { genId } from '../utils/id';
import { DEFAULT_THEME_COLOR, applyProjectBgVisual } from '../app/theme';
import { ensureCardIds, ensureJobAndTaskIds } from '../core/jobs';
import { Job } from '../core/types';
import { enforceFixedProjectSet } from '../app/project';
import { renderActivityLogSidebar } from '../app/activity-log';
import { isPanelActive } from '../utils/ui';
import { renderMyChecklist } from '../views/checklist';
import { renderReportsIfActive } from '../views/reports';
import { renderJobListWhenVisible } from '../views/job-list';
import { refreshNotifications } from '../app/notifications';

// Ambient globals this file shares verbatim with other src/ files
// (roomEverConnected, activeProjectId, projects, latestPresenceUsers,
// mergeTombstones(), renderJobList(), etc.) are declared once in
// src/shared-globals.d.ts, not repeated here.
declare global {
  // eslint-disable-next-line no-var
  var pendingRemoteRefresh: boolean;
  function enforceProjectScopeForRole(): void;
  function loadActiveProjectData(): void;
  function renderAll(): void;
  function hideFreshLoadOverlay(): void;
  function updateJobCount(): void;
  function refreshArchivedJobsListIfOpen(): void;
}

// A project's board logo and archived flag (Projects window,
// src/app/projects-admin.ts) ride in its header. Returns true when either
// changed, so the project list and the logo get redrawn.
function copyLogoAndArchived(local: any, remoteHeader: any): boolean {
  let changed = false;
  if (typeof remoteHeader.logo === 'string' && remoteHeader.logo !== local.header.logo) { local.header.logo = remoteHeader.logo; changed = true; }
  if (typeof remoteHeader.archived === 'boolean' && remoteHeader.archived !== !!local.header.archived) { local.header.archived = remoteHeader.archived; changed = true; }
  if (changed && activeProjectId && projects[activeProjectId] === local) applyProjectBgVisual();
  return changed;
}

function handleRoomMessage(msg: any): void {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'snapshot') {
    const isFirst = !roomEverConnected;
    roomEverConnected = true;
    applyRoomSnapshot(msg.projects || {}, isFirst);
    refreshNotifications();
    return;
  }
  if (msg.type === 'delta') {
    applyRoomDelta(msg.projects || {});
    refreshNotifications();
    return;
  }
  if (msg.type === 'presence') {
    latestPresenceUsers = msg.users || [];
    renderPresenceAvatars();
    return;
  }
  if (msg.type === 'ack') {
    clearPendingWrite(msg.msgId);
    return;
  }
  if (msg.type === 'rejected') {
    console.warn('Room rejected a stale write (a fresh snapshot follows to re-sync)', msg);
    clearPendingWrite(msg.msgId);
    return;
  }
  if (msg.type === 'error') {
    console.error('Room reported an error processing a message', msg);
    if (msg.msgId) clearPendingWrite(msg.msgId);
    return;
  }
}

// Best-effort recovery for a board card whose jobId doesn't match any job
// in the synced jobs — reconstructs a minimal job shell from what the card
// still has (title, color) with one blank task per board column, the same
// shape addNewJob() gives a brand-new job. Whatever the original job's own
// dates/notes/tasks were are gone (only the card survived); this recovers
// the job's existence and its link back to the card, not its history.
function synthesizeJobFromOrphanCard(card: any, boardColumns: { id: string; label: string; color?: string }[]): any {
  const tasks = (boardColumns || []).map(function (col, i) {
    return { id: genId(), name: col.label, columnId: col.id, start: '', finish: '', notes: '', color: col.color || '#3949ab', order: i };
  });
  return {
    id: card.jobId,
    name: card.title || 'Recovered job',
    color: card.color || '#3949ab',
    archived: false,
    comments: [],
    tasks: tasks
  };
}

// Jobs and cards can arrive in the same snapshot but a moment apart in
// spirit (the server applies one message at a time, but two nearly-
// simultaneous pushes from different tabs can still interleave which
// snapshot each field lands in first from this client's point of view) —
// so a card can be seen before its job in some edge case, which looks
// identical to a genuine sync gap at the instant a snapshot is processed.
// Giving each orphan a grace period before deciding it's really gone
// avoids treating that as permanent. Keyed by jobId so a second pass while
// one's already waiting doesn't stack duplicate timers.
const ORPHAN_RECOVERY_GRACE_MS = 5000;
const pendingOrphanRecovery: Record<string, ReturnType<typeof setTimeout>> = {};

// Object.assign({}, ..., remoteFieldOpts) below merges JSON parsed
// straight off the WebSocket — unlike an object literal, JSON.parse
// creates "__proto__" as an ordinary own-enumerable data property (not
// prototype-setting syntax), and Object.assign copies via [[Set]], which
// DOES trigger the target's inherited __proto__ setter for a key with
// that exact name. A remote payload carrying a top-level "__proto__" key
// would silently repoint local.fieldOptions's prototype. Filters that
// (and the two other prototype-chain property names) out before merging.
function safeMergeInto(target: any, source: any): any {
  if (!source || typeof source !== 'object') return target;
  Object.keys(source).forEach(function (key) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
    target[key] = source[key];
  });
  return target;
}

// Shared timeout-scheduling shape behind applyRoomSnapshot()'s two card-
// orphan recovery paths below (healOrphanedJobCards/healOrphanedPhaseCards)
// — a job-level card whose job hasn't arrived yet, and a phase-level card
// whose job exists but is missing that one phase. They differ in what
// they recheck/recover, not in the dedup + grace-period + recheck-before-
// recovering bookkeeping itself, so only that shape is shared; the
// domain-specific filter/recheck/recover logic stays in the two distinct
// caller functions rather than being forced into one generic callback.
// Defined as an ordinary top-level function (not nested inside
// applyRoomSnapshot) since it has no dependency on that function's own
// closure — projectId/recheckFn/recoverFn are passed in explicitly.
//
// recheckFn(proj) returns true if recovery is still needed (job/phase
// still missing, not tombstoned, card still present) — checked fresh
// after the grace period in case something else already resolved the
// gap. recoverFn(proj) does the actual reconstruction once recheckFn
// confirms it's still needed.
function scheduleOrphanRecovery(key: string, projectId: string, recheckFn: (proj: any) => boolean, recoverFn: (proj: any) => void): void {
  if (pendingOrphanRecovery[key]) return;
  pendingOrphanRecovery[key] = setTimeout(function () {
    delete pendingOrphanRecovery[key];
    const proj = projects[projectId];
    if (!proj) return;
    if (!recheckFn(proj)) return;
    recoverFn(proj);
    if (projectId === activeProjectId) refreshActiveProjectFromShared();
    queueSharedSync();
  }, ORPHAN_RECOVERY_GRACE_MS);
}

// Self-heals the "card shows but job doesn't" sync gap: if the jobId is
// tombstoned, the job was deliberately deleted and this card is a
// leftover that should have gone with it — clean it up instead of
// resurrecting a job nobody wants back. Otherwise it's the genuine sync
// gap: reconstruct a minimal job shell from what the card still has and
// re-link it, after a grace period in case the job is just still in
// flight.
function healOrphanedJobCards(local: any, projectId: string): void {
  const orphanCards = local.boardCards.filter(function (c: any) { return c.jobId && !local.jobs.some(function (j: any) { return j.id === c.jobId; }); });
  if (!orphanCards.length) return;
  const staleCards = orphanCards.filter(function (c: any) { return local.deletedIds[String(c.jobId)]; });
  const trulyOrphaned = orphanCards.filter(function (c: any) { return !local.deletedIds[String(c.jobId)]; });

  if (staleCards.length) {
    console.warn('applyRoomSnapshot: dropping ' + staleCards.length + ' card(s) whose job was deliberately deleted for project ' + projectId, staleCards.map(function (c: any) { return { cardId: c.id, title: c.title, jobId: c.jobId }; }));
    local.boardCards = local.boardCards.filter(function (c: any) { return staleCards.indexOf(c) === -1; });
    staleCards.forEach(function (c: any) { deleteCardFromShared(projectId, c.id); });
    queueSharedSync();
  }

  trulyOrphaned.forEach(function (card: any) {
    const jobId = card.jobId;
    scheduleOrphanRecovery(jobId, projectId, function (proj) {
      const stillMissing = !proj.jobs.some(function (j: any) { return j.id === jobId; });
      const stillTombstoned = proj.deletedIds && proj.deletedIds[String(jobId)];
      const stillHasCard = proj.boardCards.some(function (c: any) { return c.id === card.id; });
      return stillMissing && !stillTombstoned && stillHasCard;
    }, function (proj) {
      console.warn('applyRoomSnapshot: job ' + jobId + ' still missing ' + (ORPHAN_RECOVERY_GRACE_MS / 1000) + 's after its card arrived — reconstructing from card for project ' + projectId, { cardId: card.id, title: card.title, jobId: jobId });
      proj.jobs.push(synthesizeJobFromOrphanCard(card, proj.boardColumns));
    });
  });
}

// A narrower version of the same gap, one level down: the card's own job
// DOES exist, but that job is phased and its phases array is missing the
// specific phase this card belongs to. Same stale-vs-genuine split and
// grace period as healOrphanedJobCards(), keyed by "jobId|phaseId" so it
// can't collide with that function's whole-job pendingOrphanRecovery keys.
function healOrphanedPhaseCards(local: any, projectId: string): void {
  const phaseOrphanCards = local.boardCards.filter(function (c: any) {
    if (!c.jobId || !c.phaseId) return false;
    const j = local.jobs.find(function (j: any) { return j.id === c.jobId; });
    return !!(j && j.phases && j.phases.length && !j.phases.some(function (p: any) { return p.id === c.phaseId; }));
  });
  if (!phaseOrphanCards.length) return;
  const stalePhaseCards = phaseOrphanCards.filter(function (c: any) { return local.deletedIds[String(c.phaseId)]; });
  const trulyPhaseOrphaned = phaseOrphanCards.filter(function (c: any) { return !local.deletedIds[String(c.phaseId)]; });

  if (stalePhaseCards.length) {
    console.warn('applyRoomSnapshot: dropping ' + stalePhaseCards.length + ' card(s) whose phase was deliberately deleted for project ' + projectId, stalePhaseCards.map(function (c: any) { return { cardId: c.id, title: c.title, phaseId: c.phaseId }; }));
    local.boardCards = local.boardCards.filter(function (c: any) { return stalePhaseCards.indexOf(c) === -1; });
    stalePhaseCards.forEach(function (c: any) { deleteCardFromShared(projectId, c.id); });
    queueSharedSync();
  }

  trulyPhaseOrphaned.forEach(function (card: any) {
    const key = card.jobId + '|' + card.phaseId;
    scheduleOrphanRecovery(key, projectId, function (proj) {
      const j = proj.jobs.find(function (j: any) { return j.id === card.jobId; });
      if (!j || !j.phases) return false;
      const stillMissing = !j.phases.some(function (p: any) { return p.id === card.phaseId; });
      const stillTombstoned = proj.deletedIds && proj.deletedIds[String(card.phaseId)];
      const stillHasCard = proj.boardCards.some(function (c: any) { return c.id === card.id; });
      return stillMissing && !stillTombstoned && stillHasCard;
    }, function (proj) {
      const j = proj.jobs.find(function (j: any) { return j.id === card.jobId; });
      console.warn('applyRoomSnapshot: phase ' + card.phaseId + ' of job ' + card.jobId + ' still missing after grace period — reconstructing from card for project ' + projectId, { cardId: card.id, title: card.title });
      const shell = synthesizeJobFromOrphanCard(card, proj.boardColumns);
      j.phases.push({ id: card.phaseId, name: (card.title || 'Recovered phase').split(' — ').pop(), order: j.phases.length, tasks: shell.tasks });
    });
  });
}

// Scoped to the active project only in applyRoomSnapshot() below — that's
// the only project whose merged local.jobs is actually being viewed/
// relied on for immediate feedback right now.
function healOrphanedCardsForProject(local: any, projectId: string): void {
  healOrphanedJobCards(local, projectId);
  healOrphanedPhaseCards(local, projectId);
}

function applyRoomSnapshot(remoteProjects: Record<string, any>, isFirstSnapshot: boolean): void {
  if (!remoteProjects || typeof remoteProjects !== 'object') return;

  // The phases below are split into named nested functions purely for
  // readability — same closures, same execution order, zero behavior
  // change. remoteIds/activeDataChanged/listChanged/busy are shared
  // across the per-project loop and the 3 post-loop phases, so they're
  // declared here rather than threaded through as parameters.
  const remoteIds = new Set<string>();
  let activeDataChanged = false;
  let listChanged = false;
  const busy = isBusyEditing();

  Object.keys(remoteProjects).forEach(function (projectId) {
    const entry = remoteProjects[projectId];
    remoteIds.add(projectId);
    const isActive = projectId === activeProjectId;

    if (!entry || typeof entry !== 'object') {
      console.warn('applyRoomSnapshot: skipping malformed entry for', projectId);
      return;
    }

    const remoteName = entry.name;
    const remoteJobs = entry.jobs || {};
    const remoteCards = entry.boardCards || {};
    const remoteCalEvents = entry.calendarEvents || {};
    const remoteColumns = entry.boardColumns;
    const remoteWorkflowItems = entry.workflowItems;
    const remoteFieldOpts = entry.fieldOptions;
    const remoteHeader = entry.header;
    const remoteDeletedIds = entry.deletedIds;
    const remoteActivityLog = entry.activityLog;
    const remoteFieldRevisions = entry.fieldRevisions;

    // local/isActive/projectId/entry/the remote* extractions above are
    // freshly computed each loop iteration and consumed by most of the
    // sub-concerns below — keeping the next two as nested functions
    // sharing THIS iteration's closure avoids threading them through
    // parameters on every call, while still keeping each sub-concern
    // separately named and readable.
    let local = projects[projectId];

    function resolveLocalProject(): void {
      if (!local) {
        local = {
          id: projectId,
          name: remoteName || 'Untitled Project',
          jobs: [],
          boardColumns: JSON.parse(JSON.stringify(DEFAULT_BOARD_COLUMNS)),
          workflowItems: [],
          boardCards: [],
          calendarEvents: [],
          deletedIds: {},
          fieldOptions: {},
          header: { title: remoteName || 'Untitled Project', subtitle: '', theme: DEFAULT_THEME_COLOR, bgPhoto: null, boardBgPhoto: null }
        };
        projects[projectId] = local;
        listChanged = true;
      }

      if (typeof remoteName === 'string' && remoteName !== local.name) {
        local.name = remoteName;
        listChanged = true;
      }
    }

    function mergeProjectFields(): void {
      // ── delete tombstones ── merged/pruned before jobs/cards/events below
      // so they can be filtered against it. Always safe to merge in — a
      // tombstone only ever adds deletion knowledge, it can't itself wipe
      // out data the way blindly re-deriving jobs/cards/events below can.
      local.deletedIds = mergeTombstones(local.deletedIds, remoteDeletedIds);

      // If a write for this project is still unacked, this snapshot may be
      // racing ahead of it (broadcast by something unrelated) and not yet
      // reflect it — re-deriving local.jobs/boardCards/calendarEvents from
      // it now would clobber an optimistic local add/edit before it ever
      // reaches the server. Skip it for just this project on just this
      // snapshot; the DO always broadcasts a fresh snapshot immediately
      // after accepting any write, so the very next one (once acked) will
      // already include our change and is safe to apply normally.
      const projectSyncPending = hasPendingWriteForProject(projectId);

      // ── jobs (now a plain {id: job} object from the server, not a LiveMap) ──
      if (!projectSyncPending) {
        const j = Object.values(remoteJobs).filter(function (job: any) { return !local.deletedIds[String(job.id)]; });
        ensureJobAndTaskIds(j as Job[]);
        j.forEach(function (job: any) { if (!job.notes) job.notes = ''; });
        j.sort(function (a: any, b: any) { return (a.order || 0) - (b.order || 0); });
        local.jobs = j;
      }

      // ── columns ──
      if (Array.isArray(remoteColumns) && remoteColumns.length) local.boardColumns = remoteColumns;

      // ── workflow items ── unlike boardColumns above, an empty array is a
      // legitimate real state (no items defined yet) rather than "hasn't
      // loaded" — the length check boardColumns uses would otherwise make
      // deleting the very last item unsyncable.
      if (Array.isArray(remoteWorkflowItems)) local.workflowItems = remoteWorkflowItems;

      // ── cards ──
      if (!projectSyncPending) {
        const c = Object.values(remoteCards).filter(function (card: any) { return !local.deletedIds[String(card.id)]; }) as any[];
        ensureCardIds(c);
        local.boardCards = c;
      }

      // ── calendar-only events ──
      if (!projectSyncPending) {
        const ce = Object.values(remoteCalEvents).filter(function (ev: any) { return !local.deletedIds[String(ev.id)]; });
        ensureCalendarEventIds(ce as any);
        local.calendarEvents = ce;
      }

      // Jobs/cards/events now match the server exactly — record that, so
      // the next save only sends what changes from here (see syncedJson
      // in src/sync/outbound.ts).
      if (!projectSyncPending) resetSyncedFromProject(projectId, local);

      // ── fields ──
      if (remoteFieldOpts) local.fieldOptions = safeMergeInto(Object.assign({}, local.fieldOptions), remoteFieldOpts);

      // ── header ── same race this project's jobs/cards/events are guarded
      // against above: a snapshot arriving while our own header edit (title,
      // subtitle, or theme/color) is still in flight could otherwise revert
      // it to whatever the server had before that edit landed — reported
      // live as "changing the header color defaults back to red."
      if (remoteHeader && !projectSyncPending) {
        if (typeof remoteHeader.title === 'string') local.header.title = remoteHeader.title;
        if (typeof remoteHeader.subtitle === 'string') local.header.subtitle = remoteHeader.subtitle;
        if (remoteHeader.theme) local.header.theme = remoteHeader.theme;
        if (copyLogoAndArchived(local, remoteHeader)) listChanged = true;
      }

      // ── activity log — plain array now, no LiveList wrapping to unwrap ──
      if (Array.isArray(remoteActivityLog)) local.activityLog = remoteActivityLog;

      // ── field revisions — what pushFieldToShared() needs to include as
      // baseFieldRevision next time it changes boardColumns/fieldOptions/
      // header, so the server can tell a stale write from a current one.
      // See worker/src/room-state.ts's handleSetWholeField().
      local.fieldRevisions = remoteFieldRevisions || local.fieldRevisions || { boardColumns: 0, fieldOptions: 0, header: 0, workflowItems: 0 };
    }

    resolveLocalProject();
    mergeProjectFields();

    // healOrphanedCardsForProject() (job-level + phase-level card-orphan
    // self-healing, via scheduleOrphanRecovery()) is scoped to isActive
    // only — that's the only project whose merged local.jobs is actually
    // being viewed/relied on for immediate feedback right now.
    if (isActive) {
      healOrphanedCardsForProject(local, projectId);
      activeDataChanged = true;
    }
  });

  function pruneRemovedProjects(): void {
    Object.keys(projects).forEach(function (localId) {
      if (remoteIds.has(localId)) return;
      if (Object.keys(projects).length <= 1) return;
      if (localId === activeProjectId) {
        const survivor = Object.keys(projects).find(function (id) { return id !== localId; });
        if (survivor) {
          activeProjectId = survivor;
          delete projects[localId];
          listChanged = true;
          activeDataChanged = true;
        }
        return;
      }
      delete projects[localId];
      listChanged = true;
    });
  }

  function bootstrapFirstSnapshot(): void {
    if (!isFirstSnapshot) return;
    // First snapshot of this page load: if the room already has real
    // data, adopt it (same handling as every other snapshot, just once
    // more explicitly named here for clarity); if the room is completely
    // empty, seed it from whatever's in this browser's local project
    // list, then converge onto the fixed two-project set either way.
    const hasRemoteData = Object.keys(remoteProjects).length > 0;
    if (!hasRemoteData) {
      pushRoomState();
    }
    const fixedChangedIds = enforceFixedProjectSet();
    if (fixedChangedIds.length) {
      // Only push these locally-fabricated placeholders to the shared room
      // when it was genuinely empty to begin with. A device whose own
      // local storage happens to be empty/fresh (first-ever load, cleared
      // cache) always fabricates 2 local placeholders here regardless of
      // what the room already has — pushing them unconditionally could
      // spuriously create an extra project server-side even when the room
      // already has real data (a stray empty "Untitled" project reached
      // production this way — see git history for the diagnosis).
      if (!hasRemoteData) {
        fixedChangedIds.forEach(function (id) { pushProjectToShared(id); });
      }
      loadActiveProjectData();
      renderAll();
    }
    // fetchRoomToken() (where this normally runs) resolves before the real
    // room snapshot arrives, so `projects` may still only reflect stale/
    // empty localStorage at that point — re-assert scoping now that
    // enforceFixedProjectSet() above guarantees both fixed projects exist.
    enforceProjectScopeForRole();
  }

  function triggerPostSnapshotRefresh(): void {
    if (activeDataChanged) {
      if (busy) {
        pendingRemoteRefresh = true;
      } else {
        pendingRemoteRefresh = false;
        refreshActiveProjectFromShared();
      }
    }
    if (activeDataChanged || listChanged) updateProjectToggle();

    const sidebar = document.getElementById('activitySidebar');
    if (sidebar && !sidebar.classList.contains('collapsed')) renderActivityLogSidebar();

    // Real data (or the deliberate empty-room bootstrap) has now been
    // merged and rendered above — safe to reveal the app. No-op if the
    // loading screen was never shown (the normal, returning-device case).
    if (isFirstSnapshot) hideFreshLoadOverlay();

    // See hasDirtyItems(): push what the refresh above normalized locally.
    if (activeProjectId && hasDirtyItems(activeProjectId)) queueSharedSync();
  }

  pruneRemovedProjects();

  // See pruneStrayEmptyProjects() — catches a stray empty "Untitled
  // Project" as soon as it syncs down, before it has a chance to "pop up"
  // in the project switcher at all.
  pruneStrayEmptyProjects();

  saveProjects();

  bootstrapFirstSnapshot();
  triggerPostSnapshotRefresh();
}

// ===== Delta merge (sync protocol 2) =====
// After each accepted write the server sends only what changed (see
// worker/src/room-state.ts's computeRoomDelta()): per project, changed/
// added jobs, cards and events keyed by id, removed ids, and any changed
// top-level field. Merged item by item — unlike a full snapshot, which
// had to be skipped for a whole project while any local write was in
// flight — and an item is left alone when this browser has a change to
// it the server doesn't have yet (not sent, or sent and not yet
// acknowledged). The server's answer to that write (its echo, or a
// rejection followed by a fresh snapshot) settles it.

type DeltaKind = 'jobs' | 'boardCards' | 'calendarEvents';
const DELTA_KINDS: DeltaKind[] = ['jobs', 'boardCards', 'calendarEvents'];

function normalizeIncoming(kind: DeltaKind, item: any): any {
  if (kind === 'jobs') { ensureJobAndTaskIds([item] as Job[]); if (!item.notes) item.notes = ''; }
  else if (kind === 'boardCards') ensureCardIds([item]);
  else ensureCalendarEventIds([item]);
  return item;
}

// Local projects in the server's shape, so a rare structural change (a
// whole project added or removed) can go through applyRoomSnapshot()'s
// full, already-proven path instead of a second implementation of it.
function localProjectsAsRemote(): Record<string, any> {
  const out: Record<string, any> = {};
  Object.keys(projects).forEach(function (pid) {
    const p = projects[pid];
    const toMap = function (arr: any[]) { const m: Record<string, any> = {}; (arr || []).forEach(function (x) { m[String(x.id)] = x; }); return m; };
    out[pid] = {
      name: p.name, jobs: toMap(p.jobs), boardCards: toMap(p.boardCards), calendarEvents: toMap(p.calendarEvents),
      boardColumns: p.boardColumns, workflowItems: p.workflowItems, fieldOptions: p.fieldOptions, header: p.header,
      deletedIds: p.deletedIds, activityLog: p.activityLog, fieldRevisions: p.fieldRevisions,
    };
  });
  return out;
}

function applyRoomDelta(deltaProjects: Record<string, any>): void {
  if (!deltaProjects || typeof deltaProjects !== 'object') return;

  if (Object.keys(deltaProjects).some(function (pid) { const d = deltaProjects[pid]; return d && (d.replace || d.projectRemoved); })) {
    const remote = localProjectsAsRemote();
    Object.keys(deltaProjects).forEach(function (pid) {
      const d = deltaProjects[pid];
      if (d && d.projectRemoved) delete remote[pid];
      else if (d && d.replace) remote[pid] = d.replace;
    });
    applyRoomSnapshot(remote, false);
    Object.keys(deltaProjects).forEach(function (pid) { if (deltaProjects[pid] && deltaProjects[pid].replace && projects[pid]) resetSyncedFromProject(pid, projects[pid]); });
    return;
  }

  let activeChanged = false;
  let listChanged = false;
  let logChanged = false;

  Object.keys(deltaProjects).forEach(function (projectId) {
    const d = deltaProjects[projectId];
    const local = projects[projectId];
    if (!d || typeof d !== 'object' || !local) return;
    let changed = false;

    if (d.deletedIds && typeof d.deletedIds === 'object') {
      local.deletedIds = mergeTombstones(local.deletedIds, d.deletedIds);
      changed = true;
    }

    DELTA_KINDS.forEach(function (kind) {
      if (!Array.isArray(local[kind])) local[kind] = [];
      const arr: any[] = local[kind];
      const removed: string[] = (d.removedIds && Array.isArray(d.removedIds[kind])) ? d.removedIds[kind].map(String) : [];
      // Also drop anything a merged-in tombstone now covers.
      const drop = new Set(removed);
      arr.forEach(function (it) { if (it && local.deletedIds && local.deletedIds[String(it.id)]) drop.add(String(it.id)); });
      if (drop.size) {
        for (let i = arr.length - 1; i >= 0; i--) {
          if (arr[i] && drop.has(String(arr[i].id))) { arr.splice(i, 1); changed = true; }
        }
        drop.forEach(function (id) { forgetSyncedItem(projectId, kind, id); });
      }

      const incoming = d[kind];
      if (!incoming || typeof incoming !== 'object') return;
      const pending = pendingItemIds(projectId, kind);
      Object.keys(incoming).forEach(function (id) {
        const item = incoming[id];
        if (!item || typeof item !== 'object') return;
        if (local.deletedIds && local.deletedIds[String(id)]) return;
        const idx = arr.findIndex(function (x) { return x && String(x.id) === String(id); });
        const existing = idx === -1 ? null : arr[idx];
        if (existing && (isItemDirty(projectId, kind, existing) || pending.has(String(id)))) return;
        normalizeIncoming(kind, item);
        // Our own echo (or an identical change) — nothing to redraw.
        if (existing && JSON.stringify(Object.assign({}, existing, { updatedAt: 0 })) === JSON.stringify(Object.assign({}, item, { updatedAt: 0 }))) {
          markItemSynced(projectId, kind, existing);
          return;
        }
        if (idx === -1) arr.push(item); else arr[idx] = item;
        markItemSynced(projectId, kind, item);
        changed = true;
      });
      if (kind === 'jobs' && changed) arr.sort(function (a: any, b: any) { return (a.order || 0) - (b.order || 0); });
    });

    const projectSyncPending = hasPendingWriteForProject(projectId);
    if (typeof d.name === 'string' && d.name !== local.name) { local.name = d.name; listChanged = true; changed = true; }
    if (Array.isArray(d.boardColumns) && d.boardColumns.length) { local.boardColumns = d.boardColumns; changed = true; }
    if (Array.isArray(d.workflowItems)) { local.workflowItems = d.workflowItems; changed = true; }
    if (d.fieldOptions && typeof d.fieldOptions === 'object') { local.fieldOptions = safeMergeInto(Object.assign({}, local.fieldOptions), d.fieldOptions); changed = true; }
    if (d.header && typeof d.header === 'object' && !projectSyncPending) {
      if (typeof d.header.title === 'string') local.header.title = d.header.title;
      if (typeof d.header.subtitle === 'string') local.header.subtitle = d.header.subtitle;
      if (d.header.theme) local.header.theme = d.header.theme;
      if (copyLogoAndArchived(local, d.header)) listChanged = true;
      changed = true;
    }
    if (Array.isArray(d.activityLog)) { local.activityLog = d.activityLog; logChanged = true; }
    if (d.fieldRevisions && typeof d.fieldRevisions === 'object') local.fieldRevisions = d.fieldRevisions;

    if (changed && projectId === activeProjectId) {
      healOrphanedCardsForProject(local, projectId);
      activeChanged = true;
    }
  });

  saveProjects();
  if (activeChanged) {
    if (isBusyEditing()) pendingRemoteRefresh = true;
    else { pendingRemoteRefresh = false; refreshActiveProjectFromShared(); }
  }
  if (activeChanged || listChanged) updateProjectToggle();
  // See hasDirtyItems(): push what the refresh above normalized locally.
  if (activeChanged && activeProjectId && hasDirtyItems(activeProjectId)) queueSharedSync();
  if (logChanged) {
    const sidebar = document.getElementById('activitySidebar');
    if (sidebar && !sidebar.classList.contains('collapsed')) renderActivityLogSidebar();
  }
}

// See refreshActiveProjectFromShared()'s own comment on why the Gantt
// render specifically needs this and the other three panel renders don't.
// A single shared flag (not one setTimeout per call) — multiple snapshots
// landing inside one ~1.1s animation window is the normal case here (the
// echo, plus anyone else's concurrent writes), and without this they'd
// otherwise queue up N redundant renders instead of coalescing into one.
let ganttRefreshDeferred = false;
function deferGanttRefreshUntilAnimationDone(): void {
  if (ganttRefreshDeferred) return;
  ganttRefreshDeferred = true;
  setTimeout(function () {
    ganttRefreshDeferred = false;
    if (!isPanelActive('gantt')) return; // user switched tabs while waiting
    if (isGanttReorderAnimating()) { deferGanttRefreshUntilAnimationDone(); return; } // a new drag started in the meantime
    renderGantt();
  }, GANTT_REORDER_MS);
}

// Section 6/1 schema-lock plus Section 5's card sync both already run as
// part of this chain: loadActiveProjectData() normalizes every job's tasks
// and its card (also adopting/migrating orphaned cards), and renderBoard()
// calls syncCardColumns() as its first line — so a remote task-date or
// board-column change is reflected here without any extra wiring.
function refreshActiveProjectFromShared(): void {
  loadActiveProjectData();
  // Each render runs independently — a bug in one view (e.g. malformed
  // data breaking Calendar rendering) must never prevent the others from
  // updating, or silently make it look like sync is broken for a teammate
  // even though the underlying data merged in fine (loadActiveProjectData
  // already succeeded above; a page refresh would show it's actually there).
  //
  // This fires on EVERY incoming snapshot broadcast — including the room's
  // own echo of a write THIS client just made (see room-do.ts's
  // broadcastSnapshot(), which doesn't exclude the sender), so on a real
  // project it's essentially continuous during active use, not an
  // occasional event. renderGantt/renderBoard/renderCalendar/
  // renderHomeDashboard were all running unconditionally regardless of
  // which tab was actually on screen — real full-rebuild cost for views
  // nobody was looking at, same as the direct-edit call sites job-list.ts/
  // job-form.ts/calendar.ts/board.ts already guard with isPanelActive()
  // (see its own comment). Missing it here specifically fed straight into
  // a Gantt reorder animation still mid-flight when this fires (near-
  // guaranteed given the echo's timing) — renderGantt() itself was the
  // dominant remaining cost even after the isPanelActive() guard below
  // (measured ~45ms on a 68-job project), because Gantt IS the active tab
  // during a Gantt drag, so guarding by tab visibility alone can't skip
  // it. deferGanttRefreshUntilAnimationDone() (above) closes that specific
  // gap: while animateReorderedBars() still has a row in flight
  // (isGanttReorderAnimating()), this echo's own renderGantt() call is
  // deferred until the animation is done rather than fought for the main
  // thread mid-flight — the same "defer until safe" idiom isBusyEditing()
  // already uses for a LIVE drag, just extended to cover the ~1.1s after
  // one ends too, which isBusyEditing() itself doesn't watch for.
  // switchTab() already does a full, unconditional render of whichever
  // tab it switches TO (see its own body), so a skipped tab's data is
  // simply correct again the next time the user actually navigates there.
  // renderJobList/updateJobCount/refreshArchivedJobsListIfOpen stay
  // unconditional, matching isPanelActive()'s own doc comment on why: no
  // tab-switch hook exists to refresh them lazily the way the four panel
  // views have.
  const renders: (() => void)[] = [renderJobListWhenVisible, updateJobCount, refreshArchivedJobsListIfOpen];
  if (isPanelActive('gantt')) {
    if (isGanttReorderAnimating()) deferGanttRefreshUntilAnimationDone();
    else renders.push(renderGantt);
  }
  if (isPanelActive('board')) renders.push(renderBoard);
  if (isPanelActive('calendar')) renders.push(renderCalendar);
  if (isPanelActive('home')) renders.push(renderHomeDashboard);
  if (isPanelActive('checklist')) renders.push(renderMyChecklist);
  if (isPanelActive('reports')) renders.push(renderReportsIfActive);
  // CRITICAL: if a job is open in Job Manager, its form fields (task dates
  // in particular) are plain DOM state — they don't track the `jobs` array
  // automatically. autoSaveJobForm() reads those fields directly on every
  // save, from ANY field changing (not just task edits). Without refreshing
  // them here, the next keystroke in, say, Description would silently
  // overwrite a teammate's concurrent task-date change with this browser's
  // stale, pre-sync values — exactly the "our jobs don't quite match"
  // failure mode. Must run before the renders below in case one of them
  // (e.g. a render bug) throws and skips the rest.
  if (editingJobId) renders.unshift(function () { refreshJobFormIfOpen(editingJobId as string); });
  renders.forEach(function (fn) {
    try { fn(); } catch (err) { console.error('refreshActiveProjectFromShared: ' + (fn.name || 'refreshJobFormIfOpen') + ' failed', err); }
  });
  // No toast here on purpose — this fires on every incoming change from
  // anyone else in the room, so during normal collaborative use it was
  // one of the most frequent, most intrusive notifications in the app.
  // The UI updating is the notification; a routine sync doesn't need an
  // announcement on top of it.
}

// A remote update can land while the user is mid-edit (isBusyEditing()),
// in which case applyRoomSnapshot() defers the refresh above and sets
// pendingRemoteRefresh. Catch up the moment focus leaves the form instead
// of waiting on another remote change to retrigger the sync.
document.addEventListener('focusout', function () {
  if (!pendingRemoteRefresh) return;
  setTimeout(function () {
    if (pendingRemoteRefresh && !isBusyEditing()) {
      pendingRemoteRefresh = false;
      refreshActiveProjectFromShared();
    }
  }, 0);
});

export {
  handleRoomMessage,
  synthesizeJobFromOrphanCard,
  safeMergeInto,
  scheduleOrphanRecovery,
  healOrphanedJobCards,
  healOrphanedPhaseCards,
  healOrphanedCardsForProject,
  applyRoomSnapshot,
  applyRoomDelta,
  refreshActiveProjectFromShared,
};
