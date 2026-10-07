// --- ROOM STATE REDUCER (pure logic for applying messages to a room's
// synced state) ---
import { tierAtLeast } from './tiers.ts';
import type { RoomState, Project, Job, BoardCard, CalendarEvent, Attachment, RoomMessage, ActivityLogEntry } from './types.ts';

export const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ACTIVITY_LOG_CAP = 50;

// Shape guards for handleUpsertJob/handleUpsertCard/handleUpsertCalendarEvent/
// handleUpsertProjectBatch/handleSetWholeField below. These deliberately do
// NOT validate content (see the "otherwise-unvalidated blob" comment on
// sanitizeJobCommentAuthors() further down) — only that a field client
// rendering code loops over with `.forEach`/`.map` and no defensive
// fallback for a wrong-but-present type is actually the array/object shape
// that code assumes. A field's total ABSENCE is already handled fine
// client-side (`|| []`/`|| {}` patterns); only a wrong-typed PRESENT value
// was previously able to slip through and corrupt shared state for every
// connected teammate.
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
export function isArrayIfPresent(v: unknown): boolean {
  return v === undefined || Array.isArray(v);
}
export function isPlainObjectIfPresent(v: unknown): boolean {
  return v === undefined || isPlainObject(v);
}
// One level deeper than isArrayIfPresent: also rejects an array containing
// a null/primitive element, which the client's own rendering code (task.start,
// item.id, etc. — see the phases/checklists callers below) dereferences with
// no defensive fallback, same "wrong-but-present type" crash risk the
// original shape guards above exist to prevent, just one level further in.
export function isArrayOfPlainObjectsIfPresent(v: unknown): boolean {
  if (v === undefined) return true;
  if (!Array.isArray(v)) return false;
  return v.every(isPlainObject);
}
// card.checklists is a per-column dictionary of item arrays
// (buildMyChecklistRows() in checklist.ts does `stored.map(i => i.id)` on
// each column's value with no defensive check) — isPlainObjectIfPresent
// alone only confirms the dictionary itself is an object, not that each
// column's value is actually an item array.
export function isChecklistsShapeIfPresent(v: unknown): boolean {
  if (v === undefined) return true;
  if (!isPlainObject(v)) return false;
  return Object.values(v).every(isArrayOfPlainObjectsIfPresent);
}

// Safe id: matches every id genId() (the client's src/utils/id.ts) can
// ever produce — a crypto.randomUUID() or an "id-<base36>-<base36>"
// fallback — while excluding every character an HTML/JS-string-breakout
// needs (", ', <, >, &, backslash, whitespace). Client rendering code
// across src/views/ interpolates job/card/event/task ids raw into
// onclick="...('+id+'...)" and data-*="..." attribute strings — rejecting
// a malformed id here, at the one place this content enters shared
// state, closes that off for every one of those render sites at once
// rather than requiring each to escape correctly by hand.
export function isSafeIdString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 200 && /^[A-Za-z0-9_.:-]+$/.test(v);
}
// card.id/event.id are typed string|number for legacy reasons — a real
// number can never contain an HTML/JS metacharacter once stringified, so
// it's inherently safe without needing the character-class check above.
export function isSafeIdValue(v: unknown): v is string | number {
  if (typeof v === 'number') return Number.isFinite(v);
  return isSafeIdString(v);
}
// Safe color: the UI only ever produces a value here via <input
// type="color"> (always a lowercase #rrggbb) or a fixed client-side
// swatch palette (COLOR_PRESETS, also always #rrggbb) — never free text.
// Rejecting anything else closes the same class of
// style="background:'+color+';" attribute-breakout risk as
// isSafeIdString above, for every color-rendering site in src/views/ at
// once. Absent/empty means "no color" and is left alone (the client
// renders its own default in that case).
export function isSafeColorIfPresent(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v));
}
// Applies the two checks above to a job's nested tasks/phases — Gantt
// renders task.id (in data-cal-task-id) and task.color (in
// style="background:...") unescaped the same way it does the job's own
// top-level fields, so they need the same validation. Assumes the caller
// already ran isArrayOfPlainObjectsIfPresent on job.tasks/job.phases.
export function hasSafeNestedTaskPhaseFields(job: Job): boolean {
  const items = ([] as unknown[]).concat(job.tasks || [], job.phases || []);
  return items.every(function (item) {
    const it = item as Record<string, unknown>;
    if (it.id !== undefined && !isSafeIdValue(it.id)) return false;
    if (!isSafeColorIfPresent(it.color)) return false;
    return true;
  });
}

