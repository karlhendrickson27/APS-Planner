// New-user tutorial: notification prompt -> 6-slide overview -> (only if
// they finish, not skip) a spotlight coachmark tour pointing at Home's
// own real buttons. Approved as a mockup first (Artifact) before this
// was written — that's the source of truth for the intended look/feel;
// this just wires it to real data and real DOM. Desktop-only throughout
// (window.innerWidth check at each entry point) — same 900px breakpoint
// the Home widget expand feature already uses, since the coachmark step
// needs real on-screen buttons to point at and this app's mobile layout
// is a different enough shape that "point at this exact spot" wouldn't
// reliably land on anything.
//
// Fully self-contained — no other src/ module reads or calls anything
// here, and nothing here writes shared app state (jobs/boardCards/
// projects); the only state is this feature's own localStorage-backed
// "have I seen this" flags.
import { getStoredUsername } from '../auth/session';
import { hasMinTier } from '../auth/permissions';
import { safeJsonParse } from '../utils/id';
import { switchTabMorphed } from '../views/home';

const TUTORIAL_MAX_LOGINS = 3;

export function tutorialStateKey(): string {
  return 'gantt_tutorial_state_v1_' + (getStoredUsername() || 'anon');
}
export function getTutorialState(): any {
  return safeJsonParse(localStorage.getItem(tutorialStateKey()) || '{}', {});
}
export function saveTutorialState(state: any): void {
  localStorage.setItem(tutorialStateKey(), JSON.stringify(state));
}

// Called once per boot (see index.html's init()), not once per render —
// "logins" here means "times the app was opened," same as a user would
// describe it, not the stricter "actually re-entered credentials"
// (getSessionToken() silently reuses a cached token most days, so
// counting only real credential prompts would rarely reach 3 at all).
export function maybeShowTutorialPrompt(): void {
  if (window.innerWidth <= 900) return;
  const state = getTutorialState();
  if (state.neverShow) return;
  const loginsSeen = (state.loginsSeen || 0) + 1;
  state.loginsSeen = loginsSeen;
  saveTutorialState(state);
  if (loginsSeen > TUTORIAL_MAX_LOGINS) return;
  setTimeout(showTutorialNotification, 800);
}

function ensureOnbNotifDom(): HTMLElement {
  let el = document.getElementById('onbNotif');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'onbNotif';
  el.className = 'onb-notif';
  el.innerHTML =
    '<div class="onb-notif-head">' +
      '<span class="onb-notif-icon"><svg viewBox="0 0 24 24" width="18" height="18" xmlns="http://www.w3.org/2000/svg"><path d="M12 3L2 8l10 5 8-4.2V15h2V8L12 3z" fill="#3949ab"/><path d="M6 12.5V16c0 1.5 2.7 3 6 3s6-1.5 6-3v-3.5l-6 3-6-3z" fill="#3949ab" opacity="0.55"/></svg></span>' +
      '<span class="onb-notif-title">New here? Take a quick tour</span>' +
      '<button class="onb-notif-x" onclick="tutorialNotifLater()" title="Close" aria-label="Dismiss tour notification">&times;</button>' +
    '</div>' +
    '<div class="onb-notif-text">A quick overview, then a walkthrough of the buttons on this page — about a minute.</div>' +
    '<div class="onb-notif-actions">' +
      '<button class="onb-notif-primary" onclick="tutorialNotifShow()">Show me</button>' +
      '<button class="onb-notif-secondary" onclick="tutorialNotifLater()">Not now</button>' +
    '</div>' +
    '<button class="onb-notif-never" onclick="tutorialNotifNever()">Don\'t ask again</button>';
  document.body.appendChild(el);
  return el;
}

