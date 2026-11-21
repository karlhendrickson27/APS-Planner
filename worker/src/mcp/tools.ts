// --- CLAUDE CONNECTOR: the tools Claude can call ---
// Reads come from the room as the signed-in person sees it; every write is
// sent back to the room as ordinary room messages that go through
// ApsRoom.applyAsUser(), the same commit path as an edit in the app (tier
// checks, assigned project, persist-before-ack, audit, live broadcast).
//
// Each write: read the job, change only the targeted task(s) or field on a
// copy, then send it with `expect` = the updatedAt it was read at. If
// someone changed the job in between, the room refuses it as stale; the
// tool reads again and retries once, then gives up with a clear message.
// An activity-log line ("Karl (via Claude) moved ...") goes with it.
//
// Deliberately NOT here: deleting or archiving anything, users, roles,
// backups, sign-in settings, project admin, maintenance, exports.
import type { RoomState, Project, Job } from '../types.ts';
import type { ApplyAsUserResult, McpMessage } from '../room-do.ts';
import {
  ToolError, isRealDay, addDays, fmtRange, getProject, getJob, visibleProjectIds, isProjectArchived,
  scheduleRows, jobDetail, jobSpan, customerOf, findTask, cloneJob, taskPath, columnsOf, buildNewJob,
  canEditAtLeast, isJobVisible, stageName,
} from './schedule.ts';
import type { McpUser, ScheduleRow, StageDates, JobUnit } from './schedule.ts';
import { isSafeIdString } from '../room-state.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyObj = Record<string, any>;

export interface RoomGateway {
  read(): Promise<RoomState>;
  // Saves the messages together, all or nothing (ApsRoom.applyMcpMessages).
  apply(messages: McpMessage[]): Promise<{ result?: ApplyAsUserResult; limited?: boolean }>;
}

export interface ToolContext {
  user: McpUser;
  room: RoomGateway;
  maintenance(): Promise<{ active: boolean; message: string }>;
  now(): number;
  newId(): string;
}

export interface ToolResult {
  text: string;
  structured: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: AnyObj;
  annotations: AnyObj;
  minTier: string;
  run(ctx: ToolContext, args: AnyObj): Promise<ToolResult>;
}

export const SCHEDULE_ROW_CAP = 500;
export const SEARCH_CAP = 50;
export const COMMENT_LIMIT = 20;
export const SHIFT_MAX_TASKS = 50;
const MAX_RANGE_DAYS = 400;
const MAX_NOTES = 5000;
const MAX_COMMENT = 5000;
const MAX_REASON = 200;
const MAX_NAME = 200;

// ---- Argument checks ----
function str(args: AnyObj, key: string, opts: { required?: boolean; max: number }): string {
  const v = args[key];
  if (v === undefined || v === null || v === '') {
    if (opts.required) throw new ToolError(key + ' is required.');
    return '';
  }
  if (typeof v !== 'string') throw new ToolError(key + ' must be text.');
  if (v.length > opts.max) throw new ToolError(key + ' is too long (at most ' + opts.max + ' characters).');
  return v;
}
function day(args: AnyObj, key: string, required: boolean): string {
  const v = str(args, key, { required, max: 10 });
  if (v && !isRealDay(v)) throw new ToolError(key + ' must be a real date written YYYY-MM-DD, like 2026-11-25.');
  return v;
}
// Names every plain object inherits; never a real id, and looking one up
// would find the inherited property instead of nothing.
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf']);
function id(args: AnyObj, key: string): string {
  const v = str(args, key, { required: true, max: 200 });
  if (!isSafeIdString(v) || RESERVED_IDS.has(v)) throw new ToolError(key + ' "' + v + '" is not a TeamSync id. Read it from list_projects, get_schedule, search_jobs or get_job; never make one up.');
  return v;
}
function bool(args: AnyObj, key: string): boolean {
  const v = args[key];
  if (v === undefined || v === null) return false;
  if (typeof v !== 'boolean') throw new ToolError(key + ' must be true or false.');
  return v;
}

