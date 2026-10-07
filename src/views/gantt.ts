// Gantt view: the bar/tick drag-and-resize mechanics
// (cascadeShiftLaterTasks/startBarResizeRight/startBarResizeLeft/
// onBarResizeMove/applyBarResizeMove/onBarResizeEnd/startTickResize/
// onTickResizeMove/applyTickResizeMove/onTickResizeEnd/startBarMove/
// onBarMoveMove/applyBarMoveMove/onBarMoveEnd), the view-state toggles
// (collapse/expand, job focus, the date popover, and the task tooltip —
// togglePhaseCollapse/getSubUnitKey/toggleTasksPhaseExpanded/
// toggleTasksSubPhaseExpanded/expandAllGantt/collapseAllGantt/
// toggleGanttJobFocus/clearGanttJobFocus/toggleGanttTaskFocus/
// clearGanttTaskFocus/syncGanttFocusBanner/
// computeDateRange/showDatePopover/hideDatePopover/
// showTooltip), the visible-row builder (byStartDate/getPhaseSegments/
// buildSegment/buildPhaseCollapsedRow/buildSubPhaseRow/
// buildVisibleTaskRows — a pure data transformation, jobs/phases/tasks in
// and a flat row list out, with no DOM reads or writes), renderGantt()
// itself (by far the densest function in the app, ~800 lines), and the
// touch/pinch-zoom gesture cluster (scrollToToday/ganttTouchDist/
// setGanttDayWidthAnchored/requestGanttZoom/handleGanttTouchStart/Move/
// End/handleGanttWheelZoom/zoomGanttCentered/zoomIn/zoomOut/resetZoom/
// fitToView — never mutates task data, so the worst case of a bug here is
// a glitchy zoom or scroll position, not a corrupted date).
//
// renderGantt() is a thin, linear pipeline built from module-level
// functions (defined just above it, same pattern as
// buildVisibleTaskRows() above and scheduleOrphanRecovery() in
// src/sync/inbound.ts): setupDateRangeAndGrid/buildDateHeader/
// buildRowModel/renderLeftPanelRows/drawTodayLine/renderTimelineBars/
// drawConnectorLines/restoreScrollPosition, each taking explicit named
// parameters and returning a typed result. renderGantt() calls each
// once in a fixed order, threading each phase's return value into the
// next call's arguments — see each function's own signature for exactly
// what it depends on and produces, rather than reading a shared closure.
import type { Job, Phase, SubPhase, Task, BoardColumn } from '../core/types';
import { safeJsonParse } from '../utils/id';
import { toIsoDate, getDaysDiff, formatDate } from '../utils/date';
import { escapeHtml } from '../utils/html';
import { tintedTextColor, ganttPastel, ganttPastelHex, softChip, boardColumnColors, JOB_NAME_CONTRAST } from '../utils/color';
import { findJob, findTask, getJobPhases, getPhaseSubUnits, getPhaseCard } from '../core/models';
import { buildDateHeaderCells, renderDateHeaderInto } from './gantt-date-header';
import { renderFocusBannerInto } from './gantt-focus-banner';
import { renderTaskRowsInto, type TaskRowProps, type TaskRowPillProps } from './gantt-task-row';
import { renderTimelineBarsInto, type TaskBarEntryProps, type BarTagData, type JobSpanTickData, type JobSpanSegmentData, type JobSpanDueData } from './gantt-task-bar';
import { renderGridLinesInto, renderRowBgInto, renderTodayLineInto, type RowBgEntry, type TodayLineData } from './gantt-grid-decor';
import { updateGanttPinnedNames } from './gantt-pinned-names';
import { showToast, moveTooltip, hideTooltip } from '../utils/ui';
import { hasMinTier } from '../auth/permissions';

// Ambient globals this file shares verbatim with other src/ files
// (BOARD_COLUMNS, saveJobs(), showToast(), etc.) are declared once in
// src/shared-globals.d.ts, not repeated here. DUE_MARKER_TASK_ID/
// getJobDueMarkerTask() are real exports of THIS file now (see near the
// bottom) — src/shared-globals.d.ts still ambiently declares them too,
// for src/views/calendar.ts's own bare references to keep resolving;
// that central declaration is intentionally left alone rather than
// converted, since calendar.ts and this file would otherwise need to
// agree on one exact shared type for a value each already types its own
// way (GanttTask vs CalTask).
declare global {
  // eslint-disable-next-line no-var
  var dayWidth: number;
  // eslint-disable-next-line no-var
  var barResizeState: BarResizeState | null;
  // eslint-disable-next-line no-var
  var tickResizeState: TickResizeState | null;
  // eslint-disable-next-line no-var
  var barMoveState: BarMoveState | null;
  // getVisibleJobs/getLinkedReferenceJobs/editJob/jumpToLinkedJobReference/
  // isTaskFinished are declared here (rather than in shared-globals.d.ts)
  // because this file types them with its own Job/GanttTask shapes —
  // src/views/calendar.ts declares the same index.html functions with
  // its own, differently named/shaped types. TypeScript allows an
  // ambient `function` (unlike `var`) to be re-declared with a different
  // signature per file — each file gets its own narrower view of the
  // same real function.
  function getVisibleJobs(): Job[];
  function getLinkedReferenceJobs(): Job[];
  // A phase's own id can be null (an unphased job's synthetic default
  // phase — see getJobPhases()), so this has to accept null keys too.
  // eslint-disable-next-line no-var
  var tasksExpandedPhaseIds: Set<string | null>;
  // eslint-disable-next-line no-var
  var tasksExpandedSubPhaseIds: Set<string>;
  // eslint-disable-next-line no-var
  var ganttFocusedJobId: string | null;
  // eslint-disable-next-line no-var
  var ganttFocusedTaskColumnId: string | null;
  // eslint-disable-next-line no-var
  var startDate: Date;
  // eslint-disable-next-line no-var
  var endDate: Date;
  // Same null-key reasoning as tasksExpandedPhaseIds above.
  // eslint-disable-next-line no-var
  var collapsedPhaseIds: Set<string | null>;
  // eslint-disable-next-line no-var
  var ganttViewMode: string;
  // eslint-disable-next-line no-var
  var ganttFirstRender: boolean;
  // How far back the chart always leaves room to scroll (src/core/constants.ts).
  const ARCHIVE_CUTOFF_DAYS: number;
  function editJob(jobId: string, phaseId?: string | null, subPhaseId?: string | null): void;
  function jumpToLinkedJobReference(job: Job): void;
  function isTaskFinished(job: Job, task: GanttTask): boolean;
}

// Gantt row/bar sizing — threaded through renderGantt(), the drag/resize
// handlers, and the SVG connector lines between split job-span segments.
// Real module-owned values now (used only in this file — no other src/
// file or test ever reads or reassigns them), moved out of index.html's
// inline script where they used to live as ambient `window` globals for
// no reason beyond history. The matching CSS (.task-row, .task-bar,
// .row-bg, .job-span-*) is hand-kept in sync with these since plain CSS
// can't reference JS constants — search for GANTT_ROW_H/GANTT_BAR_H in a
// comment there if these ever change again.
export const GANTT_ROW_H = 40;
export const GANTT_BAR_H = 26;
export const GANTT_BAR_PAD = (GANTT_ROW_H - GANTT_BAR_H) / 2;

// Which phase rows are folded into one condensed bar in the Jobs/Leads
// view (see togglePhaseCollapse()). A phase's own id can be null (an
// unphased job's synthetic default phase), so this has to accept null
// keys too. Real module-owned value now, same reasoning as
// GANTT_ROW_H/etc. above — only ever read/mutated (via .add()/.delete(),
// never wholesale-reassigned) from within this file or a test exercising
// it in place.
export const collapsedPhaseIds = new Set<string | null>(safeJsonParse(localStorage.getItem('gantt_collapsed_phases_v1') || '[]', []));

// Deliberately loose local type (mirrors src/views/calendar.ts's own
// CalTask): `task` here can be a REAL task from a sub-unit's own
// tasks[], a due-date marker synthesized by getJobDueMarkerTask(), or a
// throwaway synthetic {name, start, finish} pseudo-task spanning a
// collapsed phase/sub-phase's whole date range (buildPhaseCollapsedRow/
// buildSubPhaseRow below) or — for a job-span drag — a whole sub-unit
// (startBarMove() above).
interface GanttTask {
  id?: string;
  name: string;
  start?: string;
  finish?: string;
  order?: number;
  columnId?: string;
  [key: string]: unknown;
}

interface BarResizeState {
  side: 'left' | 'right';
  jobId: string;
  taskId: string;
  task: GanttTask;
  bar: HTMLElement;
  startX: number;
  startDateObj?: Date;
  finishDateObj?: Date;
  initialDuration: number;
  currentDuration: number;
  origLeftPx?: number;
}

interface TickResizeState {
  jobId: string;
  taskId: string;
  task: GanttTask;
  tick: HTMLElement;
  startX: number;
  startDateObj: Date;
  origLeftPx: number;
  initialDuration: number;
  currentDuration: number;
}

interface BarMoveState {
  jobId: string;
  taskId: string;
  task: GanttTask;
  bar: HTMLElement;
  startX: number;
  startDateObj: Date;
  duration: number;
  deltaDays: number;
  moved: boolean;
  phaseId: string | null;
  subPhaseId: string | null;
  origLeftPx: number;
  isJobSpan: boolean;
  jobSpanOverlayEls: { el: HTMLElement; origLeft: number }[] | null;
  // Grabbing one task's (or sub-phase's) solid piece of a condensed bar:
  // the piece is stretched to that task's FULL length for the drag, and
  // the rest of the row is dimmed — see startBarMove(). Undone on drop.
  preview: { left: string; width: string; dimmed: HTMLElement[] } | null;
}

