// Calendar file download (roadmap item A3, part 3): an .ics file that
// Outlook, Google Calendar and Apple Calendar can all import. It's a
// snapshot; the live subscription is Settings > Live calendar link
// (src/app/calendar-feed.ts, built server-side in worker/src/calendar-feed.ts,
// which mirrors this file — keep the two in step).
//  - Every scheduled task of every visible job becomes an all-day event
//    ("Job — Task"), with phase/stage/customer in the description.
//  - Calendar events are expanded into their individual occurrences
//    (honoring skipped/moved dates) from 30 days back to 6 months ahead;
//    ones with a time become 1-hour timed events in local time.
// UIDs are stable per task/occurrence, so importing a newer file updates
// the existing entries instead of duplicating them in most calendar apps.
import type { Job } from '../core/types';
import { getJobPhases, getPhaseSubUnits, getPhaseCard, getPrimaryPhaseCard } from '../core/models';
import { jobsToExport, realTasks, validDate, downloadTextFile } from './export';
import { getActiveProject } from './project';
import { getCalendarEventOccurrences, isCalendarEventVisibleToMe } from '../views/calendar';
import { showToast } from '../utils/ui';
import { toIsoDate } from '../utils/date';

function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// RFC 5545 line folding: lines over 75 octets continue on the next line
// after a single leading space. Counted in UTF-8 bytes, never splitting a
// multi-byte character.
function fold(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    const limit = parts.length === 0 ? 75 : 74; // continuation lines start with a space
    if (curBytes + b > limit) { parts.push(cur); cur = ''; curBytes = 0; }
    cur += ch; curBytes += b;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

function ymd(dateStr: string): string { return dateStr.replace(/-/g, ''); }
function nextDay(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  return ymd(toIsoDate(d));
}
function pad(n: number): string { return (n < 10 ? '0' : '') + n; }
function utcStamp(d: Date): string {
  return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
}
function stageLabel(column: string | undefined): string {
  const col = column ? BOARD_COLUMNS.find((c) => c.id === column) : undefined;
  return col ? col.label : '';
}

export function buildIcs(): { text: string; count: number } {
  const project = getActiveProject();
  const projectName = project && project.name ? String(project.name) : 'TeamSync';
  const stamp = utcStamp(new Date());
  const lines: string[] = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TeamSync//Schedule export//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:' + icsEscape('TeamSync — ' + projectName),
  ];
  let count = 0;
  const add = (props: string[]) => { lines.push('BEGIN:VEVENT', ...props, 'END:VEVENT'); count++; };

  jobsToExport(false).forEach((job: Job) => {
    const phases = getJobPhases(job);
    phases.forEach((phase) => {
      const card = getPhaseCard(job, phase.id) || getPrimaryPhaseCard(job);
      const phaseName = phases.length > 1 && !phase.isDefault ? phase.name : '';
      getPhaseSubUnits(phase).forEach((sub) => realTasks(sub.tasks).forEach((t) => {
        const s = validDate(t.start), f = validDate(t.finish) || s;
        if (!s) return;
        const details = [
          phaseName ? 'Phase: ' + phaseName : '',
          !sub.isDefault && sub.name ? 'Sub-phase: ' + sub.name : '',
          card && card.column ? 'Stage: ' + stageLabel(card.column) : '',
          card && card.customFields && card.customFields.customer ? 'Customer: ' + String(card.customFields.customer) : '',
          typeof t.notes === 'string' && t.notes ? '\n' + t.notes : '',
        ].filter(Boolean).join('\n');
        add([
          'UID:task-' + job.id + '-' + t.id + '@teamsync',
          'DTSTAMP:' + stamp,
          'DTSTART;VALUE=DATE:' + ymd(s),
          'DTEND;VALUE=DATE:' + nextDay(f < s ? s : f),
          'SUMMARY:' + icsEscape(job.name + (phaseName ? ' (' + phaseName + ')' : '') + ' — ' + (t.name || 'Task')),
          ...(details ? ['DESCRIPTION:' + icsEscape(details)] : []),
          'TRANSP:TRANSPARENT',
          'CATEGORIES:' + icsEscape(projectName),
        ]);
      }));
    });
  });

  const from = new Date(); from.setDate(from.getDate() - 30);
  const to = new Date(); to.setMonth(to.getMonth() + 6);
  (calendarEvents || []).filter(isCalendarEventVisibleToMe).forEach((evt) => {
    getCalendarEventOccurrences(evt, from, to).forEach((occ) => {
      const startStr = toIsoDate(occ.start);
      const uid = 'UID:event-' + evt.id + '-' + occ.sourceDate + '@teamsync';
      const m = /^(\d{1,2}):(\d{2})/.exec(occ.time || '');
      if (m) {
        const st = new Date(occ.start); st.setHours(+m[1], +m[2], 0, 0);
        const en = new Date(st.getTime() + 3600000);
        const local = (d: Date) => toIsoDate(d).replace(/-/g, '') + 'T' + pad(d.getHours()) + pad(d.getMinutes()) + '00';
        add([uid, 'DTSTAMP:' + stamp, 'DTSTART:' + local(st), 'DTEND:' + local(en), 'SUMMARY:' + icsEscape(evt.title || 'Event')]);
      } else {
        add([uid, 'DTSTAMP:' + stamp, 'DTSTART;VALUE=DATE:' + ymd(startStr), 'DTEND;VALUE=DATE:' + nextDay(toIsoDate(occ.finish)), 'SUMMARY:' + icsEscape(evt.title || 'Event')]);
      }
    });
  });

  lines.push('END:VCALENDAR');
  return { text: lines.map(fold).join('\r\n') + '\r\n', count };
}

export function downloadIcs(): void {
  const { text, count } = buildIcs();
  if (!count) { showToast('Nothing scheduled to add to a calendar', 'info'); return; }
  const project = getActiveProject();
  const projectName = project && project.name ? String(project.name).replace(/[\\/:*?"<>|]+/g, '').trim() : 'TeamSync';
  // No BOM for .ics: some calendar importers reject a file that doesn't
  // start exactly with BEGIN:VCALENDAR.
  downloadTextFile(projectName + ' - Schedule - ' + toIsoDate(new Date()) + '.ics', text, 'text/calendar;charset=utf-8', false);
  showToast('Calendar file downloaded (' + count + ' entries). Open it to add them to Outlook or Google Calendar.', 'success');
}