// ---- Schemas ----
const S = {
  projectId: { type: 'string', description: 'Project id from list_projects.', maxLength: 200 },
  jobId: { type: 'string', description: 'Job id from get_schedule, search_jobs or get_job.', maxLength: 200 },
  taskId: { type: 'string', description: 'Task id from get_schedule or get_job (one stage of one job, phase or sub-phase).', maxLength: 200 },
  day: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Date as YYYY-MM-DD.' },
  dryRun: { type: 'boolean', default: false, description: 'true = show exactly what would change without saving. Use it first and confirm with the user.' },
  reason: { type: 'string', maxLength: MAX_REASON, description: 'Short reason, added to the TeamSync activity log (e.g. "truck rescheduled").' },
};
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = (idempotent: boolean) => ({ readOnlyHint: false, destructiveHint: false, idempotentHint: idempotent, openWorldHint: false });

// ---- Shared write path ----
interface EditOutcome {
  next: Job;
  changes: AnyObj[];
  activity: string;
  summary: string;
}

function roleError(user: McpUser, tier: string): ToolError {
  return new ToolError('Your TeamSync role (' + user.role + ') can\'t do this; it needs ' + tier + ' or higher. Ask a TeamSync admin if you need it.');
}

async function refuseDuringMaintenance(ctx: ToolContext): Promise<void> {
  const m = await ctx.maintenance();
  if (m.active) throw new ToolError('TeamSync is in maintenance mode, so changes are paused: "' + m.message + '". Nothing was saved. Try again once it\'s back.');
}

function withReason(activity: string, reason: string): string {
  return reason ? activity + ' (' + reason + ')' : activity;
}

const LIMIT_MESSAGE = "You've reached the limit of changes through Claude for this hour. Nothing was saved; try again later.";
const UNSURE_MESSAGE = "The connection to TeamSync dropped while saving, so this may or may not have been saved. Check with get_job (or search_jobs for a new job) before trying again, so it isn't done twice.";

// Sends a write; a failure after it was sent can't say "nothing was saved".
async function sendWrite(ctx: ToolContext, messages: McpMessage[]): Promise<{ result?: ApplyAsUserResult; limited?: boolean }> {
  try {
    return await ctx.room.apply(messages);
  } catch (e) {
    console.error('Connector write: no answer from the room:', e);
    throw new ToolError(UNSURE_MESSAGE);
  }
}

function friendlyApplyError(r: ApplyAsUserResult | undefined): string {
  const e = (r && r.error) || '';
  if (/^Not saved: /.test(e)) return "Nothing was saved: TeamSync didn't accept the change (the job may have just been deleted, or your role doesn't allow it).";
  if (/^Forbidden: requires (\w+)/.test(e)) return 'Your TeamSync role doesn\'t allow this change.';
  if (/outside your assigned project/.test(e)) return 'That project is outside the one your account is assigned to.';
  if (/Failed to save/.test(e)) return 'TeamSync couldn\'t save just now. Nothing was changed; try again in a moment.';
  return 'TeamSync refused the change' + (e ? ': ' + e : '.');
}