// Keeps the rest of a job's schedule in line after one task's dates change.
// Moving (or extending) a task LATER slides every later task in the same
// sub-unit (by `order`) along by the same delta, so overlaps between stages
// are kept exactly as they were. Moving (or shortening) a task EARLIER
// leaves the later tasks where they are — they were already scheduled and
// shouldn't be dragged back just because an earlier stage freed up.
// Either way, stage order is then enforced: a later stage never starts
// before an earlier one. Any later stage the change pushed past gets pushed
// along with it, and any earlier stage the task was dragged back past gets
// pulled back with it (each by only as much as needed, duration kept).
// The same order rule then runs further up, between the phase's
// sub-phases and then between the job's phases (see keepSubPhasesInOrder()/
// keepPhasesInOrder()).
function cascadeShiftLaterTasks(jobId: string, taskId: string, deltaDays: number): void {
  const found = findJob(jobId);
  if (!found) return;
  let unit: SubPhase | null = null;
  let unitPhase: Phase | null = null;
  const phases = getJobPhases(found.job);
  outer: for (let p = 0; p < phases.length; p++) {
    const units = getPhaseSubUnits(phases[p]);
    for (let u = 0; u < units.length; u++) {
      if ((units[u].tasks || []).some((t) => t.id === taskId)) { unit = units[u]; unitPhase = phases[p]; break outer; }
    }
  }
  if (!unit || !unitPhase) return;
  const sorted = (unit.tasks || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const idx = sorted.findIndex((t) => t.id === taskId);
  if (idx === -1) return;
  if (deltaDays > 0) {
    for (let i = idx + 1; i < sorted.length; i++) shiftTaskDays(sorted[i], deltaDays);
  }
  // Only tasks with real dates take part — an unscheduled "Invoiced" task
  // (say) neither blocks nor gets moved.
  const dated = sorted.filter((t) => parseTaskStart(t) !== null);
  const at = dated.findIndex((t) => t.id === taskId);
  if (at !== -1) {
    for (let i = at + 1; i < dated.length; i++) {
      const gap = getDaysDiff(parseTaskStart(dated[i])!, parseTaskStart(dated[i - 1])!);
      if (gap > 0) shiftTaskDays(dated[i], gap);
    }
    for (let i = at - 1; i >= 0; i--) {
      const gap = getDaysDiff(parseTaskStart(dated[i + 1])!, parseTaskStart(dated[i])!);
      if (gap > 0) shiftTaskDays(dated[i], -gap);
    }
  }
  // A task move only changes where its sub-phase starts, it doesn't move
  // the sub-phase as a block — so only the order rule applies (delta 0).
  keepSubPhasesInOrder(unitPhase, unit);
  keepPhasesInOrder(found.job, unitPhase);
}

// Sub-phase version, for a phase split into sub-phases (in the phase's own
// sub-phase order) — ONLY the order rule, same as keepPhasesInOrder():
// a later sub-phase never starts before an earlier one. Moving a sub-phase
// later does NOT push the later ones along by the same amount; another
// sub-phase only moves once this one's start actually passes it (pushed,
// or pulled back when dragging earlier), and then only by as much as
// needed, keeping its own schedule intact. A sub-phase's start is its
// earliest scheduled task (same rule as the Gantt bar drawn for it).
function keepSubPhasesInOrder(phase: Phase, anchor: SubPhase): void {
  const units = getPhaseSubUnits(phase);
  if (units.length < 2) return;
  const hidden = getHiddenTaskOrders();
  const startOf = (u: SubPhase) => { const seg = buildSegment(u, hidden); return seg ? seg.start : null; };
  const dated = units.filter((u) => startOf(u) !== null);
  const at = dated.indexOf(anchor);
  if (at === -1) return;
  for (let i = at + 1; i < dated.length; i++) {
    const gap = getDaysDiff(startOf(dated[i])!, startOf(dated[i - 1])!);
    if (gap > 0) shiftSubUnitDays(dated[i], gap);
  }
  for (let i = at - 1; i >= 0; i--) {
    const gap = getDaysDiff(startOf(dated[i + 1])!, startOf(dated[i])!);
    if (gap > 0) shiftSubUnitDays(dated[i], -gap);
  }
}

// Phase version, one level further up (in the job's own phase order) —
// but ONLY the order rule: a later phase never starts before an earlier
// one. Unlike stages/sub-phases, moving a phase later does NOT push the
// job's later phases along by the same amount; another phase only moves
// once this one's start actually passes it (pushed, or pulled back when
// dragging earlier), and then only by as much as needed. A phase's start
// is its earliest scheduled task across all its sub-phases (same as its
// collapsed Gantt bar).
function keepPhasesInOrder(job: Job, anchor: Phase): void {
  const phases = getJobPhases(job);
  if (phases.length < 2) return;
  const shiftPhase = (ph: Phase, days: number) => getPhaseSubUnits(ph).forEach((u) => shiftSubUnitDays(u, days));
  const hidden = getHiddenTaskOrders();
  const startOf = (ph: Phase) => {
    let min: Date | null = null;
    getPhaseSegments(ph, hidden).forEach((seg) => { if (!min || seg.start < min) min = seg.start; });
    return min as Date | null;
  };
  const dated = phases.filter((ph) => startOf(ph) !== null);
  const at = dated.indexOf(anchor);
  if (at === -1) return;
  for (let i = at + 1; i < dated.length; i++) {
    const gap = getDaysDiff(startOf(dated[i])!, startOf(dated[i - 1])!);
    if (gap > 0) shiftPhase(dated[i], gap);
  }
  for (let i = at - 1; i >= 0; i--) {
    const gap = getDaysDiff(startOf(dated[i + 1])!, startOf(dated[i])!);
    if (gap > 0) shiftPhase(dated[i], -gap);
  }
}

// The sub-unit(s) a condensed bar stands for. A collapsed phase row has a
// null subPhaseId meaning "every sub-phase at once" — but an unsplit
// phase's single default sub-unit ALSO has a null id, so which one it
// means depends on whether the phase is actually split.
function getSpanSubUnits(phase: Phase, subPhaseId: string | null): SubPhase[] {
  const units = getPhaseSubUnits(phase);
  if (!subPhaseId && phase.subPhases && phase.subPhases.length) return units;
  return units.filter((s) => (s.id || null) === (subPhaseId || null));
}

function shiftSubUnitDays(unit: SubPhase, days: number): void {
  (unit.tasks || []).forEach((t) => shiftTaskDays(t, days));
}

function parseTaskStart(t: GanttTask): Date | null {
  if (!t.start || !t.finish) return null;
  const d = new Date(t.start + 'T00:00:00');
  const f = new Date(t.finish + 'T00:00:00');
  return isNaN(d.getTime()) || isNaN(f.getTime()) ? null : d;
}

function shiftTaskDays(t: GanttTask, days: number): void {
  // Not every task necessarily has dates set yet — nothing to shift there.
  if (!days || parseTaskStart(t) === null) return;
  const newStart = new Date(t.start + 'T00:00:00');
  const newFinish = new Date(t.finish + 'T00:00:00');
  newStart.setDate(newStart.getDate() + days);
  newFinish.setDate(newFinish.getDate() + days);
  t.start = toIsoDate(newStart);
  t.finish = toIsoDate(newFinish);
}

function startBarResizeRight(e: MouseEvent, jobId: string, taskId: string, bar: HTMLElement): void {
  e.preventDefault();
  e.stopPropagation();
  if (!hasMinTier('editor')) return;
  const found = findTask(jobId, taskId);
  if (!found) return;
  const task = found.task;
  const s = new Date(task.start + 'T00:00:00');
  const f = new Date(task.finish + 'T00:00:00');
  const initialDuration = getDaysDiff(s, f) + 1;

  barResizeState = {
    side: 'right', jobId, taskId, task, bar, startX: e.clientX,
    startDateObj: s, initialDuration, currentDuration: initialDuration,
  };

  bar.classList.remove('milestone');
  bar.classList.add('resizing');
  document.addEventListener('mousemove', onBarResizeMove);
  document.addEventListener('mouseup', onBarResizeEnd);
}

// --- Left edge: drag to change start date ---
function startBarResizeLeft(e: MouseEvent, jobId: string, taskId: string, bar: HTMLElement): void {
  e.preventDefault();
  e.stopPropagation();
  if (!hasMinTier('editor')) return;
  const found = findTask(jobId, taskId);
  if (!found) return;
  const task = found.task;
  const s = new Date(task.start + 'T00:00:00');
  const f = new Date(task.finish + 'T00:00:00');
  const initialDuration = getDaysDiff(s, f) + 1;

  barResizeState = {
    side: 'left', jobId, taskId, task, bar, startX: e.clientX,
    finishDateObj: f, initialDuration, currentDuration: initialDuration,
    origLeftPx: parseFloat(bar.style.left),
  };

  bar.classList.remove('milestone');
  bar.classList.add('resizing');
  document.addEventListener('mousemove', onBarResizeMove);
  document.addEventListener('mouseup', onBarResizeEnd);
}

// rAF-coalesced for the same reason as onBarMoveMove()/applyBarMoveMove()
// just below — one tooltip innerHTML-write-then-offsetWidth-read forced
// layout flush per animation frame instead of per raw mousemove event.
let barResizeRafPending = false;
let barResizeLatestEvent: MouseEvent | null = null;
function onBarResizeMove(e: MouseEvent): void {
  if (!barResizeState) return;
  barResizeLatestEvent = e;
  if (barResizeRafPending) return;
  barResizeRafPending = true;
  requestAnimationFrame(function () {
    barResizeRafPending = false;
    if (barResizeState && barResizeLatestEvent) applyBarResizeMove(barResizeLatestEvent);
  });
}

function applyBarResizeMove(e: MouseEvent): void {
  if (!barResizeState) return;
  const deltaX = e.clientX - barResizeState.startX;
  const rawDeltaDays = Math.round(deltaX / dayWidth);
  const tt = document.getElementById('tooltip')!;
  const task = barResizeState.task;

  if (barResizeState.side === 'right') {
    const newDuration = Math.max(1, barResizeState.initialDuration + rawDeltaDays);
    barResizeState.currentDuration = newDuration;
    barResizeState.bar.style.width = (newDuration * dayWidth) + 'px';

    const newFinish = new Date(barResizeState.startDateObj!);
    newFinish.setDate(newFinish.getDate() + newDuration - 1);

    tt.innerHTML = '<div class="tt-title">' + escapeHtml(task.name) + '</div>' +
      '<div class="tt-row"><span class="tt-label">Finish:</span><span class="tt-value">' +
      newFinish.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '</span></div>' +
      '<div class="tt-row"><span class="tt-label">Duration:</span><span class="tt-value">' +
      newDuration + ' day' + (newDuration > 1 ? 's' : '') + '</span></div>';
  } else {
    const newDuration = Math.max(1, barResizeState.initialDuration - rawDeltaDays);
    const clampedDeltaDays = barResizeState.initialDuration - newDuration;
    barResizeState.currentDuration = newDuration;
    barResizeState.bar.style.left = (barResizeState.origLeftPx! + clampedDeltaDays * dayWidth) + 'px';
    barResizeState.bar.style.width = (newDuration * dayWidth) + 'px';

    const newStart = new Date(barResizeState.finishDateObj!);
    newStart.setDate(newStart.getDate() - (newDuration - 1));

    tt.innerHTML = '<div class="tt-title">' + escapeHtml(task.name) + '</div>' +
      '<div class="tt-row"><span class="tt-label">Start:</span><span class="tt-value">' +
      newStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '</span></div>' +
      '<div class="tt-row"><span class="tt-label">Duration:</span><span class="tt-value">' +
      newDuration + ' day' + (newDuration > 1 ? 's' : '') + '</span></div>';
  }

  tt.classList.add('show');
  moveTooltip(e);
}

function onBarResizeEnd(e: MouseEvent): void {
  if (!barResizeState) return;
  const { side, jobId, taskId, task, currentDuration, initialDuration, bar } = barResizeState;
  document.removeEventListener('mousemove', onBarResizeMove);
  document.removeEventListener('mouseup', onBarResizeEnd);
  bar.classList.remove('resizing');
  hideTooltip();

  if (currentDuration !== initialDuration) {
    if (side === 'right') {
      const newFinish = new Date(barResizeState.startDateObj!);
      newFinish.setDate(newFinish.getDate() + currentDuration - 1);
      task.finish = toIsoDate(newFinish);
      cascadeShiftLaterTasks(jobId, taskId, currentDuration - initialDuration);
    } else {
      const newStart = new Date(barResizeState.finishDateObj!);
      newStart.setDate(newStart.getDate() - (currentDuration - 1));
      task.start = toIsoDate(newStart);
      cascadeShiftLaterTasks(jobId, taskId, 0);
    }
    barResizeState = null;
    renderGantt();
    // Deferred past the render above — see onBarMoveEnd()'s own comment on
    // why saving/logging/the job list/the toast shouldn't share the same
    // synchronous burst as the reorder the user is actually watching.
    setTimeout(function () {
      saveJobs();
      logActivity('rescheduled task "' + task.name + '"');
      renderJobList();
      refreshJobFormIfOpen(jobId);
      showToast(side === 'right' ? 'Finish date updated' : 'Start date updated', 'success');
    }, 0);
    return;
  }

  barResizeState = null;
  renderGantt();
}

// --- Condensed Jobs/Leads bar: drag a phase-boundary tick to resize the
// task ending there (see the isJobSpan day-sweep in renderGantt(), which
// wires this up on each tick's mousedown). The tick equivalent of
// startBarResizeRight() above — same "drag right to extend, left to
// shorten" semantics and the same cascadeShiftLaterTasks() call to keep
// later tasks in the job at their own duration/gaps — just moving the
// tick element itself for live feedback instead of a bar's width, since
// there's no single bar representing one task in this condensed view.
function startTickResize(e: MouseEvent, jobId: string, taskId: string, tick: HTMLElement): void {
  e.preventDefault();
  e.stopPropagation();
  if (!hasMinTier('editor')) return;
  const found = findTask(jobId, taskId);
  if (!found) return;
  const task = found.task;
  const s = new Date(task.start + 'T00:00:00');
  const f = new Date(task.finish + 'T00:00:00');
  const initialDuration = getDaysDiff(s, f) + 1;

  tickResizeState = {
    jobId, taskId, task, tick, startX: e.clientX,
    startDateObj: s, origLeftPx: parseFloat(tick.style.left),
    initialDuration, currentDuration: initialDuration,
  };

  tick.classList.add('resizing');
  document.addEventListener('mousemove', onTickResizeMove);
  document.addEventListener('mouseup', onTickResizeEnd);
}

// Same rAF-coalescing as onBarResizeMove()/onBarMoveMove() above — this
// wasn't named in the original review pass, but it's the identical
// tooltip write-then-forced-layout-read pattern on every raw mousemove,
// just for the condensed Jobs/Leads view's tick-resize drag instead of a
// normal task bar's.
let tickResizeRafPending = false;
let tickResizeLatestEvent: MouseEvent | null = null;
function onTickResizeMove(e: MouseEvent): void {
  if (!tickResizeState) return;
  tickResizeLatestEvent = e;
  if (tickResizeRafPending) return;
  tickResizeRafPending = true;
  requestAnimationFrame(function () {
    tickResizeRafPending = false;
    if (tickResizeState && tickResizeLatestEvent) applyTickResizeMove(tickResizeLatestEvent);
  });
}

function applyTickResizeMove(e: MouseEvent): void {
  if (!tickResizeState) return;
  const deltaX = e.clientX - tickResizeState.startX;
  const rawDeltaDays = Math.round(deltaX / dayWidth);
  const newDuration = Math.max(1, tickResizeState.initialDuration + rawDeltaDays);
  tickResizeState.currentDuration = newDuration;
  tickResizeState.tick.style.left =
    (tickResizeState.origLeftPx + (newDuration - tickResizeState.initialDuration) * dayWidth) + 'px';

  const newFinish = new Date(tickResizeState.startDateObj);
  newFinish.setDate(newFinish.getDate() + newDuration - 1);

  const tt = document.getElementById('tooltip')!;
  tt.innerHTML = '<div class="tt-title">' + escapeHtml(tickResizeState.task.name) + '</div>' +
    '<div class="tt-row"><span class="tt-label">Finish:</span><span class="tt-value">' +
    newFinish.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '</span></div>' +
    '<div class="tt-row"><span class="tt-label">Duration:</span><span class="tt-value">' +
    newDuration + ' day' + (newDuration > 1 ? 's' : '') + '</span></div>';
  tt.classList.add('show');
  moveTooltip(e);
}

function onTickResizeEnd(e: MouseEvent): void {
  if (!tickResizeState) return;
  const { jobId, taskId, task, currentDuration, initialDuration } = tickResizeState;
  document.removeEventListener('mousemove', onTickResizeMove);
  document.removeEventListener('mouseup', onTickResizeEnd);
  hideTooltip();

  if (currentDuration !== initialDuration) {
    const newFinish = new Date(tickResizeState.startDateObj);
    newFinish.setDate(newFinish.getDate() + currentDuration - 1);
    task.finish = toIsoDate(newFinish);
    cascadeShiftLaterTasks(jobId, taskId, currentDuration - initialDuration);
    tickResizeState = null;
    renderGantt();
    // Deferred past the render above — see onBarMoveEnd()'s own comment.
    setTimeout(function () {
      saveJobs();
      logActivity('rescheduled task "' + task.name + '"');
      renderJobList();
      refreshJobFormIfOpen(jobId);
      showToast('Finish date updated', 'success');
    }, 0);
    return;
  }

  tickResizeState = null;
  renderGantt();
}

// --- Bar body: drag to move the whole task (both dates shift together) ---
// isJobSpan: dragging a condensed phase/sub-phase bar moves every dated
// task in it together (see onBarMoveEnd) rather than one real task, so
// `task` here is a synthetic start/finish spanning all of them, recomputed
// fresh from the job's current tasks (same rule as buildPhaseCollapsedRow()/
// buildSubPhaseRow()).
function startBarMove(e: MouseEvent, jobId: string, taskId: string, bar: HTMLElement, isJobSpan?: boolean, phaseId?: string | null, subPhaseId?: string | null): void {
  let task: GanttTask | undefined;
  if (isJobSpan) {
    const jf = findJob(jobId);
    if (!jf) return;
    const phase = getJobPhases(jf.job).find((p) => (p.id || null) === (phaseId || null));
    if (!phase) return;
    const spanUnits = getSpanSubUnits(phase, subPhaseId ?? null);
    if (!spanUnits.length) return;
    const hiddenOrders = new Set(
      BOARD_COLUMNS.map((c, i) => (c.hideFromSchedule ? i : null)).filter((i) => i !== null)
    );
    let minStart: Date | null = null;
    let maxFinish: Date | null = null;
    spanUnits.flatMap((u) => u.tasks || []).forEach((t) => {
      if (hiddenOrders.has(t.order as number)) return;
      if (!t.start || !t.finish) return;
      const s = new Date(t.start + 'T00:00:00');
      const f = new Date(t.finish + 'T00:00:00');
      if (isNaN(s.getTime()) || isNaN(f.getTime())) return;
      if (!minStart || s < minStart) minStart = s;
      if (!maxFinish || f > maxFinish) maxFinish = f;
    });
    if (!minStart || !maxFinish) return;
    task = { name: jf.job.name, start: toIsoDate(minStart), finish: toIsoDate(maxFinish) };
  } else if (taskId === DUE_MARKER_TASK_ID) {
    const jf = findJob(jobId);
    if (!jf) return;
    const dueTask = getJobDueMarkerTask(jf.job, phaseId ?? null);
    if (!dueTask) return;
    task = dueTask;
  } else {
    const found = findTask(jobId, taskId);
    if (!found) return;
    task = found.task;
    phaseId = found.phaseId;
    subPhaseId = found.subPhaseId;
  }
  if (!task) return;
  const s = new Date(task.start + 'T00:00:00');
  const f = new Date(task.finish + 'T00:00:00');
  const duration = getDaysDiff(s, f) + 1;

  // A solid piece of a condensed bar only covers the days where its task
  // (or sub-phase) doesn't overlap a neighbour — the overlapped days are
  // drawn as a separate hatch piece. Moving just the solid piece left that
  // hatch behind as a "ghost" of the same task (and moving the whole row
  // with it, as this once did, showed everything else moving when it
  // wouldn't). Instead, stretch the grabbed piece over its task's whole
  // length, dim the rest of the row, and hide the row's outline (it's
  // redrawn around the new dates on drop), so what moves is exactly what
  // will move.
  let preview: BarMoveState['preview'] = null;
  if (bar.dataset.fullLeft && bar.dataset.fullWidth) {
    preview = {
      left: bar.style.left, width: bar.style.width,
      dimmed: Array.from(document.querySelectorAll<HTMLElement>(
        '.job-span-task-tick, .job-span-gap-hash, .job-span-task-hatch, .job-span-task-solid, .job-span-border'
      )).filter((el) => el !== bar && el.dataset.rowKey === bar.dataset.rowKey),
    };
    bar.style.left = bar.dataset.fullLeft + 'px';
    bar.style.width = bar.dataset.fullWidth + 'px';
  }

  barMoveState = {
    jobId, taskId, task, bar, startX: e.clientX,
    startDateObj: s, duration, deltaDays: 0, moved: false, phaseId: phaseId || null, subPhaseId: subPhaseId || null,
    origLeftPx: parseFloat(bar.style.left),
    isJobSpan: !!isJobSpan,
    preview,
    // Queried + filtered ONCE here at drag start instead of on every
    // mousemove tick (see applyBarMoveMove()) — this used to be a
    // whole-document 6-class querySelectorAll + per-element dataset
    // filter running dozens of times a second for the whole duration of
    // a drag. The matching set can't change mid-drag (nothing else
    // touches these overlay elements while a drag is in progress), so
    // there's nothing to invalidate by caching it up front.
    //
    // Matched by rowKey (shared by every piece of one visual row — see
    // ganttRowKey()'s own comment) rather than the (jobId, phaseId,
    // subPhaseId) tuple this used to compare: a phase collapsed into one
    // row that folds several real sub-phases together (isCollapsedRow in
    // renderTimelineBars()) gives its border/label the ROW's own
    // subPhaseId (null, standing for "all of them") but gives each
    // colored day-segment its OWN task's real, specific subPhaseId —
    // genuinely different values for pieces of the exact same row. Matching
    // on that tuple meant grabbing the row's empty background dragged the
    // border/label but left every colored segment behind, while grabbing a
    // segment dragged it (and same-subphase siblings) but left the border
    // behind — a real, visible "duplicate bar" of the row's own outline
    // sitting apart from its own colored segments (Karl's own screenshot).
    // `bar` here is whichever element's own mousedown started this drag
    // (the base bar, or a specific segment), and every piece of this row —
    // border, label, every tick/hash/solid segment regardless of which
    // task or sub-phase it individually represents — already carries this
    // same rowKey, so this reliably grabs the whole row's worth of pieces
    // no matter which one the user actually grabbed.
    jobSpanOverlayEls: isJobSpan && !preview ? Array.from(document.querySelectorAll<HTMLElement>(
      '.job-span-task-tick, .job-span-gap-hash, .job-span-task-hatch, .job-span-task-solid, .job-span-name-wrap, .job-span-border'
    )).filter((tk) => tk.dataset.rowKey === bar.dataset.rowKey)
      .map((tk) => ({ el: tk, origLeft: parseFloat(tk.dataset.origLeft || '0') })) : null,
  };

  document.addEventListener('mousemove', onBarMoveMove);
  document.addEventListener('mouseup', onBarMoveEnd);
}

// rAF-coalesced the same way requestGanttZoom() below is — a raw
// mousemove can fire far more often than this can usefully repaint, and
// every tick was doing a
// tooltip innerHTML write immediately followed by an offsetWidth/
// offsetHeight read (see moveTooltip()), which forces a synchronous layout
// flush of whatever DOM writes are still pending (the bar's own style.left/
// width, here) on every single event instead of once per frame.
let barMoveRafPending = false;
let barMoveLatestEvent: MouseEvent | null = null;
function onBarMoveMove(e: MouseEvent): void {
  if (!barMoveState) return;
  barMoveLatestEvent = e;
  if (barMoveRafPending) return;
  barMoveRafPending = true;
  requestAnimationFrame(function () {
    barMoveRafPending = false;
    if (barMoveState && barMoveLatestEvent) applyBarMoveMove(barMoveLatestEvent);
  });
}

function applyBarMoveMove(e: MouseEvent): void {
  if (!barMoveState) return;
  // Below Editor: never let the drag actually move anything (and never set
  // .moved, so a click-drag attempt just resolves as a plain click on
  // mouseup and opens the job read-only, same as any other click) — mirrors
  // handleCalBarMouseMove()'s same reasoning for the calendar's bars.
  if (!hasMinTier('editor')) return;
  const deltaX = e.clientX - barMoveState.startX;

  if (Math.abs(deltaX) > 3) {
    barMoveState.moved = true;
    barMoveState.bar.classList.add('moving');
    if (barMoveState.preview) barMoveState.preview.dimmed.forEach((el) => el.classList.add('gantt-drag-dim'));
  }
  if (!barMoveState.moved) return;

  const deltaDays = Math.round(deltaX / dayWidth);
  barMoveState.deltaDays = deltaDays;
  barMoveState.bar.style.left = (barMoveState.origLeftPx + deltaDays * dayWidth) + 'px';

  // Drag the job-span bar's phase-boundary ticks, gap hashing, solid task
  // segments, overlap hatching, name label, and outline along with it so
  // they don't visually detach from the bar mid-drag (they otherwise only
  // catch up once renderGantt() redraws everything on drop). Set (see
  // startBarMove()) once at drag start instead of re-queried here.
  if (barMoveState.isJobSpan && barMoveState.jobSpanOverlayEls) {
    barMoveState.jobSpanOverlayEls.forEach((entry) => {
      entry.el.style.left = (entry.origLeft + deltaDays * dayWidth) + 'px';
    });
  }

  const newStart = new Date(barMoveState.startDateObj);
  newStart.setDate(newStart.getDate() + deltaDays);
  const newFinish = new Date(newStart);
  newFinish.setDate(newFinish.getDate() + barMoveState.duration - 1);

  const tt = document.getElementById('tooltip')!;
  tt.innerHTML = '<div class="tt-title">' + escapeHtml(barMoveState.task.name) + '</div>' +
    '<div class="tt-row"><span class="tt-label">Start:</span><span class="tt-value">' +
    newStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '</span></div>' +
    '<div class="tt-row"><span class="tt-label">Finish:</span><span class="tt-value">' +
    newFinish.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '</span></div>';
  tt.classList.add('show');
  moveTooltip(e);
}

function onBarMoveEnd(e: MouseEvent): void {
  if (!barMoveState) return;
  const { task, taskId, deltaDays, moved, duration, startDateObj, bar, jobId, isJobSpan, phaseId, subPhaseId } = barMoveState;
  document.removeEventListener('mousemove', onBarMoveMove);
  document.removeEventListener('mouseup', onBarMoveEnd);
  bar.classList.remove('moving');
  hideTooltip();
  // Undo the drag preview before any re-render — Preact only rewrites a
  // style it thinks changed, so a stretched width left on an element that
  // survives the render (e.g. a drag that ended back where it started)
  // would otherwise stick.
  const preview = barMoveState.preview;
  if (preview) {
    bar.style.left = preview.left;
    bar.style.width = preview.width;
    preview.dimmed.forEach((el) => el.classList.remove('gantt-drag-dim'));
  }

  if (isJobSpan) {
    if (moved && deltaDays !== 0) {
      const jf = findJob(jobId);
      const phase = jf && getJobPhases(jf.job).find((p) => (p.id || null) === (phaseId || null));
      const spanUnits = phase ? getSpanSubUnits(phase, subPhaseId) : [];
      const subUnit = spanUnits.length === 1 ? spanUnits[0] : null;
      if (jf && phase && spanUnits.length) {
        spanUnits.forEach((u) => shiftSubUnitDays(u, deltaDays));
        // One sub-phase moved on its own: keep the phase's other
        // sub-phases in order around it. The whole phase moving together
        // (a collapsed phase bar, or an unsplit phase's only bar) can't put
        // its own sub-phases out of order. Either way, the job's phases
        // are then kept in order (see keepPhasesInOrder()).
        if (subUnit && spanUnits.length < getPhaseSubUnits(phase).length) {
          keepSubPhasesInOrder(phase, subUnit);
        }
        keepPhasesInOrder(jf.job, phase);
        bar.dataset.dragged = 'true';
        barMoveState = null;
        renderGantt();
        // Deferred past the render above (see this function's own opening
        // comment on why) — saving, activity-log, job-list and the toast
        // are all real work a busy real project makes slow (see
        // saveActiveProject()'s localStorage write), but none of it is what the user actually just let go of
        // the mouse to see. Running it in the very same synchronous burst
        // as the reorder itself made the animation wait behind it for a
        // frame the user was already staring at, which read as the bar
        // freezing for a beat right as it was meant to start moving.
        setTimeout(function () {
          saveJobs();
          logActivity('moved job "' + jf.job.name + '"' + (phase.isDefault ? '' : ' phase "' + phase.name + '"') + (!subUnit || subUnit.isDefault ? '' : ' sub-phase "' + subUnit.name + '"'));
          showToast('Job dates updated', 'success');
        }, 0);
        // renderJobList()/refreshJobFormIfOpen() rebuild real DOM (the
        // whole sidebar list, potentially the open job form) — on a busy
        // real project (measured: 150+ jobs) that's tens of ms of main-
        // thread work, landing well inside the still-playing reorder
        // animation's ~1.1s window (see GANTT_REORDER_MS) once the
        // setTimeout above fires. The animation's own per-frame writes
        // are cheap and keep up fine on their own, but they still share
        // the SAME main thread — a render that expensive blocks whichever
        // frame it lands on, and since each frame's position is computed
        // from real elapsed time (not a frame counter), the bar visibly
        // freezes for that block, then snaps ahead to catch up the moment
        // it's released (Karl's own description: "jumps past the other
        // bar, then freezes, then resumes where it should have been").
        // Neither of these two is time-sensitive the way saveJobs() above
        // is, so pushing them past the animation's own end avoids the
        // collision entirely instead of just racing it.
        setTimeout(function () {
          renderJobList();
          refreshJobFormIfOpen(jobId);
        }, GANTT_REORDER_MS);
        return;
      }
      bar.dataset.dragged = 'true';
    } else {
      bar.dataset.dragged = 'false';
    }
    barMoveState = null;
    renderGantt();
    return;
  }

  if (moved && deltaDays !== 0 && taskId === DUE_MARKER_TASK_ID) {
    const newStart = new Date(startDateObj);
    newStart.setDate(newStart.getDate() + deltaDays);
    const dueJf = findJob(jobId);
    const card = dueJf ? getPhaseCard(dueJf.job as Job, phaseId) : null;
    if (card) {
      card.due = toIsoDate(newStart);
      bar.dataset.dragged = 'true';
      barMoveState = null;
      renderGantt();
      // See the isJobSpan branch above for why this is deferred rather
      // than run before the render the user is actually watching.
      setTimeout(function () {
        saveJobs();
        const jf = findJob(jobId);
        logActivity('rescheduled due date for job "' + (jf ? jf.job.name : '') + '"');
        showToast('Due date updated', 'success');
      }, 0);
      // See the isJobSpan branch above's own comment on why these three
      // (each a real DOM rebuild, not free on a busy project) wait until
      // the reorder animation is done rather than fight it for the main
      // thread mid-flight.
      setTimeout(function () {
        renderJobList();
        // Was missing here — the identical Calendar-side due-marker drag
        // already calls this; card.due drives the Board's own "overdue"
        // badge (see the isOverdue check), so without it a Gantt-side
        // due-date drag left that badge stale.
        renderBoard();
        refreshJobFormIfOpen(jobId);
      }, GANTT_REORDER_MS);
      return;
    }
    bar.dataset.dragged = 'true';
  } else if (moved && deltaDays !== 0) {
    const newStart = new Date(startDateObj);
    newStart.setDate(newStart.getDate() + deltaDays);
    const newFinish = new Date(newStart);
    newFinish.setDate(newFinish.getDate() + duration - 1);
    task.start = toIsoDate(newStart);
    task.finish = toIsoDate(newFinish);
    // Keep the rest of the job's schedule in order — see
    // cascadeShiftLaterTasks() for the later/earlier rules.
    cascadeShiftLaterTasks(jobId, taskId, deltaDays);
    bar.dataset.dragged = 'true';
    barMoveState = null;
    renderGantt();
    // See the isJobSpan branch above for why this is deferred.
    setTimeout(function () {
      saveJobs();
      logActivity('moved task "' + task.name + '"');
      showToast('Task dates updated', 'success');
    }, 0);
    // See the isJobSpan branch above's own comment on why these wait
    // until the reorder animation is done.
    setTimeout(function () {
      renderJobList();
      refreshJobFormIfOpen(jobId);
    }, GANTT_REORDER_MS);
    return;
  } else {
    bar.dataset.dragged = 'false';
  }

  barMoveState = null;
  renderGantt();
}

// ===== GANTT: VIEW-STATE TOGGLES (collapse/expand, job focus) =====
// A phase split into sub-phases normally gets one bar per sub-phase.
// Collapsing that phase folds its sub-phase bars back into one phase-wide
// bar with one solid segment per sub-phase, all in the job's own color.
// Purely a local view preference — not synced to other users.
function togglePhaseCollapse(phaseId: string | null): void {
  if (collapsedPhaseIds.has(phaseId)) collapsedPhaseIds.delete(phaseId); else collapsedPhaseIds.add(phaseId);
  localStorage.setItem('gantt_collapsed_phases_v1', JSON.stringify(Array.from(collapsedPhaseIds)));
  renderGantt();
}

// Sub-phases are keyed by a job+phase+sub-unit composite rather than just
// the sub-unit's own id, because both an unphased job's synthetic default
// phase AND an unsplit phase's synthetic default sub-unit share id:null
// (see getJobPhases()/getPhaseSubUnits()) — without the job/phase prefix,
// expanding one flat job's default bar would collide with every other
// flat job's.
function getSubUnitKey(job: Job, phaseId: string | null, subPhaseId: string | null): string {
  return job.id + '::' + (phaseId || 'p0') + '::' + (subPhaseId || 's0');
}
// Every phase/sub-phase in Tasks view starts CONDENSED (one bar) instead
// of showing individual tasks — these two track which ones a given user
// has explicitly EXPANDED back open, so that choice survives a reload.
function toggleTasksPhaseExpanded(phaseId: string | null): void {
  if (tasksExpandedPhaseIds.has(phaseId)) tasksExpandedPhaseIds.delete(phaseId); else tasksExpandedPhaseIds.add(phaseId);
  localStorage.setItem('gantt_tasks_expanded_phases_v1', JSON.stringify(Array.from(tasksExpandedPhaseIds)));
  renderGantt();
}
function toggleTasksSubPhaseExpanded(key: string): void {
  if (tasksExpandedSubPhaseIds.has(key)) tasksExpandedSubPhaseIds.delete(key); else tasksExpandedSubPhaseIds.add(key);
  localStorage.setItem('gantt_tasks_expanded_subphases_v1', JSON.stringify(Array.from(tasksExpandedSubPhaseIds)));
  renderGantt();
}
// Gantt toolbar's Expand All/Collapse All — bulk versions of the two
// toggles above, over every phase/sub-phase of every job currently in
// view (same job set buildVisibleTaskRows() renders).
function expandAllGantt(): void {
  getVisibleJobs().concat(getLinkedReferenceJobs()).forEach(function(job) {
    getJobPhases(job).forEach(function(phase) {
      const phaseId = phase.id || null;
      tasksExpandedPhaseIds.add(phaseId);
      getPhaseSubUnits(phase).forEach(function(sub) {
        tasksExpandedSubPhaseIds.add(getSubUnitKey(job, phaseId, sub.id || null));
      });
    });
  });
  localStorage.setItem('gantt_tasks_expanded_phases_v1', JSON.stringify(Array.from(tasksExpandedPhaseIds)));
  localStorage.setItem('gantt_tasks_expanded_subphases_v1', JSON.stringify(Array.from(tasksExpandedSubPhaseIds)));
  renderGantt();
}
function collapseAllGantt(): void {
  tasksExpandedPhaseIds.clear();
  tasksExpandedSubPhaseIds.clear();
  localStorage.setItem('gantt_tasks_expanded_phases_v1', '[]');
  localStorage.setItem('gantt_tasks_expanded_subphases_v1', '[]');
  renderGantt();
}

// Expand All / Collapse All are cleanup tools: after opening and closing
// rows one at a time, one click resets them. The single arrow in the Job
// column header (#ganttBulkToggle, plus a phone-only toolbar copy) shows
// the current mix: ▸ nothing open (click expands everything), ▾ everything
// open, or – a mix (either of those collapses everything). Counts the same
// foldable things the rows' own ▸ arrows toggle, on the rows in view.
function getGanttFoldCounts(): { open: number; total: number } {
  let open = 0, total = 0;
  getVisibleJobs().concat(getLinkedReferenceJobs()).forEach(function (job) {
    if (job.archived) return;
    getJobPhases(job).forEach(function (phase) {
      if (isPhaseFinishedOnBoard(job, phase.id)) return;
      const phaseId = phase.id || null;
      if (phase.subPhases && phase.subPhases.length > 1) {
        total++;
        if (tasksExpandedPhaseIds.has(phaseId)) open++;
      }
      getPhaseSubUnits(phase).forEach(function (sub) {
        total++;
        if (tasksExpandedSubPhaseIds.has(getSubUnitKey(job, phaseId, sub.id || null))) open++;
      });
    });
  });
  return { open: open, total: total };
}
function toggleGanttBulkFold(): void {
  if (getGanttFoldCounts().open === 0) expandAllGantt(); else collapseAllGantt();
}
// Alt-click on any row's own ▸/▾ arrow does the same for every row, in the
// direction that arrow was about to go (Finder's Option-click).
function bulkFoldFromRow(wasFolded: boolean): void {
  if (wasFolded) expandAllGantt(); else collapseAllGantt();
}
const BULK_ICON = {
  closed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
  mixed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M7 12h10"/></svg>',
};
function updateGanttBulkToggle(): void {
  const c = getGanttFoldCounts();
  const state = c.open === 0 ? 'closed' : c.open === c.total ? 'open' : 'mixed';
  const action = state === 'closed' ? 'Expand every job into its tasks' : 'Collapse every job back into one bar';
  const btn = document.getElementById('ganttBulkToggle');
  if (btn) {
    btn.innerHTML = BULK_ICON[state];
    btn.dataset.state = state;
    btn.title = action + ' (or Alt-click any row arrow)';
    btn.setAttribute('aria-label', action);
  }
  const phone = document.getElementById('ganttBulkTogglePhone');
  if (phone) {
    phone.innerHTML = BULK_ICON[state] + (state === 'closed' ? 'Expand all' : 'Collapse all');
    phone.title = action;
  }
}

// Clicking a job's name pill isolates the Gantt to just that job. NOT
// persisted to localStorage — a short-lived "let me focus on this one
// job" tool, reset on every page load and whenever the active project
// changes (see switchProject() in src/app/project.ts). Activating this
// clears ganttFocusedTaskColumnId below — see setGanttTaskFocus()'s own
// comment on why the two stay mutually exclusive.
function toggleGanttJobFocus(jobId: string): void {
  ganttFocusedJobId = (ganttFocusedJobId === jobId) ? null : jobId;
  if (ganttFocusedJobId) ganttFocusedTaskColumnId = null;
  renderGantt();
}
function clearGanttJobFocus(): void {
  if (!ganttFocusedJobId) return;
  ganttFocusedJobId = null;
  renderGantt();
}

// Mirrors ganttFocusedJobId/toggleGanttJobFocus() above, flipped to the
// other axis: instead of hiding every job but one, this hides every TASK
// but one (by BOARD_COLUMNS entry — see columnId on Task in
// src/core/types.ts) while keeping every job. Same lifecycle as job
// focus — not persisted, reset on reload/project switch (see
// switchProject() in src/app/project.ts).
//
// Kept mutually exclusive with job focus rather than combinable: showing
// "just this job's Framing" and "just Framing, every job" as two
// independently-toggleable filters would need the banner (and the
// toolbar picker) to describe a two-axis state on day one, for a
// combination nobody's asked for yet. Activating one clears the other, so
// exactly one of ganttFocusedJobId/ganttFocusedTaskColumnId is ever set.
function setGanttTaskFocus(columnId: string | null): void {
  ganttFocusedTaskColumnId = columnId;
  if (columnId) ganttFocusedJobId = null;
  renderGantt();
}
// Toggle entry point for clicking a task's name in the left panel (see
// renderLeftPanelRows()'s mainLabelClickable below) — same click-to-
// toggle-off gesture as toggleGanttJobFocus().
function toggleGanttTaskFocus(columnId: string): void {
  setGanttTaskFocus(ganttFocusedTaskColumnId === columnId ? null : columnId);
}
function clearGanttTaskFocus(): void {
  if (!ganttFocusedTaskColumnId) return;
  setGanttTaskFocus(null);
}

// Floating chip just above the zoom pill (Tasks view only), shown only
// while a job or task is isolated: "Showing only X · Show all". The
// "click a name to isolate it" tip lives in the Key panel now.
function syncGanttFocusBanner(): void {
  const el = document.getElementById('ganttJobFocusBanner');
  if (!el) return;
  if (ganttViewMode !== 'tasks') {
    renderFocusBannerInto(el, false, null, null, clearGanttJobFocus);
    return;
  }
  // The focused job/column could vanish out from under the filter
  // (deleted, no longer a Member, a project switch already cleared
  // ganttFocusedJobId, or it's not in the member currently being
  // previewed; a column stops matching once BOARD_COLUMNS no longer has
  // it, e.g. deleted from Board settings).
  const job = ganttFocusedJobId ? getVisibleJobs().find(function(j) { return j.id === ganttFocusedJobId; }) : null;
  const col = ganttFocusedTaskColumnId ? BOARD_COLUMNS.find(function(c) { return c.id === ganttFocusedTaskColumnId; }) : null;
  renderFocusBannerInto(el, !!(job || col), job ? job.name : null, col ? col.label : null, job ? clearGanttJobFocus : clearGanttTaskFocus);
}
// A .task-bar-job-tag has no background chip of its own anymore — just
// plain text in a contrast-adjusted variant of `color` (darkened/lightened
// as needed, never snapped to a flat white/black — see tintedTextColor())
// sitting directly on the bar underneath it. That bar's own fill is always
// `color` run through ganttPastel() (see the various `background:
// ganttPastel(...)` bar/segment fills below), so approximating against
// that same softened tone here keeps the tag readable against its real
// background without needing to thread the exact segment color through.
function barTagTextColor(color: string): string {
  return tintedTextColor(color, ganttPastelHex(color));
}

// The left-panel Job column's job-name/phase/sub-phase labels have no
// background chip either, same treatment as the on-bar tags above — but
// unlike a bar (whose fill is the job's own softened color, theme-
// independent), a row sits on the app's plain card background, which
// genuinely differs between light and dark mode (see index.html's --card
// under :root vs body.dark-mode). Toggling dark mode doesn't re-render an
// already-open Gantt, so a single computed-at-render-time color can't
// track that — instead this computes BOTH exact answers up front and
// hands them to TaskRowPill/TaskRow (gantt-task-row.tsx) as inline
// `--*-color-light`/`--*-color-dark` custom properties, letting a plain
// `body.dark-mode` CSS rule pick the right one instantly on toggle, no
// re-render needed.
function rowLabelColors(color: string): { light: string; dark: string } {
  // A row's real background isn't a flat color even within one theme —
  // .left-panel is translucent (a gradient in dark mode) over whatever
  // sits behind it, alternating rows tint slightly, and hover recolors it
  // again — so these reference colors are deliberately conservative
  // (already-composited estimates, not exact), checked against
  // JOB_NAME_CONTRAST (WCAG AA).
  return { light: tintedTextColor(color, '#f7f8fb', JOB_NAME_CONTRAST), dark: tintedTextColor(color, '#242732', JOB_NAME_CONTRAST) };
}
// Builds the phase-fold and/or sub-phase-fold tag(s) shown on a Tasks-view
// Gantt bar, as plain data for BarTag (see gantt-task-bar.tsx) to render.
// Returns 0-2 of them. `excludeSubTag` is set for a row that already
// represents a WHOLE folded phase (no single sub-unit context to toggle).
function buildPhaseSubTagsData(job: Job, phaseId: string | null, phaseName: string | null, subPhaseId: string | null, subPhaseName: string | null, phaseFoldable: boolean, excludeSubTag: boolean): BarTagData[] {
  const tags: BarTagData[] = [];
  const tagColor = barTagTextColor(job.color || '#999');
  function makeTag(folded: boolean, label: string, foldedTitle: string, unfoldedTitle: string, onClick: () => void): BarTagData {
    return {
      chevron: folded ? '▸' : '▾',
      label,
      title: (folded ? foldedTitle : unfoldedTitle) + (label ? ' — ' + label : ''),
      color: tagColor,
      focused: false,
      onClick: function (e?: MouseEvent) { if (e && e.altKey) bulkFoldFromRow(folded); else onClick(); },
    };
  }
  if (phaseFoldable && phaseName !== null) {
    tags.push(makeTag(!tasksExpandedPhaseIds.has(phaseId as string), phaseName,
      'Click to expand sub-phases', 'Click to collapse sub-phases into one bar',
      function() { toggleTasksPhaseExpanded(phaseId); }));
  }
  if (!excludeSubTag) {
    const subKey = getSubUnitKey(job, phaseId, subPhaseId);
    tags.push(makeTag(!tasksExpandedSubPhaseIds.has(subKey), subPhaseName || phaseName || '',
      'Click to expand into individual tasks', 'Click to collapse into a single bar',
      function() { toggleTasksSubPhaseExpanded(subKey); }));
  }
  return tags;
}

// ===== GANTT: DATE RANGE, DATE POPOVER, TASK TOOLTIP =====
function computeDateRange(): void {
  const hiddenOrders = new Set(
    BOARD_COLUMNS.map(function(c, i) { return c.hideFromSchedule ? i : null; }).filter(function(i) { return i !== null; })
  ) as Set<number>;
  let datedTasks: GanttTask[] = [];
  getVisibleJobs().concat(getLinkedReferenceJobs()).forEach(function(job) {
    getJobPhases(job).forEach(function(phase) {
      getPhaseSubUnits(phase).forEach(function(subUnit, subIdx) {
        (subUnit.tasks || []).forEach(function(task: GanttTask) {
          if (hiddenOrders.has(task.order as number)) return;
          if (!task.start || !task.finish) return;
          const s = new Date(task.start + 'T00:00:00');
          const f = new Date(task.finish + 'T00:00:00');
          if (isNaN(s.getTime()) || isNaN(f.getTime())) return;
          datedTasks.push(task);
        });
        // A due date can sit outside every task's date range — without this
        // the marker could fall off the edge of the chart entirely, with no
        // grid to scroll into. Only the FIRST sub-unit's row carries it.
        if (!job.isLinkedReference && subIdx === 0) {
          const dueTask = getJobDueMarkerTask(job, phase.id);
          if (dueTask) datedTasks.push(dueTask as GanttTask);
        }
      });
    });
  });
  // However the task dates work out, always leave room to scroll back at
  // least ARCHIVE_CUTOFF_DAYS — otherwise a project with nothing scheduled
  // that far back leaves no grid to scroll into.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const minPastDate = new Date(today);
  minPastDate.setDate(minPastDate.getDate() - ARCHIVE_CUTOFF_DAYS);

  if (datedTasks.length === 0) {
    // No dated tasks anywhere — give the chart a window around today.
    // Matches the +30 days buffer the dated-tasks branch below gets, so
    // every project behaves the same regardless of whether it has dates
    // set yet.
    startDate = new Date(minPastDate);
    endDate = new Date(today); endDate.setDate(today.getDate() + 30);
    return;
  }
  const starts = datedTasks.map(t => new Date(t.start + 'T00:00:00'));
  const finishes = datedTasks.map(t => new Date(t.finish + 'T00:00:00'));
  startDate = new Date(Math.min.apply(null, starts.map(d => d.getTime())));
  endDate = new Date(Math.max.apply(null, finishes.map(d => d.getTime())));
  startDate.setDate(startDate.getDate() - 3);
  endDate.setDate(endDate.getDate() + 30);
  if (startDate > minPastDate) startDate = minPastDate;
}

function showDatePopover(e: MouseEvent, date: Date): void {
  const popover = document.getElementById('datePopover')!;
  const dayJobs: { job: Job; task: GanttTask }[] = [];
  getVisibleJobs().forEach(job => {
    if (job.archived) return;
    if (getJobPhases(job).every((p) => isPhaseFinishedOnBoard(job, p.id))) return;
    (job.tasks || []).forEach((task: GanttTask) => {
      const s = new Date(task.start + 'T00:00:00');
      const f = new Date(task.finish + 'T00:00:00');
      if (date >= s && date <= f) dayJobs.push({ job: job, task: task });
    });
  });

  let html = '<h5>' + date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) + '</h5>';
  if (dayJobs.length === 0) {
    html += '<div class="dp-row"><span class="dp-label">No jobs</span></div>';
  } else {
    html += '<div class="dp-row"><span class="dp-label">Jobs:</span><span class="dp-value">' + dayJobs.length + '</span></div>';
    dayJobs.slice(0, 5).forEach(jt => {
      html += '<div class="dp-row" style="margin-top: var(--s-1);"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + jt.job.color + ';margin-right: var(--s-1-5);"></span>' + escapeHtml(jt.job.name) + '</div>';
    });
    if (dayJobs.length > 5) html += '<div class="dp-row" style="color:var(--text-light);font-size: var(--t-2xs);">+' + (dayJobs.length - 5) + ' more...</div>';
  }
  popover.innerHTML = html;
  popover.classList.add('show');

  const rect = (e.target as HTMLElement).getBoundingClientRect();
  const timelineBody = document.getElementById('timelineBody')!;
  const parentRect = timelineBody.getBoundingClientRect();
  let left = rect.left - parentRect.left + timelineBody.scrollLeft;
  let top = rect.bottom - parentRect.top + timelineBody.scrollTop + 4;
  popover.style.left = left + 'px';
  popover.style.top = top + 'px';
}