export function mergeTombstones(a: Record<string, number> | undefined, b: Record<string, number> | undefined): Record<string, number> {
  const merged: Record<string, number> = Object.assign({}, a || {}, b || {});
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  Object.keys(merged).forEach(function (id) {
    if (!merged[id] || merged[id] < cutoff) delete merged[id];
  });
  return merged;
}

export function blankProject(name?: string | null): Project {
  return {
    name: name || 'Untitled Project',
    jobs: {},
    boardCards: {},
    calendarEvents: {},
    boardColumns: [],
    fieldOptions: {},
    deletedIds: {},
    header: { title: name || 'Untitled', subtitle: '', theme: { c1: '#1a237e', c2: '#3949ab' } },
    activityLog: [],
    rev: 0,
    fieldRevisions: { boardColumns: 0, fieldOptions: 0, header: 0, workflowItems: 0 }
  };
}

export function cloneRoomState<T>(state: T): T {
  return JSON.parse(JSON.stringify(state));
}

// Copy-on-write replacement for deep-cloning the whole project on every
// write (which cost O(entire room) per edit — ~20 ms+ at a few hundred
// jobs, before the broadcast even started). Copies only the containers a
// handler is allowed to change: the three per-id maps, tombstones, the
// activity log and fieldRevisions. Every handler below REPLACES items in
// those containers (next.jobs[id] = job) and never mutates an existing
// item in place, so the previous project object is left untouched —
// which is what lets computeRoomDelta() find what changed by reference.
export function copyProjectForWrite(project: Project): Project {
  return {
    ...project,
    jobs: { ...project.jobs },
    boardCards: { ...project.boardCards },
    calendarEvents: { ...project.calendarEvents },
    deletedIds: { ...project.deletedIds },
    activityLog: (project.activityLog || []).slice(),
    fieldRevisions: { ...project.fieldRevisions },
  };
}

// ===== Delta sync =====
// What a write actually changed, so connected clients get just that
// instead of the whole room re-sent to every socket on every edit (at 250
// jobs / 50 users that was ~75 MB per edit). Relies on copy-on-write:
// an unchanged job/card/event is the SAME object in prev and next, so
// reference comparison finds changes without deep-comparing anything.
//   projects[pid] = { replace: <whole project> }   — project added
//   projects[pid] = { projectRemoved: true }         — project removed
//   projects[pid] = { jobs, boardCards, calendarEvents: {id: item} changed/added,
//                     removedIds: { jobs: [ids], boardCards: [ids], calendarEvents: [ids] },
//                     <other top-level fields>: new value, only if changed }
export type ProjectDelta = Record<string, unknown>;
export interface RoomDelta { projects: Record<string, ProjectDelta>; }

const DELTA_MAP_KEYS = ['jobs', 'boardCards', 'calendarEvents'] as const;

export function computeProjectDelta(prev: Project, next: Project): ProjectDelta | null {
  if (prev === next) return null;
  const delta: ProjectDelta = {};
  let any = false;
  const removed: Record<string, string[]> = {};
  DELTA_MAP_KEYS.forEach(function (key) {
    const a = (prev[key] || {}) as Record<string, unknown>;
    const b = (next[key] || {}) as Record<string, unknown>;
    if (a === b) return;
    const changed: Record<string, unknown> = {};
    let n = 0;
    Object.keys(b).forEach(function (id) { if (a[id] !== b[id]) { changed[id] = b[id]; n++; } });
    const gone = Object.keys(a).filter(function (id) { return !(id in b); });
    if (n) { delta[key] = changed; any = true; }
    if (gone.length) { removed[key] = gone; any = true; }
  });
  if (Object.keys(removed).length) delta.removedIds = removed;
  const keys = new Set(Object.keys(prev).concat(Object.keys(next)));
  keys.forEach(function (k) {
    if ((DELTA_MAP_KEYS as readonly string[]).indexOf(k) !== -1 || k === 'removedIds' || k === 'replace' || k === 'projectRemoved') return;
    const a = (prev as Record<string, unknown>)[k], b = (next as Record<string, unknown>)[k];
    if (a === b) return;
    // Copy-on-write re-creates these containers on every write even when
    // their contents didn't change — only send them when they really did.
    if ((k === 'deletedIds' || k === 'activityLog' || k === 'fieldRevisions') && deepEqual(a, b)) return;
    delta[k] = b;
    any = true;
  });
  return any ? delta : null;
}