export function showTutorialNotification(): void {
  const el = ensureOnbNotifDom();
  requestAnimationFrame(function() { el.classList.add('show'); });
}
export function hideTutorialNotification(): void {
  const el = document.getElementById('onbNotif');
  if (el) el.classList.remove('show');
}
export function tutorialNotifShow(): void {
  hideTutorialNotification();
  openTutorialSlides();
}
// "Not now"/"×" used to just hide the popup for this session, writing
// nothing to storage — so a user who dismissed it was indistinguishable
// from one who'd never seen it, and got the exact same prompt again on
// their next 1-2 app opens. Now an explicit dismissal counts: two of them
// and it stops, same end state as "Don't ask again", just requiring one
// extra "no" first instead of assuming the harsher-sounding button is the
// only way to actually say so. A user who never interacts with it at all
// (just navigates away) still gets the original up-to-3-boots behavior.
export function tutorialNotifLater(): void {
  const state = getTutorialState();
  state.dismissCount = (state.dismissCount || 0) + 1;
  if (state.dismissCount >= 2) state.neverShow = true;
  saveTutorialState(state);
  hideTutorialNotification();
}
export function tutorialNotifNever(): void {
  const state = getTutorialState();
  state.neverShow = true;
  saveTutorialState(state);
  hideTutorialNotification();
}

const TUTORIAL_SLIDES = [
  { title: 'Welcome to TeamSync', desc: 'A job is a single project — a remodel, a new build, whatever you\'re tracking from bid to invoiced. Everything below — schedule, checklist, board, comments — is scoped to one. This quick tour covers the six main views, then points out the buttons on Home.',
    icon: '<svg viewBox="0 0 24 24" width="42" height="42" xmlns="http://www.w3.org/2000/svg"><path d="M12 3L2 8l10 5 8-4.2V15h2V8L12 3z" fill="#fff"/><path d="M6 12.5V16c0 1.5 2.7 3 6 3s6-1.5 6-3v-3.5l-6 3-6-3z" fill="#fff" opacity="0.7"/></svg>' },
  { title: 'Home — your daily overview', desc: 'Home gathers what needs your attention today: open checklist items, overdue jobs, the board summary, and today\'s schedule, all in one glance.',
    icon: '<svg viewBox="0 0 24 24" width="42" height="42" xmlns="http://www.w3.org/2000/svg"><path d="M12 3l9 8h-3v9h-4v-6H10v6H6v-9H3l9-8z" fill="#fff"/></svg>' },
  { title: 'Checklist — your open items', desc: 'Every task assigned to you, across every job you can see, in one running list. Check them off as you go — no need to hunt through each job.',
    icon: '<svg viewBox="0 0 24 24" width="42" height="42" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="18" height="18" rx="3" fill="#fff"/><path d="M7 12l3 3 7-7" stroke="#1a237e" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' },
  { title: 'Calendar — what\'s due, and when', desc: 'A real month view with every job\'s scheduled bar laid out day by day, plus a running flag on anything overdue or due soon.',
    icon: '<svg viewBox="0 0 24 24" width="42" height="42" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="5" width="18" height="16" rx="2" fill="#fff"/><rect x="3" y="5" width="18" height="4" rx="2" fill="#e53935"/></svg>' },
  { title: 'Gantt Chart — the full timeline', desc: 'Every job\'s phases laid out on one schedule. Drag to reschedule, zoom to focus on a stretch of weeks, and see how jobs overlap.',
    icon: '<svg viewBox="0 0 24 24" width="42" height="42" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4" width="10" height="4" rx="1.5" fill="#fff"/><rect x="3" y="10.5" width="16" height="4" rx="1.5" fill="#fff" opacity="0.75"/></svg>' },
  { title: 'Board — track every stage', desc: 'A Trello-style board — Bid, Scheduled, Active, Complete — that moves jobs along automatically as their schedule progresses.',
    icon: '<svg viewBox="0 0 24 24" width="42" height="42" xmlns="http://www.w3.org/2000/svg"><path d="M3 6a1 1 0 011-1h5l2 2h9a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V6z" fill="#fff"/></svg>' },
];
let tutorialSlideStep = 0;

