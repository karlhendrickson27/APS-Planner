// Help panel (#helpPanel, opened by the ? button left of Settings — Karl,
// 2026-09-29). One place for everything someone needs to know about the
// site: a section per page plus the job drawer, settings, roles and tips.
// The page you're on opens by default; the rest stay folded so it reads at
// a glance. The Gantt key lives in the Gantt section (it used to be the ⓘ
// in the Gantt's floating pill), and the new-user tour starts from the top
// of the panel (it used to be "Replay Tour" in Settings).
import { render } from 'preact';
import { GanttKeyBody } from './gantt-key';

declare global {
  function tutorialNotifShow(): void;
}

interface Section {
  id: string;
  title: string;
  body: () => preact.JSX.Element;
}

const SECTIONS: Section[] = [
  {
    id: 'start',
    title: 'Getting started',
    body: () => (
      <>
        <p>A <b>job</b> is one project you track from bid to invoiced. Its schedule is made of <b>tasks</b>, one per stage, and a big job can be split into <b>phases</b> that move along on their own.</p>
        <p>The <b>stages</b> are the columns on the Board (Bid, Scheduled, Active…). As a job's dates pass, its card moves along the Board by itself.</p>
        <p>Everything saves as you go and shows up for the rest of the team right away. The faces at the top right are who else is on right now.</p>
        <p><b>On a phone</b>, add TeamSync to your home screen to use it like an app. iPhone: in Safari tap Share, then <b>Add to Home Screen</b>. Android: in Chrome tap ⋮, then <b>Install app</b>. Once it has opened on a phone, it opens with no signal too and shows the last schedule it saw.</p>
      </>
    ),
  },
  {
    id: 'jobs',
    title: 'Jobs list',
    body: () => (
      <ul>
        <li>The <b>☰</b> at the top left shows or hides the list of jobs.</li>
        <li>Jobs are grouped by where they are in the workflow. Click a group's name to fold it away.</li>
        <li>Type in <b>Search jobs</b> to find one by name.</li>
        <li><b>+ New job</b> starts a new one (if your role allows it).</li>
        <li>The <b>⋯</b> on a job duplicates or deletes it.</li>
        <li><b>Archived jobs</b>, at the bottom of the list, brings back a job you archived.</li>
      </ul>
    ),
  },
  {
    id: 'job',
    title: 'Editing a job',
    body: () => (
      <ul>
        <li>Click a job anywhere (the jobs list, a bar, a card) to open it on the right. Changes save as you type.</li>
        <li>Set the <b>name</b>, <b>color</b> and <b>due date</b> at the top.</li>
        <li><b>Tasks</b> has one row per stage. Pick a start date and how many days it takes.</li>
        <li><b>Phases</b> splits the job into parts with their own schedules and Board cards.</li>
        <li><b>Linked job</b> connects it to the same job in the other project.</li>
        <li>Comments go at the bottom. <b>Ctrl+Enter</b> sends.</li>
        <li>Press <b>Esc</b> or click outside to close it.</li>
      </ul>
    ),
  },
  {
    id: 'home',
    title: 'Home',
    body: () => (
      <ul>
        <li>Your day at a glance: your open checklist items, the Board summary, Job Chat, the calendar and today's schedule.</li>
        <li>Click a widget's title to go to its full page.</li>
        <li>The expand button in a widget's corner makes it bigger without leaving Home.</li>
        <li><b>Job Chat</b> lets you pick a job and message the team about it.</li>
      </ul>
    ),
  },
  {
    id: 'checklist',
    title: 'Checklist',
    body: () => (
      <ul>
        <li>Every open item assigned to you, across every job you can see.</li>
        <li>Tick an item to check it off.</li>
        <li>Use the bar at the top to add an item: pick the job, type it and press Enter.</li>
        <li>A stage can hand out its own checklist the moment a job reaches it (set up from the stage's ⚙ on the Board).</li>
      </ul>
    ),
  },
  {
    id: 'calendar',
    title: 'Calendar',
    body: () => (
      <ul>
        <li><b>Today</b> and <b>‹ ›</b> move between months (or weeks). <b>Month</b> and <b>Week</b> switch the view.</li>
        <li><b>Stages</b> shows a bar for each stage of a job. <b>Jobs</b> shows one bar per job.</li>
        <li><b>Filter</b> shows only certain jobs, people or stages.</li>
        <li>Click a day to see everything on it and add an event. Events can repeat and can be private or shared with certain people.</li>
        <li>Click a bar to open that job.</li>
        <li>Finished jobs drop off the calendar.</li>
        <li>To see this schedule in Outlook or Google Calendar, use <b>Live calendar link</b> in the Settings menu. It keeps itself up to date. Add stages as separate calendars to give each its own color.</li>
      </ul>
    ),
  },
  {
    id: 'gantt',
    title: 'Gantt Chart',
    body: () => (
      <>
        <ul>
          <li>Every job's schedule on one timeline. Drag a bar to move it.</li>
          <li>Click <b>▸</b> by a job to see its tasks one per row. The arrow in the Job column header opens or closes every job.</li>
          <li>Click a job or task name to show only that one. Click it again to show everything.</li>
          <li><b>− +</b> at the bottom zoom out and in; <b>Reset</b> goes back to normal. Pinching or Ctrl+scroll zooms too.</li>
          <li>When today is scrolled out of view, the red <b>Today</b> tag takes you back.</li>
          <li>Finished jobs drop off the chart.</li>
          <li>On a phone, a job's name stays at the edge of the screen as you scroll, and a job whose bar is off screen shows its name in grey at that edge.</li>
        </ul>
        <div class="help-key"><GanttKeyBody /></div>
      </>
    ),
  },
  {
    id: 'board',
    title: 'Board',
    body: () => (
      <ul>
        <li>Each column is a stage, and each card is a job (or one phase of it). Cards move along by themselves as the schedule goes; drag one to move it yourself.</li>
        <li>The bar across the top groups the stages into workflow items and counts the jobs in each. A <b>⚠</b> means jobs that have sat too long.</li>
        <li>Drag the empty space to scroll sideways.</li>
        <li>A stage's <b>⚙</b> sets its color and workflow item, whether it shows on the schedule, whether jobs there count as finished, its checklist, and more.</li>
        <li><b>+ Add Board</b> adds a stage.</li>
      </ul>
    ),
  },
  {
    id: 'reports',
    title: 'Reports',
    body: () => (
      <ul>
        <li>Pick <b>Month</b>, <b>Quarter</b> or <b>Year</b>, and use <b>‹ ›</b> to move back and forth.</li>
        <li><b>Filter</b> narrows it to a customer, project manager, foreman or job type.</li>
        <li>See how many jobs finished and how many were on time, where open jobs are right now, what's coming up, and a breakdown you can click into.</li>
      </ul>
    ),
  },
  {
    id: 'settings',
    title: 'Settings and your account',
    body: () => (
      <ul>
        <li><b>⚙ Settings</b>: dark mode, export to a spreadsheet, print or save as PDF, and add the schedule to your own calendar. Project admins also set the theme color and workflow items, and see the activity log.</li>
        <li><b>Your initials</b>: change your password or email, turn on two-step sign-in, switch project, and log out.</li>
      </ul>
    ),
  },
  {
    id: 'roles',
    title: 'Who can do what',
    body: () => (
      <ul>
        <li><b>Viewer</b>: can look at everything but not change it.</li>
        <li><b>Commenter</b>: can also comment and check off items.</li>
        <li><b>Editor</b>: can also create and edit jobs and cards.</li>
        <li><b>Project Admin</b>: full control of one project, including its stages and look.</li>
        <li><b>Admin</b>: everything, in both projects, plus managing accounts.</li>
      </ul>
    ),
  },
  {
    id: 'tips',
    title: 'Tips',
    body: () => (
      <ul>
        <li>Deleting a job, phase or stage, or archiving a job, shows an <b>Undo</b> button for 10 seconds.</li>
        <li><b>Esc</b> closes whatever is open.</li>
        <li>Everything works on a phone too. The pages sit along the top instead of the side.</li>
      </ul>
    ),
  },
];

// The section that opens first for each page (tab ids from switchTab()).
const SECTION_FOR_TAB: Record<string, string> = {
  home: 'home', checklist: 'checklist', calendar: 'calendar', gantt: 'gantt', board: 'board', reports: 'reports', jobs: 'jobs',
};

function HelpPanel({ openId, onClose, onTour }: { openId: string; onClose: () => void; onTour: () => void }) {
  return (
    <>
      <div class="help-head">
        <h2 id="helpTitle">Help</h2>
        <button type="button" class="help-close" aria-label="Close help" title="Close" onClick={onClose}>×</button>
      </div>
      <div class="help-body">
        <button type="button" class="help-tour" id="helpTourBtn" onClick={onTour}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3L2 8l10 5 8-4.2V15h2V8L12 3z" fill="currentColor"/><path d="M6 12.5V16c0 1.5 2.7 3 6 3s6-1.5 6-3v-3.5l-6 3-6-3z" fill="currentColor" opacity="0.55"/></svg>
          <span><b>Take the tour</b><span>A quick walk through the main pages</span></span>
        </button>
        {SECTIONS.map((s) => (
          <details class="help-section" key={s.id} data-section={s.id} open={s.id === openId}>
            <summary>{s.title}</summary>
            <div class="help-section-body">{s.body()}</div>
          </details>
        ))}
      </div>
    </>
  );
}

function panel(): HTMLElement { return document.getElementById('helpPanel')!; }
function button(): HTMLElement { return document.getElementById('helpBtn')!; }

export function isHelpOpen(): boolean {
  return !panel().hidden;
}

export function closeHelp(returnFocus?: boolean): void {
  const p = panel();
  if (p.hidden) return;
  p.hidden = true;
  button().setAttribute('aria-expanded', 'false');
  document.removeEventListener('mousedown', onOutsidePointer, true);
  document.removeEventListener('keydown', onKeyDown, true);
  if (returnFocus) button().focus();
}

export function openHelp(sectionId?: string): void {
  const p = panel();
  const w = window as unknown as { getActiveTab?: () => string };
  const tab = document.body.dataset.mobileView === 'jobs' ? 'jobs' : (w.getActiveTab ? w.getActiveTab() : 'home');
  const openId = sectionId || SECTION_FOR_TAB[tab] || 'start';
  // Rendered fresh on each open so the Gantt key's stage colors match the
  // Board right now. Cleared first so each <details> takes its new open state.
  render(null, p);
  render(<HelpPanel openId={openId} onClose={() => closeHelp(true)} onTour={() => { closeHelp(); tutorialNotifShow(); }} />, p);
  p.hidden = false;
  button().setAttribute('aria-expanded', 'true');
  document.addEventListener('mousedown', onOutsidePointer, true);
  document.addEventListener('keydown', onKeyDown, true);
  (p.querySelector('.help-close') as HTMLElement | null)?.focus();
  const open = p.querySelector('.help-section[open]') as HTMLElement | null;
  const body = p.querySelector('.help-body') as HTMLElement | null;
  // Scroll only when the open section would start below the fold, so the
  // tour button stays in view whenever it can.
  if (open && body) {
    const top = open.offsetTop - body.offsetTop;
    if (top > body.clientHeight - 120) body.scrollTop = top - 8;
  }
}

export function toggleHelp(): void {
  if (isHelpOpen()) closeHelp(); else openHelp();
}

function onOutsidePointer(e: MouseEvent): void {
  const t = e.target as Node;
  if (panel().contains(t) || button().contains(t)) return;
  closeHelp();
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.stopPropagation(); closeHelp(true); }
}