export function computeRoomDelta(prev: RoomState, next: RoomState): RoomDelta | null {
  if (prev === next) return null;
  const out: RoomDelta = { projects: {} };
  let any = false;
  const ids = new Set(Object.keys(prev.projects || {}).concat(Object.keys(next.projects || {})));
  ids.forEach(function (pid) {
    const a = prev.projects[pid], b = next.projects[pid];
    if (!a && b) { out.projects[pid] = { replace: b }; any = true; return; }
    if (a && !b) { out.projects[pid] = { projectRemoved: true }; any = true; return; }
    const d = computeProjectDelta(a, b);
    if (d) { out.projects[pid] = d; any = true; }
  });
  return any ? out : null;
}

// Read-side scoping for a delta, same rule as filterRoomStateForAttachment():
// a project-restricted (non-admin) connection only ever hears about its own
// project. Returns null when nothing in the delta is visible to it.
export function filterRoomDeltaForAttachment(delta: RoomDelta, attachment: Attachment | null | undefined): RoomDelta | null {
  if (!attachment || attachment.role === 'admin' || !attachment.assignedProjectId) return delta;
  const own = delta.projects[attachment.assignedProjectId];
  return own ? { projects: { [attachment.assignedProjectId]: own } } : null;
}

export function ensureProject(state: RoomState, projectId: string, seedName?: string | null): RoomState {
  if (state.projects[projectId]) return state;
  return { ...state, projects: { ...state.projects, [projectId]: blankProject(seedName) } };
}

export function emptyRoomState(): RoomState {
  return { projects: {} };
}

// Read-side counterpart to the write-side project-scoping check in
// ApsRoom.webSocketMessage() — that check already exempts role==='admin'
// and an unset assignedProjectId the same way this does, so a restricted
// connection's blast radius matches on both reads and writes. A
// blankProject() stand-in is sent for the non-assigned project rather than
// omitting it from `projects` entirely, so the client always sees the same
// fixed set of project ids it always has (see the client's
// FIXED_PROJECT_NAMES/enforceFixedProjectSet() in src/app/project.ts) —
// omitting the key would exercise that create-if-missing path instead.
export function filterRoomStateForAttachment(roomState: RoomState, attachment: Attachment | null | undefined): RoomState {
  if (!attachment || attachment.role === "admin" || !attachment.assignedProjectId) return roomState;
  const filtered: RoomState = { projects: {} };
  Object.keys(roomState.projects).forEach(function (pid) {
    filtered.projects[pid] = pid === attachment.assignedProjectId
      ? roomState.projects[pid]
      : blankProject(roomState.projects[pid].name);
  });
  return filtered;
}

// Same identity-spoofing issue as handleLogActivity below, but for
// comment/reply author fields embedded inside a job — the client's
// postJobComment()/postJobReply() (src/views/job-comments.ts) stamp
// `author` from the client's own editable localStorage display name, not
// a verified identity. Rather
// than validating the whole job object (the worker deliberately treats
// job/card content as an otherwise-unvalidated blob — see the
// architecture notes on that), this only ever touches the two already-
// load-bearing comments/replies arrays: an entry's author gets
// overwritten with the WebSocket's own verified identity ONLY when it's
// genuinely new this write (its id isn't in existingJob's corresponding
// array) AND it's a live post (`when` is truthy — `when: null` is this
// codebase's existing marker for an imported/historical note, see
// ensureJobAndTaskIds() in the client's src/core/jobs.ts, and must pass
// through untouched, same as anything already persisted).
export function sanitizeJobCommentAuthors(job: Job, existingJob: Job | undefined, attachment: Attachment | null | undefined): void {
  if (!Array.isArray(job.comments) || !attachment || !attachment.displayName) return;
  const existingComments = (existingJob && existingJob.comments) || [];
  const existingCommentIds = new Set(existingComments.map(function (c) { return c.id; }));
  const existingReplyIdsByComment: Record<string, Set<string>> = {};
  existingComments.forEach(function (c) {
    existingReplyIdsByComment[c.id] = new Set((c.replies || []).map(function (r) { return r.id; }));
  });
  job.comments.forEach(function (c) {
    if (!c) return;
    if (!existingCommentIds.has(c.id) && c.when) c.author = attachment.displayName;
    if (Array.isArray(c.replies)) {
      const existingReplyIds = existingReplyIdsByComment[c.id] || new Set();
      c.replies.forEach(function (r) {
        if (r && !existingReplyIds.has(r.id) && r.when) r.author = attachment.displayName;
      });
    }
  });
}