function hideDatePopover(): void {
  document.getElementById('datePopover')!.classList.remove('show');
}

function showTooltip(e: MouseEvent, job: Job, task: GanttTask): void {
  const tt = document.getElementById('tooltip')!;
  const s = new Date(task.start + 'T00:00:00');
  const f = new Date(task.finish + 'T00:00:00');
  const dur = getDaysDiff(s, f) + 1;
  let html = '<div class="tt-title">' + escapeHtml(job.name) + '</div>';
  // A job-span bar IS the job/phase, condensed — task.name is just that
  // name again there, so a "Task:" row repeating the title would be
  // redundant.
  if (!task.isJobSpan) {
    html += '<div class="tt-row"><span class="tt-label">Task:</span><span class="tt-value">' + escapeHtml(task.name) + '</span></div>';
  }
  html += '<div class="tt-row"><span class="tt-label">Start:</span><span class="tt-value">' + s.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) + '</span></div>';
  html += '<div class="tt-row"><span class="tt-label">Finish:</span><span class="tt-value">' + f.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) + '</span></div>';
  html += '<div class="tt-row"><span class="tt-label">Duration:</span><span class="tt-value">' + dur + ' day' + (dur>1?'s':'') + '</span></div>';
  if (task.notes) html += '<div class="tt-notes">' + escapeHtml(task.notes as string) + '</div>';
  tt.innerHTML = html;
  tt.classList.add('show');
  moveTooltip(e);
}

// ===== GANTT: VISIBLE-ROW BUILDER =====
// Pure data transformation — jobs/phases/tasks in, a flat list of rows to
// draw out. Was a cluster of nested closures inside renderGantt() itself
// with exactly one external call site (`visibleRows =
// buildVisibleTaskRows();`), confirmed by grepping renderGantt()'s whole
// body before moving anything.

interface GanttSegment {
  subPhaseId: string | null;
  subPhaseName: string | null;
  start: Date;
  finish: Date;
}

interface GanttRow {
  job: Job;
  task: GanttTask;
  phaseId: string | null;
  phaseName: string | null;
  subPhaseId: string | null;
  subPhaseName: string | null;
  collapsible: boolean;
  collapsedSegments?: GanttSegment[];
}

// Row order across the WHOLE board: earliest start date first, regardless
// of which job a task belongs to. Ties broken by job order then task's
// stored order so identical start dates stay stable/predictable.
function byStartDate(a: GanttTask, b: GanttTask): number {
  const aValid = !!(a.start && a.finish && !isNaN(new Date(a.start + 'T00:00:00').getTime()));
  const bValid = !!(b.start && b.finish && !isNaN(new Date(b.start + 'T00:00:00').getTime()));
  if (aValid && bValid) {
    const diff = new Date(a.start!).getTime() - new Date(b.start!).getTime();
    if (diff !== 0) return diff;
  } else if (aValid !== bValid) {
    // Dated tasks sort above undated ones, which fall to the bottom.
    return aValid ? -1 : 1;
  }
  return (a.order || 0) - (b.order || 0);
}

// Gathers one segment per dated sub-unit of a phase — the sub-unit's own
// min-start/max-finish across its tasks. Shared by both row builders
// below and by a single sub-phase's own condensed row.
function getPhaseSegments(phase: Phase, hiddenOrders: Set<number>): GanttSegment[] {
  const segments: GanttSegment[] = [];
  getPhaseSubUnits(phase).forEach((subUnit) => {
    const seg = buildSegment(subUnit, hiddenOrders);
    if (seg) segments.push(seg);
  });
  return segments;
}

function buildSegment(subUnit: SubPhase, hiddenOrders: Set<number>): GanttSegment | null {
  let minStart: Date | null = null;
  let maxFinish: Date | null = null;
  (subUnit.tasks || []).forEach((task) => {
    if (hiddenOrders.has(task.order)) return;
    if (!task.start || !task.finish) return;
    const s = new Date(task.start + 'T00:00:00');
    const f = new Date(task.finish + 'T00:00:00');
    if (isNaN(s.getTime()) || isNaN(f.getTime())) return;
    if (!minStart || s < minStart) minStart = s;
    if (!maxFinish || f > maxFinish) maxFinish = f;
  });
  if (!minStart || !maxFinish) return null;
  return { subPhaseId: subUnit.id, subPhaseName: subUnit.isDefault ? null : subUnit.name, start: minStart!, finish: maxFinish! };
}

// One row for a WHOLE phase — every one of its sub-units' tasks folded
// into a single span, with one solid segment per sub-unit drawn inside it
// (see the isJobSpan collapsed branch in renderGantt() itself). Only
// offered when the phase is actually split into 2+ real sub-phases.
function buildPhaseCollapsedRow(job: Job, phase: Phase, segments: GanttSegment[]): GanttRow {
  let overallStart: Date | null = null;
  let overallFinish: Date | null = null;
  segments.forEach((seg) => {
    if (!overallStart || seg.start < overallStart) overallStart = seg.start;
    if (!overallFinish || seg.finish > overallFinish) overallFinish = seg.finish;
  });
  const namePart = phase.isDefault ? '' : ' — ' + phase.name;
  const pseudoTask: GanttTask = {
    id: 'jobspan-collapsed|' + job.id + '|' + (phase.id || ''),
    name: job.name + namePart,
    start: toIsoDate(overallStart!),
    finish: toIsoDate(overallFinish!),
    notes: '',
    color: job.color,
    order: 0,
    isJobSpan: true,
  };
  return { job, task: pseudoTask, phaseId: phase.id, phaseName: phase.isDefault ? null : phase.name, subPhaseId: null, subPhaseName: null, collapsible: true, collapsedSegments: segments };
}

// One row for a SINGLE sub-unit — its own tasks folded into a single
// span. Used both for every sub-unit of an un-folded phase in Jobs/Leads
// view, and for a still-collapsed (i.e. not yet individually expanded)
// sub-phase in Tasks view (see tasksExpandedSubPhaseIds).
function buildSubPhaseRow(job: Job, phase: Phase, seg: GanttSegment): GanttRow {
  const namePart = (phase.isDefault ? '' : ' — ' + phase.name) + (seg.subPhaseName ? ' — ' + seg.subPhaseName : '');
  const pseudoTask: GanttTask = {
    id: 'jobspan|' + job.id + '|' + (phase.id || '') + '|' + (seg.subPhaseId || ''),
    name: job.name + namePart,
    start: toIsoDate(seg.start),
    finish: toIsoDate(seg.finish),
    notes: '',
    color: job.color,
    order: 0,
    isJobSpan: true,
  };
  const collapsible = !!(phase.subPhases && phase.subPhases.length > 1);
  return { job, task: pseudoTask, phaseId: phase.id, phaseName: phase.isDefault ? null : phase.name, subPhaseId: seg.subPhaseId, subPhaseName: seg.subPhaseName, collapsible };
}

// Tasks view: every phase/sub-phase starts CONDENSED by default —
// explicitly expanding one (see tasksExpandedPhaseIds/
// tasksExpandedSubPhaseIds above, toggleTasksPhaseExpanded()/
// toggleTasksSubPhaseExpanded() below) peels it open independently of
// every other phase/sub-phase.
function buildVisibleTaskRows(): GanttRow[] {
  const hiddenOrders = getHiddenTaskOrders();
  const rows: GanttRow[] = [];

  if (ganttFocusedTaskColumnId) {
    // See ganttFocusedTaskColumnId/setGanttTaskFocus() above — the other
    // axis from ganttFocusedJobId below: every job stays, but only the ONE
    // task matching this column. A totally separate pass rather than a
    // branch threaded through the one below — with a single task type
    // singled out there's no phase/sub-phase fold state left to respect
    // (tasksExpandedPhaseIds/tasksExpandedSubPhaseIds), so every phase and
    // sub-unit that has this task dated gets its own row regardless of its
    // own collapse state, instead of collapsing into a job-span pseudo-row.
    getVisibleJobs().concat(getLinkedReferenceJobs()).forEach((job) => {
      if (job.archived) return;
      getJobPhases(job).forEach((phase) => {
        if (isPhaseFinishedOnBoard(job, phase.id)) return;
        const phaseName = phase.isDefault ? null : phase.name;
        const collapsible = !!(phase.subPhases && phase.subPhases.length > 1);
        getPhaseSubUnits(phase).forEach((subUnit) => {
          const subPhaseName = subUnit.isDefault ? null : subUnit.name;
          const task = (subUnit.tasks || []).find((t) => t.columnId === ganttFocusedTaskColumnId);
          if (!task) return;
          if (hiddenOrders.has(task.order)) return;
          if (!task.start || !task.finish) return;
          if (isNaN(new Date(task.start + 'T00:00:00').getTime()) || isNaN(new Date(task.finish + 'T00:00:00').getTime())) return;
          rows.push({ job, task, phaseId: phase.id, phaseName, subPhaseId: subUnit.id, subPhaseName, collapsible });
        });
      });
    });
  } else {
    getVisibleJobs().concat(getLinkedReferenceJobs()).forEach((job) => {
      if (job.archived) return;
      // See ganttFocusedJobId/toggleGanttJobFocus() above — isolates the
      // chart to one job's rows when set, Tasks
      // view only. Whichever side of a linked pair is isolated, the other
      // side stays visible too — a job's .link.jobId only ever points at
      // its actual linked counterpart (linkJobs() always pairs across the
      // two fixed projects), so this can't accidentally match an unrelated
      // job.
      if (ganttFocusedJobId && job.id !== ganttFocusedJobId) {
        const isLinkedCounterpart = !!(job.link && job.link.jobId === ganttFocusedJobId);
        if (!isLinkedCounterpart) return;
      }
      getJobPhases(job).forEach((phase) => {
        if (isPhaseFinishedOnBoard(job, phase.id)) return;
        const phaseName = phase.isDefault ? null : phase.name;
        const collapsible = !!(phase.subPhases && phase.subPhases.length > 1);
        if (collapsible && !tasksExpandedPhaseIds.has(phase.id || '')) {
          const segments = getPhaseSegments(phase, hiddenOrders);
          if (segments.length) rows.push(buildPhaseCollapsedRow(job, phase, segments));
          return;
        }
        getPhaseSubUnits(phase).forEach((subUnit, subIdx) => {
          const subPhaseName = subUnit.isDefault ? null : subUnit.name;
          const subKey = getSubUnitKey(job, phase.id, subUnit.id);
          const subCollapsed = !tasksExpandedSubPhaseIds.has(subKey);
          if (subCollapsed) {
            const seg = buildSegment(subUnit, hiddenOrders);
            if (seg) rows.push(buildSubPhaseRow(job, phase, seg));
          } else {
            (subUnit.tasks || []).forEach((task) => {
              if (hiddenOrders.has(task.order)) return;
              // Unscheduled tasks (no start/finish yet) don't get a Gantt row
              // at all — they still exist on the job and in the Job Manager
              // grid, they just don't clutter the schedule until a date is set.
              if (!task.start || !task.finish) return;
              if (isNaN(new Date(task.start + 'T00:00:00').getTime()) || isNaN(new Date(task.finish + 'T00:00:00').getTime())) return;
              rows.push({ job, task, phaseId: phase.id, phaseName, subPhaseId: subUnit.id, subPhaseName, collapsible });
            });
          }
          // A linked reference job's due marker lives on a card in ITS OWN
          // project, not this one's boardCards — nothing to fetch here.
          // Sub-phases never have their own card either, so the due marker
          // only ever shows on the FIRST sub-unit's row — real or synthetic
          // default — never duplicated across every sub-phase. A COLLAPSED
          // first sub-unit already carries its own due marker inline (see
          // the isJobSpan branch in renderGantt()'s own draw loop, which
          // attaches the flag straight to the end of that sub-unit's own
          // condensed bar) — pushing a second, separate due-marker row here
          // on top of that would just duplicate it as an extra dropped-down
          // line.
          if (!job.isLinkedReference && subIdx === 0 && !subCollapsed) {
            const dueTask = getJobDueMarkerTask(job, phase.id);
            if (dueTask) rows.push({ job, task: dueTask, phaseId: phase.id, phaseName, subPhaseId: subUnit.id, subPhaseName, collapsible });
          }
        });
      });
    });
  }

  rows.sort((a, b) => byStartDate(a.task, b.task) || (((a.job.order as number | undefined) || 0) - ((b.job.order as number | undefined) || 0)));
  return rows;
}

// ===== GANTT: MAIN RENDER =====
// The 8 phases below are module-level functions (not closures nested
// inside renderGantt()) — each takes exactly what it needs as named
// parameters and returns exactly what it produces, instead of ~12 values
// shared implicitly through closure. renderGantt() itself is a thin
// pipeline that calls each once, in a fixed order, threading each
// phase's return value into the next call's arguments.

interface JobBarMapEntry {
  left: number;
  width: number;
  top: number;
  bar: HTMLElement;
  jobColor?: string;
}

