// --- CLAUDE CONNECTOR: reading and editing the schedule data ---
// Pure functions over the room data (no I/O), used by tools.ts. They work
// on the same shapes the app stores (src/core/types.ts): a job has either
// tasks, or phases -> tasks, or phases -> subPhases -> tasks; a task is one
// Board column's (stage's) dates for that unit. Visibility follows the app
// and the live calendar feed exactly (calendar-feed.ts):
//   - a restricted account (assignedProjectId, not admin) sees only its
//     own project;
//   - below projectAdmin, only jobs whose first card lists them as a member;
//   - linked-reference jobs (read-only copies from another project) are
//     never shown or edited here.
import { tierAtLeast } from '../tiers.ts';
import { isJobVisibleTo } from '../calendar-feed.ts';
import type { RoomState, Project, Job, BoardCard, UserRecord } from '../types.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyObj = Record<string, any>;

// The account a connector call acts as, as it is right now (handler.ts
// reloads it on every call).
export interface McpUser {
  username: string;
  displayName: string;
  role: string;
  assignedProjectId: string | null;
}

export class ToolError extends Error {}

// ---- Dates (plain calendar days, all math in UTC) ----
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function isRealDay(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
export function addDays(day: string, n: number): string {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function fmtDay(day: string): string {
  if (!isRealDay(day)) return '(no date)';
  return MONTHS[+day.slice(5, 7) - 1] + ' ' + (+day.slice(8, 10));
}
export function fmtRange(start: string, finish: string): string {
  if (!start && !finish) return 'no dates';
  return fmtDay(start) + '–' + fmtDay(finish);
}
export function todayUtc(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

// ---- Projects ----
export function canSeeProject(user: McpUser, projectId: string): boolean {
  return user.role === 'admin' || !user.assignedProjectId || user.assignedProjectId === projectId;
}
export function visibleProjectIds(state: RoomState, user: McpUser): string[] {
  return Object.keys(state.projects || {}).filter((pid) => canSeeProject(user, pid));
}
export function isProjectArchived(p: Project): boolean {
  return !!(p && p.header && (p.header as AnyObj).archived === true);
}
export function getProject(state: RoomState, user: McpUser, projectId: unknown): Project {
  if (typeof projectId !== 'string' || !projectId) throw new ToolError('projectId is required. Call list_projects to get it.');
  const p = state.projects && Object.prototype.hasOwnProperty.call(state.projects, projectId) ? state.projects[projectId] : undefined;
  if (!p || !canSeeProject(user, projectId)) throw new ToolError('No project with id "' + projectId + '" that you can see. Call list_projects for the ids.');
  return p;
}

export function columnsOf(p: Project): AnyObj[] {
  return (Array.isArray(p.boardColumns) ? p.boardColumns : []).filter((c): c is AnyObj => !!c && typeof c === 'object');
}
export function cardsOf(p: Project): AnyObj[] {
  return Object.values(p.boardCards || {}) as AnyObj[];
}

// ---- Jobs ----
export function isJobVisible(job: Job, project: Project, user: McpUser): boolean {
  if (!job || job.isLinkedReference) return false;
  return isJobVisibleTo(job as AnyObj, cardsOf(project), user as unknown as UserRecord);
}
export function getJob(project: Project, user: McpUser, jobId: unknown): Job {
  if (typeof jobId !== 'string' || !jobId) throw new ToolError('jobId is required. Use search_jobs or get_schedule to find it.');
  const job = project.jobs && Object.prototype.hasOwnProperty.call(project.jobs, jobId) ? project.jobs[jobId] : undefined;
  if (!job || !isJobVisible(job, project, user)) throw new ToolError('No job with id "' + jobId + '" in that project that you can see.');
  return job;
}

// One schedulable unit of a job: the job itself, a phase, or a sub-phase.
// `tasks` is the real array on the job object (not a copy), so edits to a
// cloned job's units land on the clone.
export interface JobUnit { phaseId: string | null; phase: string; subPhaseId: string | null; subPhase: string; tasks: AnyObj[] }

export function jobUnits(job: Job): JobUnit[] {
  const units: JobUnit[] = [];
  const phases = Array.isArray(job.phases) ? (job.phases as AnyObj[]) : [];
  if (phases.length) {
    phases.forEach((ph, i) => {
      const phaseName = (ph && typeof ph.name === 'string' && ph.name) || 'Phase ' + (i + 1);
      const subs = Array.isArray(ph.subPhases) ? (ph.subPhases as AnyObj[]) : [];
      if (subs.length) {
        subs.forEach((s, j) => {
          if (!Array.isArray(s.tasks)) s.tasks = [];
          units.push({ phaseId: ph.id || null, phase: phaseName, subPhaseId: s.id || null, subPhase: (typeof s.name === 'string' && s.name) || 'Sub-Phase ' + (j + 1), tasks: s.tasks });
        });
      } else {
        if (!Array.isArray(ph.tasks)) ph.tasks = [];
        units.push({ phaseId: ph.id || null, phase: phaseName, subPhaseId: null, subPhase: '', tasks: ph.tasks });
      }
    });
    return units;
  }
  if (!Array.isArray(job.tasks)) job.tasks = [];
  units.push({ phaseId: null, phase: '', subPhaseId: null, subPhase: '', tasks: job.tasks as AnyObj[] });
  return units;
}

export function isRealTask(t: AnyObj): boolean {
  return !!t && typeof t === 'object' && !t.isDueMarker && !t.isJobSpan;
}

export function findTask(job: Job, taskId: string): { unit: JobUnit; task: AnyObj } | null {
  for (const unit of jobUnits(job)) {
    const task = unit.tasks.find((t) => isRealTask(t) && t.id === taskId);
    if (task) return { unit, task };
  }
  return null;
}

export function stageName(task: AnyObj, columns: AnyObj[]): string {
  const col = task.columnId ? columns.find((c) => c.id === task.columnId) : undefined;
  return String((col && col.label) || task.name || 'Task');
}

// "Highland (3 F2) › Ext › Deliver": job › phase › sub-phase › stage.
export function taskPath(job: Job, unit: JobUnit, task: AnyObj, columns: AnyObj[]): string {
  return [String(job.name || 'Untitled job'), unit.phase, unit.subPhase, stageName(task, columns)].filter(Boolean).join(' › ');
}

export function primaryCard(job: Job, project: Project): AnyObj | undefined {
  const phases = Array.isArray(job.phases) ? (job.phases as AnyObj[]) : [];
  const firstPhaseId = phases.length ? phases[0].id || null : null;
  return cardsOf(project).find((c) => c.jobId === job.id && (c.phaseId || null) === firstPhaseId);
}

export function customerOf(job: Job, project: Project): string {
  const card = primaryCard(job, project);
  const v = card && card.customFields ? card.customFields.customer : '';
  return typeof v === 'string' ? v : '';
}

export function jobSpan(job: Job): { start: string; finish: string } {
  let start = '', finish = '';
  jobUnits(job).forEach((u) => u.tasks.forEach((t) => {
    if (!isRealTask(t) || !isRealDay(t.start)) return;
    const f = isRealDay(t.finish) ? t.finish : t.start;
    if (!start || t.start < start) start = t.start;
    if (!finish || f > finish) finish = f;
  }));
  return { start, finish };
}

// Plain JSON copy, so a write never mutates the stored job in place (the
// room relies on copy-on-write, see copyProjectForWrite in room-state.ts).
export function cloneJob(job: Job): Job {
  return JSON.parse(JSON.stringify(job));
}

// ---- Schedule rows (get_schedule) ----
export interface ScheduleRow {
  projectId: string; jobId: string; jobName: string; customer: string;
  phase: string; subPhase: string; taskId: string; stage: string;
  start: string; finish: string; notes: string;
}

function matchesQuery(q: string, ...fields: string[]): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return fields.some((f) => f && f.toLowerCase().indexOf(needle) !== -1);
}

export function scheduleRows(project: Project, projectId: string, user: McpUser, from: string, to: string, query: string): ScheduleRow[] {
  const columns = columnsOf(project);
  const rows: ScheduleRow[] = [];
  Object.values(project.jobs || {}).forEach((job) => {
    if (!job || job.archived || !isJobVisible(job, project, user)) return;
    const customer = customerOf(job, project);
    jobUnits(job).forEach((unit) => unit.tasks.forEach((t) => {
      if (!isRealTask(t) || !isRealDay(t.start)) return;
      const finish = isRealDay(t.finish) && t.finish >= t.start ? t.finish : t.start;
      if (t.start > to || finish < from) return;
      const stage = stageName(t, columns);
      if (!matchesQuery(query, String(job.name || ''), customer, unit.phase, unit.subPhase, stage)) return;
      rows.push({
        projectId, jobId: job.id, jobName: String(job.name || ''), customer,
        phase: unit.phase, subPhase: unit.subPhase, taskId: String(t.id), stage,
        start: t.start, finish, notes: typeof t.notes === 'string' ? t.notes : '',
      });
    }));
  });
  return rows;
}

// ---- Job detail (get_job) ----
const CUSTOM_FIELD_KEYS = ['customer', 'poNumber', 'location', 'jobType', 'timeframe', 'incentivePeriod', 'pm', 'foreman', 'members'];

export function jobDetail(job: Job, project: Project, projectId: string, commentLimit: number): AnyObj {
  const columns = columnsOf(project);
  const card = primaryCard(job, project);
  const fields: AnyObj = {};
  const cf = (card && card.customFields) || {};
  CUSTOM_FIELD_KEYS.forEach((k) => {
    const v = cf[k];
    if (typeof v === 'string' && v) fields[k] = v.slice(0, 500);
    else if (Array.isArray(v) && v.length) fields[k] = v.filter((x) => typeof x === 'string').slice(0, 100);
  });
  const stageCol = card && card.column ? columns.find((c) => c.id === card.column) : undefined;
  const attachments = cardsOf(project)
    .filter((c) => c.jobId === job.id && Array.isArray(c.attachments))
    .flatMap((c) => (c.attachments as AnyObj[]).map((a) => (a && typeof a.name === 'string' ? a.name : 'attachment')));
  const comments = (Array.isArray(job.comments) ? job.comments : [])
    .filter((c) => c && typeof c === 'object')
    .slice(-commentLimit)
    .map((c: AnyObj) => ({
      author: typeof c.author === 'string' ? c.author : '',
      when: typeof c.when === 'number' ? new Date(c.when).toISOString() : null,
      text: typeof c.text === 'string' ? c.text.slice(0, 2000) : '',
      ...(c.important ? { important: true } : {}),
      ...(Array.isArray(c.replies) && c.replies.length ? {
        replies: c.replies.slice(-10).map((r: AnyObj) => ({
          author: typeof r.author === 'string' ? r.author : '',
          when: typeof r.when === 'number' ? new Date(r.when).toISOString() : null,
          text: typeof r.text === 'string' ? r.text.slice(0, 2000) : '',
        })),
      } : {}),
    }));
  const units = jobUnits(job).map((u) => ({
    phase: u.phase || undefined, phaseId: u.phaseId || undefined,
    subPhase: u.subPhase || undefined, subPhaseId: u.subPhaseId || undefined,
    tasks: u.tasks.filter(isRealTask).map((t) => ({
      taskId: String(t.id), stage: stageName(t, columns),
      start: isRealDay(t.start) ? t.start : '', finish: isRealDay(t.finish) ? t.finish : '',
      notes: typeof t.notes === 'string' ? t.notes : '',
    })),
  }));
  const span = jobSpan(job);
  return {
    projectId, jobId: job.id, name: String(job.name || ''), archived: !!job.archived,
    color: typeof job.color === 'string' ? job.color : '',
    boardStage: stageCol ? String(stageCol.label || '') : '',
    due: card && typeof card.due === 'string' ? card.due : '',
    start: span.start, finish: span.finish,
    customFields: fields, units, attachments, comments,
    commentCount: Array.isArray(job.comments) ? job.comments.length : 0,
  };
}

// ---- New job (create_job): the same shape the app's job form saves ----
// Mirrors saveJobForm()/addNewJob() in src/views/job-form.ts, plus
// makePhaseCard() and deriveColumnForTasks() in src/core/jobs.ts: one task
// per Board column, in column order, colored like its column; one board
// card for the job, starting in the first column and moved only where the
// app would move it.
export interface StageDates { stage: string; start: string; finish: string }

export function findColumn(columns: AnyObj[], stage: string): AnyObj | undefined {
  const s = stage.trim().toLowerCase();
  return columns.find((c) => String(c.id) === stage) || columns.find((c) => String(c.label || '').trim().toLowerCase() === s);
}

// deriveColumnForTasks() from src/core/jobs.ts, step for step, for a card
// sitting in `currentColumn` with no manual override (a new card never has
// one). Keep the two in step: in order, a card in a schedule-disconnected
// column stays put; no dates keeps it where it is; a task covering today
// wins; a card in a hideFromSchedule column (Bid-style holding spot) stays
// put; then before the first task -> first dated stage, after the last ->
// last dated stage, in a gap -> the last finished one.
export function deriveColumnForTasks(tasks: AnyObj[], columns: AnyObj[], today: string, currentColumn: string): string {
  const current = columns.find((c) => String(c.id) === currentColumn);
  if (current && current.scheduleDisconnected) return currentColumn;
  if (!tasks.some((t) => t.start && t.finish)) return currentColumn;
  if (!columns.length) return '';
  let active = -1, lastFinished = -1, firstDated = -1, lastDated = -1;
  tasks.forEach((t, i) => {
    if (!isRealDay(t.start) || !isRealDay(t.finish)) return;
    if (firstDated === -1) firstDated = i;
    lastDated = i;
    if (today >= t.start && today <= t.finish) active = i; // later overlaps win
    if (today > t.finish) lastFinished = i;
  });
  const idAt = (i: number) => (columns[i] ? String(columns[i].id) : '');
  if (active !== -1) return idAt(active);
  if (current && current.hideFromSchedule) return currentColumn;
  if (firstDated === -1) return idAt(0);
  if (today < tasks[firstDated].start) return idAt(firstDated);
  if (today > tasks[lastDated].finish) return idAt(lastDated);
  if (lastFinished !== -1) return idAt(lastFinished);
  return idAt(0);
}

// The checklist automation a card runs when it lands in a column
// (runColumnEntryActions() + getChecklistForStageInProject()).
function runColumnEntryActions(card: AnyObj, columns: AnyObj[]): void {
  const col = columns.find((c) => c.id === card.column);
  if (!col || !col.autoAssignChecklist) return;
  const items: AnyObj[] = card.checklists[col.id] = card.checklists[col.id] || [];
  (Array.isArray(col.defaultChecklist) ? col.defaultChecklist : []).forEach((d: AnyObj) => {
    if (d && !items.some((i) => i.id === d.id)) items.push({ id: d.id, text: d.text, done: false, assignee: '' });
  });
  const assignee = col.checklistAssigneeOverride || (card.customFields && (card.customFields.foreman || card.customFields.pm)) || '';
  if (assignee) items.forEach((i) => { if (!i.assignee) i.assignee = assignee; });
}

export function buildNewJob(project: Project, opts: { name: string; color: string; customer: string; stageDates: StageDates[] }, now: number, newId: () => string): { job: Job; card: BoardCard } {
  const columns = columnsOf(project);
  if (!columns.length) throw new ToolError('This project has no Board columns yet, so a job has nowhere to go. Add columns in TeamSync first.');
  const byColumn = new Map<string, StageDates>();
  opts.stageDates.forEach((sd) => {
    const col = findColumn(columns, sd.stage);
    if (!col) throw new ToolError('No stage named "' + sd.stage + '". Stages in this project: ' + columns.map((c) => c.label).join(', ') + '.');
    if (col.hideFromSchedule) throw new ToolError('"' + col.label + '" is not on the schedule, so it has no dates.');
    if (byColumn.has(String(col.id))) throw new ToolError('Stage "' + col.label + '" is listed twice.');
    byColumn.set(String(col.id), sd);
  });
  const tasks = columns.map((col, i) => {
    const sd = byColumn.get(String(col.id));
    return { id: newId(), name: String(col.label || ''), columnId: String(col.id), start: sd ? sd.start : '', finish: sd ? sd.finish : '', notes: '', color: col.color || '#3949ab', order: i };
  });
  const job: Job = { id: newId(), name: opts.name, color: opts.color, archived: false, comments: [], tasks, updatedAt: now };
  const card: AnyObj = {
    id: newId(), title: opts.name, description: '', due: '', color: opts.color || '#3949ab',
    column: String(columns[0].id), columnEnteredAt: now,
    jobId: job.id, phaseId: null, manualColumn: null, manualColumnUntil: null,
    customFields: opts.customer ? { customer: opts.customer } : {}, checklists: {}, attachments: [],
    updatedAt: now,
  };
  // makePhaseCard() starts the card in the first column, then the form's
  // syncCardColumns() moves it if its dates say so; each landing runs that
  // column's automation once.
  runColumnEntryActions(card, columns);
  const derived = deriveColumnForTasks(tasks, columns, todayUtc(now), card.column);
  if (derived && derived !== card.column) { card.column = derived; runColumnEntryActions(card, columns); }
  return { job, card: card as BoardCard };
}

export function canEditAtLeast(user: McpUser, tier: string): boolean {
  return tierAtLeast(user.role, tier);
}