export interface HandlerResult {
  project: Project;
  changed: boolean;
  error?: string;
  rejected?: 'stale';
  currentFieldRevision?: number;
  newFieldRevision?: number;
}

export function handleUpsertJob(project: Project, msg: { job?: Job }, attachment?: Attachment | null): HandlerResult {
  const job = msg.job;
  if (!job || !isSafeIdString(job.id)) return { project, changed: false, error: 'upsertJob missing or unsafe job.id' };
  if (!isArrayOfPlainObjectsIfPresent(job.tasks) || !isArrayOfPlainObjectsIfPresent(job.phases)) {
    return { project, changed: false, error: 'upsertJob: tasks/phases must be arrays of objects if present' };
  }
  if (!isSafeColorIfPresent(job.color) || !hasSafeNestedTaskPhaseFields(job)) {
    return { project, changed: false, error: 'upsertJob: color contains unsafe characters' };
  }
  if (project.deletedIds[job.id]) return { project, changed: false };
  const existing = project.jobs[job.id];
  const incomingUpdatedAt = job.updatedAt || 0;
  if (existing && (existing.updatedAt || 0) > incomingUpdatedAt) {
    return { project, changed: false, rejected: 'stale' };
  }
  sanitizeJobCommentAuthors(job, existing, attachment);
  const next = copyProjectForWrite(project);
  next.jobs[job.id] = job;
  next.rev++;
  return { project: next, changed: true };
}

export function handleUpsertCard(project: Project, msg: { card?: BoardCard }): HandlerResult {
  const card = msg.card;
  if (!card || !isSafeIdValue(card.id)) return { project, changed: false, error: 'upsertCard missing or unsafe card.id' };
  if (!isArrayIfPresent(card.attachments) || !isChecklistsShapeIfPresent(card.checklists)) {
    return { project, changed: false, error: 'upsertCard: attachments/checklists have wrong shape' };
  }
  if (!isSafeColorIfPresent(card.color)) {
    return { project, changed: false, error: 'upsertCard: color contains unsafe characters' };
  }
  if (project.deletedIds[String(card.id)]) return { project, changed: false };
  const existing = project.boardCards[card.id];
  const incomingUpdatedAt = card.updatedAt || 0;
  if (existing && (existing.updatedAt || 0) > incomingUpdatedAt) {
    return { project, changed: false, rejected: 'stale' };
  }
  const next = copyProjectForWrite(project);
  next.boardCards[card.id] = card;
  next.rev++;
  return { project: next, changed: true };
}

export function handleUpsertCalendarEvent(project: Project, msg: { event?: CalendarEvent }): HandlerResult {
  const event = msg.event;
  if (!event || !isSafeIdValue(event.id)) return { project, changed: false, error: 'upsertCalendarEvent missing or unsafe event.id' };
  if (!isPlainObjectIfPresent(event.exceptions) || !isArrayIfPresent(event.visibleMembers)) {
    return { project, changed: false, error: 'upsertCalendarEvent: exceptions/visibleMembers have wrong shape' };
  }
  if (!isSafeColorIfPresent(event.color)) {
    return { project, changed: false, error: 'upsertCalendarEvent: color contains unsafe characters' };
  }
  if (project.deletedIds[String(event.id)]) return { project, changed: false };
  const existing = project.calendarEvents[event.id];
  const incomingUpdatedAt = event.updatedAt || 0;
  if (existing && (existing.updatedAt || 0) > incomingUpdatedAt) {
    return { project, changed: false, rejected: 'stale' };
  }
  const next = copyProjectForWrite(project);
  next.calendarEvents[event.id] = event;
  next.rev++;
  return { project: next, changed: true };
}

export interface UpsertProjectBatchMessage {
  name?: string;
  jobs?: Job[];
  boardCards?: BoardCard[];
  calendarEvents?: CalendarEvent[];
  header?: Record<string, unknown>;
}

