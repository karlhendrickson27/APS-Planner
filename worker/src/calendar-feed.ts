// --- LIVE CALENDAR FEED (roadmap J6, part 1) ---
//   POST /calendar-feed/link  {token, action?: 'get' | 'reset' | 'off'} -> {feedToken: string | null}
//   GET  /cal/<feedToken>/<projectId>.ics                               -> text/calendar
//   GET  /cal/<feedToken>/<projectId>/<stageId>.ics                     -> one Board stage only
// A stage link holds only that stage's tasks (task.columnId) and no calendar
// events. Google and Outlook color whole calendars, not single events, so
// subscribing to a few stages lets people give each stage its own color.
// A private address people paste into Outlook or Google Calendar once; the
// calendar app then re-fetches it on its own schedule (a few hours, the
// app decides), so the schedule stays current without downloading a file.
// It's the server-side twin of the app's one-time download (src/app/ics.ts):
// same events, same UIDs, same visibility rules as the app:
//   - a restricted account (assignedProjectId, not admin) gets only its
//     own project;
//   - below projectAdmin, only jobs whose first card lists them as a member
//     (isJobVisibleToMe) and only calendar events they can see
//     (isCalendarEventVisibleToMe);
//   - linked-reference and archived jobs are left out.
// The feed token is a long random secret, stored as "calfeed:<token>" ->
// {username, createdAt}, and on the user record as calFeedToken so 'reset'
// and 'off' can find and delete the old one. A feed stops working when its
// account is removed or has its password reset (tokensValidAfter), the
// same as a signed-in session.
import { jsonResponse } from './http.ts';
import { resolveCaller, getUser, putUser, bytesToHex } from './users.ts';
import { tierAtLeast } from './tiers.ts';
import { getRoomStub } from './room-stub.ts';
import { recordAudit, clientIp } from './audit.ts';
import type { RoomState, Project, UserRecord } from './types.ts';

const FEED_KEY_PREFIX = 'calfeed:';
const FEED_TOKEN_RE = /^[0-9a-f]{40}$/;

interface FeedRecord { username: string; createdAt: number }

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyObj = Record<string, any>;

export function newFeedToken(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export async function handleCalendarFeedLink(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  let body: { token?: string; action?: string };
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders); }
  const caller = await resolveCaller(env, body);
  const user = caller ? await getUser(env, caller.username) : null;
  if (!user) return jsonResponse({ error: 'Invalid credentials' }, 401, corsHeaders);
  const action = body.action === 'reset' || body.action === 'off' ? body.action : 'get';
  const old = typeof user.calFeedToken === 'string' ? user.calFeedToken : '';

  if (action === 'get' && old && (await env.USERS_KV.get(FEED_KEY_PREFIX + old))) {
    return jsonResponse({ feedToken: old }, 200, corsHeaders);
  }
  if (old) await env.USERS_KV.delete(FEED_KEY_PREFIX + old);
  if (action === 'off') {
    delete user.calFeedToken;
    await putUser(env, user);
    if (old) await recordAudit(env, { user: user.username, role: user.role, action: 'Turned off calendar link', ip: clientIp(request), details: '' });
    return jsonResponse({ feedToken: null }, 200, corsHeaders);
  }
  const feedToken = newFeedToken();
  const rec: FeedRecord = { username: user.username, createdAt: Date.now() };
  await env.USERS_KV.put(FEED_KEY_PREFIX + feedToken, JSON.stringify(rec));
  user.calFeedToken = feedToken;
  await putUser(env, user);
  await recordAudit(env, { user: user.username, role: user.role, action: old ? 'Reset calendar link' : 'Created calendar link', ip: clientIp(request), details: '' });
  return jsonResponse({ feedToken }, 200, corsHeaders);
}

// Resolves a feed token to its (still valid) account, or null.
export async function resolveFeedUser(env: Env, feedToken: string): Promise<UserRecord | null> {
  if (!FEED_TOKEN_RE.test(feedToken)) return null;
  const raw = await env.USERS_KV.get(FEED_KEY_PREFIX + feedToken);
  if (!raw) return null;
  let rec: FeedRecord;
  try { rec = JSON.parse(raw); } catch (e) { return null; }
  const user = await getUser(env, rec.username);
  if (!user || user.calFeedToken !== feedToken) return null;
  if (typeof user.tokensValidAfter === 'number' && rec.createdAt < user.tokensValidAfter) return null;
  return user;
}