interface SetupDateRangeAndGridResult {
  grid: HTMLElement;
  header: HTMLElement;
  leftBody: HTMLElement;
  // Five dedicated, purely structural sub-containers of `grid`, one per
  // concern that writes into it — see their own creation below for why.
  gridLinesLayer: HTMLElement;
  rowBgLayer: HTMLElement;
  todayLineLayer: HTMLElement;
  barsLayer: HTMLElement;
  connectorsLayer: HTMLElement;
  totalDays: number;
  containerH: number;
  gridWidth: number;
  savedScrollLeft: number;
  savedScrollTop: number;
}

interface GanttGridLayers {
  gridLinesLayer: HTMLElement;
  rowBgLayer: HTMLElement;
  todayLineLayer: HTMLElement;
  barsLayer: HTMLElement;
  connectorsLayer: HTMLElement;
}
let cachedGanttGridLayers: GanttGridLayers | null = null;

// Five dedicated, purely structural sub-containers of `grid`, one per
// concern that writes into it (grid-lines/today-bg from
// buildDateHeader(), the zebra-stripe row backgrounds from
// renderLeftPanelRows(), the today-line+label from drawTodayLine(), every
// bar/tick/marker from renderTimelineBars(), the connector SVG from
// drawConnectorLines()). A plain, unstyled div creates no new stacking
// context and isn't a `position` ancestor, so absolutely-positioned
// children inside these still resolve their left/top against `grid`
// itself exactly as if these wrapper divs weren't there, and every
// existing z-index still competes in that same shared stacking context
// across group boundaries — this changes nothing visible, only which
// specific element each function is handed to append into.
//
// Created ONCE and cached rather than fresh on every render — barsLayer
// is Preact-rendered (see renderTimelineBars()), and Preact needs the
// SAME container object across calls to diff against; a fresh
// document.createElement('div') every render would look like a brand-new,
// never-before-seen container each time, defeating node reuse entirely
// (this is exactly how #timelineHeader/#leftBody already behave, being
// static elements from index.html rather than dynamically created ones —
// see buildDateHeader()'s/renderLeftPanelRows()'s own comments). The
// `grid.contains()` guard re-creates them if `grid` itself was ever reset
// out from under this cache (defensive; `grid` is a static element from
// index.html today and never actually is).
function getOrCreateGanttGridLayers(grid: HTMLElement): GanttGridLayers {
  if (cachedGanttGridLayers && grid.contains(cachedGanttGridLayers.barsLayer)) {
    return cachedGanttGridLayers;
  }
  grid.innerHTML = '';
  const gridLinesLayer = document.createElement('div');
  const rowBgLayer = document.createElement('div');
  const todayLineLayer = document.createElement('div');
  const barsLayer = document.createElement('div');
  const connectorsLayer = document.createElement('div');
  grid.appendChild(gridLinesLayer);
  grid.appendChild(rowBgLayer);
  grid.appendChild(todayLineLayer);
  grid.appendChild(barsLayer);
  grid.appendChild(connectorsLayer);
  cachedGanttGridLayers = { gridLinesLayer, rowBgLayer, todayLineLayer, barsLayer, connectorsLayer };
  return cachedGanttGridLayers;
}

function setupDateRangeAndGrid(): SetupDateRangeAndGridResult {
  computeDateRange();
  let totalDays = getDaysDiff(startDate, endDate) + 1;
  const containerW = document.getElementById('timelineBody')!.clientWidth;
  const containerH = document.getElementById('timelineBody')!.clientHeight;
  // Zoomed far out, the date range can be narrower than the chart. Keep
  // adding days until the columns reach the right edge, so they don't
  // stop partway across. The grid itself stays the chart's width then (the
  // last day may be cut off), so this never adds a sideways scroll.
  const daysToFill = Math.ceil(containerW / dayWidth);
  const padded = totalDays < daysToFill;
  if (padded) {
    endDate.setDate(endDate.getDate() + (daysToFill - totalDays));
    totalDays = daysToFill;
  }
  const gridWidth = padded ? containerW : totalDays * dayWidth;
  const grid = document.getElementById('timelineGrid')!;
  const header = document.getElementById('timelineHeader')!;
  const leftBody = document.getElementById('leftBody')!;

  // timelineBody's own scrollLeft is the source of truth for horizontal
  // position now — the header is positioned via transform, driven from
  // it (see setHeaderScroll()), not independently scrolled itself.
  const savedScrollTb = document.getElementById('timelineBody');
  const savedScrollLeft = savedScrollTb ? savedScrollTb.scrollLeft : 0;
  const savedScrollTop = savedScrollTb ? savedScrollTb.scrollTop : 0;

  grid.style.width = gridWidth + 'px';
  header.style.width = gridWidth + 'px';
  // header's and leftBody's children are Preact-rendered now (see
  // buildDateHeader()/renderLeftPanelRows() below and
  // src/views/gantt-date-header.tsx/gantt-task-row.tsx) — NOT cleared
  // here on purpose, for both of them. Preact keeps its own internal
  // record of what it last rendered into a container; wiping that out
  // from outside leaves that record pointing at DOM nodes that no longer
  // exist, so the next render() call diffs against a stale tree and
  // silently produces nothing. Preact's own diffing replaces the previous
  // render's output on every call regardless — it doesn't need this reset
  // the way plain innerHTML-rebuilding code does.
  //
  // The same is now true of `grid` itself: barsLayer below is ALSO
  // Preact-rendered (see renderTimelineBars()/gantt-task-bar.tsx), so
  // `grid.innerHTML = ''` can no longer run unconditionally on every call
  // the way it used to — that would destroy and recreate barsLayer itself
  // every render, handing Preact a brand-new, never-before-seen container
  // each time with no prior tree to diff against, silently defeating node
  // reuse entirely (caught live: a bar's own DOM identity check came back
  // false after this refactor, wired up before Preact ever owned any of
  // `grid`'s content). All five sub-containers are now created ONCE and
  // cached across renders instead.
  const gridLayers = getOrCreateGanttGridLayers(grid);
  const { gridLinesLayer, rowBgLayer, todayLineLayer, barsLayer, connectorsLayer } = gridLayers;
  // gridLinesLayer/rowBgLayer/todayLineLayer are Preact-rendered now too
  // (see gantt-grid-decor.tsx) — same rule as barsLayer/header/leftBody
  // above: never innerHTML-cleared from outside. Only connectorsLayer
  // stays fully imperative; drawConnectorLines() manages its own content
  // by removing its previous SVG-by-id before creating a fresh one, which
  // needs no help here.

  return {
    grid, header, leftBody, gridLinesLayer, rowBgLayer, todayLineLayer, barsLayer, connectorsLayer,
    totalDays, containerH, gridWidth, savedScrollLeft, savedScrollTop,
  };
}

function buildDateHeader(totalDays: number, gridLinesLayer: HTMLElement, header: HTMLElement): Date {
  const cells = buildDateHeaderCells(startDate, totalDays, dayWidth);

  // The day/week header cells themselves are Preact-rendered (see
  // src/views/gantt-date-header.tsx's own comment on why #timelineHeader
  // specifically was safe to hand over first) — the background grid-lines
  // below are now ALSO Preact's, into their own dedicated sub-container of
  // #timelineGrid (see gantt-grid-decor.tsx and getOrCreateGanttGridLayers()'s
  // own comment on why each concern there gets one).
  renderDateHeaderInto(
    header,
    cells,
    (e, date) => showDatePopover(e, date),
    hideDatePopover,
    (weekLeft) => document.getElementById('timelineBody')!.scrollTo({ left: weekLeft - 20, behavior: 'smooth' })
  );

  renderGridLinesInto(gridLinesLayer, cells.days);

  return cells.today;
}

interface BuildRowModelResult {
  jobBarMap: Record<string, JobBarMapEntry[]>;
  visibleRows: GanttRow[];
  gridHeightPx: number;
}

function buildRowModel(containerH: number, grid: HTMLElement): BuildRowModelResult {
  const jobBarMap: Record<string, JobBarMapEntry[]> = {};
  const visibleRows = buildVisibleTaskRows();

  // .timeline-grid's own CSS only guarantees min-height:100% of its
  // scroll container — every child in here (row backgrounds aside) is
  // position:absolute, so they never grow that box themselves. Elements
  // anchored with top:0/bottom:0 to fill it (.grid-line day separators,
  // .today-line) were stopping at the viewport edge instead of reaching
  // the actual last task row when there were more rows than fit on
  // screen. Explicitly size the box to cover every row plus a few extra
  // rows of breathing room below the last task, falling back to at least
  // the viewport height so a short list still fills the visible area.
  const GANTT_EXTRA_ROWS_BELOW = 4;
  const gridHeightPx = Math.max(containerH, (visibleRows.length + GANTT_EXTRA_ROWS_BELOW) * GANTT_ROW_H);
  grid.style.height = gridHeightPx + 'px';

  return { jobBarMap, visibleRows, gridHeightPx };
}

// See this function's own visibleRowIdx — barVisibleIdx in
// renderTimelineBars() below MUST stay in lockstep with it for the same
// reason: both loops walk the identical visibleRows array,
// unconditionally, once — that's the only reason a left-panel row's
// Y-position and its timeline bar's Y-position (computed from two
// separately-incrementing counters) stay aligned. If either loop ever
// gains a mid-loop skip/continue, the other must get the same one.
// Merged Date column — one "Mar 3–7" string instead of separate Start/
// Finish columns. Drops the year unconditionally (unlike the old per-
// column format, which always showed it) since there's no room for it
// twice in one narrow column; the row's own title attribute and the task
// editor both still carry the full dates including year.
function formatMergedDateRange(startIso: string | undefined, finishIso: string | undefined, hasDates: boolean): string {
  if (!hasDates || !startIso || !finishIso) return '—';
  const s = new Date(startIso + 'T00:00:00'), f = new Date(finishIso + 'T00:00:00');
  const sMonth = formatDate(s, { month: 'short' });
  if (startIso === finishIso) return sMonth + ' ' + s.getDate();
  const fMonth = formatDate(f, { month: 'short' });
  if (sMonth === fMonth && s.getFullYear() === f.getFullYear()) return sMonth + ' ' + s.getDate() + '–' + f.getDate();
  return sMonth + ' ' + s.getDate() + ' – ' + fMonth + ' ' + f.getDate();
}

// The new Task column's answer for a folded/merged row, which spans many
// real tasks at once: which one is "current" right now. Priority — a task
// whose start..finish window covers today; else the soonest upcoming one;
// else the most recently finished one; else just the first dated task —
// so the column always shows *something* rather than sitting blank. ISO
// date strings compare correctly as plain strings, no Date parsing needed.
function findCurrentTask(tasks: Task[]): Task | null {
  const dated = tasks.filter((t) => t.start && t.finish && !isNaN(new Date(t.start + 'T00:00:00').getTime()) && !isNaN(new Date(t.finish + 'T00:00:00').getTime()));
  if (!dated.length) return null;
  const todayIso = toIsoDate(new Date());
  const covering = dated.filter((t) => t.start! <= todayIso && todayIso <= t.finish!);
  if (covering.length) return covering.slice().sort((a, b) => (a.order || 0) - (b.order || 0))[0];
  const upcoming = dated.filter((t) => t.start! > todayIso).sort((a, b) => (a.start! < b.start! ? -1 : a.start! > b.start! ? 1 : 0));
  if (upcoming.length) return upcoming[0];
  const past = dated.filter((t) => t.finish! < todayIso).sort((a, b) => (a.finish! > b.finish! ? -1 : a.finish! < b.finish! ? 1 : 0));
  if (past.length) return past[0];
  return dated[0];
}

// All the real tasks a folded/merged row's date-range summarizes — every
// task in the phase (phaseMerged row) or just the one sub-phase
// (subMerged row) — for findCurrentTask() above to pick from. Walks the
// job's real phase/sub-phase structure via getJobPhases()/
// getPhaseSubUnits() rather than trusting the pseudo-row's own fields,
// since a merged row's `task` is a synthetic span, not a real task.
function getTasksForMergedRow(job: Job, phaseId: string | null | undefined, subPhaseId: string | null | undefined, wholePhase: boolean): Task[] {
  const phase = getJobPhases(job).find((p) => (p.id || null) === (phaseId || null));
  if (!phase) return [];
  if (wholePhase) return getPhaseSubUnits(phase).reduce((acc: Task[], su) => acc.concat(su.tasks || []), []);
  const subUnit = getPhaseSubUnits(phase).find((su) => (su.id || null) === (subPhaseId || null));
  return subUnit ? (subUnit.tasks || []) : [];
}

// Which task a folded/merged row's job is actually in right now: the task
// matching its board card's current column, which (unlike findCurrentTask()'s
// date-only guess) also covers a card sitting in a hideFromSchedule board
// (Bid/Invoiced-style — no dates, no Gantt bar, but still the job's real
// stage). Null when there's no card here (a linked reference job's card
// lives in its own project) or no task matches the column, so the caller
// falls back to findCurrentTask().
function findTaskForCardColumn(job: Job, phaseId: string | null | undefined, tasks: Task[]): Task | null {
  if (job.isLinkedReference) return null;
  const card = getPhaseCard(job, phaseId);
  if (!card || !card.column) return null;
  return tasks.find((t) => t.columnId === card.column) || null;
}

// A task pill's colors. A real task mirrors its Board column, so its pill
// is that column exactly as the Board shows it: the same fill and the same
// title color (boardColumnColors() — Karl, 2026-09-30: not a softened
// version). Due markers and colorless tasks get a soft chip of the job's
// color instead (softChip()).
function taskPillColors(task: { [key: string]: any }, jobColor: string): { background: string; color: string | undefined } {
  const own = task.color as string | undefined;
  if (own && !task.isDueMarker) { const cc = boardColumnColors(own); return { background: cc.background, color: cc.title }; }
  return softChip(own || jobColor);
}

function renderLeftPanelRows(visibleRows: GanttRow[], rowBgLayer: HTMLElement, gridWidth: number, leftBody: HTMLElement, gridHeightPx: number): void {
  const rowProps: TaskRowProps[] = [];
  // Zebra-stripe backgrounds — Preact-rendered too now (see
  // gantt-grid-decor.tsx), but deliberately keyed by POSITION there, not
  // by the row's own identity the way the row/bar above it are: this is
  // pure decoration, full page width, a full 40px row tall, and solidly
  // opaque, so if it were reused/animated by row identity a multi-row
  // reorder would show two of these bands sliding across the same
  // stretch of screen at once — an obvious gray "ghost" bar (a real,
  // reported bug — see tests/gantt-rowbg-no-ghost.spec.js). A positional
  // key means each slot just gets restyled in place, never moved.
  const rowBgEntries: RowBgEntry[] = [];
  let visibleRowIdx = 0;
  visibleRows.forEach(function (entry) {
    const job = entry.job, task = entry.task, phaseId = entry.phaseId, phaseName = entry.phaseName, subPhaseId = entry.subPhaseId, subPhaseName = entry.subPhaseName;
    const rowKey = ganttRowKey(job.id, task.id, phaseId, subPhaseId);

    rowBgEntries.push({ top: visibleRowIdx * GANTT_ROW_H });

    const hasDates = !!(task.start && task.finish && !isNaN(new Date(task.start + 'T00:00:00').getTime()) && !isNaN(new Date(task.finish + 'T00:00:00').getTime()));
    const dateStr = formatMergedDateRange(task.start, task.finish, hasDates);

    // The main label is always the job's own name now, on every row
    // regardless of fold state — a stable anchor since rows from
    // different jobs interleave by date (Tasks view sorts purely by
    // start date, not grouped by job/phase). Clicking it isolates the
    // Gantt to just this job (see ganttFocusedJobId/toggleGanttJobFocus()
    // above) — same feature the old separate job pill used to carry.
    const isTasksMode = ganttViewMode === 'tasks';
    const linkGlyph = job.isLinkedReference ? '🔗 ' : '';
    const mainLabel = linkGlyph + job.name + (job.isLinkedReference ? ' (' + (job.linkedFromProjectName || '') + ')' : '');
    const mainLabelColors = rowLabelColors(job.color || '#999');
    const isFocusedJob = isTasksMode && ganttFocusedJobId === job.id;

    // Clicking a real (non-job-span, non-due-marker) task's own name
    // isolates the Gantt to just that BOARD_COLUMNS stage across every
    // job — see ganttFocusedTaskColumnId/toggleGanttTaskFocus() above. A
    // job-span/due-marker task never carries a columnId (see GanttTask's
    // own comment), so this only ever lights up on a real leaf task row.
    const isFocusableTask = isTasksMode && !task.isJobSpan && !task.isDueMarker && !!task.columnId;
    const isTaskFocused = isFocusableTask && ganttFocusedTaskColumnId === task.columnId;

    const pills: TaskRowPillProps[] = [];
    let taskPill: TaskRowPillProps | null = null;

    if (isTasksMode) {
      const jobColor = job.color || '#999';
      const jobLabelColors = mainLabelColors;
      // The Task column, between Date and Job: a pill for a real leaf
      // row's own task (clickable — same board-column-focus feature as
      // above). On a folded/merged row there's no single task anymore, so
      // it points at whichever one is "current" right now instead — see
      // findCurrentTask()'s own comment for the priority order — still
      // clickable, isolating by THAT task's own board-column stage.
      // Colored by the task's OWN color (softened, same treatment a
      // regular task bar's fill already gets — see the 'plain' entries
      // push below), falling back to the job's color only when the task
      // has none of its own — unlike every other pill here, which is
      // always the job's color, since this one identifies a task, not a
      // fold level.
      if (!task.isJobSpan) {
        const focusTitle = isFocusableTask ? (isTaskFocused ? 'Click to show every task again' : 'Click to show only ' + task.name + '\'s column — every job') : task.name;
        taskPill = {
          label: (task.isDueMarker ? '🚩 ' : '') + task.name,
          title: focusTitle,
          ...taskPillColors(task, jobColor),
          focused: isTaskFocused,
          onClick: isFocusableTask ? (e) => { e.stopPropagation(); toggleGanttTaskFocus(task.columnId as string); } : undefined,
        };
      } else {
        const wholePhase = !!(task.isJobSpan && entry.collapsedSegments);
        const mergedTasks = getTasksForMergedRow(job, phaseId, subPhaseId, wholePhase);
        const current = findTaskForCardColumn(job, phaseId, mergedTasks) || findCurrentTask(mergedTasks);
        if (current && current.columnId) {
          const currentFocused = isTasksMode && ganttFocusedTaskColumnId === current.columnId;
          // A task whose board is hidden from the schedule never gets a
          // Gantt row, so isolating by it would just empty the chart —
          // still shown as the current task, just not clickable.
          const currentHidden = BOARD_COLUMNS.some((c) => c.id === current.columnId && c.hideFromSchedule);
          taskPill = {
            label: current.name,
            title: currentHidden
              ? current.name + ' — currently in progress (hidden from the schedule)'
              : (currentFocused ? 'Click to show every task again' : 'Click to show only ' + current.name + '\'s column — every job') + ' — currently in progress',
            ...taskPillColors(current, jobColor),
            focused: currentFocused,
            onClick: currentHidden ? undefined : (e) => { e.stopPropagation(); toggleGanttTaskFocus(current.columnId as string); },
          };
        } else if (current) {
          // A real task, but not tied to any BOARD_COLUMNS stage — show
          // it, just not clickable (nothing for toggleGanttTaskFocus() to
          // isolate by).
          taskPill = { label: current.name, title: current.name, ...taskPillColors(current, jobColor) };
        }
      }
      // Only offered when the phase actually has 2+ real sub-phases —
      // folds/unfolds just THIS phase (tasksExpandedPhaseIds), independent
      // of the sub-phase pill below. phaseName !== null (rather than just
      // truthy) so an unnamed-but-real phase still gets this pill; null
      // specifically means "no real phase here at all" (the synthetic
      // default from getJobPhases()).
      if (entry.collapsible && phaseName !== null) {
        const phaseFolded = !tasksExpandedPhaseIds.has(phaseId || '');
        pills.push({
          chevron: phaseFolded ? '▸' : '▾',
          label: phaseName || '',
          title: phaseFolded ? 'Click to expand sub-phases' : 'Click to collapse sub-phases into one bar',
          colorLight: jobLabelColors.light,
          colorDark: jobLabelColors.dark,
          onClick: (e) => { e.stopPropagation(); if (e.altKey) bulkFoldFromRow(phaseFolded); else toggleTasksPhaseExpanded(phaseId); },
        });
      }
      // Not shown on a whole-phase-collapsed row (task.isJobSpan with
      // collapsedSegments) — that row already stands for every sub-phase
      // at once, so there's no single sub-phase context left to fold.
      if (!(task.isJobSpan && entry.collapsedSegments)) {
        const subKey = getSubUnitKey(job, phaseId, subPhaseId);
        const subFolded = !tasksExpandedSubPhaseIds.has(subKey);
        const subLabel = subPhaseName || (entry.collapsible ? '' : phaseName) || '';
        pills.push({
          chevron: subFolded ? '▸' : '▾',
          label: subLabel,
          title: (subFolded ? 'Click to expand into individual tasks' : 'Click to collapse into a single bar') + (subLabel ? ' — ' + subLabel : ''),
          colorLight: jobLabelColors.light,
          colorDark: jobLabelColors.dark,
          onClick: (e) => { e.stopPropagation(); if (e.altKey) bulkFoldFromRow(subFolded); else toggleTasksSubPhaseExpanded(subKey); },
        });
      }
    } else {
      // Jobs/Leads view: unreachable today (ganttViewMode is a constant
      // 'tasks' — see its own comment above) but kept working rather than
      // deleted, same reasoning as that comment's. Mapped onto the same
      // `pills` array Tasks view now uses (still just the one pill here).
      const collapseGlyph = entry.collapsible ? (collapsedPhaseIds.has(phaseId || '') ? '▸ ' : '▾ ') : '';
      pills.push({
        label: collapseGlyph + job.name + (job.isLinkedReference ? ' (' + (job.linkedFromProjectName || '') + ')' : ''),
        title: entry.collapsible ? (collapsedPhaseIds.has(phaseId || '') ? 'Click to expand sub-phases' : 'Click to collapse sub-phases into one bar') : '',
        background: job.color || '#999',
        color: '#fff',
        onClick: entry.collapsible ? (e) => { e.stopPropagation(); togglePhaseCollapse(phaseId); } : undefined,
      });
    }

    const title = (job.isLinkedReference ? 'Linked from ' + job.linkedFromProjectName + ' — read-only, click to open there — ' : '') + job.name + (phaseName ? ' — ' + phaseName : '') + (subPhaseName ? ' — ' + subPhaseName : '');
    const openRow = () => { if (job.isLinkedReference) jumpToLinkedJobReference(job); else editJob(job.id, phaseId, subPhaseId); };

    // Same flat (unpadded) alignment as `bg` above — see its own comment
    // on why this needs its own suffixed key rather than the plain
    // `rowKey` the timeline side uses.
    rowProps.push({
      rowKey: rowKey + '::flat',
      jobId: job.id,
      taskId: task.id || '',
      className: 'task-row' + (task.isDueMarker ? ' due-marker-row' : '') + (job.archived ? ' archived' : '') + (isTaskFinished(job, task) ? ' finished' : '') + (job.isLinkedReference ? ' linked-ref' : ''),
      title,
      dateStr,
      taskPill,
      mainLabel,
      mainLabelColorLight: mainLabelColors.light,
      mainLabelColorDark: mainLabelColors.dark,
      mainLabelClickable: isTasksMode,
      mainLabelFocused: isFocusedJob,
      onMainLabelClick: isTasksMode ? () => toggleGanttJobFocus(job.id) : undefined,
      hasNote: !!task.notes,
      pills,
      onOpen: openRow,
    });

    visibleRowIdx++;
  });

  // leftBody's own scrollable height is just its stacked .task-row
  // children (visibleRows.length * GANTT_ROW_H) — shorter than
  // .timeline-grid's height (gridHeightPx, above), which pads in
  // GANTT_EXTRA_ROWS_BELOW of empty space below the last row. Without
  // matching that here, leftBody hits its own scroll limit first while
  // timelineBody (synced 1:1 by scrollTop, see setupScrollSync()) can
  // keep going those extra rows further — the two panels desync and
  // job rows stop lining up with their Gantt bars. A trailing spacer
  // the same size as that padding keeps both panels' max scrollTop
  // identical — rendered as the last item in the Preact tree below
  // rather than appended imperatively after it, since Preact owns every
  // child of #leftBody now (see renderTaskRowsInto()'s own comment).
  const spacerHeight = Math.max(0, gridHeightPx - visibleRows.length * GANTT_ROW_H);
  renderTaskRowsInto(leftBody, rowProps, spacerHeight, GANTT_ROW_H);
  // The row lines carry on below the last job to the bottom of the grid,
  // matching the left panel's filler rows. Whole rows only: a partial one
  // would stick out past the grid and lengthen the scroll.
  for (let i = visibleRows.length; (i + 1) * GANTT_ROW_H <= gridHeightPx; i++) rowBgEntries.push({ top: i * GANTT_ROW_H });
  renderRowBgInto(rowBgLayer, rowBgEntries, gridWidth);
}