// Reads, edits a copy, saves with a precondition, retries once if stale.
async function editJob(ctx: ToolContext, args: AnyObj, opts: { tier: string; kind: 'job' | 'comment'; edit: (job: Job, project: Project) => EditOutcome }): Promise<ToolResult> {
  if (!canEditAtLeast(ctx.user, opts.tier)) throw roleError(ctx.user, opts.tier);
  const projectId = id(args, 'projectId');
  const jobId = id(args, 'jobId');
  const dryRun = bool(args, 'dryRun');
  const reason = str(args, 'reason', { max: MAX_REASON }).replace(/\s+/g, ' ').trim();
  if (!dryRun) await refuseDuringMaintenance(ctx);

  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await ctx.room.read();
    const project = getProject(state, ctx.user, projectId);
    const job = getJob(project, ctx.user, jobId);
    if (isProjectArchived(project)) throw new ToolError('That project is archived. Restore it in TeamSync before changing it.');
    if (job.archived && opts.kind === 'job') throw new ToolError('"' + job.name + '" is archived. Restore it in TeamSync before changing its dates.');
    const out = opts.edit(cloneJob(job), project);
    if (dryRun) {
      return {
        text: 'Preview only, nothing saved. ' + out.summary + '\nRun the same call with dryRun false to save it.',
        structured: { dryRun: true, saved: false, projectId, jobId, changes: out.changes },
      };
    }
    const next = out.next;
    next.updatedAt = Math.max(ctx.now(), (job.updatedAt || 0) + 1);
    const expect = { projectId, jobId, updatedAt: job.updatedAt || 0 };
    const write: McpMessage = opts.kind === 'job'
      ? { type: 'upsertJob', projectId, job: next, expect }
      : { type: 'upsertProjectBatch', projectId, jobs: [next], expect };
    const log: McpMessage = { type: 'logActivity', projectId, what: withReason(out.activity, reason) };
    // The edit and its activity line are saved together or not at all.
    const res = await sendWrite(ctx, [write, log]);
    if (res.limited) throw new ToolError(LIMIT_MESSAGE);
    const r = res.result;
    if (r && r.rejected && r.rejected.reason === 'stale') {
      if (attempt === 0) continue;
      throw new ToolError('Someone else changed this job at the same moment, twice. Nothing was saved. Read it again with get_job and retry.');
    }
    if (!r || !r.ok || !r.changed) throw new ToolError(friendlyApplyError(r));
    return {
      text: 'Saved. ' + out.summary + ' Anyone with TeamSync open sees it now.',
      structured: { dryRun: false, saved: true, projectId, jobId, changes: out.changes },
    };
  }
  throw new ToolError('Nothing was saved.');
}

// The one project a call names, after checking the caller can see it.
function onlyProject(state: RoomState, user: McpUser, args: AnyObj): string {
  const pid = id(args, 'projectId');
  getProject(state, user, pid);
  return pid;
}

function requireTask(job: Job, taskId: string): { unit: JobUnit; task: AnyObj } {
  const found = findTask(job, taskId);
  if (!found) throw new ToolError('No task with id "' + taskId + '" in "' + job.name + '". Use get_job to see its task ids.');
  return found;
}