// The client's routine (debounced) save batches every job/card/calendar-
// event in the active project into ONE message rather than one per item —
// keeps a save touching a few dozen items down to one storage write and
// one broadcast instead of dozens of each. Each item inside still gets
// its own independent staleness check. header is intentionally NOT
// staleness-protected here (unlike setBoardColumns/setFieldOptions/
// setHeader's baseFieldRevision) — a deliberate, known, low-priority gap
// carried over from the pre-migration behavior rather than something
// newly introduced.
// A project's header also holds its board logo (header.logo: an uploaded
// image as a data: URL, an assets/ path, or '' for none) and whether it's
// archived (header.archived). The logo is drawn as a CSS background, so
// only those shapes are accepted.
const LOGO_RE = /^(data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+|assets\/[A-Za-z0-9._\-/]+)$/;
const MAX_LOGO_LEN = 700000;
export function isSafeHeader(header: Record<string, unknown>): boolean {
  if ('logo' in header && header.logo !== '' && (typeof header.logo !== 'string' || header.logo.length > MAX_LOGO_LEN || !LOGO_RE.test(header.logo))) return false;
  if ('archived' in header && typeof header.archived !== 'boolean') return false;
  return true;
}
// Batch upserts replace the header whole, and older app versions only send
// title/subtitle/theme, so a logo or archived flag the message doesn't
// mention is kept rather than wiped.
export function withKeptHeaderFields(incoming: Record<string, unknown>, existing: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...incoming };
  ['logo', 'archived'].forEach(function (k) {
    if (!(k in out) && existing && k in existing) out[k] = existing[k];
  });
  return out;
}

export function handleUpsertProjectBatch(project: Project, msg: UpsertProjectBatchMessage, attachment?: Attachment | null): HandlerResult {
  let next = project;
  let changed = false;
  function ensureCloned() { if (next === project) next = copyProjectForWrite(next); }

  if (typeof msg.name === 'string' && msg.name !== next.name) {
    ensureCloned();
    next.name = msg.name;
    changed = true;
  }

  (msg.jobs || []).forEach(function (job) {
    if (!job || !isSafeIdString(job.id)) return;
    if (!isArrayOfPlainObjectsIfPresent(job.tasks) || !isArrayOfPlainObjectsIfPresent(job.phases)) return;
    if (!isSafeColorIfPresent(job.color) || !hasSafeNestedTaskPhaseFields(job)) return;
    if (next.deletedIds[job.id]) return;
    const existing = next.jobs[job.id];
    if (existing && (existing.updatedAt || 0) > (job.updatedAt || 0)) return;
    // An identical re-send (older clients push every item on every save)
    // is a no-op: no re-save, no broadcast, stored updatedAt left alone.
    if (existing && !fieldsChangedExcluding(job as unknown as Record<string, unknown>, existing as unknown as Record<string, unknown>, ['updatedAt'])) return;
    sanitizeJobCommentAuthors(job, existing, attachment);
    ensureCloned();
    next.jobs[job.id] = job;
    changed = true;
  });

  (msg.boardCards || []).forEach(function (card) {
    if (!card || !isSafeIdValue(card.id)) return;
    if (!isArrayIfPresent(card.attachments) || !isChecklistsShapeIfPresent(card.checklists)) return;
    if (!isSafeColorIfPresent(card.color)) return;
    if (next.deletedIds[String(card.id)]) return;
    const existing = next.boardCards[card.id];
    if (existing && (existing.updatedAt || 0) > (card.updatedAt || 0)) return;
    if (existing && !fieldsChangedExcluding(card as unknown as Record<string, unknown>, existing as unknown as Record<string, unknown>, ['updatedAt'])) return;
    ensureCloned();
    next.boardCards[card.id] = card;
    changed = true;
  });

  (msg.calendarEvents || []).forEach(function (ev) {
    if (!ev || !isSafeIdValue(ev.id)) return;
    if (!isPlainObjectIfPresent(ev.exceptions) || !isArrayIfPresent(ev.visibleMembers)) return;
    if (!isSafeColorIfPresent(ev.color)) return;
    if (next.deletedIds[String(ev.id)]) return;
    const existing = next.calendarEvents[ev.id];
    if (existing && (existing.updatedAt || 0) > (ev.updatedAt || 0)) return;
    if (existing && !fieldsChangedExcluding(ev as unknown as Record<string, unknown>, existing as unknown as Record<string, unknown>, ['updatedAt'])) return;
    ensureCloned();
    next.calendarEvents[ev.id] = ev;
    changed = true;
  });

  if (msg.header && typeof msg.header === 'object' && isSafeHeader(msg.header)) {
    ensureCloned();
    next.header = withKeptHeaderFields(msg.header, next.header);
    changed = true;
  }

  if (!changed) return { project, changed: false };
  next.rev++;
  return { project: next, changed: true };
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) { if (!deepEqual(a[i], b[i])) return false; }
    return true;
  }
  const aObj = a as Record<string, unknown>, bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj), bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, k)) return false;
    if (!deepEqual(aObj[k], bObj[k])) return false;
  }
  return true;
}