function drawTodayLine(todayLineLayer: HTMLElement, today: Date, totalDays: number): void {
  const todayIdx = getDaysDiff(startDate, today);
  const data: TodayLineData | null = (todayIdx >= 0 && todayIdx < totalDays) ? {
    left: todayIdx * dayWidth + dayWidth / 2,
    label: 'Today — ' + today.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  } : null;
  renderTodayLineInto(todayLineLayer, data);
}

// See renderLeftPanelRows()'s comment on visibleRowIdx — barVisibleIdx
// here must stay in exact lockstep with it for the same reason.
//
// Mutates the jobBarMap parameter in place (pushes an entry per job) —
// this is the one phase whose real output isn't a return value.
// buildRowModel() creates it, this function fills it, and
// drawConnectorLines() below reads the same object afterward.
//
// Shared with renderLeftPanelRows() below — both build their own separate
// DOM for the exact same logical row (one in #timelineGrid, one in
// #leftBody), so animateReorderedBars() needs the identical key from both
// sides to recognize them as the same row and move them together.
function ganttRowKey(jobId: string, taskId: string | undefined, phaseId: string | null | undefined, subPhaseId: string | null | undefined): string {
  return jobId + '::' + (taskId || '') + '::' + (phaseId || '') + '::' + (subPhaseId || '');
}

function renderTimelineBars(visibleRows: GanttRow[], barsLayer: HTMLElement, jobBarMap: Record<string, JobBarMapEntry[]>): void {
  // Builds one big props array (mirroring the original imperative build
  // exactly — same variable names/math/comments where they still apply)
  // and hands it to Preact in a single renderTimelineBarsInto() call. See
  // gantt-task-bar.tsx's own header comment for why this container (and
  // ALL its live-drag/reorder-animation interactions) is safe to convert
  // wholesale: both existing systems match elements by CSS class + data-*
  // attributes (never DOM node identity), and no render — Preact or
  // otherwise — ever runs while a drag/resize gesture is in progress
  // (isBusyEditing() in src/sync/connection.ts), so Preact's diff never
  // has a chance to fight a gesture's direct style.left/width mutations.
  const entries: TaskBarEntryProps[] = [];
  let barVisibleIdx = 0;
  visibleRows.forEach(function (entry) {
    const job = entry.job, task = entry.task, phaseId = entry.phaseId, phaseName = entry.phaseName, subPhaseId = entry.subPhaseId, subPhaseName = entry.subPhaseName;
    const phaseLabel = subPhaseName ? (subPhaseName + (phaseName ? ' (' + phaseName + ')' : '')) : phaseName;
    const hasDates = !!(task.start && task.finish);
    const s = hasDates ? new Date(task.start + 'T00:00:00') : null;
    const f = hasDates ? new Date(task.finish + 'T00:00:00') : null;
    const validDates = hasDates && s && f && !isNaN(s.getTime()) && !isNaN(f.getTime());

    // Tasks without dates still occupy a row (drawn above in the left
    // panel) but get no bar in the timeline grid — nothing to position.
    if (validDates && s && f) {
      const startIdx = getDaysDiff(startDate, s);
      const duration = getDaysDiff(s, f) + 1;
      // Screen-reader name for the bar (A5) — the visible name tag is a
      // separate element, so the focusable bar itself was otherwise nameless.
      const fmtDay = (d: Date) => formatDate(d, { month: 'short', day: 'numeric' });
      const barAriaLabel = [job.name, phaseLabel, task.isJobSpan ? null : task.name].filter(Boolean).join(', ') +
        ': ' + fmtDay(s) + (duration > 1 ? ' to ' + fmtDay(f) : '') + (job.isLinkedReference ? ' (linked from another project, read-only)' : '');
      // Stable identity across a re-render (Preact reuses a node whose
      // `key` matches — see gantt-task-row.tsx's own note on why that's
      // safe here too) so animateReorderedBars() can tell "this is the
      // same row, just moved" from "this is a different row that happens
      // to land at the same top" — see its own comment for why that
      // distinction matters. Applied to EVERY element this row draws, not
      // just `bar` itself — a job-span row's actual VISIBLE content (the
      // border outline, the job-name label, the due marker, the day-by-day
      // segments below) are all separate elements layered over `bar`,
      // which is left transparent and only exists as a fallback drag/click
      // target (see its own comment) — AND renderLeftPanelRows() builds
      // its own separate .task-row for this exact same row in the sidebar,
      // which needs the identical key (see ganttRowKey()) so it animates
      // in step too, instead of snapping while the timeline side glides
      // (Karl's own report: "phases moving independently of the individual
      // job bars").
      const rowKey = ganttRowKey(job.id, task.id, phaseId, subPhaseId);
      const left = startIdx * dayWidth;
      const width = duration * dayWidth;
      const top = barVisibleIdx * GANTT_ROW_H + GANTT_BAR_PAD;

      // Captured at mount/update time (fires synchronously during
      // Preact's own render() call, always before any later user
      // interaction) so the plain-bar branch's resize handles — which
      // listen on their OWN element, a child of `bar` — can still target
      // `bar` itself via startBarResizeLeft/Right, exactly like the old
      // `bar` closure variable did. jobBarMap needs the same node for
      // drawConnectorLines()/redrawConnectorLinesLive() to measure at any
      // time, not just mid-gesture, so it's populated here too.
      let barNode: HTMLDivElement | null = null;
      const barRef = (el: HTMLDivElement | null) => {
        barNode = el;
        if (!el) return;
        if (!jobBarMap[job.id]) jobBarMap[job.id] = [];
        jobBarMap[job.id].push({ left, width, top, bar: el, jobColor: job.color });
      };

      if (task.isJobSpan) {
        // Tasks view shows the phase/sub-phase fold toggles as their own
        // separate tags (see buildPhaseSubTagsData() below) instead of
        // folding them into this job tag, so the job tag itself is a pure
        // label there — matches the left-panel pill split (see
        // renderGantt()'s sidebar loop above).
        const isTasksMode = ganttViewMode === 'tasks';
        const isFocusedJob = isTasksMode && ganttFocusedJobId === job.id;
        const barCollapseGlyph = !isTasksMode && entry.collapsible ? (collapsedPhaseIds.has(phaseId || '') ? '▸ ' : '▾ ') : '';
        // The on-bar name tag gets the same click-to-focus (Tasks view) or
        // collapse toggle (Jobs/Leads view) as the left-panel pill — its
        // onClick (see BarTag in gantt-task-bar.tsx) wires the
        // stopPropagation + 'collapsible' class together so it toggles
        // instead of also starting a whole-bar drag or falling through to
        // editJob.
        const jobTag: BarTagData = {
          label: (job.isLinkedReference ? '🔗 ' : '') + barCollapseGlyph + job.name + (!isTasksMode && phaseLabel ? ' — ' + phaseLabel : ''),
          title: (isTasksMode ? (isFocusedJob ? 'Click to show every job again — ' : 'Click to show only this job — ') : (entry.collapsible ? (collapsedPhaseIds.has(phaseId || '') ? 'Click to expand sub-phases — ' : 'Click to collapse sub-phases into one bar — ') : '')) +
            job.name + (phaseName ? ' — ' + phaseName : '') + (subPhaseName ? ' — ' + subPhaseName : ''),
          color: barTagTextColor(job.color || '#999'),
          focused: isFocusedJob,
          onClick: isTasksMode ? (() => toggleGanttJobFocus(job.id)) : (entry.collapsible ? (() => togglePhaseCollapse(phaseId)) : undefined),
        };
        const subTags: BarTagData[] = isTasksMode
          ? buildPhaseSubTagsData(job, phaseId, phaseName, subPhaseId, subPhaseName, entry.collapsible, !!entry.collapsedSegments)
          : [];

        // Due date marker: its own little flagged circle (same look as a
        // Tasks-view due-marker bar), connected back to the condensed span
        // by a line in the bar's own color — unless the span's own finish
        // already reaches the due date, in which case there's nothing to
        // bridge and the circle just sits on top of the bar instead (see
        // the z-index on .job-span-due-marker). Deliberately left out of
        // the whole-job-move drag-along list (unlike the ticks/segments) —
        // moving the scheduled tasks doesn't move the deadline itself,
        // only re-render() catching up on drop should change how far apart
        // they are. It's independently draggable on its own via
        // startBarMove()'s existing DUE_MARKER_TASK_ID handling, same as
        // the Tasks-view due marker. Only drawn on the FIRST sub-unit's bar
        // (there's no per-sub-phase card to carry a second due date) — same
        // gating as flattenJobs()/buildVisibleTaskRows().
        // phaseId is always the row's real phase — even when collapsed, the
        // collapsed row still belongs to one specific phase (unlike the
        // sub-phases it folds together). A collapsed row's own subPhaseId
        // is null (it stands for all of them at once), which the due
        // marker treats the same as "the first sub-unit" since the card —
        // and its due date — is per-phase either way.
        const parentPhaseForDue = getJobPhases(job).find(function (p) { return (p.id || null) === (phaseId || null); });
        const isFirstSubUnit = entry.collapsedSegments ? true : (!parentPhaseForDue || (getPhaseSubUnits(parentPhaseForDue)[0].id || null) === (subPhaseId || null));
        const dueTask = isFirstSubUnit ? getJobDueMarkerTask(job, phaseId) : null;
        let due: JobSpanDueData | undefined;
        if (dueTask && dueTask.start) {
          const dueDate = new Date(dueTask.start + 'T00:00:00');
          const dueIdx = getDaysDiff(startDate, dueDate);
          const barEndIdx = startIdx + duration - 1;
          const dueLeft = dueIdx * dayWidth;
          const markerColor = (task.color as string | undefined) || '#e53935';

          let lineLeft: number | null = null, lineWidth = 0;
          if (dueIdx > barEndIdx) {
            lineLeft = (barEndIdx + 1) * dayWidth;
            lineWidth = dueLeft - lineLeft;
          } else if (dueIdx < startIdx) {
            lineLeft = dueLeft + 18;
            lineWidth = (startIdx * dayWidth) - lineLeft;
          }

          // Read-only, same as the span's own bar/border above — a linked
          // reference job's real data lives in its home project, so this
          // must jump there (like the bar) instead of calling editJob()
          // straight against job.id, which belongs to the OTHER project's
          // jobs array and would just silently no-op here. No mousedown/
          // startBarMove wiring either — dragging isn't offered for a
          // linked reference's bar, so its due marker shouldn't be
          // draggable on its own either.
          due = {
            left: dueLeft, top,
            background: markerColor,
            title: dueTask.name + ': ' + formatDate(dueDate, { month: 'short', day: 'numeric', year: 'numeric' }),
            onMouseEnter: (e: MouseEvent) => showTooltip(e, job, dueTask),
            onMouseLeave: hideTooltip,
            onMouseMove: moveTooltip,
            onMouseDown: job.isLinkedReference ? undefined : ((e: MouseEvent) => startBarMove(e, job.id, DUE_MARKER_TASK_ID, e.currentTarget as HTMLElement, false, phaseId)),
            onClick: job.isLinkedReference
              ? (() => jumpToLinkedJobReference(job))
              : ((e: MouseEvent | KeyboardEvent) => {
                  const el = e.currentTarget as HTMLElement;
                  if (el.dataset.dragged === 'true') { el.dataset.dragged = 'false'; return; }
                  editJob(job.id, phaseId);
                }),
            line: (lineLeft !== null && lineWidth > 0)
              ? { left: lineLeft, width: lineWidth, top: (barVisibleIdx * GANTT_ROW_H + Math.round(GANTT_ROW_H / 2) - 1), background: markerColor }
              : undefined,
          };
        }

        // Jobs/Leads view: the condensed bar is one solid span, but the
        // real tasks inside it usually run back-to-back rather than as a
        // single block. Walk it day by day and group consecutive days that
        // have the exact same set of covering tasks into one segment: a
        // day covered by one task is drawn solid in that task's own color
        // and is individually grabbable to move just that task (leaving
        // the rest of the job alone), a day covered by two or more
        // overlapping tasks gets a hard hatch alternating between their
        // colors (click-through to the whole-job drag, since there's no
        // single task to target), and a day covered by none is left blank.
        // Ticks still mark each task's finish date (except the last, which
        // already coincides with the bar's own right edge) so phase
        // boundaries stay visible even between two same-colored/adjacent
        // tasks.
        // Skipped entirely for a linked reference — there's no single task
        // to individually grab/resize on a read-only bar, so the day-by-day
        // breakdown below (only useful for picking out one draggable task
        // segment from another) has nothing to offer; the plain outline+
        // label built above is enough.
        const ticks: JobSpanTickData[] = [];
        const segments: JobSpanSegmentData[] = [];
        if (!job.isLinkedReference) {
          // A collapsed row (see collapsedPhaseIds/buildPhaseCollapsedRow)
          // still belongs to one specific phase — phaseId stays the row's
          // real phase either way — it just has no single sub-unit to read
          // tasks from (it spans every sub-phase of that phase). Build one
          // synthetic "task" per sub-phase segment instead, each covering
          // that sub-phase's own date range in the job's own color
          // (per-task coloring doesn't generalize once the same task types
          // repeat across sub-phases). Everything below (ticks, solid/hash/
          // hatch grouping) is identical either way; only which list feeds
          // it, and how a solid segment's drag/click is wired, differs.
          const isCollapsedRow = !!entry.collapsedSegments;
          const jobEndIdx = startIdx + duration - 1;
          let datedTasks: { t: GanttTask; sIdx: number; eIdx: number }[];
          if (isCollapsedRow && entry.collapsedSegments) {
            datedTasks = entry.collapsedSegments.map(function (seg) {
              return {
                t: {
                  id: 'subphaseseg|' + (seg.subPhaseId || ''),
                  name: seg.subPhaseName || '', color: job.color, notes: '',
                  start: toIsoDate(seg.start), finish: toIsoDate(seg.finish),
                  subPhaseId: seg.subPhaseId,
                },
                sIdx: getDaysDiff(startDate, seg.start), eIdx: getDaysDiff(startDate, seg.finish),
              };
            });
          } else {
            const spanPhase = getJobPhases(job).find(function (p) { return (p.id || null) === (phaseId || null); });
            const spanUnit = spanPhase && getPhaseSubUnits(spanPhase).find(function (s) { return (s.id || null) === (subPhaseId || null); });
            datedTasks = ((spanUnit && spanUnit.tasks) || []).map(function (t) {
              if (!t.start || !t.finish) return null;
              const ts = new Date(t.start + 'T00:00:00'), tf = new Date(t.finish + 'T00:00:00');
              if (isNaN(ts.getTime()) || isNaN(tf.getTime())) return null;
              return { t: t, sIdx: getDaysDiff(startDate, ts), eIdx: getDaysDiff(startDate, tf) };
            }).filter((x): x is { t: Task; sIdx: number; eIdx: number } => x !== null);
          }

          const seenIdx: Record<number, boolean> = {};
          datedTasks.forEach(function (dt) {
            if (dt.eIdx >= jobEndIdx || seenIdx[dt.eIdx]) return;
            seenIdx[dt.eIdx] = true;
            const tickLeft = (dt.eIdx + 1) * dayWidth;
            // A sub-phase boundary (collapsed row) has no single task to
            // resize — moving it would mean shifting every task in that
            // sub-phase, which is what dragging the solid segment itself
            // already does. Static divider only; a real task's tick still
            // resizes as before.
            ticks.push({
              domKey: rowKey + '::tick::' + dt.t.id,
              jobId: job.id, phaseId: phaseId || '',
              subPhaseId: isCollapsedRow ? ((dt.t.subPhaseId as string | undefined) || '') : (subPhaseId || ''),
              taskId: dt.t.id!, rowKey, origLeft: tickLeft, left: tickLeft, top,
              title: isCollapsedRow ? (dt.t.name + ' ends') : (dt.t.name + ' — drag to change finish date'),
              cursorDefault: isCollapsedRow,
              onMouseDown: isCollapsedRow ? undefined : ((e: MouseEvent) => startTickResize(e, job.id, dt.t.id!, e.currentTarget as HTMLElement)),
            });
          });

          // Keyed by task id (not color) so two different same-colored
          // tasks never get merged into one segment — each solid segment
          // needs to map to exactly one real task to be individually
          // draggable.
          const dayTasks: { t: GanttTask; sIdx: number; eIdx: number }[][] = [];
          for (let i = 0; i < duration; i++) dayTasks.push([]);
          datedTasks.forEach(function (dt) {
            for (let d = Math.max(dt.sIdx, startIdx); d <= Math.min(dt.eIdx, jobEndIdx); d++) {
              dayTasks[d - startIdx].push(dt);
            }
          });

          let di = 0;
          while (di < duration) {
            const covering = dayTasks[di];
            const key = covering.map(function (dt) { return dt.t.id; }).sort().join('|');
            let dj = di;
            while (dj + 1 < duration && dayTasks[dj + 1].map(function (dt) { return dt.t.id; }).sort().join('|') === key) dj++;
            const segLeft = (startIdx + di) * dayWidth;
            const segWidth = (dj - di + 1) * dayWidth;

            if (covering.length === 0) {
              segments.push({
                domKey: rowKey + '::hash::' + segLeft, kind: 'hash',
                jobId: job.id, phaseId: phaseId || '', subPhaseId: isCollapsedRow ? '' : (subPhaseId || ''),
                rowKey, origLeft: segLeft, left: segLeft, width: segWidth, top,
                title: 'No task scheduled here',
              });
            } else if (covering.length === 1) {
              // Unambiguously one task's (or, collapsed, one sub-phase's)
              // own stretch — grabbable to move just that task/sub-phase,
              // same as an individual bar in Tasks view. Overlap (below)
              // stays click-through since there's no single one to target
              // there; it falls through to the whole-job drag on `bar`.
              const dt = covering[0];
              segments.push({
                domKey: rowKey + '::solid::' + segLeft, kind: 'solid',
                jobId: job.id, phaseId: phaseId || '',
                subPhaseId: isCollapsedRow ? ((dt.t.subPhaseId as string | undefined) || '') : (subPhaseId || ''),
                rowKey, origLeft: segLeft, left: segLeft, width: segWidth, top,
                fullLeft: dt.sIdx * dayWidth, fullWidth: (dt.eIdx - dt.sIdx + 1) * dayWidth,
                title: dt.t.name,
                background: ganttPastel((dt.t.color as string | undefined) || job.color || '#3949ab'),
                onMouseEnter: (e: MouseEvent) => showTooltip(e, job, dt.t),
                onMouseLeave: hideTooltip,
                onMouseMove: moveTooltip,
                onMouseDown: isCollapsedRow
                  ? ((e: MouseEvent) => startBarMove(e, job.id, dt.t.id!, e.currentTarget as HTMLElement, true, phaseId, dt.t.subPhaseId as string | null))
                  : ((e: MouseEvent) => startBarMove(e, job.id, dt.t.id!, e.currentTarget as HTMLElement)),
                onOpen: (e: MouseEvent | KeyboardEvent) => {
                  const el = e.currentTarget as HTMLElement;
                  if (el.dataset.dragged === 'true') { el.dataset.dragged = 'false'; return; }
                  if (isCollapsedRow) editJob(job.id, phaseId, dt.t.subPhaseId as string | null);
                  else editJob(job.id, phaseId, subPhaseId);
                },
              });
            } else {
              let background: string, title: string;
              if (isCollapsedRow) {
                // Every sub-phase segment already shares the same job
                // color, so a normal same-color-dedup hatch would render
                // as a flat fill indistinguishable from a solid segment.
                // Alternate the job color with a darker shade of itself
                // instead, so an overlap still reads as a hatch.
                const base = ganttPastel(job.color || '#3949ab');
                const dark = ganttPastel(job.color || '#3949ab', true);
                background = 'repeating-linear-gradient(45deg, ' + base + ' 0px, ' + base + ' 6px, ' + dark + ' 6px, ' + dark + ' 12px)';
                title = 'Overlapping sub-phases: ' + covering.map(function (dt) { return dt.t.name; }).join(', ');
              } else {
                const uniqColors = Array.from(new Set(covering.map(function (dt) { return ganttPastel((dt.t.color as string | undefined) || job.color || '#3949ab'); })));
                const stripe = 6;
                const stops: string[] = [];
                uniqColors.forEach(function (c, idx) {
                  stops.push(c + ' ' + (idx * stripe) + 'px');
                  stops.push(c + ' ' + ((idx + 1) * stripe) + 'px');
                });
                background = 'repeating-linear-gradient(45deg, ' + stops.join(', ') + ')';
                title = 'Overlapping tasks';
              }
              segments.push({
                domKey: rowKey + '::hatch::' + segLeft, kind: 'hatch',
                jobId: job.id, phaseId: phaseId || '', subPhaseId: isCollapsedRow ? '' : (subPhaseId || ''),
                rowKey, origLeft: segLeft, left: segLeft, width: segWidth, top,
                title, background,
              });
            }
            di = dj + 1;
          }
        }

        entries.push({
          kind: 'jobspan',
          ariaLabel: barAriaLabel,
          rowKey, jobId: job.id, phaseId: phaseId || '', subPhaseId: subPhaseId || '',
          linkedRef: !!job.isLinkedReference,
          finished: isTaskFinished(job, task),
          milestone: duration === 1,
          left, width, top,
          labelWrap: { jobTag, subTags },
          borderColor: job.color || '#3949ab',
          due,
          // Condensed 'jobs'/'leads' bar: left transparent — a solid fill
          // here would otherwise show through in gap stretches, which are
          // meant to look empty. `bar` itself stays in the DOM purely so a
          // grab anywhere that isn't one of the individually-colored task
          // segments (i.e. a gap, or an overlap hatch) still moves the
          // whole job — all the color comes from the outline and the
          // individual day-segments above. Dragging it moves every one of
          // the sub-unit's real tasks by the same number of days (see the
          // isJobSpan branch in onBarMoveEnd), keeping the whole schedule
          // connected. No resize handles — there's no single task to
          // stretch.
          onOpen: (e: MouseEvent | KeyboardEvent) => {
            const el = e.currentTarget as HTMLElement;
            if (el.dataset.dragged === 'true') { el.dataset.dragged = 'false'; return; }
            if (job.isLinkedReference) jumpToLinkedJobReference(job); else editJob(job.id, phaseId, subPhaseId);
          },
          onMouseEnter: (e: MouseEvent) => showTooltip(e, job, task),
          onMouseLeave: hideTooltip,
          onMouseMove: moveTooltip,
          onMouseDown: job.isLinkedReference ? undefined : ((e: MouseEvent) => startBarMove(e, job.id, task.id!, e.currentTarget as HTMLElement, true, phaseId, subPhaseId)),
          barRef,
          ticks, segments,
        });
      } else {
        // Same job-color outline as a condensed Jobs/Leads bar, so which
        // job a task belongs to is visible at a glance without needing the
        // job-name tag below. Due markers keep their own white/red ring
        // instead — that's a distinct "this is a due date" signal, not a
        // job identity one. Left at full saturation (unsoftened) so it
        // still reads as a crisp edge against the softened fill.
        const isTasksMode = ganttViewMode === 'tasks';
        const isFocusedJob = isTasksMode && ganttFocusedJobId === job.id;
        let jobTag: BarTagData | undefined;
        let subTags: BarTagData[] | undefined;
        if (duration !== 1) {
          // Tasks view: clicking it isolates the Gantt to just this job
          // (see ganttFocusedJobId/toggleGanttJobFocus()) — Jobs/Leads
          // view's phase/sub-phase fold toggles are separate tags appended
          // below instead, matching the left-panel pill split.
          jobTag = {
            label: (job.isLinkedReference ? '🔗 ' : '') + job.name + (!isTasksMode && phaseLabel ? ' — ' + phaseLabel : ''),
            title: (isTasksMode ? (isFocusedJob ? 'Click to show every job again — ' : 'Click to show only this job — ') : '') + job.name + (phaseName ? ' — ' + phaseName : '') + (subPhaseName ? ' — ' + subPhaseName : ''),
            color: barTagTextColor(job.color || '#999'),
            focused: isFocusedJob,
            onClick: isTasksMode ? (() => toggleGanttJobFocus(job.id)) : undefined,
          };
          if (isTasksMode) subTags = buildPhaseSubTagsData(job, phaseId, phaseName, subPhaseId, subPhaseName, entry.collapsible, false);
        }

        // Read-only: a linked reference job's bar is never draggable/
        // resizable — its real data lives in, and can only be edited from,
        // its home project (see the "Interactivity" decision in the plan).
        // A due date is a single point in time, not a range — only "move"
        // makes sense, so it gets no resize handles.
        entries.push({
          kind: 'plain',
          ariaLabel: barAriaLabel,
          rowKey,
          className: 'task-bar' + (isTaskFinished(job, task) ? ' finished' : '') + (task.isDueMarker ? ' due-marker-bar' : '') + (duration === 1 ? ' milestone' : '') + (job.isLinkedReference ? ' linked-ref' : ''),
          left, width, top,
          background: task.isDueMarker ? undefined : ganttPastel((task.color as string | undefined) || job.color),
          border: task.isDueMarker ? undefined : ('2px solid ' + (job.color || '#3949ab')),
          isFlag: !!task.isDueMarker,
          jobTag, subTags,
          onMouseEnter: (e: MouseEvent) => showTooltip(e, job, task),
          onMouseLeave: hideTooltip,
          onMouseMove: moveTooltip,
          onOpen: (e: MouseEvent | KeyboardEvent) => {
            const el = e.currentTarget as HTMLElement;
            if (el.dataset.dragged === 'true') { el.dataset.dragged = 'false'; return; }
            if (job.isLinkedReference) jumpToLinkedJobReference(job); else editJob(job.id, phaseId, subPhaseId);
          },
          onMouseDown: job.isLinkedReference ? undefined : ((e: MouseEvent) => startBarMove(e, job.id, task.id!, e.currentTarget as HTMLElement)),
          resizeHandles: (!job.isLinkedReference && !task.isDueMarker) ? {
            onLeftDown: (e: MouseEvent) => startBarResizeLeft(e, job.id, task.id!, barNode!),
            onRightDown: (e: MouseEvent) => startBarResizeRight(e, job.id, task.id!, barNode!),
          } : undefined,
          barRef,
        });
      }
    }

    barVisibleIdx++;
  });

  renderTimelineBarsInto(barsLayer, entries);
}