// ---- The tools ----
export const TOOLS: ToolDef[] = [
  {
    name: 'list_projects',
    title: 'List TeamSync projects',
    description: 'Lists the TeamSync projects you can see, with their ids. Call this first: every other tool needs a projectId from here.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'List TeamSync projects', ...READ },
    minTier: 'viewer',
    async run(ctx) {
      const state = await ctx.room.read();
      const projects = visibleProjectIds(state, ctx.user).map((pid) => {
        const p = state.projects[pid];
        return { projectId: pid, name: String(p.name || ''), ...(isProjectArchived(p) ? { archived: true } : {}) };
      });
      const text = projects.length
        ? projects.map((p) => '- ' + p.name + (p.archived ? ' (archived)' : '') + ' — projectId: ' + p.projectId).join('\n')
        : 'You can\'t see any projects yet.';
      return { text, structured: { projects } };
    },
  },
  {
    name: 'get_schedule',
    title: 'Get the schedule',
    description: 'Lists scheduled tasks (one stage of one job, phase or sub-phase, e.g. Design, Cut, Panel, Deliver) whose dates overlap from..to, sorted by start date. Leave out projectId to cover every active project you can see. query narrows it by job, customer, phase or stage name. Archived jobs are left out. At most ' + SCHEDULE_ROW_CAP + ' rows.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: S.projectId,
        from: { ...S.day, description: 'First day of the range, YYYY-MM-DD.' },
        to: { ...S.day, description: 'Last day of the range, YYYY-MM-DD (at most ' + MAX_RANGE_DAYS + ' days after from).' },
        query: { type: 'string', maxLength: 200, description: 'Optional words to match in job, customer, phase or stage names.' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    annotations: { title: 'Get the schedule', ...READ },
    minTier: 'viewer',
    async run(ctx, args) {
      const from = day(args, 'from', true);
      const to = day(args, 'to', true);
      if (to < from) throw new ToolError('to must be on or after from.');
      if (addDays(from, MAX_RANGE_DAYS) < to) throw new ToolError('That range is too long; ask for at most ' + MAX_RANGE_DAYS + ' days at a time.');
      const query = str(args, 'query', { max: 200 }).trim();
      const state = await ctx.room.read();
      const pids = args.projectId !== undefined && args.projectId !== ''
        ? [onlyProject(state, ctx.user, args)]
        : visibleProjectIds(state, ctx.user).filter((pid) => !isProjectArchived(state.projects[pid]));
      let rows: ScheduleRow[] = [];
      pids.forEach((pid) => { rows = rows.concat(scheduleRows(state.projects[pid], pid, ctx.user, from, to, query)); });
      rows.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.jobName.localeCompare(b.jobName)));
      const total = rows.length;
      const truncated = total > SCHEDULE_ROW_CAP;
      if (truncated) rows = rows.slice(0, SCHEDULE_ROW_CAP);
      const lines = rows.map((r) => '- ' + fmtRange(r.start, r.finish) + ': ' + [r.jobName, r.phase, r.subPhase, r.stage].filter(Boolean).join(' › ') +
        (r.customer ? ' [' + r.customer + ']' : '') + ' (jobId ' + r.jobId + ', taskId ' + r.taskId + ')');
      const head = total ? total + ' task' + (total === 1 ? '' : 's') + ' between ' + from + ' and ' + to + (query ? ' matching "' + query + '"' : '') + ':' : 'No scheduled tasks between ' + from + ' and ' + to + (query ? ' matching "' + query + '"' : '') + '.';
      const tail = truncated ? '\nShowing the first ' + SCHEDULE_ROW_CAP + ' of ' + total + '. Narrow the dates, projectId or query to see the rest.' : '';
      return { text: [head].concat(lines).join('\n') + tail, structured: { tasks: rows, total, truncated } };
    },
  },
  {
    name: 'search_jobs',
    title: 'Search jobs',
    description: 'Finds jobs by name, customer, P.O. number or location. Returns each job\'s id, customer, whether it\'s archived, and its first and last scheduled dates. At most ' + SEARCH_CAP + ' results.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 200, description: 'Words to look for.' },
        projectId: S.projectId,
        includeArchived: { type: 'boolean', default: false, description: 'Also search archived jobs.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { title: 'Search jobs', ...READ },
    minTier: 'viewer',
    async run(ctx, args) {
      const query = str(args, 'query', { required: true, max: 200 }).trim().toLowerCase();
      if (!query) throw new ToolError('query is required.');
      const includeArchived = bool(args, 'includeArchived');
      const state = await ctx.room.read();
      const pids = args.projectId !== undefined && args.projectId !== ''
        ? [onlyProject(state, ctx.user, args)]
        : visibleProjectIds(state, ctx.user);
      const found: AnyObj[] = [];
      pids.forEach((pid) => {
        const project = state.projects[pid];
        Object.values(project.jobs || {}).forEach((job) => {
          if (!job || (job.archived && !includeArchived) || !isJobVisible(job, project, ctx.user)) return;
          const customer = customerOf(job, project);
          const card = (Object.values(project.boardCards || {}) as AnyObj[]).find((c) => c.jobId === job.id);
          const cf = (card && card.customFields) || {};
          const hay = [job.name, customer, cf.poNumber, cf.location].filter((x) => typeof x === 'string').join(' \u0001 ').toLowerCase();
          if (hay.indexOf(query) === -1) return;
          const span = jobSpan(job);
          found.push({ projectId: pid, projectName: String(project.name || ''), jobId: job.id, name: String(job.name || ''), customer, archived: !!job.archived, start: span.start, finish: span.finish });
        });
      });
      found.sort((a, b) => a.name.localeCompare(b.name));
      const total = found.length;
      const jobs = found.slice(0, SEARCH_CAP);
      const text = total
        ? total + ' job' + (total === 1 ? '' : 's') + ' found' + (total > SEARCH_CAP ? ' (showing ' + SEARCH_CAP + ')' : '') + ':\n' +
          jobs.map((j) => '- ' + j.name + (j.customer ? ' [' + j.customer + ']' : '') + (j.archived ? ' (archived)' : '') + ', ' + (j.start ? fmtRange(j.start, j.finish) : 'no dates') + ' — jobId ' + j.jobId + ', projectId ' + j.projectId).join('\n')
        : 'No jobs match "' + query + '".';
      return { text, structured: { jobs, total, truncated: total > SEARCH_CAP } };
    },
  },
  {
    name: 'get_job',
    title: 'Get a job',
    description: 'Shows one job in full: its phases and sub-phases with every task (stage) and its dates and notes, custom fields (customer, P.O. number, PM, foreman, members…), its Board stage, attachment names, and the latest ' + COMMENT_LIMIT + ' comments.',
    inputSchema: { type: 'object', properties: { projectId: S.projectId, jobId: S.jobId }, required: ['projectId', 'jobId'], additionalProperties: false },
    annotations: { title: 'Get a job', ...READ },
    minTier: 'viewer',
    async run(ctx, args) {
      const projectId = id(args, 'projectId');
      const jobId = id(args, 'jobId');
      const state = await ctx.room.read();
      const project = getProject(state, ctx.user, projectId);
      const job = getJob(project, ctx.user, jobId);
      const d = jobDetail(job, project, projectId, COMMENT_LIMIT);
      const lines: string[] = [d.name + (d.archived ? ' (archived)' : '') + (d.boardStage ? ' — Board stage: ' + d.boardStage : '')];
      Object.keys(d.customFields).forEach((k) => lines.push(k + ': ' + (Array.isArray(d.customFields[k]) ? d.customFields[k].join(', ') : d.customFields[k])));
      d.units.forEach((u: AnyObj) => {
        if (u.phase || u.subPhase) lines.push([u.phase, u.subPhase].filter(Boolean).join(' › ') + ':');
        u.tasks.forEach((t: AnyObj) => lines.push('  - ' + t.stage + ': ' + (t.start ? fmtRange(t.start, t.finish) : 'no dates') + ' (taskId ' + t.taskId + ')' + (t.notes ? ' — notes: ' + t.notes : '')));
      });
      if (d.comments.length) {
        lines.push('Latest comments' + (d.commentCount > d.comments.length ? ' (' + d.comments.length + ' of ' + d.commentCount + ')' : '') + ':');
        d.comments.forEach((c: AnyObj) => lines.push('  - ' + (c.author || 'Someone') + (c.when ? ' (' + c.when.slice(0, 10) + ')' : '') + ': ' + c.text));
      }
      return { text: lines.join('\n'), structured: d };
    },
  },
  {
    name: 'update_task_dates',
    title: 'Change a task\'s dates',
    description: 'Sets the start and finish dates of one task (one stage of a job, phase or sub-phase). Only that task changes. Use dryRun true first to preview.',
    inputSchema: {
      type: 'object',
      properties: { projectId: S.projectId, jobId: S.jobId, taskId: S.taskId, start: { ...S.day, description: 'New start date, YYYY-MM-DD.' }, finish: { ...S.day, description: 'New finish date, YYYY-MM-DD, on or after start.' }, dryRun: S.dryRun, reason: S.reason },
      required: ['projectId', 'jobId', 'taskId', 'start', 'finish'],
      additionalProperties: false,
    },
    annotations: { title: 'Change a task\'s dates', ...WRITE(true) },
    minTier: 'editor',
    async run(ctx, args) {
      const taskId = id(args, 'taskId');
      const start = day(args, 'start', true);
      const finish = day(args, 'finish', true);
      if (finish < start) throw new ToolError('finish must be on or after start.');
      return editJob(ctx, args, {
        tier: 'editor', kind: 'job',
        edit(job, project) {
          const { unit, task } = requireTask(job, taskId);
          const path = taskPath(job, unit, task, columnsOf(project));
          const before = { start: task.start || '', finish: task.finish || '' };
          task.start = start; task.finish = finish;
          return {
            next: job,
            changes: [{ taskId, task: path, before, after: { start, finish } }],
            activity: 'moved ' + path + ' to ' + fmtRange(start, finish),
            summary: path + ': ' + fmtRange(before.start, before.finish) + ' → ' + fmtRange(start, finish) + '.',
          };
        },
      });
    },
  },
  {
    name: 'shift_tasks',
    title: 'Shift several tasks',
    description: 'Moves several tasks of one job together by the same number of calendar days (negative = earlier), keeping each task\'s length. For example, all of a job\'s sub-phase deliveries. At most ' + SHIFT_MAX_TASKS + ' tasks; each must already have dates. Use dryRun true first to preview.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: S.projectId, jobId: S.jobId,
        taskIds: { type: 'array', items: S.taskId, minItems: 1, maxItems: SHIFT_MAX_TASKS, uniqueItems: true, description: 'Task ids from get_job.' },
        days: { type: 'integer', minimum: -365, maximum: 365, description: 'Calendar days to move by; negative moves earlier.' },
        dryRun: S.dryRun, reason: S.reason,
      },
      required: ['projectId', 'jobId', 'taskIds', 'days'],
      additionalProperties: false,
    },
    annotations: { title: 'Shift several tasks', ...WRITE(false) },
    minTier: 'editor',
    async run(ctx, args) {
      const raw = args.taskIds;
      if (!Array.isArray(raw) || !raw.length) throw new ToolError('taskIds must be a list of at least one task id.');
      if (raw.length > SHIFT_MAX_TASKS) throw new ToolError('At most ' + SHIFT_MAX_TASKS + ' tasks at a time.');
      const taskIds = raw.map((t) => id({ taskId: t }, 'taskId'));
      if (new Set(taskIds).size !== taskIds.length) throw new ToolError('taskIds lists the same task twice.');
      const days = args.days;
      if (typeof days !== 'number' || !Number.isInteger(days) || Math.abs(days) > 365) throw new ToolError('days must be a whole number between -365 and 365.');
      if (days === 0) throw new ToolError('days is 0, so nothing would move.');
      return editJob(ctx, args, {
        tier: 'editor', kind: 'job',
        edit(job, project) {
          const columns = columnsOf(project);
          const changes: AnyObj[] = [];
          taskIds.forEach((taskId) => {
            const { unit, task } = requireTask(job, taskId);
            const path = taskPath(job, unit, task, columns);
            if (!isRealDay(task.start)) throw new ToolError(path + ' has no dates yet, so it can\'t be shifted. Use update_task_dates for it.');
            const finish0 = isRealDay(task.finish) ? task.finish : task.start;
            const before = { start: task.start, finish: finish0 };
            task.start = addDays(before.start, days);
            task.finish = addDays(before.finish, days);
            changes.push({ taskId, task: path, before, after: { start: task.start, finish: task.finish } });
          });
          const n = changes.length;
          const dir = (days > 0 ? 'later' : 'earlier');
          const amount = Math.abs(days) + ' day' + (Math.abs(days) === 1 ? '' : 's');
          const label = n === 1 ? changes[0].task : n + ' tasks on ' + job.name;
          return {
            next: job, changes,
            activity: 'shifted ' + label + ' ' + amount + ' ' + dir,
            summary: 'Shifted ' + n + ' task' + (n === 1 ? '' : 's') + ' ' + amount + ' ' + dir + ':\n' + changes.map((c) => '- ' + c.task + ': ' + fmtRange(c.before.start, c.before.finish) + ' → ' + fmtRange(c.after.start, c.after.finish)).join('\n'),
          };
        },
      });
    },
  },
  {
    name: 'set_task_notes',
    title: 'Set a task\'s notes',
    description: 'Replaces the notes on one task (one stage of a job, phase or sub-phase). Pass an empty string to clear them. Read the current notes with get_job first if you mean to add to them.',
    inputSchema: {
      type: 'object',
      properties: { projectId: S.projectId, jobId: S.jobId, taskId: S.taskId, notes: { type: 'string', maxLength: MAX_NOTES, description: 'The full new notes text.' }, dryRun: S.dryRun, reason: S.reason },
      required: ['projectId', 'jobId', 'taskId', 'notes'],
      additionalProperties: false,
    },
    annotations: { title: 'Set a task\'s notes', ...WRITE(true) },
    minTier: 'editor',
    async run(ctx, args) {
      const taskId = id(args, 'taskId');
      if (typeof args.notes !== 'string') throw new ToolError('notes must be text (use "" to clear).');
      const notes = str(args, 'notes', { max: MAX_NOTES });
      return editJob(ctx, args, {
        tier: 'editor', kind: 'job',
        edit(job, project) {
          const { unit, task } = requireTask(job, taskId);
          const path = taskPath(job, unit, task, columnsOf(project));
          const before = typeof task.notes === 'string' ? task.notes : '';
          task.notes = notes;
          return {
            next: job,
            changes: [{ taskId, task: path, before: { notes: before }, after: { notes } }],
            activity: (notes ? 'updated the notes on ' : 'cleared the notes on ') + path,
            summary: (notes ? 'Notes on ' + path + ' set to: "' + notes + '"' : 'Cleared the notes on ' + path) + '.',
          };
        },
      });
    },
  },
  {
    name: 'add_job_comment',
    title: 'Comment on a job',
    description: 'Adds a comment to a job\'s comment thread, posted under your name and marked as coming via Claude. Teammates on the job are notified the same way as for any comment.',
    inputSchema: {
      type: 'object',
      properties: { projectId: S.projectId, jobId: S.jobId, text: { type: 'string', minLength: 1, maxLength: MAX_COMMENT, description: 'The comment.' }, dryRun: S.dryRun },
      required: ['projectId', 'jobId', 'text'],
      additionalProperties: false,
    },
    annotations: { title: 'Comment on a job', ...WRITE(false) },
    minTier: 'commenter',
    async run(ctx, args) {
      const text = str(args, 'text', { required: true, max: MAX_COMMENT }).trim();
      if (!text) throw new ToolError('text is required.');
      return editJob(ctx, Object.assign({}, args, { reason: '' }), {
        tier: 'commenter', kind: 'comment',
        edit(job) {
          if (!Array.isArray(job.comments)) job.comments = [];
          // `author` is overwritten by the room with the verified name
          // ("Karl Hendrickson (via Claude)", see sanitizeJobCommentAuthors).
          const comment = { id: ctx.newId(), author: ctx.user.displayName + ' (via Claude)', by: ctx.user.username, text, when: ctx.now(), important: false, via: 'Claude' };
          job.comments.push(comment);
          return {
            next: job,
            changes: [{ comment: { text, author: comment.author } }],
            activity: 'commented on job "' + job.name + '"',
            summary: 'Comment on "' + job.name + '": "' + text + '"',
          };
        },
      });
    },
  },
  {
    name: 'create_job',
    title: 'Create a job',
    description: 'Creates a new job the same way TeamSync\'s Add New Job form does: one task per Board stage, plus its Board card. Give dates for any stages you know; the rest stay blank. customer must be one of the project\'s existing customers. Needs Project Admin or higher, like the form. Use dryRun true first to preview.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: S.projectId,
        name: { type: 'string', minLength: 1, maxLength: MAX_NAME, description: 'Job name.' },
        customer: { type: 'string', maxLength: 200, description: 'Optional; must match one of the project\'s customers.' },
        color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: 'Optional job color like #3949ab (the form\'s default).' },
        stageDates: {
          type: 'array', maxItems: 30, description: 'Optional dates per stage.',
          items: { type: 'object', properties: { stage: { type: 'string', maxLength: 200, description: 'Stage (Board column) name, e.g. Design.' }, start: S.day, finish: S.day }, required: ['stage', 'start', 'finish'], additionalProperties: false },
        },
        dryRun: S.dryRun, reason: S.reason,
      },
      required: ['projectId', 'name'],
      additionalProperties: false,
    },
    annotations: { title: 'Create a job', ...WRITE(false) },
    minTier: 'projectAdmin',
    async run(ctx, args) {
      if (!canEditAtLeast(ctx.user, 'projectAdmin')) throw roleError(ctx.user, 'projectAdmin');
      const projectId = id(args, 'projectId');
      const name = str(args, 'name', { required: true, max: MAX_NAME }).trim();
      if (!name) throw new ToolError('name is required.');
      const color = str(args, 'color', { max: 7 }) || '#3949ab';
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new ToolError('color must look like #3949ab.');
      const customerIn = str(args, 'customer', { max: 200 }).trim();
      const rawStages = args.stageDates === undefined ? [] : args.stageDates;
      if (!Array.isArray(rawStages) || rawStages.length > 30) throw new ToolError('stageDates must be a list of at most 30 { stage, start, finish }.');
      const stageDates: StageDates[] = rawStages.map((sd: AnyObj, i: number) => {
        if (!sd || typeof sd !== 'object') throw new ToolError('stageDates[' + i + '] must be { stage, start, finish }.');
        const stage = str(sd, 'stage', { required: true, max: 200 });
        const start = day(sd, 'start', true);
        const finish = day(sd, 'finish', true);
        if (finish < start) throw new ToolError('stageDates[' + i + ']: finish must be on or after start.');
        return { stage, start, finish };
      });
      const dryRun = bool(args, 'dryRun');
      const reason = str(args, 'reason', { max: MAX_REASON }).replace(/\s+/g, ' ').trim();
      if (!dryRun) await refuseDuringMaintenance(ctx);

      const state = await ctx.room.read();
      const project = getProject(state, ctx.user, projectId);
      if (isProjectArchived(project)) throw new ToolError('That project is archived.');
      let customer = '';
      if (customerIn) {
        const options = Array.isArray((project.fieldOptions || {} as AnyObj).customer) ? ((project.fieldOptions as AnyObj).customer as unknown[]).filter((o): o is string => typeof o === 'string') : [];
        const match = options.find((o) => o.toLowerCase() === customerIn.toLowerCase());
        if (!match) throw new ToolError('"' + customerIn + '" isn\'t one of this project\'s customers' + (options.length ? ' (' + options.slice(0, 40).join(', ') + ')' : '') + '. Use an existing one, or add it in TeamSync first.');
        customer = match;
      }
      const { job, card } = buildNewJob(project, { name, color, customer, stageDates }, ctx.now(), ctx.newId);
      const columns = columnsOf(project);
      const dated = (job.tasks as AnyObj[]).filter((t) => t.start).map((t) => stageName(t, columns) + ' ' + fmtRange(t.start, t.finish));
      const summary = 'New job "' + name + '"' + (customer ? ' for ' + customer : '') + (dated.length ? ' with ' + dated.join(', ') : ' with no dates yet') + '.';
      const preview = { name, customer, color, stages: (job.tasks as AnyObj[]).map((t) => ({ stage: stageName(t, columns), start: t.start, finish: t.finish })) };
      if (dryRun) return { text: 'Preview only, nothing saved. ' + summary + '\nRun the same call with dryRun false to create it.', structured: { dryRun: true, saved: false, projectId, job: preview } };
      const expect = { projectId, jobId: job.id, absent: true };
      // Job and card in one batch (new items in a batch need Project Admin,
      // the same floor as this tool), plus the activity line, all saved and
      // broadcast together: an open app never sees the job without its card.
      const res = await sendWrite(ctx, [
        { type: 'upsertProjectBatch', projectId, jobs: [job], boardCards: [card], expect },
        { type: 'logActivity', projectId, what: withReason('added job "' + name + '"', reason) },
      ]);
      if (res.limited) throw new ToolError(LIMIT_MESSAGE);
      if (!res.result || !res.result.ok || !res.result.changed) throw new ToolError(friendlyApplyError(res.result));
      return { text: 'Created. ' + summary + ' (jobId ' + job.id + ')', structured: { dryRun: false, saved: true, projectId, jobId: job.id, job: preview } };
    },
  },
];

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

// Runs a tool and turns any problem into a friendly tool error (never a
// stack trace). Role floors are checked here as well as inside each tool.
export async function runTool(tool: ToolDef, ctx: ToolContext, args: AnyObj): Promise<ToolResult> {
  if (!canEditAtLeast(ctx.user, tool.minTier)) {
    const e = roleError(ctx.user, tool.minTier);
    return { text: e.message, structured: { error: e.message }, isError: true };
  }
  try {
    return await tool.run(ctx, args || {});
  } catch (e) {
    if (e instanceof ToolError) return { text: e.message, structured: { error: e.message }, isError: true };
    console.error('Connector tool ' + tool.name + ' failed:', e);
    const msg = 'Something went wrong in TeamSync while running ' + tool.name + '. Nothing was saved.';
    return { text: msg, structured: { error: msg }, isError: true };
  }
}