export function fieldsChangedExcluding(a: Record<string, unknown>, b: Record<string, unknown>, ignoreKeys: string[]): boolean {
  const aKeys = Object.keys(a).filter(function (k) { return ignoreKeys.indexOf(k) === -1; });
  const bKeys = Object.keys(b).filter(function (k) { return ignoreKeys.indexOf(k) === -1; });
  if (aKeys.length !== bKeys.length) return true;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return true;
    if (!deepEqual(a[k], b[k])) return true;
  }
  return false;
}

// The client's pushProjectToShared() (src/sync/outbound.ts) always sends the ENTIRE project's
// jobs/boardCards/calendarEvents/name/header on every save, not a diff —
// every job gets a freshly stamped updatedAt on every push regardless of
// whether it actually changed. So "is this field present in the message"
// can't tell a real edit from routine re-transmission; each item here is
// compared against what's actually stored (roomState, loaded fresh above
// in webSocketMessage()) to find out. Runs AFTER the message-type/project
// floor in webSocketMessage() has already confirmed the caller is at
// least 'commenter' — this only narrows further, per-item, so a commenter
// can't smuggle a non-comment edit and an editor can't smuggle a
// brand-new job/card/event past the type-level floor above.
export function filterUpsertProjectBatchByTier(msg: UpsertProjectBatchMessage, storedProject: Project | undefined, role: string): UpsertProjectBatchMessage {
  const stored = storedProject || { jobs: {}, boardCards: {}, calendarEvents: {}, name: undefined, header: undefined } as Partial<Project>;

  function filterMap<T extends { id: string | number }>(items: T[] | undefined, storedMap: Record<string, unknown>, extraIgnoreKeys: string[]): T[] {
    return (items || []).filter(function (item) {
      if (!item || !item.id) return false;
      const existing = storedMap[item.id];
      if (!existing) return tierAtLeast(role, 'projectAdmin');
      const realChange = fieldsChangedExcluding(item as unknown as Record<string, unknown>, existing as Record<string, unknown>, ['updatedAt'].concat(extraIgnoreKeys || []));
      if (!realChange) return tierAtLeast(role, 'commenter');
      return tierAtLeast(role, 'editor');
    });
  }

  const out: UpsertProjectBatchMessage = Object.assign({}, msg, {
    jobs: filterMap(msg.jobs, stored.jobs || {}, ['comments']),
    boardCards: filterMap(msg.boardCards, stored.boardCards || {}, []),
    calendarEvents: filterMap(msg.calendarEvents, stored.calendarEvents || {}, [])
  });

  if (typeof out.name === 'string' && (out.name === stored.name || !tierAtLeast(role, 'projectAdmin'))) {
    delete out.name;
  }
  if (out.header && typeof out.header === 'object' && (deepEqual(out.header, stored.header) || !tierAtLeast(role, 'projectAdmin'))) {
    delete out.header;
  }

  return out;
}

export const SET_WHOLE_FIELD_ARRAY_FIELDS = ['boardColumns', 'workflowItems'];
export const SET_WHOLE_FIELD_OBJECT_FIELDS = ['fieldOptions', 'header'];