// Given a stable id and removed-then-recreated on every call (rather than
// just appended) so redrawConnectorLinesLive() below can call this
// repeatedly on a rAF loop while bars are still animating, without
// stacking a fresh SVG on top of the last one every frame. The normal
// (non-animating) render path already gets this for free from
// setupDateRangeAndGrid()'s own grid.innerHTML wipe — this only matters
// for redraws that happen BETWEEN full renders.
const GANTT_CONNECTOR_SVG_ID = 'ganttConnectorSvg';
// Pure geometry — shared between the normal (full) draw below and
// redrawConnectorLinesLive()'s per-frame path-only updates, so the elbow-
// routing logic only exists in one place.
function computeConnectorPathD(a: JobBarMapEntry, b: JobBarMapEntry): string {
  const x1 = a.left + a.width;
  const y1 = a.top + GANTT_BAR_H / 2;
  const x2 = b.left;
  const y2 = b.top + GANTT_BAR_H / 2;
  if (x2 >= x1) {
    // Normal case: successor starts at/after predecessor ends — the
    // gap between the bars is empty, so a simple mid-point elbow is fine.
    const midX = (x1 + x2) / 2;
    return 'M ' + x1 + ' ' + y1 + ' L ' + midX + ' ' + y1 + ' L ' + midX + ' ' + y2 + ' L ' + x2 + ' ' + y2;
  }
  // Overlap case: successor starts before predecessor ends, so a
  // straight-through elbow would cut across one or both bars. Route it
  // out to the right of the predecessor, through the empty gap between
  // the rows, then down/up into the left of the successor.
  const laneY = Math.min(a.top, b.top) + GANTT_BAR_H + GANTT_BAR_PAD + 3;
  const rightX = x1 + 10;
  const leftX = x2 - 10;
  return 'M ' + x1 + ' ' + y1 + ' L ' + rightX + ' ' + y1 + ' L ' + rightX + ' ' + laneY + ' L ' + leftX + ' ' + laneY + ' L ' + leftX + ' ' + y2 + ' L ' + x2 + ' ' + y2;
}

function drawConnectorLines(gridWidth: number, jobBarMap: Record<string, JobBarMapEntry[]>, connectorsLayer: HTMLElement): void {
  const existing = document.getElementById(GANTT_CONNECTOR_SVG_ID);
  if (existing) existing.remove();
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('id', GANTT_CONNECTOR_SVG_ID);
  svg.setAttribute('style', 'position:absolute;top:0;left:0;width:' + gridWidth + 'px;height:100%;pointer-events:none;z-index:30;overflow:visible;');
  Object.keys(jobBarMap).forEach(function (jobId) {
    const bars = jobBarMap[jobId];
    if (bars.length < 2) return;
    for (let i = 0; i < bars.length - 1; i++) {
      const a = bars[i], b = bars[i + 1];
      const path = document.createElementNS(svgNs, 'path');
      // Identifies this exact pair so redrawConnectorLinesLive() can find
      // and update just its `d`, without touching (or recreating) any
      // other path — see that function's own comment on why per-frame DOM
      // node churn here specifically was worth avoiding.
      path.setAttribute('data-job-id', jobId);
      path.setAttribute('data-pair-index', String(i));
      path.setAttribute('d', computeConnectorPathD(a, b));
      path.setAttribute('stroke', a.jobColor || '#3949ab');
      path.setAttribute('stroke-width', '2');
      path.setAttribute('fill', 'none');
      svg.appendChild(path);
    }
  });
  connectorsLayer.appendChild(svg);
}

// CSS's `ease-out` keyword is cubic-bezier(0, 0, 0.58, 1). An earlier
// version of this approximated it with the standard "ease-out cubic"
// (1 - (1-t)^3) as close enough by eye for a thin connector line — but
// that curve is NOT the same shape as the real one applied to the bars
// (see GANTT_REORDER_MS's own transition string): by roughly 40% through
// the animation the two disagree by several real pixels. That only became
// visible as a jump when an overlapping render's own connector loop takes
// over (see redrawConnectorLinesLive()'s own comment on why that happens
// on a busy real project) — the new loop's very first frame seeds from a
// freshly-measured true bar position, while the old loop's last frame was
// this approximation's own drifted value, so the switch itself reads as a
// visible snap even though each loop's own motion was smooth on its own.
// Solving the actual bezier removes the drift instead of just tolerating
// it. x1=y1=0 and x3=y3=1 always hold for CSS timing functions, so only
// x2/y2 vary per curve; Newton-Raphson (falling back to nothing fancier
// since this curve has no vertical tangents) converges in a couple of
// iterations for any progress value.
function makeCubicBezierEase(x2: number, y2: number): (p: number) => number {
  function bezierComponent(t: number, c2: number): number {
    // c1 (the first control point) is always 0 for both x and y here.
    const c = 3 * c2;
    const b = 3 * (1 - c2) - c;
    const a = 1 - b - c;
    return ((a * t + b) * t + c) * t;
  }
  function bezierSlope(t: number, c2: number): number {
    const c = 3 * c2;
    const b = 3 * (1 - c2) - c;
    const a = 1 - b - c;
    return (3 * a * t + 2 * b) * t + c;
  }
  return function (p: number): number {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    let t = p;
    for (let i = 0; i < 8; i++) {
      const x = bezierComponent(t, x2) - p;
      const slope = bezierSlope(t, x2);
      if (Math.abs(slope) < 1e-6) break;
      t -= x / slope;
    }
    return bezierComponent(t, y2);
  };
}
const easeOutCubic = makeCubicBezierEase(0.58, 1);

// The line(s) connecting a multi-phase job's separate bars into one
// visible "whole project" run (Karl's own description) are drawn ONCE per
// render, from each bar's FINAL rest position — reasonable when nothing's
// moving, but when a reorder animation is playing, those bars slide
// smoothly while this connector just sat at its post-render position the
// entire time, reading as the job's own bars fully snapping ahead of it/
// behind it rather than the connector tracking them.
//
// Deliberately does NOT measure anything from the DOM — an earlier version
// read each bar's real getBoundingClientRect() every frame, which (even
// after a later fix stopped it from also recreating DOM nodes every
// frame) still forced the browser to synchronously resolve the bar's
// CURRENT transform-animated position back onto the main thread on every
// single call. transform is normally cheap specifically because the
// browser can run it entirely on the compositor thread without any main-
// thread involvement per frame; reading layout geometry off an element
// mid-transform defeats that, and repeating it 60 times a second is
// exactly the kind of thing that reads as uneven, "lurching" motion on a
// real device (Karl's own report, persisting after the DOM-churn fix
// alone). Computing each bar's position analytically — its already-known
// start top, its already-known final top (jobBarMap's own `top`), and
// how far through GANTT_REORDER_MS this frame is — needs no DOM reads at
// all beyond the one-time `dataset.rowKey` lookup.
// Reads each bar's live position from barAnimOrigins (see its own comment)
// instead of a progress value passed in by the caller — both this and the
// bars themselves now derive their per-frame position from that one
// shared, persisted-across-renders source of truth, so they can never
// drift out of sync with each other (Karl's own report, both on the bars
// vs. task bars moving separately and on the connector not tracking its
// own job's phases) regardless of how many overlapping renders land while
// this is playing. `now` is the caller's own tick()'s single shared
// per-frame timestamp (see its own comment) rather than a fresh
// performance.now() call here — this always runs after that frame's own
// bar-position loop, so calling it again here would already be a little
// later than what the bars themselves just used.
function redrawConnectorLinesLive(jobBarMap: Record<string, JobBarMapEntry[]>, liveJobIds: Set<string>, gridTop: number, now: number): void {
  const svg = document.getElementById(GANTT_CONNECTOR_SVG_ID);
  if (!svg) return;
  liveJobIds.forEach(function (jobId) {
    const bars = jobBarMap[jobId];
    if (!bars || bars.length < 2) return;
    function liveEntry(entry: JobBarMapEntry): JobBarMapEntry {
      const key = entry.bar.dataset.rowKey;
      const origin = key !== undefined ? barAnimOrigins[key] : undefined;
      if (!origin) return entry;
      const fromTop = origin.fromTop - gridTop;
      const progress = Math.min(1, (now - origin.startTime) / GANTT_REORDER_MS);
      const top = fromTop + (entry.top - fromTop) * easeOutCubic(progress);
      return { left: entry.left, width: entry.width, top: top, bar: entry.bar, jobColor: entry.jobColor };
    }
    for (let i = 0; i < bars.length - 1; i++) {
      const path = svg.querySelector<SVGPathElement>('path[data-job-id="' + jobId + '"][data-pair-index="' + i + '"]');
      if (!path) continue;
      path.setAttribute('d', computeConnectorPathD(liveEntry(bars[i]), liveEntry(bars[i + 1])));
    }
  });
}

function restoreScrollPosition(savedScrollTop: number, savedScrollLeft: number): void {
  requestAnimationFrame(() => {
    const tb = document.getElementById('timelineBody');
    // renderAll() calls renderGantt() unconditionally on load/refresh even
    // when Home (or any other tab) is what's actually showing — Gantt's
    // own panel is display:none then, so tb.clientWidth is 0 and
    // scrollToToday() below would silently compute against zero width and
    // effectively no-op. Only consume ganttFirstRender once the panel is
    // genuinely visible, so the real first scroll-to-today happens the
    // first time a user actually switches to the Gantt tab, not whenever
    // it happens to render invisibly first.
    if (ganttFirstRender && tb && tb.clientWidth > 0) {
      ganttFirstRender = false;
      tb.scrollTop = savedScrollTop;
      scrollToToday();
      setHeaderScroll(tb.scrollLeft);
    } else {
      if (tb) tb.scrollLeft = savedScrollLeft;
      setHeaderScroll(savedScrollLeft);
      if (tb) tb.scrollTop = savedScrollTop;
    }
    setupScrollSync();
  });
}

// Captures every row-tagged element's current position, keyed by the same
// stable dataset.rowKey renderTimelineBars() writes on `bar` AND every
// other element sharing its row (labelWrap/borderOverlay/dueEl/dueLine/
// tick/hash/solid/hatch — see rowKey's own comment for why all of them
// need this, not just `bar`), BEFORE setupDateRangeAndGrid()'s
// grid.innerHTML reset wipes them — there's no "old" DOM element to read a
// position back off of once that's run, since every one of them is a
// brand-new document.createElement() on every render, not an existing one
// being moved. Not scoped to any one class — any element carrying
// data-row-key gets the same treatment uniformly.
//
// Deliberately getBoundingClientRect().top, NOT el.style.top: a bar mid-
// reorder-animation already has its FINAL row's `top` set (only its
// `transform` is what's still animating away from it — see
// animateReorderedBars()), so el.style.top reads as the destination, not
// where it visually is right now. That distinction is exactly what broke
// this the first time it shipped: this app's own sync layer broadcasts a
// confirmation snapshot back to the very client that made a change (see
// room-do.ts's broadcastSnapshot() — it doesn't exclude the sender), which
// often lands well inside this animation's ~1s window and forces a second
// render on top of the first. Reading el.style.top there would see
// oldTop === newTop (both already the destination) and conclude nothing
// moved, so the freshly rebuilt bar would just appear at rest with no
// transform at all — silently truncating the animation after a fraction
// of a second, which read as "it barely animated"/"nothing happened"
// (Karl's own report). getBoundingClientRect() reflects the bar's TRUE
// current on-screen position, transform included, so a render that
// interrupts an in-flight one still computes a real, correct delta and
// continues the motion smoothly instead of snapping.
// #timelineGrid (the bars) and #leftBody (renderLeftPanelRows()'s own
// separate .task-row/.row-bg for the exact same rows, in a completely
// different container) both need every row-keyed element gathered
// together — otherwise the sidebar just snaps while the timeline glides,
// which is exactly what read as "phases moving independently of the
// individual job bars" (Karl's own report).
function allRowKeyedElements(): HTMLElement[] {
  const grid = document.getElementById('timelineGrid');
  const leftBody = document.getElementById('leftBody');
  const out: HTMLElement[] = [];
  if (grid) grid.querySelectorAll<HTMLElement>('[data-row-key]').forEach(function (el) { out.push(el); });
  if (leftBody) leftBody.querySelectorAll<HTMLElement>('[data-row-key]').forEach(function (el) { out.push(el); });
  return out;
}

function captureBarTopsByRowKey(): Record<string, number> {
  const tops: Record<string, number> = {};
  allRowKeyedElements().forEach(function (el) {
    const key = el.dataset.rowKey as string;
    tops[key] = el.getBoundingClientRect().top;
  });
  return tops;
}

// Called once the rebuild above has finished — every bar now sits at its
// FINAL row position. For any bar whose row key existed before AND whose
// top actually changed (a job/task reordering past another, per date
// changes, an expand/collapse, etc.), fake a "before" frame by offsetting
// it back to its old position via transform (cheap, GPU-only, doesn't
// re-trigger layout the way animating `top` itself would), then let it
// transition to transform:none — i.e. its real new position. A bar with
// no prior entry (brand new, or the very first render of this session,
// when oldTops is empty) just appears at its final spot, unanimated, same
// as before this existed.
// Single source of truth for how long a reorder move takes — read by both
// the transition set on each element below AND redrawConnectorLinesLive()'s
// own tracking loop, so the connector lines linking a multi-phase job's
// separate bars ("the full project bar", per Karl's own description) keep
// pace with the bars for exactly as long as they're actually moving,
// instead of one hardcoded number living in CSS and a second one here that
// could quietly drift apart. Went .9s -> 1.3s -> 1.8s on direct feedback
// that it read as too fast to track — then back down partway once every
// element was ACTUALLY animating for its full stated duration instead of
// being cut short by the various bugs fixed along the way (the interrupted-
// echo snap, the untagged sidebar, the connector not tracking): once
// nothing was silently truncating it anymore, 1.8s of real, uninterrupted
// motion read as noticeably slower than what 1.8s had ever actually looked
// like before.
const GANTT_REORDER_MS = 1100;

// A live, busy, multi-user project renders far more often than any small
// test scenario ever does (Karl's own account: "a lot — many jobs, many
// tasks" — this app's own sync layer broadcasts a confirmation snapshot
// back to the client that made a change, and every OTHER connected
// teammate's own edits do the same — see room-do.ts's broadcastSnapshot()
// and captureBarTopsByRowKey()'s own comment on why the sender gets one
// too). Each render's own animateReorderedBars() call starts an
// independent trackConnectors() loop below, and unlike the bar elements
// themselves (torn down and rebuilt fresh by every render, so an older
// render's loop writing to a stale, already-detached element is a
// harmless no-op), the connector's own <path> elements are deliberately
// PERSISTENT across renders now (see redrawConnectorLinesLive()'s own
// comment on why) — meaning if two renders' loops are ever both still
// running at once, they both keep writing to the SAME live elements,
// each computing its own progress from its own start time, with whichever
// one's requestAnimationFrame callback happens to fire last in a given
// frame "winning" that frame. That's exactly what reads as smooth motion
// interrupted by small backward jumps, repeating (Karl's own description)
// — an older, stale loop's already-passed progress overwriting a newer
// loop's further-along one, back and forth, for as long as both keep
// running. Only ever letting the MOST RECENT render's loop actually write
// anything fixes it outright.
let ganttReorderGeneration = 0;

// Persists ACROSS renders, keyed by rowKey — deliberately not reset inside
// animateReorderedBars() itself. A row already mid-flight from an earlier,
// still-running render (the overlap this app's own sync echoes make
// routine on a busy real project — see captureBarTopsByRowKey()'s own
// comment) keeps its ORIGINAL fromTop/startTime here instead of a newer
// render restarting them. An earlier version drove this motion with a
// plain CSS `transition`, which has no way to "resume" a curve already in
// progress — retriggering one mid-flight always restarts its FULL
// duration from whatever position it's currently at, so a nearly-arrived
// bar would suddenly crawl its last few pixels out over another whole
// GANTT_REORDER_MS instead of just finishing. That read as a stutter right
// at the handoff — the bars' own version of the connector's "jumps back a
// little" (Karl's own report, persisting after the connector's own
// version of this exact class of bug was fixed by tracking it
// analytically instead of measuring/retriggering every frame). Storing
// the ORIGINAL start here and computing each frame's transform from it
// directly (see the shared rAF loop below) means an overlapping render
// only ever updates WHERE the bar is headed, never WHEN its motion began,
// so the same one deceleration curve runs start to finish regardless of
// how many renders land while it's playing.
const barAnimOrigins: Record<string, { fromTop: number; startTime: number; zIndexOffset: number }> = {};

// Whether any row currently has a live reorder animation in flight — the
// signal other files need to know it's unsafe (expensive + collision-
// prone, not incorrect — see animateReorderedBars()'s own comment on why
// an overlapping render is handled correctly, just not cheaply) to call
// renderGantt() again right now. Age-filtered rather than a bare
// Object.keys(barAnimOrigins).length check: an entry can outlive its own
// animation (e.g. its row vanishes from a later render entirely — job
// deleted, phase collapsed, focus-isolated — before Pass 1 or tick() ever
// gets a chance to clean it up), which would otherwise report "animating"
// forever until some unrelated render happened to sweep it.
function isGanttReorderAnimating(): boolean {
  const now = performance.now();
  return Object.keys(barAnimOrigins).some(function (key) {
    return now - barAnimOrigins[key].startTime < GANTT_REORDER_MS;
  });
}

// Every piece of a job-span row (border/name-tag/ticks/day-segments) has
// its OWN fixed baseline z-index in CSS specifically so the row reads
// correctly internally — the name tag (70) always over the day-segments
// (64), the outline (80) always over the tag, etc. (see each rule's own
// spot in index.html). ganttReorderZIndexOffset's own comment covers WHY
// an animating row needs to out-rank another one it's crossing; giving
// every element the exact SAME flat number to do that (this function's
// first version) threw away that internal ordering too — with both rows'
// elements collapsed to one shared value, whichever one's day-segments
// happened to be later in the DOM painted over BOTH rows' name tags,
// including its own (Karl's own screenshot: a row's tag hidden behind its
// own segments, not just the other row's). This preserves each element's
// own rank by reading its declared baseline here (by class, not
// getComputedStyle — the element can be genuinely :hover-ed right when a
// drag ends, which would read back its transient hover z-index instead of
// its real resting one) and only ADDING the per-row offset on top, so
// "tag over segments over nothing" still holds inside each row while the
// two rows crossing still separate cleanly from each other.
function ganttRowStackBaseZ(el: HTMLElement): number {
  const cl = el.classList;
  if (cl.contains('job-span-due-marker')) return 82;
  if (cl.contains('job-span-border')) return 80;
  if (cl.contains('job-span-name-wrap')) return 70;
  if (cl.contains('job-span-task-tick')) return 65;
  if (cl.contains('job-span-task-solid') || cl.contains('job-span-task-hatch') || cl.contains('job-span-gap-hash')) return 64;
  if (cl.contains('job-span-due-line')) return 63;
  return 0; // .task-bar itself, and #leftBody's .task-row — no CSS z-index of their own.
}

// Assigns each row's OWN z-index OFFSET once, the same moment its
// barAnimOrigins entry is created — never recomputed from DOM/paint order
// on a later, overlapping render of the same in-flight transition (see
// barAnimOrigins' own comment on why fromTop/startTime already work this
// way). Two rows swapping places are each 26px tall sliding across a 40px
// gap, so for a real stretch of the animation they're both occupying the
// same on-screen band at once — which of them paints on top during that
// overlap otherwise falls to plain DOM/paint order, which Preact is free
// to rebuild differently on a second render of the identical transition
// (this app's own sync layer echoes every change back to its sender,
// routinely landing a confirming re-render mid-animation — see
// captureBarTopsByRowKey()'s own comment). That let the two rows visibly
// swap which one was drawn in front partway through a single crossing,
// then swap back a frame later — read as "the bars are switching places,
// then switching back" (Karl's own description, confirmed against real
// screenshots of the actual production drag) even though neither row's
// own position ever reversed.
// Each slot is spaced 100 apart — comfortably more than
// ganttRowStackBaseZ()'s own 0–82 spread — so two DIFFERENT rows' offset
// bands can never interleave with each other regardless of which pieces
// of each row happen to be animating, while still preserving each row's
// own internal ordering (base 0 through 82) within its own band. Cycles
// through a small fixed number of slots rather than growing forever, so
// even a long, busy session's worth of reorders stays well clear of the
// unrelated fixed z-indices this app uses further up the stack (the
// tooltip at 1000, toasts at 2000, modals at 3000): the small number of
// rows ever crossing at the EXACT same instant only ever needs a few
// slots' worth of separation, not one forever-unique value per row.
const GANTT_REORDER_ZINDEX_SLOTS = 8;
let ganttReorderZIndexSlot = 0;
function ganttNextReorderZIndexOffset(): number {
  const offset = 200 + (ganttReorderZIndexSlot % GANTT_REORDER_ZINDEX_SLOTS) * 100;
  ganttReorderZIndexSlot++;
  return offset;
}