export async function handleCalendarFeed(env: Env, corsHeaders: Record<string, string>, url: URL): Promise<Response> {
  const m = /^\/cal\/([^/]+)\/([^/]+?)(?:\/([^/]+))?\.ics$/.exec(url.pathname);
  const notFound = () => new Response('Not found', { status: 404, headers: corsHeaders });
  if (!m) return notFound();
  const user = await resolveFeedUser(env, m[1]);
  if (!user) return notFound();
  const projectId = decodeURIComponent(m[2]);
  if (user.role !== 'admin' && user.assignedProjectId && user.assignedProjectId !== projectId) return notFound();
  const res = await getRoomStub(env).fetch('https://internal/internal/export');
  const state = (await res.json()) as RoomState | null;
  const project = state && state.projects ? state.projects[projectId] : undefined;
  if (!project) return notFound();
  const stageId = m[3] ? decodeURIComponent(m[3]) : undefined;
  if (stageId !== undefined && !stageColumn(project, stageId)) return notFound();
  const text = buildFeedIcs(project, user, new Date(), stageId);
  return new Response(text, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="teamsync.ics"',
      'Cache-Control': 'private, max-age=300',
    },
  });
}

// ---- Building the calendar (mirrors src/app/ics.ts) ----

function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function fold(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    const limit = parts.length === 0 ? 75 : 74;
    if (curBytes + b > limit) { parts.push(cur); cur = ''; curBytes = 0; }
    cur += ch; curBytes += b;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

function pad(n: number): string { return (n < 10 ? '0' : '') + n; }
function validDate(s: unknown): string { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''; }
// Dates here are plain calendar days, so all math is done in UTC to stay
// clear of the server's own time zone.
function parseDay(s: string): Date { return new Date(s + 'T00:00:00Z'); }
function isoDay(d: Date): string { return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
function addDays(s: string, n: number): string { const d = parseDay(s); d.setUTCDate(d.getUTCDate() + n); return isoDay(d); }
function addMonths(d: Date, delta: number): Date {
  const out = new Date(d);
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + delta);
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, last));
  return out;
}
function ymd(s: string): string { return s.replace(/-/g, ''); }
function utcStamp(d: Date): string {
  return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
}

function jobPhases(job: AnyObj): AnyObj[] {
  if (Array.isArray(job.phases) && job.phases.length) return job.phases;
  return [{ id: null, name: job.name, tasks: job.tasks || [], isDefault: true }];
}
function phaseSubUnits(phase: AnyObj): AnyObj[] {
  if (Array.isArray(phase.subPhases) && phase.subPhases.length) return phase.subPhases;
  return [{ id: null, name: phase.name, tasks: phase.tasks || [], isDefault: true }];
}
function realTasks(tasks: unknown): AnyObj[] {
  return (Array.isArray(tasks) ? tasks : []).filter((t: AnyObj) => t && !t.isDueMarker && !t.isJobSpan);
}

export function isJobVisibleTo(job: AnyObj, cards: AnyObj[], user: UserRecord): boolean {
  if (tierAtLeast(user.role, 'projectAdmin')) return true;
  const firstPhaseId = jobPhases(job)[0].id || null;
  const card = cards.find((c) => c.jobId === job.id && (c.phaseId || null) === firstPhaseId);
  const members = (card && card.customFields && card.customFields.members) || [];
  return Array.isArray(members) && members.indexOf(user.username) !== -1;
}

export function isEventVisibleTo(evt: AnyObj, user: UserRecord): boolean {
  const visibility = evt.visibility || 'all';
  if (visibility === 'all') return true;
  if (tierAtLeast(user.role, 'projectAdmin')) return true;
  if (visibility === 'private') return evt.createdBy === user.username;
  if (visibility === 'members') return (evt.visibleMembers || []).indexOf(user.username) !== -1;
  return true;
}

// Same expansion as getCalendarEventOccurrences() in src/views/calendar.ts.
export function eventOccurrences(evt: AnyObj, from: string, to: string): { sourceDate: string; start: string; finish: string; time: string }[] {
  const startStr = validDate(evt.start);
  if (!startStr) return [];
  const theoretical: string[] = [];
  if (!evt.repeat || evt.repeat === 'none') {
    theoretical.push(startStr);
  } else {
    const anchor = parseDay(startStr);
    const until = validDate(evt.repeatUntil) ? parseDay(evt.repeatUntil) : addMonths(anchor, 6);
    let cursor = new Date(anchor);
    let guard = 0;
    while (cursor <= until && guard < 500) {
      theoretical.push(isoDay(cursor));
      if (evt.repeat === 'daily') cursor.setUTCDate(cursor.getUTCDate() + 1);
      else if (evt.repeat === 'weekly') cursor.setUTCDate(cursor.getUTCDate() + 7);
      else if (evt.repeat === 'monthly') cursor = addMonths(cursor, 1);
      else break;
      guard++;
    }
  }
  const exceptions: AnyObj = evt.exceptions || {};
  const out: { sourceDate: string; start: string; finish: string; time: string }[] = [];
  theoretical.forEach((sourceDate) => {
    const ex = exceptions[sourceDate];
    if (ex && ex.skip) return;
    const start = validDate(ex && ex.start) || sourceDate;
    const time = ex && ex.time !== undefined ? ex.time : (evt.time || '');
    const duration = (ex && ex.duration) || evt.duration || 1;
    const finish = addDays(start, duration - 1);
    if (start > to || finish < from) return;
    out.push({ sourceDate, start, finish, time: typeof time === 'string' ? time : '' });
  });
  return out;
}