export function handleSetWholeField(project: Project, msg: { baseFieldRevision?: number; value?: unknown }, fieldName: keyof Project['fieldRevisions']): HandlerResult {
  const currentRev = project.fieldRevisions[fieldName] || 0;
  const baseRev = typeof msg.baseFieldRevision === 'number' ? msg.baseFieldRevision : -1;
  if (baseRev < currentRev) {
    return { project, changed: false, rejected: 'stale', currentFieldRevision: currentRev };
  }
  if (SET_WHOLE_FIELD_ARRAY_FIELDS.indexOf(fieldName) !== -1 && !Array.isArray(msg.value)) {
    return { project, changed: false, error: 'setWholeField: ' + fieldName + ' must be an array' };
  }
  if (SET_WHOLE_FIELD_OBJECT_FIELDS.indexOf(fieldName) !== -1 && !isPlainObject(msg.value)) {
    return { project, changed: false, error: 'setWholeField: ' + fieldName + ' must be a plain object' };
  }
  if (fieldName === 'header' && !isSafeHeader(msg.value as Record<string, unknown>)) {
    return { project, changed: false, error: 'setWholeField: header has an invalid logo or archived value' };
  }
  // boardColumns/workflowItems render their id/color unescaped in every
  // Kanban view (col-swatch style="background:...", changeColumnColor()
  // onclick="...('+id+'...)") the same way job/card/event do above —
  // same validation, same reason.
  if (fieldName === 'boardColumns' || fieldName === 'workflowItems') {
    const itemsSafe = (msg.value as unknown[]).every(function (item) {
      if (!isPlainObject(item)) return false;
      const it = item as Record<string, unknown>;
      return (it.id === undefined || isSafeIdValue(it.id)) && isSafeColorIfPresent(it.color);
    });
    if (!itemsSafe) {
      return { project, changed: false, error: 'setWholeField: ' + fieldName + ' contains an unsafe id/color value' };
    }
  }
  const next = copyProjectForWrite(project);
  (next as Record<string, unknown>)[fieldName] = msg.value;
  next.fieldRevisions[fieldName] = currentRev + 1;
  next.rev++;
  return { project: next, changed: true, newFieldRevision: currentRev + 1 };
}

export function handleDeleteFromMap(project: Project, msg: { mapKey?: string; id: string | number }): HandlerResult {
  const mapKey = msg.mapKey;
  const id = String(msg.id);
  if (!mapKey || ['jobs', 'boardCards', 'calendarEvents'].indexOf(mapKey) === -1) {
    return { project, changed: false, error: 'deleteFromMap: invalid mapKey' };
  }
  const next = copyProjectForWrite(project);
  const map = next[mapKey as 'jobs' | 'boardCards' | 'calendarEvents'] as Record<string, unknown>;
  delete map[id];
  delete map[String(msg.id)];
  next.deletedIds = mergeTombstones(next.deletedIds, { [id]: Date.now() });
  next.rev++;
  return { project: next, changed: true };
}

export function handleRecordTombstone(project: Project, msg: { id: string | number }): HandlerResult {
  const id = String(msg.id);
  const next = copyProjectForWrite(project);
  next.deletedIds = mergeTombstones(next.deletedIds, { [id]: Date.now() });
  next.rev++;
  return { project: next, changed: true };
}

// attachment (the WS connection's own server-verified identity, from
// resolveIdentityFromToken() at connect time) is preferred over msg.who
// whenever it's available — msg.who is the client's own display-name
// preference (editable in localStorage, not authenticated), so trusting
// it outright let anyone attribute an activity-log entry to a different
// teammate. Same reasoning for `when`: Date.now() is always server time,
// never the client's claim, since a log a caller can backdate isn't much
// of an audit trail.
export function handleLogActivity(project: Project, msg: { who?: string; what?: string }, attachment?: Attachment | null): HandlerResult {
  const next = copyProjectForWrite(project);
  const who = (attachment && attachment.displayName) || msg.who || 'Someone';
  const entry: ActivityLogEntry = { who: who, what: msg.what || '', when: Date.now() };
  next.activityLog.push(entry);
  while (next.activityLog.length > ACTIVITY_LOG_CAP) next.activityLog.shift();
  next.rev++;
  return { project: next, changed: true };
}

// Minimum tier required to send each WebSocket message type — enforced in
// ApsRoom.webSocketMessage(), BEFORE applyMessage() ever runs, so an
// unauthorized write is rejected rather than applied and broadcast. Floors
// mirror what the client's own hasMinTier()/data-min-tier gating already
// treats as the minimum for the equivalent UI action. Types with no entry
// here (setPresence is short-circuited earlier; anything unrecognized)
// fall through unchanged to applyMessage()'s own 'unknown message type'
// error — this table only ever narrows, never grants new capability.
export const MESSAGE_TIER_REQUIREMENTS: Record<string, string> = {
  upsertProjectBatch: 'commenter',
  logActivity: 'commenter',
  upsertJob: 'editor',
  upsertCard: 'editor',
  upsertCalendarEvent: 'editor',
  deleteFromMap: 'editor',
  recordTombstone: 'editor',
  setBoardColumns: 'projectAdmin',
  setFieldOptions: 'projectAdmin',
  setHeader: 'projectAdmin',
  setWorkflowItems: 'projectAdmin',
  renameProject: 'projectAdmin',
  removeProject: 'admin'
};