function animateReorderedBars(oldTops: Record<string, number>, jobBarMap: Record<string, JobBarMapEntry[]>, gridWidth: number, connectorsLayer: HTMLElement): void {
  // Bumped UNCONDITIONALLY, before either early return below — every
  // render calls drawConnectorLines() once as part of its own normal flow
  // (see renderGantt()), drawing a fresh, correct, static connector from
  // THIS render's own data, regardless of whether THIS render happens to
  // need a new animation of its own. An older render's still-running
  // trackConnectors loop has to be told to stop right here, even when
  // (especially when) this particular render has nothing new to animate —
  // otherwise that fresh, correct state drawn a moment ago just gets
  // immediately overwritten by the older loop's own stale, further-along
  // progress on its very next frame. Bumping this only when toAnimate
  // turned out non-empty (this function's own first version) missed
  // exactly that case: a render that confirms already-final data (this
  // app's sync layer echoes every change back to its own sender — see
  // captureBarTopsByRowKey()'s own comment) needs no animation of its own,
  // but still has to cancel whichever older loop is still running.
  ganttReorderGeneration++;

  if (!Object.keys(oldTops).length) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const now = performance.now();

  // Drop any origin whose animation has already fully finished, so a much
  // later, unrelated move of the very same row starts a genuinely fresh
  // deceleration instead of being treated as a continuation of one that
  // ended long ago — and so this map doesn't just grow for the rest of the
  // session.
  Object.keys(barAnimOrigins).forEach(function (k) {
    if (now - barAnimOrigins[k].startTime >= GANTT_REORDER_MS) delete barAnimOrigins[k];
  });

  // Pass 1 — READ ONLY. A row can draw many elements sharing one row key
  // (every day-segment/tick in a job-span row, easily a dozen-plus for a
  // month-long sub-unit — see rowKey's own comment), and a cascaded drag
  // (cascadeShiftLaterTasks()) can reorder several DIFFERENT rows in the
  // same render on top of that. Collect every element that actually needs
  // to animate here (across both #timelineGrid and #leftBody — see
  // allRowKeyedElements()'s own comment), without writing anything yet.
  const toAnimate: { el: HTMLElement; key: string; delta: number }[] = [];
  // A row's "still moving enough to animate" call must be made ONCE per
  // key, not once per element sharing it — the elements sharing one rowKey
  // are separately measured (their own getBoundingClientRect(), not a
  // shared value), and sub-pixel rendering differences between e.g. a
  // day-segment and its row's job-name tag can put one of them on either
  // side of the < 1 threshold below even though they belong to the same
  // logical move. Deciding per element used to let a later element for a
  // key ALREADY pushed into toAnimate by an earlier one delete that same
  // key's shared barAnimOrigins entry out from under it — the write pass
  // just below then dereferences a key that's already gone, and even short
  // of an outright crash, different pieces of one row could end up
  // animating from inconsistent origins. Deciding once per key and
  // recording it here — 'bail' (with its cleanup) or 'continue' (with its
  // origin, reused for every element under that key) — keeps the whole
  // row's pieces acting as one unit either way.
  const keyDecisions: Record<string, { bail: boolean; origin?: { fromTop: number; startTime: number; zIndexOffset: number } }> = {};
  allRowKeyedElements().forEach(function (el) {
    const key = el.dataset.rowKey as string;
    const oldTop = oldTops[key];
    if (oldTop === undefined) return;
    let decision = keyDecisions[key];
    if (!decision) {
      // Freshly (re)created by the rebuild above, no transform applied yet
      // — this is its real resting position, directly comparable to
      // captureBarTopsByRowKey()'s own getBoundingClientRect()-based
      // measurement (same coordinate space, viewport-relative).
      const newTop = el.getBoundingClientRect().top;
      const origin = barAnimOrigins[key] || { fromTop: oldTop, startTime: now, zIndexOffset: ganttNextReorderZIndexOffset() };
      const delta = origin.fromTop - newTop;
      if (Math.abs(delta) < 1) {
        delete barAnimOrigins[key];
        decision = keyDecisions[key] = { bail: true };
      } else {
        barAnimOrigins[key] = origin;
        decision = keyDecisions[key] = { bail: false, origin: origin };
      }
    }
    if (decision.bail) {
      // A row already mid-flight (existing origin) can land here instead
      // of the tick() loop's own completion branch — e.g. a second drag
      // right back to roughly where an still-in-flight one started nets a
      // ~0 delta against that ORIGINAL origin.fromTop before it ever
      // reaches progress>=1. Without this, whatever an earlier pass
      // already wrote (transform/transition/the class/the pinned z-index)
      // is stuck on the element for good — nothing else ever clears it,
      // since it won't be in toAnimate again to reach that branch. Stuck
      // z-index was the visible failure: a day-segment permanently pinned
      // at an elevated offset (see ganttNextReorderZIndexOffset()'s own
      // comment) outranked ANOTHER row's tag it was never meant to
      // compete with at all, hiding it behind the segment (Karl's own
      // screenshot, worse than the original flicker this was meant to
      // fix).
      el.style.transform = '';
      el.style.transition = '';
      el.style.zIndex = '';
      el.classList.remove('gantt-bar-reorder');
      return;
    }
    // This element's OWN measured position still drives its OWN delta
    // (see this function's own comment elsewhere on why day-segment/tag/
    // border sub-pixel differences matter) — only the bail-vs-continue
    // call itself, and the shared origin when continuing, are pinned once
    // per key above.
    const newTop = el.getBoundingClientRect().top;
    const delta = decision.origin!.fromTop - newTop;
    toAnimate.push({ el: el, key: key, delta: delta });
  });
  if (!toAnimate.length) return;

  // transition: none matters here, not just the class toggle — .task-bar's
  // OWN base CSS rule sets `transition: transform 0.15s, ...` (for its
  // normal hover/drag feedback), and without overriding that, this raw
  // per-frame style.transform write below doesn't take effect immediately:
  // the browser's own 150ms transition engine takes over and eases toward
  // whatever value was JUST written, but by the very next frame (~16ms
  // later) this loop has already written a NEWER target — so the element
  // spends the whole animation perpetually 150ms behind, chasing a target
  // that keeps moving out from under it, and never actually reaches where
  // it's "supposed" to be until the whole thing ends. Every OTHER piece of
  // a job-span row (.job-span-border, -solid, -hash, -tick) has no such
  // rule of its own and tracks correctly — only .task-bar (the invisible-
  // fill click-target underneath a job-span row, or the visible pill for a
  // real task) has this, and its own faint 1px border/box-shadow (see its
  // own CSS) is exactly transparent-but-visible enough to read as a ghost
  // bar trailing the real one (Karl's own screenshot and description, "its
  // basically transparent... but I can tell when it moves").
  toAnimate.forEach(function (a) {
    a.el.style.transition = 'none';
    a.el.classList.add('gantt-bar-reorder');
    // See ganttNextReorderZIndexOffset()'s own comment — pinned once per
    // row here, not recomputed from DOM order, so two rows crossing paths
    // can't swap which one paints on top partway through, even across an
    // overlapping second render of the same transition. ganttRowStackBaseZ()
    // keeps this element's own normal rank WITHIN its row (tag over
    // segments, etc. — see its own comment) intact underneath that offset.
    a.el.style.zIndex = String(ganttRowStackBaseZ(a.el) + barAnimOrigins[a.key].zIndexOffset);
  });

  // Only the job(s) actually reordering need their connector recomputed
  // every frame — a rowKey's own job id is always its first `::` segment
  // (see ganttRowKey()). Every other multi-phase job's connector is left
  // alone entirely below (redrawConnectorLinesLive() only touches
  // liveJobIds), reusing whatever static position drawConnectorLines()
  // already gave it.
  const movedJobIds = new Set<string>();
  toAnimate.forEach(function (a) { movedJobIds.add(a.key.slice(0, a.key.indexOf('::'))); });

  const grid = document.getElementById('timelineGrid');
  const gridTop = grid ? grid.getBoundingClientRect().top : 0;

  // Already bumped once, unconditionally, at the very top of this function
  // — just capture the current value here. Both bars and the connector now
  // read their live position straight out of barAnimOrigins (a single
  // shared source of truth) rather than a local `start` timestamp each
  // loop invocation used to own, so a stale loop from an older, superseded
  // render would actually compute the exact same values as the current
  // one on any given frame — no more of the "smooth, jump back, smooth,
  // jump back" fight that used to cause (Karl's own report). This check is
  // now a performance optimization (only the newest render's loop keeps
  // running instead of every superseded one piling up doing identical
  // redundant work), not a correctness requirement.
  const myGeneration = ganttReorderGeneration;

  // ONE shared rAF loop drives both the bars' own transform AND the
  // connector line(s) linking them, from the exact same per-frame timing
  // source (barAnimOrigins) — they literally cannot drift apart from each
  // other the way separately-timed loops could (Karl's own reports, both
  // "the job bar and task bars move separately" and "the full project bar
  // doesn't move in sync with the phases"). Needs no DOM reads at all
  // beyond the one-time `dataset.rowKey` lookup in Pass 1 above, for the
  // same reason redrawConnectorLinesLive()'s own comment gives.
  (function tick() {
    if (myGeneration !== ganttReorderGeneration) return;
    // Captured ONCE per frame and reused for every element below (and
    // handed straight to redrawConnectorLinesLive()) instead of each
    // element calling performance.now() itself inside the loop. On a busy
    // real project toAnimate can hold a great many elements — every
    // day-tick/hash/solid-segment sharing a row, across every row that
    // moved (see toAnimate's own comment) — and that loop's own writes
    // take real, if small, time to run. An element processed a few dozen
    // iterations into the loop would otherwise compute its progress from
    // a measurably later timestamp than one processed first, so bars
    // (and the connector, measured later still) drift apart from each
    // other by a growing amount as the element count grows — exactly the
    // "isn't quite in sync" Karl's own report described, worse on exactly
    // the busy real projects where toAnimate is largest. One shared clock
    // for the whole frame means every element's position this frame is
    // computed from the identical instant, regardless of list size.
    const frameNow = performance.now();
    let stillActive = false;
    // A finished row's shared origin is deleted ONCE, after every element
    // sharing its key has already been styled below — not inline inside
    // the loop. toAnimate routinely holds several elements per key (every
    // day-segment/tick/border/tag sharing one row — see Pass 1's own
    // comment), and deleting barAnimOrigins[key] the moment the FIRST of
    // them reached progress>=1 left barAnimOrigins[a.key] gone by the time
    // the SECOND one was processed a moment later in this same forEach —
    // its own `if (!origin) return` guard then bailed it out with NONE of
    // the cleanup below ever applied, permanently stuck with whatever
    // transform/transition/class/z-index it had from the frame before.
    // Harmless-looking on its own (a ~0px leftover transform), but
    // deadly combined with ganttNextReorderZIndexOffset()'s pinned
    // z-index: a day-segment stuck elevated above its own row's job-name
    // tag hid that tag completely (Karl's own screenshot) — the first
    // time this latent gap became visible, though it's always applied to
    // transform/transition/the class too.
    const finishedKeys = new Set<string>();
    toAnimate.forEach(function (a) {
      const origin = barAnimOrigins[a.key];
      if (!origin) return;
      const progress = Math.min(1, (frameNow - origin.startTime) / GANTT_REORDER_MS);
      a.el.style.transform = 'translateY(' + (a.delta * (1 - easeOutCubic(progress))) + 'px)';
      if (progress >= 1) {
        a.el.classList.remove('gantt-bar-reorder');
        a.el.style.transform = '';
        a.el.style.transition = '';
        a.el.style.zIndex = '';
        finishedKeys.add(a.key);
      } else {
        stillActive = true;
      }
    });
    finishedKeys.forEach(function (k) { delete barAnimOrigins[k]; });
    if (grid) redrawConnectorLinesLive(jobBarMap, movedJobIds, gridTop, frameNow);
    if (stillActive) {
      requestAnimationFrame(tick);
    } else if (grid) {
      // One final pass from the real, static, exact-not-eased-estimate
      // final positions — removes any last-frame rounding drift from
      // easeOutCubic()'s own approximation of the real CSS curve.
      drawConnectorLines(gridWidth, jobBarMap, connectorsLayer);
    }
  })();
}

function renderGantt(): void {
  syncGanttFocusBanner();

  const oldBarTops = captureBarTopsByRowKey();

  const {
    grid, header, leftBody, gridLinesLayer, rowBgLayer, todayLineLayer, barsLayer, connectorsLayer,
    totalDays, containerH, gridWidth, savedScrollLeft, savedScrollTop,
  } = setupDateRangeAndGrid();
  const today = buildDateHeader(totalDays, gridLinesLayer, header);
  const { jobBarMap, visibleRows, gridHeightPx } = buildRowModel(containerH, grid);
  renderLeftPanelRows(visibleRows, rowBgLayer, gridWidth, leftBody, gridHeightPx);
  drawTodayLine(todayLineLayer, today, totalDays);
  renderTimelineBars(visibleRows, barsLayer, jobBarMap);
  drawConnectorLines(gridWidth, jobBarMap, connectorsLayer);
  restoreScrollPosition(savedScrollTop, savedScrollLeft);

  animateReorderedBars(oldBarTops, jobBarMap, gridWidth, connectorsLayer);
  updateGanttBulkToggle();
}

function scrollToToday(): void {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  computeDateRange();
  const todayIdx = getDaysDiff(startDate, today);
  const timelineBody = document.getElementById('timelineBody')!;

  if (todayIdx < 0 || todayIdx >= getDaysDiff(startDate, endDate) + 1) {
    showToast('Today is outside the project date range', 'info');
    return;
  }

  const targetLeft = Math.max(0, todayIdx * dayWidth - timelineBody.clientWidth / 2 + dayWidth / 2);
  timelineBody.scrollLeft = targetLeft;
}

// ===== GANTT PINCH-TO-ZOOM =====
// Phones and trackpads; the zoom pill's buttons (#ganttZoomInBtn etc.)
// are the tap/click alternative on every device. Two input paths
// land here: real multi-touch (phones/tablets —
// handleGanttTouchStart/Move/End below) and the wheel event a trackpad's
// pinch gesture synthesizes with ctrlKey set on both macOS and Windows
// precision touchpads (handleGanttWheelZoom), so a laptop trackpad pinch
// works the same way without an actual touchscreen — this one desktop
// input path stays even though the buttons came back, since a trackpad
// pinch is a strictly nicer way to zoom than clicking + repeatedly.
//
// The touch path deliberately does NOT call renderGantt() on every
// touchmove the way the first version of this did. A touch's move/end
// events are dispatched to whatever element was actually under the
// finger at touchstart (commonly a specific bar/cell inside
// #timelineGrid, not the container the listener is bound to) — the FIRST
// renderGantt() rebuilds that element's innerHTML and detaches the
// original node the browser is tracking the gesture against, and most
// mobile browsers simply stop delivering further touchmove/touchend for
// a touch once its original target is gone. In testing that showed up as
// "pinch does nothing": the very first frame silently broke the rest of
// the gesture. Fixed by keeping touchmove purely visual — a CSS
// scaleX() preview on #timelineGrid, which repaints without touching the
// DOM tree at all — and only running the real renderGantt() once, at
// touchend, after the gesture (and its original touch targets) is done
// mattering.
const GANTT_ZOOM_MIN = 14, GANTT_ZOOM_MAX = 80;
let ganttPinchStartDist: number | null = null;
let ganttPinchStartDayWidth: number | null = null;
let ganttPinchAnchorX: number | null = null;
let ganttPinchScale = 1;
let ganttZoomRafPending = false;
let ganttZoomPendingWidth: number | null = null;
let ganttZoomAnchorX: number | null = null;

function ganttTouchDist(touches: { clientX: number; clientY: number }[] | TouchList): number {
  return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
}

// Shared commit path for both input methods: clamp, bail if it's a no-op,
// otherwise re-render at the new width and correct scrollLeft so whatever
// day was under the anchor point lands back under that same screen point
// instead of the zoom recentering on the timeline's left edge.
function setGanttDayWidthAnchored(newDayWidth: number, anchorClientX: number): void {
  const clamped = Math.max(GANTT_ZOOM_MIN, Math.min(GANTT_ZOOM_MAX, Math.round(newDayWidth)));
  if (clamped === dayWidth) return;
  const timelineBody = document.getElementById('timelineBody')!;
  const anchorOffset = anchorClientX - timelineBody.getBoundingClientRect().left;
  const dayPos = (timelineBody.scrollLeft + anchorOffset) / dayWidth;
  dayWidth = clamped;
  renderGantt();
  // renderGantt() ends by calling restoreScrollPosition(), which restores
  // the PRE-zoom scrollLeft but only on the next animation frame (see its
  // own comment) — asserting the anchored scrollLeft synchronously here
  // would just get clobbered a frame later, snapping back to the old
  // position (visibly "zooming toward the left edge" on a single click,
  // since there's no follow-up frame to mask it the way a continuous
  // wheel/pinch gesture's rapid re-zooms do). Scheduling this in its own
  // rAF — registered after renderGantt()'s already-pending one — runs it
  // afterward instead, so this is the value that actually sticks.
  requestAnimationFrame(function () {
    const newScrollLeft = dayPos * dayWidth - anchorOffset;
    timelineBody.scrollLeft = newScrollLeft;
    setHeaderScroll(newScrollLeft);
  });
}

// Wheel/trackpad path only — a wheel event has no persistent "original
// target" the way a touch sequence does (each tick just hits whatever's
// currently under the cursor), so re-rendering mid-gesture here doesn't
// have the touch path's problem. Still coalesced to at most one
// renderGantt() per animation frame purely for perf, since a trackpad
// can fire wheel ticks much faster than this chart can usefully re-render.
function requestGanttZoom(newDayWidth: number, anchorClientX: number): void {
  ganttZoomPendingWidth = newDayWidth;
  ganttZoomAnchorX = anchorClientX;
  if (ganttZoomRafPending) return;
  ganttZoomRafPending = true;
  requestAnimationFrame(function () {
    ganttZoomRafPending = false;
    setGanttDayWidthAnchored(ganttZoomPendingWidth!, ganttZoomAnchorX!);
  });
}

function handleGanttTouchStart(e: TouchEvent): void {
  if (e.touches.length === 2) {
    ganttPinchStartDist = ganttTouchDist(e.touches);
    ganttPinchStartDayWidth = dayWidth;
    ganttPinchAnchorX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    ganttPinchScale = 1;
    const grid = document.getElementById('timelineGrid');
    if (grid) {
      grid.style.transformOrigin = (ganttPinchAnchorX - grid.getBoundingClientRect().left) + 'px 0';
    }
  }
}
function handleGanttTouchMove(e: TouchEvent): void {
  if (e.touches.length !== 2 || ganttPinchStartDist == null || ganttPinchStartDayWidth == null) return;
  e.preventDefault();
  const rawScale = ganttTouchDist(e.touches) / ganttPinchStartDist;
  // Clamp the SCALE (not dayWidth, which doesn't change until touchend)
  // so the live preview can't stretch past what touchend would actually
  // commit to.
  ganttPinchScale = Math.max(GANTT_ZOOM_MIN / ganttPinchStartDayWidth, Math.min(GANTT_ZOOM_MAX / ganttPinchStartDayWidth, rawScale));
  const grid = document.getElementById('timelineGrid');
  if (grid) grid.style.transform = 'scaleX(' + ganttPinchScale + ')';
}
function handleGanttTouchEnd(e: TouchEvent): void {
  if (e.touches.length >= 2 || ganttPinchStartDist == null || ganttPinchStartDayWidth == null) return;
  const grid = document.getElementById('timelineGrid');
  if (grid) { grid.style.transform = ''; grid.style.transformOrigin = ''; }
  setGanttDayWidthAnchored(ganttPinchStartDayWidth * ganttPinchScale, ganttPinchAnchorX!);
  ganttPinchStartDist = null;
  ganttPinchStartDayWidth = null;
}
// ctrlKey is how both macOS and Windows report a trackpad pinch as a
// wheel event — a plain scroll wheel/two-finger-pan never sets it, so
// this leaves ordinary wheel scrolling of the timeline completely alone.
function handleGanttWheelZoom(e: WheelEvent): void {
  if (!e.ctrlKey) return;
  e.preventDefault();
  requestGanttZoom(dayWidth * Math.exp(-e.deltaY * 0.01), e.clientX);
}

// The zoom pill's buttons (see .gantt-zoom-pill) — anchored on the
// visible timeline viewport's own horizontal center (there's no cursor
// position to anchor on the way the wheel/pinch paths have one), reusing
// the same setGanttDayWidthAnchored() commit path so the day currently in
// the middle of the screen stays there instead of the zoom appearing to
// pull everything toward the left edge.
function zoomGanttCentered(newDayWidth: number): void {
  const timelineBody = document.getElementById('timelineBody')!;
  const rect = timelineBody.getBoundingClientRect();
  setGanttDayWidthAnchored(newDayWidth, rect.left + rect.width / 2);
}
function zoomIn(): void { zoomGanttCentered(dayWidth + 6); }
function zoomOut(): void { zoomGanttCentered(dayWidth - 6); }
function resetZoom(): void { zoomGanttCentered(34); }

function fitToView(): void {
  const containerWidth = document.getElementById('timelineBody')!.clientWidth - 20;
  computeDateRange();
  const totalDays = getDaysDiff(startDate, endDate) + 1;
  const fitted = Math.max(Math.floor(containerWidth / totalDays), 14);
  zoomGanttCentered(fitted);
}

// ===== GANTT: CLICK-AND-DRAG PAN =====
// "Grab the empty canvas and drag" — a second way to scroll #timelineBody
// besides its native scrollbar/wheel/pinch, same hand-tool gesture as Miro/
// Google Maps. Only ever starts from genuinely empty grid background: any
// mousedown whose real target (e.target, which bubbling never changes) is
// inside a bar/tick/segment/resize-handle/collapsible-tag is left alone so
// it can run ITS OWN drag (move/resize/fold-toggle) instead — see
// GANTT_PAN_BLOCK_SELECTOR. A .job-span-bar's own invisible hit-target div
// already covers its whole condensed row for the move-drag above, so on a
// Jobs/Leads row this naturally only engages outside that job's own date
// range; on a Tasks-view row it's the day-gaps between individual task bars.
interface GanttPanState {
  startX: number;
  startY: number;
  startScrollLeft: number;
  startScrollTop: number;
  // Distinguishes a real pan from a plain click that never moved — same
  // "was this actually dragged" gate startBarMove()'s own `moved`/
  // `dataset.dragged` pair uses, just simpler here since nothing under a
  // pan gesture needs to tell a click from a drag afterward (empty
  // background has no click handler of its own to suppress).
  moved: boolean;
}
let ganttPanState: GanttPanState | null = null;
const GANTT_PAN_BLOCK_SELECTOR = '.task-bar, .job-span-task-tick, .job-span-task-solid, .task-bar-resize-handle, .task-bar-job-tag.collapsible, .job-span-due-marker';
// Pixels of slop before a mousedown-that-moved counts as a pan — small
// mouse jitter on what the user meant as a plain click on empty background
// shouldn't scroll the chart out from under them.
const GANTT_PAN_THRESHOLD_PX = 4;

function startGanttPan(e: MouseEvent): void {
  if (e.button !== 0) return;
  if ((e.target as HTMLElement).closest(GANTT_PAN_BLOCK_SELECTOR)) return;
  const timelineBody = document.getElementById('timelineBody');
  if (!timelineBody) return;
  ganttPanState = {
    startX: e.clientX, startY: e.clientY,
    startScrollLeft: timelineBody.scrollLeft, startScrollTop: timelineBody.scrollTop,
    moved: false,
  };
  document.addEventListener('mousemove', onGanttPanMove);
  document.addEventListener('mouseup', onGanttPanEnd);
}

function onGanttPanMove(e: MouseEvent): void {
  if (!ganttPanState) return;
  const dx = e.clientX - ganttPanState.startX;
  const dy = e.clientY - ganttPanState.startY;
  if (!ganttPanState.moved) {
    if (Math.abs(dx) < GANTT_PAN_THRESHOLD_PX && Math.abs(dy) < GANTT_PAN_THRESHOLD_PX) return;
    ganttPanState.moved = true;
    document.body.classList.add('gantt-panning');
  }
  e.preventDefault();
  const timelineBody = document.getElementById('timelineBody');
  if (!timelineBody) return;
  timelineBody.scrollLeft = ganttPanState.startScrollLeft - dx;
  timelineBody.scrollTop = ganttPanState.startScrollTop - dy;
}

function onGanttPanEnd(): void {
  document.body.classList.remove('gantt-panning');
  ganttPanState = null;
  document.removeEventListener('mousemove', onGanttPanMove);
  document.removeEventListener('mouseup', onGanttPanEnd);
}

// ===== GANTT: HEADER/BODY SCROLL SYNC =====
let isSyncingScroll = false;

// The single place that positions the date header horizontally — always
// via transform, never timelineHeaderWrap.scrollLeft (see the comment on
// .timeline-header). #timelineBody's own scrollLeft is the one source of
// truth for "how far scrolled right now."
function setHeaderScroll(px: number): void {
  const header = document.getElementById('timelineHeader');
  if (header) header.style.transform = 'translateX(-' + px + 'px)';
  updateGanttTodayMark(px);
  updateGanttPinnedNames(px);
}