function stageColumn(project: Project, stageId: string): AnyObj | undefined {
  const columns: AnyObj[] = Array.isArray(project.boardColumns) ? (project.boardColumns as AnyObj[]) : [];
  return columns.find((c) => c && c.id === stageId);
}

export function buildFeedIcs(project: Project, user: UserRecord, now: Date, stageId?: string): string {
  const projectName = project.name ? String(project.name) : 'TeamSync';
  const stamp = utcStamp(now);
  const cards: AnyObj[] = Object.values(project.boardCards || {});
  const columns: AnyObj[] = Array.isArray(project.boardColumns) ? (project.boardColumns as AnyObj[]) : [];
  const stageLabel = (column: unknown) => { const col = columns.find((c) => c && c.id === column); return col && col.label ? String(col.label) : ''; };
  const lines: string[] = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TeamSync//Live schedule//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:' + icsEscape('TeamSync — ' + (stageId ? stageLabel(stageId) || 'Stage' : projectName)),
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
  ];
  const add = (props: string[]) => { lines.push('BEGIN:VEVENT', ...props, 'END:VEVENT'); };

  Object.values(project.jobs || {}).forEach((job: AnyObj) => {
    if (!job || job.isLinkedReference || job.archived) return;
    if (!isJobVisibleTo(job, cards, user)) return;
    const phases = jobPhases(job);
    phases.forEach((phase) => {
      const pid = phase.id || null;
      const card = cards.find((c) => c.jobId === job.id && (c.phaseId || null) === pid)
        || cards.find((c) => c.jobId === job.id && (c.phaseId || null) === (phases[0].id || null));
      const phaseName = phases.length > 1 && !phase.isDefault ? phase.name : '';
      phaseSubUnits(phase).forEach((sub) => realTasks(sub.tasks).forEach((t) => {
        const s = validDate(t.start), f = validDate(t.finish) || s;
        if (!s) return;
        if (stageId && t.columnId !== stageId) return;
        const details = [
          phaseName ? 'Phase: ' + phaseName : '',
          !sub.isDefault && sub.name ? 'Sub-phase: ' + sub.name : '',
          card && card.column && stageLabel(card.column) ? 'Stage: ' + stageLabel(card.column) : '',
          card && card.customFields && card.customFields.customer ? 'Customer: ' + String(card.customFields.customer) : '',
          typeof t.notes === 'string' && t.notes ? '\n' + t.notes : '',
        ].filter(Boolean).join('\n');
        add([
          'UID:task-' + job.id + '-' + t.id + '@teamsync',
          'DTSTAMP:' + stamp,
          'DTSTART;VALUE=DATE:' + ymd(s),
          'DTEND;VALUE=DATE:' + ymd(addDays(f < s ? s : f, 1)),
          'SUMMARY:' + icsEscape(job.name + (phaseName ? ' (' + phaseName + ')' : '') + ' — ' + (t.name || 'Task')),
          ...(details ? ['DESCRIPTION:' + icsEscape(details)] : []),
          'TRANSP:TRANSPARENT',
          'CATEGORIES:' + icsEscape(projectName),
        ]);
      }));
    });
  });

  // Calendar events aren't tied to a stage, so they're only in the full link.
  if (stageId) {
    lines.push('END:VCALENDAR');
    return lines.map(fold).join('\r\n') + '\r\n';
  }

  const today = isoDay(now);
  const from = addDays(today, -30);
  const to = isoDay(addMonths(parseDay(today), 6));
  Object.values(project.calendarEvents || {}).forEach((evt: AnyObj) => {
    if (!evt || !isEventVisibleTo(evt, user)) return;
    eventOccurrences(evt, from, to).forEach((occ) => {
      const uid = 'UID:event-' + evt.id + '-' + occ.sourceDate + '@teamsync';
      const title = 'SUMMARY:' + icsEscape(evt.title || 'Event');
      const tm = /^(\d{1,2}):(\d{2})/.exec(occ.time);
      if (tm) {
        // Floating local time (no time zone), same as the download: shows
        // at that clock time wherever the calendar is.
        const startMin = +tm[1] * 60 + +tm[2];
        const endMin = startMin + 60;
        const endDay = endMin >= 1440 ? addDays(occ.start, 1) : occ.start;
        const at = (day: string, min: number) => ymd(day) + 'T' + pad(Math.floor(min / 60) % 24) + pad(min % 60) + '00';
        add([uid, 'DTSTAMP:' + stamp, 'DTSTART:' + at(occ.start, startMin), 'DTEND:' + at(endDay, endMin % 1440), title]);
      } else {
        add([uid, 'DTSTAMP:' + stamp, 'DTSTART;VALUE=DATE:' + ymd(occ.start), 'DTEND;VALUE=DATE:' + ymd(addDays(occ.finish, 1)), title]);
      }
    });
  });

  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