export interface ApplyMessageResult {
  state: RoomState;
  changed: boolean;
  error?: string;
  rejected?: { reason: string; currentFieldRevision?: number };
  ack?: { type: string; msgId?: number; newFieldRevision?: number };
}

export function applyMessage(state: RoomState, msg: RoomMessage, attachment?: Attachment | null): ApplyMessageResult {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
    return { state, changed: false, error: 'malformed message' };
  }
  if (!msg.projectId) {
    return { state, changed: false, error: 'message missing projectId' };
  }

  // Special-cased ahead of ensureProject() below: removing a project
  // operates on the whole state directly (see removeProject() just below
  // applyMessage), no reason to fabricate a blank project first.
  if (msg.type === 'removeProject') {
    const result = removeProject(state, msg.projectId);
    return {
      state: result.state,
      changed: result.changed,
      ack: { type: 'ack', msgId: msg.msgId }
    };
  }

  let working = ensureProject(state, msg.projectId, msg.seedProjectName as string | undefined);
  const project = working.projects[msg.projectId];
  let result: HandlerResult;

  switch (msg.type) {
    case 'upsertJob': result = handleUpsertJob(project, msg as { job?: Job }, attachment); break;
    case 'upsertCard': result = handleUpsertCard(project, msg as { card?: BoardCard }); break;
    case 'upsertCalendarEvent': result = handleUpsertCalendarEvent(project, msg as { event?: CalendarEvent }); break;
    case 'upsertProjectBatch': result = handleUpsertProjectBatch(project, msg as UpsertProjectBatchMessage, attachment); break;
    case 'setBoardColumns': result = handleSetWholeField(project, msg as { baseFieldRevision?: number; value?: unknown }, 'boardColumns'); break;
    case 'setFieldOptions': result = handleSetWholeField(project, msg as { baseFieldRevision?: number; value?: unknown }, 'fieldOptions'); break;
    case 'setHeader': result = handleSetWholeField(project, msg as { baseFieldRevision?: number; value?: unknown }, 'header'); break;
    case 'setWorkflowItems': result = handleSetWholeField(project, msg as { baseFieldRevision?: number; value?: unknown }, 'workflowItems'); break;
    case 'deleteFromMap': result = handleDeleteFromMap(project, msg as unknown as { mapKey?: string; id: string | number }); break;
    case 'recordTombstone': result = handleRecordTombstone(project, msg as unknown as { id: string | number }); break;
    case 'logActivity': result = handleLogActivity(project, msg as { who?: string; what?: string }, attachment); break;
    case 'renameProject': {
      const next = copyProjectForWrite(project);
      next.name = (msg.name as string) || next.name;
      next.rev++;
      result = { project: next, changed: true };
      break;
    }
    default:
      return { state, changed: false, error: 'unknown message type: ' + msg.type };
  }

  if (result.error) return { state, changed: false, error: result.error };
  if (!result.changed) {
    return {
      state,
      changed: false,
      rejected: result.rejected ? { reason: result.rejected, currentFieldRevision: result.currentFieldRevision } : undefined,
      ack: { type: 'ack', msgId: msg.msgId }
    };
  }

  const newState: RoomState = { ...working, projects: { ...working.projects, [msg.projectId]: result.project } };
  return {
    state: newState,
    changed: true,
    ack: { type: 'ack', msgId: msg.msgId, newFieldRevision: result.newFieldRevision }
  };
}

export interface RemoveProjectResult {
  state: RoomState;
  changed: boolean;
}

// Removes a project entirely — a real capability now (used once to clean
// up a stray empty project a client-side bug created; see the fix in the
// client's applyRoomSnapshot() isFirstSnapshot handling, src/sync/inbound.ts).
// Project deletion is still not exposed anywhere in the app's own UI otherwise.
export function removeProject(state: RoomState, projectId: string): RemoveProjectResult {
  if (!state.projects[projectId]) return { state, changed: false };
  const next: RoomState = { ...state, projects: { ...state.projects } };
  delete next.projects[projectId];
  return { state: next, changed: true };
}