// The red "Today" tag in the date header: hidden while today's column is
// on screen, otherwise pinned to the edge today went off, with an arrow
// pointing that way. Clicking it (wired in static-event-wiring.ts) jumps
// back. Runs from setHeaderScroll(), so on every scroll and zoom.
function updateGanttTodayMark(scrollLeft?: number): void {
  const mark = document.getElementById('ganttTodayMark');
  const body = document.getElementById('timelineBody');
  if (!mark || !body || !startDate) return;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const idx = getDaysDiff(startDate, today);
  const inRange = idx >= 0 && (!endDate || idx <= getDaysDiff(startDate, endDate));
  const left = scrollLeft !== undefined ? scrollLeft : body.scrollLeft;
  const x = idx * dayWidth + dayWidth / 2;
  const side = !inRange ? null : x < left ? 'left' : x > left + body.clientWidth ? 'right' : null;
  mark.hidden = !side;
  if (!side) return;
  mark.classList.toggle('left', side === 'left');
  mark.classList.toggle('right', side === 'right');
  const weekday = today.toLocaleDateString('en-US', { weekday: 'short' });
  const label = 'Today · ' + weekday + ' ' + today.getDate();
  mark.textContent = side === 'left' ? '‹ ' + label : label + ' ›';
  mark.setAttribute('aria-label', 'Jump to today, ' + (side === 'left' ? 'earlier' : 'later') + ' in the chart');
}

// Called from home.ts (whenever the Home dashboard's expanded Gantt
// widget switches to this tab) and from src/app/boot.ts's init(), in
// addition to this file's own renderGantt()/scrollToToday() — re-wiring
// on every call is deliberate (see below), so any of those callers is
// safe even if scroll sync is already set up.
function setupScrollSync(): void {
  const timelineBody = document.getElementById('timelineBody');
  const leftBody = document.getElementById('leftBody');

  if (!timelineBody || !leftBody) return;

  timelineBody.onscroll = function() {
    if (isSyncingScroll) return;
    isSyncingScroll = true;
    setHeaderScroll(timelineBody.scrollLeft);
    leftBody.scrollTop = timelineBody.scrollTop;
    isSyncingScroll = false;
  };

  leftBody.onscroll = function() {
    if (isSyncingScroll) return;
    isSyncingScroll = true;
    timelineBody.scrollTop = leftBody.scrollTop;
    isSyncingScroll = false;
  };

  // Pinch-to-zoom — bound on .gantt-panels-row (the date header row is a
  // SIBLING of timelineBody, not a descendant of it — see the
  // "right-panel" markup — so a pinch starting with either finger over
  // the header would never reach a listener scoped to timelineBody alone)
  // rather than just timelineBody itself, even though the zoom math
  // inside still targets timelineBody specifically (its own
  // getBoundingClientRect()/scrollLeft — touch clientX/Y are
  // viewport-relative regardless of which element the listener sits on,
  // so this doesn't need to change). Re-wired here since renderGantt()
  // rebuilds timelineBody's contents (though not the panels-row itself)
  // on every call; property assignment rather than addEventListener so
  // re-running this never stacks up duplicate listeners the way repeated
  // addEventListener calls would.
  const panelsRow = document.querySelector('.gantt-panels-row') as HTMLElement | null;
  if (panelsRow) {
    panelsRow.ontouchstart = handleGanttTouchStart;
    panelsRow.ontouchmove = handleGanttTouchMove;
    panelsRow.ontouchend = handleGanttTouchEnd;
  }
  timelineBody.onwheel = handleGanttWheelZoom;
  timelineBody.onmousedown = startGanttPan;
  setupGanttColumnResize();
}

// ===== GANTT: RESIZABLE JOB COLUMN =====
// The left panel's right edge (#ganttColResize) drags to widen or narrow
// it, so long job names fit. Width lives in the --gantt-left-w custom
// property on <html> (index.html's .left-panel/.gantt-view-toggle-row read
// it, defaulting to 400px) and is remembered per browser. Desktop only —
// the ≤1100px breakpoint pins its own fixed width and hides the handle.
const GANTT_LEFT_W_KEY = 'gantt_left_panel_width_v1';
const GANTT_LEFT_W_DEFAULT = 400;
const GANTT_LEFT_W_MIN = 320;
let ganttColResizeStart: { x: number; width: number } | null = null;

function ganttLeftWidthMax(): number {
  return Math.max(GANTT_LEFT_W_MIN, Math.min(760, Math.round(window.innerWidth * 0.55)));
}

function applyGanttLeftWidth(px: number | null): void {
  const root = document.documentElement;
  if (px === null) root.style.removeProperty('--gantt-left-w');
  else root.style.setProperty('--gantt-left-w', Math.round(Math.max(GANTT_LEFT_W_MIN, Math.min(ganttLeftWidthMax(), px))) + 'px');
  syncGanttColResizeAria();
}

// A focusable role="separator" must report its value (WCAG 4.1.2 / A5) —
// the column width in px, within its current min/max.
function syncGanttColResizeAria(): void {
  const handle = document.getElementById('ganttColResize');
  if (!handle) return;
  const v = document.documentElement.style.getPropertyValue('--gantt-left-w');
  handle.setAttribute('aria-valuemin', String(GANTT_LEFT_W_MIN));
  handle.setAttribute('aria-valuemax', String(ganttLeftWidthMax()));
  handle.setAttribute('aria-valuenow', String(v ? parseInt(v, 10) : GANTT_LEFT_W_DEFAULT));
}

function currentGanttLeftWidth(): number {
  const panel = document.querySelector('.left-panel') as HTMLElement | null;
  return panel ? panel.getBoundingClientRect().width : GANTT_LEFT_W_DEFAULT;
}

function saveGanttLeftWidth(): void {
  const v = document.documentElement.style.getPropertyValue('--gantt-left-w');
  try {
    if (v) localStorage.setItem(GANTT_LEFT_W_KEY, String(parseInt(v, 10)));
    else localStorage.removeItem(GANTT_LEFT_W_KEY);
  } catch (e) { /* storage unavailable — width just isn't remembered */ }
}

function onGanttColResizeMove(e: MouseEvent): void {
  if (!ganttColResizeStart) return;
  e.preventDefault();
  applyGanttLeftWidth(ganttColResizeStart.width + (e.clientX - ganttColResizeStart.x));
}

function onGanttColResizeEnd(): void {
  ganttColResizeStart = null;
  document.body.classList.remove('gantt-col-resizing');
  document.removeEventListener('mousemove', onGanttColResizeMove);
  document.removeEventListener('mouseup', onGanttColResizeEnd);
  saveGanttLeftWidth();
}

// Property assignment (not addEventListener), same as the rest of
// setupScrollSync(), so re-running it never stacks duplicate listeners.
function setupGanttColumnResize(): void {
  const handle = document.getElementById('ganttColResize');
  if (!handle) return;
  if (!document.documentElement.style.getPropertyValue('--gantt-left-w')) {
    let saved: number | null = null;
    try { saved = parseInt(localStorage.getItem(GANTT_LEFT_W_KEY) || '', 10) || null; } catch (e) { saved = null; }
    if (saved) applyGanttLeftWidth(saved);
  }
  syncGanttColResizeAria();
  handle.onmousedown = function (e: MouseEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    ganttColResizeStart = { x: e.clientX, width: currentGanttLeftWidth() };
    document.body.classList.add('gantt-col-resizing');
    document.addEventListener('mousemove', onGanttColResizeMove);
    document.addEventListener('mouseup', onGanttColResizeEnd);
  };
  handle.ondblclick = function () {
    applyGanttLeftWidth(null);
    saveGanttLeftWidth();
  };
  handle.onkeydown = function (e: KeyboardEvent) {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === 'ArrowLeft') applyGanttLeftWidth(currentGanttLeftWidth() - step);
    else if (e.key === 'ArrowRight') applyGanttLeftWidth(currentGanttLeftWidth() + step);
    else if (e.key === 'Home') applyGanttLeftWidth(null);
    else return;
    e.preventDefault();
    saveGanttLeftWidth();
  };
}

// ===== Row builders shared with Calendar (src/views/calendar.ts consumes
// flattenJobs()/buildCalendarJobRows()/isCalendarJobSpanTaskId() as
// ambient globals — its own comment explains why: they're really this
// file's own task-clustering logic reused there, not Calendar-specific,
// so this is their real home despite Calendar being the only render
// surface for some of them) =====

// A job's due date (card.due) isn't a task — it doesn't live in job.tasks
// and Job Manager never shows it as one — but it still needs to appear on
// the Gantt/Calendar and be draggable like a task bar. This synthesizes a
// single-day pseudo-task at render time (start === finish naturally gets
// the app's existing "milestone" single-day styling) that the Gantt/
// Calendar drag handlers special-case by id instead of writing through
// findTask()/job.tasks.
const DUE_MARKER_TASK_ID = '__due__';
function getJobDueMarkerTask(job: Job, phaseId: string | null): GanttTask | null {
  const card = getPhaseCard(job, phaseId);
  if (!card || !card.due) return null;
  if (isNaN(new Date(card.due + 'T00:00:00').getTime())) return null;
  return { id: DUE_MARKER_TASK_ID, name: 'Due Date', start: card.due, finish: card.due, notes: '', color: job.color, order: -1, isDueMarker: true };
}

// A phase whose Board card sits in a finished-trigger board (the board's
// ⋮ menu "finished" toggle, see isFinishedColumnId()) is done: it drops off
// the Gantt and Calendar (Karl's call, 2026-09-28). Judged per phase, since
// each phase has its own card, so a plain job disappears as a whole and a
// multi-phase job loses each phase as its card gets there. A linked
// reference's cards live in its own project, so it never matches here.
export function isPhaseFinishedOnBoard(job: Job, phaseId: string | null): boolean {
  if ((job as any).isLinkedReference) return false;
  const card = getPhaseCard(job, phaseId);
  return !!(card && card.column && isFinishedColumnId(card.column));
}

// Shared job -> phase -> sub-unit walk behind flattenJobs() (Gantt Tasks
// view) and buildCalendarJobRows() (Calendar) — the genuinely-matching
// pair. Skips archived jobs, folds in linked reference jobs the same way
// both callers already did, visits every phase then every sub-unit within
// it (including the synthetic single-entry wrap an unphased job/phase
// gets from getJobPhases()/getPhaseSubUnits()), and appends that phase's
// one due-marker row on the FIRST sub-unit only — there's no per-sub-phase
// card to carry a second one, so it must never be duplicated across every
// sub-phase.
// subUnitCallback(job, jobIdx, phase, phaseName, subUnit, subIdx,
// subPhaseName) does each caller's own per-sub-unit row shaping;
// dueRowBuilder(...) builds that caller's own due-marker row shape (only
// called when a due task actually exists).
//
// buildVisibleTaskRows() (this file's own collapse-aware nested helper,
// inside renderGantt()) is deliberately NOT built on this — it's tightly
// coupled to Gantt-only collapse state (collapsedPhaseIds/
// tasksExpandedPhaseIds/tasksExpandedSubPhaseIds/ganttFocusedJobId) and
// produces a genuinely different row shape (collapse-aware synthetic
// phase/sub-phase rows). Forcing it through this walker would mean
// threading Gantt-specific collapse logic into code the other two
// callers don't need — worse for long-term readability than the current
// split, not better.
function forEachVisibleSubUnit(
  jobsArr: Job[],
  subUnitCallback: (job: any, jobIdx: number, phase: Phase, phaseName: string | null, subUnit: SubPhase, subIdx: number, subPhaseName: string | null) => void,
  dueRowBuilder: (job: any, jobIdx: number, phase: Phase, phaseName: string | null, subUnit: SubPhase, subPhaseName: string | null, dueTask: GanttTask) => void
): void {
  const combined = (jobsArr || []).concat(getLinkedReferenceJobs() as Job[]);
  combined.forEach(function (job: any, jobIdx: number) {
    if (job.archived) return;
    getJobPhases(job).forEach(function (phase) {
      if (isPhaseFinishedOnBoard(job, phase.id)) return;
      const phaseName = phase.isDefault ? null : phase.name;
      getPhaseSubUnits(phase).forEach(function (subUnit, subIdx) {
        const subPhaseName = subUnit.isDefault ? null : subUnit.name;
        subUnitCallback(job, jobIdx, phase, phaseName, subUnit, subIdx, subPhaseName);
        if (!job.isLinkedReference && subIdx === 0) {
          const dueTask = getJobDueMarkerTask(job, phase.id);
          if (dueTask) dueRowBuilder(job, jobIdx, phase, phaseName, subUnit, subPhaseName, dueTask);
        }
      });
    });
  });
}

function flattenJobs(jobsArr: Job[]): any[] {
  const hiddenOrders = getHiddenTaskOrders();
  const rows: any[] = [];
  forEachVisibleSubUnit(jobsArr, function (job, jobIdx, phase, phaseName, subUnit, subIdx, subPhaseName) {
    (subUnit.tasks || []).sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    (subUnit.tasks || []).forEach(function (task, taskIdx) {
      if (hiddenOrders.has(task.order as number)) return;
      rows.push({ job: job, jobIdx: jobIdx, task: task, taskIdx: taskIdx, phaseId: phase.id, phaseName: phaseName, subPhaseId: subUnit.id, subPhaseName: subPhaseName });
    });
  }, function (job, jobIdx, phase, phaseName, subUnit, subPhaseName, dueTask) {
    rows.push({ job: job, jobIdx: jobIdx, task: dueTask, taskIdx: -1, phaseId: phase.id, phaseName: phaseName, subPhaseId: subUnit.id, subPhaseName: subPhaseName });
  });
  return rows;
}

// ===== CALENDAR: COLLAPSED JOB ROWS =====
// Calendar's own version of flattenJobs() — a job's sub-units start
// CONDENSED into one bar each (spanning that sub-unit's own min-start/
// max-finish) instead of one bar per task, using the exact same
// tasksExpandedSubPhaseIds Set the Gantt's Tasks view already maintains
// (see toggleTasksSubPhaseExpanded()) — expanding a sub-phase in either
// view shows it expanded in both, since it's the same shared state, not
// a separate Calendar-only copy.
//
// Deliberately simpler than the Gantt's two-level collapse (a whole
// phase folds into one bar across all its sub-phases, and each
// sub-phase separately folds into one bar across its own tasks): here,
// a real sub-phase always gets its own bar rather than also being
// foldable together with its siblings into one bar — a calendar shows
// literal dates on a grid, and merging unrelated sub-phases' date
// ranges into a single bar read as more confusing than useful for that,
// unlike the Gantt's zoomable timeline where it's a genuine space-saver.
// A phase-less/sub-phase-less job (the common case) still gets exactly
// one collapsible bar per phase, via getPhaseSubUnits()'s synthetic
// single-entry wrap — same as flattenJobs().
function getHiddenTaskOrders(): Set<number> {
  const hidden = new Set<number>();
  BOARD_COLUMNS.forEach(function (c, i) { if (c.hideFromSchedule) hidden.add(i); });
  return hidden;
}
// Groups a collapsed sub-phase's tasks into "clusters" — a cluster is a
// maximal run of days with no missing day anywhere inside it (tasks
// touching or overlapping stay one cluster; an actual scheduling gap
// starts a new one). Within a cluster, day-bucketed sub-segments still
// track exactly which task(s) cover each stretch (mirroring the Gantt
// Tasks view's own collapsed-sub-phase day-sweep, renderGantt()'s
// job-span drawing pass) so an overlap still reads as a hatch and a
// hand-off between two tasks still reads as two different colors — but
// that's rendered as ONE bordered bar per cluster (buildCalBarHtml's
// nested inner blocks), not a separate bar for the overlap itself. A
// real gap gets no bar at all over those days. Per the user: don't
// connect a bar across an unscheduled day, but don't fragment a
// genuinely-connected (touching/overlapping) run into multiple bars
// either.
function buildSubUnitClusters(job: any, subUnit: SubPhase, hiddenOrders: Set<number>): any[] {
  const dated = (subUnit.tasks || []).filter(function (task) {
    if (hiddenOrders.has(task.order as number)) return false;
    if (!task.start || !task.finish) return false;
    const s = new Date(task.start + 'T00:00:00'), f = new Date(task.finish + 'T00:00:00');
    return !isNaN(s.getTime()) && !isNaN(f.getTime());
  }).map(function (task) {
    return { task: task, start: new Date(task.start + 'T00:00:00'), finish: new Date(task.finish + 'T00:00:00') };
  });
  if (!dated.length) return [];
  let minStart = dated[0].start, maxFinish = dated[0].finish;
  dated.forEach(function (dt) {
    if (dt.start < minStart) minStart = dt.start;
    if (dt.finish > maxFinish) maxFinish = dt.finish;
  });
  const totalDays = getDaysDiff(minStart, maxFinish) + 1;
  const dayTasks: GanttTask[][] = [];
  for (let i = 0; i < totalDays; i++) dayTasks.push([]);
  dated.forEach(function (dt) {
    const sIdx = getDaysDiff(minStart, dt.start), eIdx = getDaysDiff(minStart, dt.finish);
    for (let d = Math.max(0, sIdx); d <= Math.min(totalDays - 1, eIdx); d++) dayTasks[d].push(dt.task);
  });
  const fineSegments: any[] = [];
  let di = 0;
  while (di < totalDays) {
    const covering = dayTasks[di];
    const key = covering.map(function (t) { return t.id; }).sort().join('|');
    let dj = di;
    while (dj + 1 < totalDays && dayTasks[dj + 1].map(function (t) { return t.id; }).sort().join('|') === key) dj++;
    if (covering.length > 0) {
      fineSegments.push({
        startOffset: di, endOffset: dj,
        // taskCount is the real "is this an overlap" signal — colors is
        // deduped, so two overlapping tasks that both happen to be
        // job-colored (the common case — see normalizeTasksToColumns())
        // would otherwise collapse to a single color and look identical
        // to a plain one-task segment, silently losing the overlap.
        taskCount: covering.length,
        colors: Array.from(new Set(covering.map(function (t) { return t.color || job.color || '#3949ab'; }))),
      });
    }
    di = dj + 1;
  }
  // Merge fine segments into clusters wherever there's no day-gap between
  // them (adjacent fine segments always represent a hand-off between
  // different covering-task-sets, but that alone isn't a gap — only a
  // missing offset between them is).
  const clusters: any[] = [];
  fineSegments.forEach(function (seg) {
    const last = clusters[clusters.length - 1];
    if (last && seg.startOffset === last.endOffset + 1) {
      last.endOffset = seg.endOffset;
      last.segs.push(seg);
    } else {
      clusters.push({ startOffset: seg.startOffset, endOffset: seg.endOffset, segs: [seg] });
    }
  });
  return clusters.map(function (c) {
    const start = new Date(minStart); start.setDate(start.getDate() + c.startOffset);
    const finish = new Date(minStart); finish.setDate(finish.getDate() + c.endOffset);
    return {
      start: start, finish: finish,
      // Re-based to the CLUSTER's own start (not the whole sub-phase's) —
      // buildCalBarHtml positions these relative to the bar it's building,
      // which is now exactly this cluster.
      segments: c.segs.map(function (s: any) {
        return { startOffset: s.startOffset - c.startOffset, endOffset: s.endOffset - c.startOffset, taskCount: s.taskCount, colors: s.colors };
      }),
    };
  });
}
const CALENDAR_JOB_SPAN_TASK_PREFIX = 'calspan|';
function isCalendarJobSpanTaskId(taskId: unknown): boolean {
  return typeof taskId === 'string' && taskId.indexOf(CALENDAR_JOB_SPAN_TASK_PREFIX) === 0;
}
// Condenses a sub-phase's tasks into one bar per cluster
// (buildSubUnitClusters) — unlike the Gantt's own Tasks view, the
// Calendar never offers expanding back out to individual task bars
// (deliberately no chevron/toggle here), and unlike the Gantt's own
// collapsed-row look, a real scheduling gap between two of a sub-phase's
// tasks gets no bar at all instead of one continuous bar painted
// straight through it.
//
// Calendar tab options: onlyColumnId keeps just that stage's tasks (every
// other stage is treated like a hideFromSchedule one); perJob replaces
// all of a job's bars with one plain bar in the job's color from its
// first start to its last finish.
function buildCalendarJobRows(jobsArr: Job[], opts?: { onlyColumnId?: string; perJob?: boolean }): any[] {
  const hiddenOrders = getHiddenTaskOrders();
  if (opts && opts.onlyColumnId) {
    BOARD_COLUMNS.forEach(function (c, i) { if (c.id !== opts.onlyColumnId) hiddenOrders.add(i); });
  }
  const rows: any[] = [];
  const jobSpans = new Map<string, { job: Job; start: Date; finish: Date }>();
  forEachVisibleSubUnit(jobsArr, function (job, jobIdx, phase, phaseName, subUnit, subIdx, subPhaseName) {
    const clusters = buildSubUnitClusters(job, subUnit, hiddenOrders);
    if (opts && opts.perJob) {
      clusters.forEach(function (cluster) {
        const span = jobSpans.get(job.id);
        if (!span) jobSpans.set(job.id, { job: job, start: cluster.start, finish: cluster.finish });
        else {
          if (cluster.start < span.start) span.start = cluster.start;
          if (cluster.finish > span.finish) span.finish = cluster.finish;
        }
      });
      return;
    }
    const namePart = (phaseName ? ' — ' + phaseName : '') + (subPhaseName ? ' — ' + subPhaseName : '');
    clusters.forEach(function (cluster, clusterIdx) {
      const single = cluster.segments.length === 1 ? cluster.segments[0] : null;
      const pseudoTask = {
        id: CALENDAR_JOB_SPAN_TASK_PREFIX + job.id + '|' + (phase.id || '') + '|' + (subUnit.id || '') + '|' + clusterIdx,
        name: job.name + namePart,
        start: toIsoDate(cluster.start), finish: toIsoDate(cluster.finish),
        notes: '', color: (single && single.taskCount === 1) ? single.colors[0] : job.color, order: 0, isJobSpan: true,
        clusterSegments: cluster.segments,
      };
      rows.push({ job: job, task: pseudoTask, phaseId: phase.id, phaseName: phaseName, subPhaseId: subUnit.id, subPhaseName: subPhaseName });
    });
  }, function (job, jobIdx, phase, phaseName, subUnit, subPhaseName, dueTask) {
    rows.push({ job: job, task: dueTask, phaseId: phase.id, phaseName: phaseName, subPhaseId: subUnit.id, subPhaseName: subPhaseName });
  });
  jobSpans.forEach(function (span) {
    const pseudoTask = {
      id: CALENDAR_JOB_SPAN_TASK_PREFIX + span.job.id + '|||0',
      name: span.job.name,
      start: toIsoDate(span.start), finish: toIsoDate(span.finish),
      notes: '', color: span.job.color, order: 0, isJobSpan: true,
    };
    rows.push({ job: span.job, task: pseudoTask, phaseId: null, phaseName: '', subPhaseId: null, subPhaseName: '' });
  });
  return rows;
}

export {
  cascadeShiftLaterTasks,
  startBarResizeRight,
  startBarResizeLeft,
  onBarResizeMove,
  applyBarResizeMove,
  onBarResizeEnd,
  startTickResize,
  onTickResizeMove,
  applyTickResizeMove,
  onTickResizeEnd,
  startBarMove,
  onBarMoveMove,
  applyBarMoveMove,
  onBarMoveEnd,
  buildVisibleTaskRows,
  renderGantt,
  scrollToToday,
  ganttTouchDist,
  setGanttDayWidthAnchored,
  requestGanttZoom,
  handleGanttTouchStart,
  handleGanttTouchMove,
  handleGanttTouchEnd,
  handleGanttWheelZoom,
  zoomGanttCentered,
  zoomIn,
  zoomOut,
  resetZoom,
  fitToView,
  setHeaderScroll,
  setupScrollSync,
  togglePhaseCollapse,
  getSubUnitKey,
  toggleTasksPhaseExpanded,
  toggleTasksSubPhaseExpanded,
  expandAllGantt,
  collapseAllGantt,
  toggleGanttBulkFold,
  toggleGanttJobFocus,
  clearGanttJobFocus,
  toggleGanttTaskFocus,
  clearGanttTaskFocus,
  syncGanttFocusBanner,
  computeDateRange,
  showDatePopover,
  hideDatePopover,
  showTooltip,
  DUE_MARKER_TASK_ID,
  getJobDueMarkerTask,
  forEachVisibleSubUnit,
  flattenJobs,
  getHiddenTaskOrders,
  buildSubUnitClusters,
  isCalendarJobSpanTaskId,
  buildCalendarJobRows,
  GANTT_REORDER_MS,
  isGanttReorderAnimating,
};