// Appended to only the last slide's desc — the six slides above cover what
// each view IS, but never what to actually do first. hasMinTier gates the
// same way the "Add a job" coachmark step already does, so someone who
// can't add jobs isn't told to.
function finalSlideCta(): string {
  return hasMinTier('projectAdmin')
    ? ' Ready to start? Add your first job from the + at the top of the job list on the left.'
    : ' Ready to start? Your admin will assign you to a job — it\'ll appear in the list on the left once they do.';
}

function ensureOnbTutDom(): HTMLElement {
  let el = document.getElementById('onbTutOverlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'onbTutOverlay';
  el.className = 'onb-tut-overlay';
  el.innerHTML =
    '<div class="onb-tut-box">' +
      '<div class="onb-tut-visual" id="onbTutVisual"></div>' +
      '<div class="onb-tut-body">' +
        '<div class="onb-tut-step-label" id="onbTutStepLabel"></div>' +
        '<div class="onb-tut-title" id="onbTutTitle"></div>' +
        '<div class="onb-tut-desc" id="onbTutDesc"></div>' +
      '</div>' +
      '<div class="onb-tut-footer">' +
        '<div class="onb-tut-dots" id="onbTutDots"></div>' +
        '<div class="onb-tut-nav">' +
          '<button class="onb-tut-skip" onclick="tutorialSlideSkip()">Skip</button>' +
          '<button class="onb-tut-back" id="onbTutBack" onclick="tutorialSlideBack()">Back</button>' +
          '<button class="onb-tut-next" id="onbTutNext" onclick="tutorialSlideNext()">Next</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(el);
  return el;
}

export function renderTutorialSlide(): void {
  const s = TUTORIAL_SLIDES[tutorialSlideStep];
  document.getElementById('onbTutStepLabel')!.textContent = 'Step ' + (tutorialSlideStep + 1) + ' of ' + TUTORIAL_SLIDES.length;
  document.getElementById('onbTutTitle')!.textContent = s.title;
  document.getElementById('onbTutDesc')!.textContent = s.desc + (tutorialSlideStep === TUTORIAL_SLIDES.length - 1 ? finalSlideCta() : '');
  document.getElementById('onbTutVisual')!.innerHTML = s.icon;
  document.getElementById('onbTutDots')!.innerHTML = TUTORIAL_SLIDES.map(function(_, i) {
    return '<span class="onb-tut-dot' + (i === tutorialSlideStep ? ' active' : '') + '"></span>';
  }).join('');
  (document.getElementById('onbTutBack') as HTMLButtonElement).disabled = tutorialSlideStep === 0;
  document.getElementById('onbTutNext')!.textContent = tutorialSlideStep === TUTORIAL_SLIDES.length - 1 ? 'Done' : 'Next';
}
export function openTutorialSlides(): void {
  tutorialSlideStep = 0;
  ensureOnbTutDom();
  renderTutorialSlide();
  document.getElementById('onbTutOverlay')!.classList.add('show');
}
export function closeTutorialSlides(finished?: boolean): void {
  const el = document.getElementById('onbTutOverlay');
  if (el) el.classList.remove('show');
  if (finished) setTimeout(openCoachmarkTour, 350);
}
export function tutorialSlideBack(): void {
  if (tutorialSlideStep > 0) { tutorialSlideStep--; renderTutorialSlide(); }
}
export function tutorialSlideNext(): void {
  if (tutorialSlideStep < TUTORIAL_SLIDES.length - 1) { tutorialSlideStep++; renderTutorialSlide(); }
  else closeTutorialSlides(true);
}
export function tutorialSlideSkip(): void {
  closeTutorialSlides(false);
}

// Each step tries its selectors in order and uses the first one actually
// on-screen (offsetParent !== null) — lets a permission-gated step (Add
// Job is projectAdmin+ only) just get skipped for a lower-tier viewer
// instead of pointing at a hidden button.
const COACHMARK_STEPS = [
  { find: ['#notifyBtn'], title: 'Notifications', desc: 'Comments, @mentions, assignments and due dates on your jobs.' },
  { find: ['#helpBtn'], title: 'Help', desc: 'How every page works, what the Gantt colors mean, and this tour again.' },
  { find: ['#settingsBtn'], title: 'Settings', desc: 'Dark mode, the project\'s look and workflow, and export and print.' },
  { find: ['#accountBtn'], title: 'Your account', desc: 'Your password, email, two-step sign-in, and logging out.' },
  { find: ['#jobRailToggleBtn'], title: 'Jobs list', desc: 'The ☰ button shows or hides the full job list along the left edge.' },
  { find: ['.job-rail-add-btn'], title: 'Add a job', desc: 'Start a brand new job from scratch.' },
  { find: ['#tab-checklist'], title: 'Checklist tab', desc: 'Jump to the full checklist — every open item assigned to you.' },
  { find: ['#tab-calendar'], title: 'Calendar tab', desc: 'The full month view, with every job\'s scheduled bar.' },
  { find: ['#tab-gantt'], title: 'Gantt Chart tab', desc: 'The full project timeline — every job\'s phases on one schedule.' },
  { find: ['#tab-board'], title: 'Board tab', desc: 'The full Trello-style board, all boards and every card.' },
  { find: ['#homeWidgetChecklist .home-widget-expand-btn'], title: 'Expand a widget', desc: 'Every Home widget has this — grow it in place to see more, without leaving Home. Try it on any of the five.' },
  // requiresJobs: on a brand-new account with zero jobs yet, this widget
  // has no job selected and nothing to demonstrate — the spotlight would
  // land on an empty panel. Skipped (like any step whose target isn't
  // found — see findCoachmarkTarget()) until a real job exists.
  { find: ['#homeWidgetJobChat'], title: 'Job Chat', desc: 'Message the team about any job without leaving Home.', requiresJobs: true },
];
let coachmarkStep = -1;
let coachmarkResizeHandler: (() => void) | null = null;

export function findCoachmarkTarget(step: { find: string[]; requiresJobs?: boolean }): HTMLElement | null {
  // window.jobs, not the bare `jobs` global — index.html's `var jobs = []`
  // hasn't necessarily run in every context this bundle gets loaded into
  // (e.g. tests/unit-fixture.html loads dist/app.bundle.js standalone), and
  // a bare undeclared identifier reference throws ReferenceError where a
  // property lookup on window just yields undefined.
  if (step.requiresJobs && (!window.jobs || window.jobs.length === 0)) return null;
  for (let i = 0; i < step.find.length; i++) {
    const el = document.querySelector(step.find[i]) as HTMLElement | null;
    if (el && el.offsetParent !== null) return el;
  }
  return null;
}

function ensureOnbCmDom(): HTMLElement {
  let el = document.getElementById('onbCmDim');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'onbCmDim';
  el.className = 'onb-cm-dim';
  el.innerHTML =
    '<div class="onb-cm-hole" id="onbCmHole"><div class="onb-cm-ring"></div></div>' +
    '<div class="onb-cm-card" id="onbCmCard">' +
      '<div class="onb-cm-step-label">On this page</div>' +
      '<div class="onb-cm-title" id="onbCmTitle"></div>' +
      '<div class="onb-cm-desc" id="onbCmDesc"></div>' +
      '<div class="onb-cm-footer">' +
        '<span class="onb-cm-progress" id="onbCmProgress"></span>' +
        '<div class="onb-cm-nav">' +
          '<button class="onb-cm-skip" onclick="closeCoachmarkTour()">Skip</button>' +
          '<button class="onb-cm-back" id="onbCmBack" onclick="coachmarkBack()">Back</button>' +
          '<button class="onb-cm-next" id="onbCmNext" onclick="coachmarkNext()">Next</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(el);
  return el;
}

function positionCoachmark(targetEl: HTMLElement): void {
  const r = targetEl.getBoundingClientRect();
  const pad = 6;
  const hole = document.getElementById('onbCmHole') as HTMLElement;
  hole.style.top = (r.top - pad) + 'px';
  hole.style.left = (r.left - pad) + 'px';
  hole.style.width = (r.width + pad * 2) + 'px';
  hole.style.height = (r.height + pad * 2) + 'px';

  const card = document.getElementById('onbCmCard') as HTMLElement;
  const cardW = 250, cardH = card.offsetHeight || 130;
  const below = r.bottom + pad + 10;
  const top = (below + cardH > window.innerHeight - 10) ? Math.max(10, r.top - pad - cardH - 10) : below;
  let left = r.left + r.width / 2 - cardW / 2;
  left = Math.max(10, Math.min(left, window.innerWidth - cardW - 10));
  card.style.top = top + 'px';
  card.style.left = left + 'px';
}

// Walks forward/backward over COACHMARK_STEPS looking for the next one
// whose target actually exists+is visible right now, rather than
// assuming every step always applies (see findCoachmarkTarget()'s own
// comment on why a step can legitimately have nothing to point at).
// Returns -1 if none found in that direction.
export function findNextCoachmarkIndex(fromIndex: number, direction: number): number {
  let i = fromIndex + direction;
  while (i >= 0 && i < COACHMARK_STEPS.length) {
    if (findCoachmarkTarget(COACHMARK_STEPS[i])) return i;
    i += direction;
  }
  return -1;
}

export function renderCoachmarkStep(): void {
  const step = COACHMARK_STEPS[coachmarkStep];
  const targetEl = findCoachmarkTarget(step);
  if (!targetEl) { closeCoachmarkTour(); return; }
  document.getElementById('onbCmTitle')!.textContent = step.title;
  document.getElementById('onbCmDesc')!.textContent = step.desc;
  document.getElementById('onbCmProgress')!.textContent = (coachmarkStep + 1) + ' / ' + COACHMARK_STEPS.length;
  (document.getElementById('onbCmBack') as HTMLButtonElement).disabled = findNextCoachmarkIndex(coachmarkStep, -1) === -1;
  document.getElementById('onbCmNext')!.textContent = findNextCoachmarkIndex(coachmarkStep, 1) === -1 ? 'Done' : 'Next';
  targetEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  positionCoachmark(targetEl);
}
export function openCoachmarkTour(): void {
  if (window.innerWidth <= 900) return;
  switchTabMorphed('home');
  const firstIndex = findCoachmarkTarget(COACHMARK_STEPS[0]) ? 0 : findNextCoachmarkIndex(0, 1);
  if (firstIndex === -1) return;
  coachmarkStep = firstIndex;
  ensureOnbCmDom();
  requestAnimationFrame(function() {
    document.getElementById('onbCmDim')!.classList.add('show');
    renderCoachmarkStep();
  });
  coachmarkResizeHandler = function() { renderCoachmarkStep(); };
  window.addEventListener('resize', coachmarkResizeHandler);
}
export function closeCoachmarkTour(): void {
  const el = document.getElementById('onbCmDim');
  if (el) el.classList.remove('show');
  if (coachmarkResizeHandler) { window.removeEventListener('resize', coachmarkResizeHandler); coachmarkResizeHandler = null; }
}
export function coachmarkBack(): void {
  const i = findNextCoachmarkIndex(coachmarkStep, -1);
  if (i !== -1) { coachmarkStep = i; renderCoachmarkStep(); }
}
export function coachmarkNext(): void {
  const i = findNextCoachmarkIndex(coachmarkStep, 1);
  if (i !== -1) { coachmarkStep = i; renderCoachmarkStep(); }
  else closeCoachmarkTour();
}
