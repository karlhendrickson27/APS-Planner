// Job Manager: the job edit/create form itself — phase/sub-phase strips
// and switching, the fixed task grid (dates/duration), the linked-job
// section, addNewJob()/editJob()/cancelEdit(), refreshJobFormIfOpen(),
// the whole autosave system, and the color/mobile-field/custom-fields/
// attachments panel (buildColorPresets/toggleMobileField/
// renderJobCustomFieldsGrid/renderJobTeamFieldsGrid/
// JM_ATTACHMENT_PANEL_CONFIG+wrappers). See tests/unit-job-form.spec.js.
//
// currentGridTasks/editingPhaseId/editingSubPhaseId/jobLinkPickerOpen are
// real module state here (not ambient) — every reader and writer of each
// lives in this file. jmDraftAttachments stays an ambiently-declared
// `var` (declared in index.html) rather than real module state.
//
// The job/phase data model (splitJobIntoPhases/addJobPhase/removeJobPhase/
// unsplitJobFromPhases/splitPhaseIntoSubPhases/addPhaseSubUnit/
// removePhaseSubUnit/unsplitPhaseFromSubPhases/ensureJobHasCards/
// ensureJobTasksMatchColumns/isJobVisibleToMe) is a real import from
// src/core/jobs.ts. The linked-job data model (getOtherFixedProjectId/
// isLinkEnabledLocally/linkJobs/setJobLinkEnabled/unlinkJobById), real in
// src/app/project.ts, is referenced here as an ambient global instead.
import type { Job, Phase, Task, BoardCard } from '../core/types';
import { offerUndo } from '../app/undo';
import { findJob, getJobPhases, getPhaseSubUnits, getPhaseCard, getPrimaryPhaseCard } from '../core/models';
import { escapeHtml } from '../utils/html';
import { genId } from '../utils/id';
import { getBusinessDaysDiff, addBusinessDays, toIsoDate } from '../utils/date';
import { createAutosaveController } from '../utils/autosave';
import { showToast, isPanelActive } from '../utils/ui';
import { hasMinTier } from '../auth/permissions';
import { queueSharedSync } from '../sync/outbound';
import { renderGantt } from './gantt';
import { renderCalendar } from './calendar';
import { renderBoard, renderFieldDefHtml, renderAttachmentPanel, handleAttachmentPanelUpload, removeAttachmentPanelItem } from './board';
import { renderJobList, archiveJob, restoreJob } from './job-list';
import { renderJobComments } from './job-comments';
import {
  ensureJobHasCards, ensureJobTasksMatchColumns, splitJobIntoPhases, addJobPhase, removeJobPhase,
  unsplitJobFromPhases, splitPhaseIntoSubPhases, addPhaseSubUnit, removePhaseSubUnit,
  unsplitPhaseFromSubPhases, isJobVisibleToMe, syncCardColumns,
} from '../core/jobs';

declare global {
  // eslint-disable-next-line no-var
  var jmDraftAttachments: unknown[];
  function getOtherFixedProjectId(projectId: string | null): string | null;
  function getOtherProjectIds(projectId: string | null): string[];
  function isLinkEnabledLocally(jobId: string): boolean;
  function linkJobs(jobA: Job, projectAId: string | null, jobBId: string, projectBId: string): boolean;
  function setJobLinkEnabled(jobId: string, projectId: string | null, enabled: boolean): void;
  function unlinkJobById(jobId: string, projectId: string | null): void;
}

// ===== Fixed task grid =====
// Just formats for the compact display span below — the real value lives
// on the (hidden) native date input untouched, full year and all.
function formatMonthDayShort(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  return (d.getMonth() + 1) + '/' + d.getDate();
}

// A small calendar glyph (currentColor, so it follows .empty's muted
// tint) plus the "M/D" text, or "Set date" when there's nothing yet —
// shared between buildDateCell() and every place that refreshes a date
// cell after a picker/duration change, so the icon+empty-state logic
// never has to be kept in sync by hand in more than one spot.
function renderDateDisplayContent(display: HTMLElement, iso: string): void {
  const text = formatMonthDayShort(iso);
  display.classList.toggle('empty', !text);
  display.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0;"><rect x="3" y="5" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="3" y="5" width="18" height="4" fill="currentColor"/></svg><span>' + (text || 'Set date') + '</span>';
}

// A native <input type="date"> always renders as the browser's own
// segmented month/day/year widget — no reliable cross-browser CSS trick
// reskins it into plain text (hiding the year sub-field and the leftover
// separator next to it only ever half-worked). Instead of fighting that,
// the real date input here is visually hidden and stretched to fill an
// invisible layer over a button-styled span showing "M/D" (no year, no
// native boxes) — clicking it calls showPicker() on the hidden input, so
// picking a date still goes through the browser's own calendar UI rather
// than requiring anyone to type a date in by hand.
function buildDateCell(className: string, initialIso: string): { wrap: HTMLElement; input: HTMLInputElement; display: HTMLElement } {
  const wrap = document.createElement('span');
  wrap.className = 'task-fixed-date-wrap';

  const display = document.createElement('span');
  display.className = 'task-fixed-date-display';
  display.title = 'Click to change date';
  renderDateDisplayContent(display, initialIso);

  const input = document.createElement('input');
  input.type = 'date';
  input.className = className;
  input.value = initialIso || '';

  wrap.appendChild(display);
  wrap.appendChild(input);

  display.addEventListener('click', function () {
    if (typeof input.showPicker === 'function') input.showPicker();
    else input.focus();
  });

  return { wrap: wrap, input: input, display: display };
}

// Holds the full per-column task list (including any hidden-from-schedule
// columns that don't get a row below) so autoSaveJobForm() can carry their
// data forward untouched instead of trying to read a row that was never
// rendered.
let currentGridTasks: Task[] = [];

export function renderFixedTaskGrid(taskList: Task[]): void {
  currentGridTasks = taskList || [];
  const container = document.getElementById('taskRows');
  if (!container) return;
  container.innerHTML = '';
  (taskList || []).forEach(function (t, i) {
    const col = BOARD_COLUMNS[i];
    // A board hidden from the Gantt/Calendar is hidden here too — its data
    // (dates/notes) is untouched, it just isn't editable from this grid
    // while hidden. Un-hide the board to edit it again.
    if (col && (col as any).hideFromSchedule) return;

    const row = document.createElement('div');
    row.className = 'task-fixed-row';
    row.dataset.index = String(i);
    row.dataset.taskId = t.id;
    row.dataset.color = t.color || '#3949ab';

    const swatch = document.createElement('span');
    swatch.className = 'task-fixed-swatch';
    swatch.style.background = t.color || '#3949ab';
    swatch.title = 'Color follows the board column';

    const nameLabel = document.createElement('span');
    nameLabel.className = 'task-fixed-name';
    nameLabel.textContent = t.name || '';
    nameLabel.title = t.name || '';

    const startCell = buildDateCell('task-fixed-start', t.start);
    const startInput = startCell.input;

    const durationInput = document.createElement('input');
    durationInput.type = 'number';
    durationInput.className = 'task-fixed-duration';
    durationInput.min = '1';
    durationInput.placeholder = 'Days';

    const finishCell = buildDateCell('task-fixed-finish', t.finish);
    const finishInput = finishCell.input;

    // Duration is never stored on the task itself — start/finish stay the
    // single source of truth (unchanged schema). It's just derived here for
    // display and re-applied to finish (or vice versa) as the user edits.
    // Business days only (Sat/Sun don't count), per the Job Manager's own
    // convention — the Gantt chart itself still uses calendar days.
    if (t.start && t.finish) {
      const s0 = new Date(t.start + 'T00:00:00');
      const f0 = new Date(t.finish + 'T00:00:00');
      if (!isNaN(s0.getTime()) && !isNaN(f0.getTime())) {
        const dur0 = getBusinessDaysDiff(s0, f0);
        if (dur0 > 0) durationInput.value = String(dur0);
      }
    }

    function applyDurationToFinish(): void {
      const durVal = parseInt(durationInput.value, 10);
      if (!startInput.value || !durVal || durVal < 1) return;
      const s = new Date(startInput.value + 'T00:00:00');
      if (isNaN(s.getTime())) return;
      const f = addBusinessDays(s, durVal);
      finishInput.value = toIsoDate(f);
      renderDateDisplayContent(finishCell.display, finishInput.value);
    }

    function applyFinishToDuration(): void {
      if (!startInput.value || !finishInput.value) return;
      const s = new Date(startInput.value + 'T00:00:00');
      const f = new Date(finishInput.value + 'T00:00:00');
      if (isNaN(s.getTime()) || isNaN(f.getTime())) return;
      const dur = getBusinessDaysDiff(s, f);
      if (dur > 0) durationInput.value = String(dur);
    }

    startInput.addEventListener('change', function () {
      renderDateDisplayContent(startCell.display, startInput.value);
      if (!startInput.value) return;
      // A start date with nothing else set yet defaults to this board's
      // configured duration (see the board's ⋮ settings) — otherwise keep
      // whatever duration/finish relationship already exists.
      if (!durationInput.value && !finishInput.value) {
        durationInput.value = String((col && (col as any).defaultDuration) || DEFAULT_TASK_DURATION_DAYS);
      }
      if (durationInput.value) applyDurationToFinish();
      else applyFinishToDuration();
      scheduleAutoSaveJobForm();
    });
    durationInput.addEventListener('change', function () { applyDurationToFinish(); scheduleAutoSaveJobForm(); });
    finishInput.addEventListener('change', function () {
      renderDateDisplayContent(finishCell.display, finishInput.value);
      applyFinishToDuration();
      scheduleAutoSaveJobForm();
    });

    row.appendChild(swatch);
    row.appendChild(nameLabel);
    row.appendChild(startCell.wrap);
    row.appendChild(durationInput);
    row.appendChild(finishCell.wrap);
    container.appendChild(row);
  });
}

// A job's card position is date-derived (or manually overridden) — this
// just surfaces syncCardColumns()'s result so a job's current board is
// visible without switching to the Board tab to look for it.
export function updateJobCurrentBoardIndicator(job: Job | null, phaseId?: string | null): void {
  const el = document.getElementById('jobCurrentBoardIndicator');
  if (!el) return;
  const card = job ? getPhaseCard(job, phaseId) : null;
  const col = card ? BOARD_COLUMNS.find(function (c) { return c.id === card.column; }) : null;
  if (!col) { el.style.display = 'none'; return; }
  const manual = !!(card && (card as any).manualColumn && (card as any).manualColumnUntil && Date.now() < (card as any).manualColumnUntil);
  el.style.display = 'flex';
  el.innerHTML = '<span class="job-card-board-dot" style="background:' + (col.color || '#3949ab') + ';"></span> Currently on <strong>' + escapeHtml(col.label) + '</strong>' + (manual ? ' (manually placed)' : '');
}

// ===== Phase strip (Job Manager) =====
// editingPhaseId/editingSubPhaseId: which phase/sub-phase's tasks/card the
// Job Manager's grid + description/due/checklists/attachments fields
// currently show, when the open job has phases (see getJobPhases()). null
// for an unphased job's single "phase".
let editingPhaseId: string | null = null;
let editingSubPhaseId: string | null = null;

// Only shown once a job actually exists (not for the "Add New Job" blank
// draft, which has no card yet to repurpose into a phase). Phase-less
// jobs never see this section at all (display:none) — splitting into
// phases is opt-in, see splitJobIntoPhases().
export function renderJobPhaseStrip(job: Job | null): void {
  const section = document.getElementById('jobPhaseSection');
  const strip = document.getElementById('jobPhaseStrip');
  if (!section || !strip) return;
  if (!job) { section.style.display = 'none'; return; }

  if (!job.phases || !job.phases.length) {
    section.style.display = 'block';
    strip.innerHTML = '<button type="button" class="job-phase-strip-btn" data-min-tier="projectAdmin" onclick="splitJobIntoPhasesUI()">+ Split into phases</button>';
    applyPermissionGating();
    return;
  }

  section.style.display = 'block';
  const phases = getJobPhases(job);
  strip.innerHTML = phases.map(function (phase) {
    const card = getPhaseCard(job, phase.id);
    const col = card ? BOARD_COLUMNS.find(function (c) { return c.id === card.column; }) : null;
    const active = (phase.id || null) === (editingPhaseId || null);
    // Even the last remaining phase gets a delete button — deleting it
    // un-splits the job back to a single unphased task list instead of
    // being blocked, see deleteJobPhaseUI().
    // Nested tabbable spans (chip select, edit, delete) rather than a
    // sibling-controls restructure — the edit/delete clicks already rely
    // on event.stopPropagation() to not also trigger the chip's own
    // select, which applies identically to a keyboard-triggered .click()
    // (it dispatches a real, bubbling click event), so Tab reaching each
    // in DOM order and Enter/Space activating it behaves the same as a
    // mouse click on each already does — no visual or DOM-shape change.
    const kbdAttrs = ' tabindex="0" role="button" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();event.stopPropagation();this.click();}"';
    const delBtn = '<span class="job-phase-chip-del"' + kbdAttrs + ' data-min-tier="projectAdmin" onclick="event.stopPropagation(); deleteJobPhaseUI(\'' + phase.id + '\')" title="' +
      (phases.length > 1 ? 'Delete phase' : 'Remove phasing (merge back into the job)') + '">×</span>';
    // An unnamed phase (see splitJobIntoPhases()/renameJobPhaseUI()) shows a
    // placeholder instead of an empty chip, styled like a real input
    // placeholder so it reads as "click to name this" rather than a stray
    // literal label.
    const nameHtml = phase.name ? escapeHtml(phase.name) : '<span class="job-phase-chip-placeholder">Add name</span>';
    return '<span class="job-phase-chip' + (active ? ' active' : '') + '"' + kbdAttrs + ' onclick="selectJobPhase(\'' + phase.id + '\')" title="Click to select, click the pencil to rename">' +
      '<span class="job-card-board-dot" style="background:' + (col ? (col.color || '#3949ab') : '#ccc') + ';"></span>' +
      nameHtml +
      '<span class="job-phase-chip-edit"' + kbdAttrs + ' data-min-tier="projectAdmin" onclick="event.stopPropagation(); renameJobPhaseUI(\'' + phase.id + '\')" title="Rename phase">✎</span>' +
      delBtn + '</span>';
  }).join('') + '<button type="button" class="job-phase-strip-btn" data-min-tier="projectAdmin" onclick="addJobPhaseUI()">+ Add Phase</button>';
  applyPermissionGating();
}

// Nested one level under the phase strip — mirrors it almost exactly,
// minus any card/stage dot (a sub-phase never has its own card, so there's
// no "current stage" to show on its chip the way a phase chip does).
export function renderJobSubPhaseStrip(job: Job | null, phase: Phase | null): void {
  const strip = document.getElementById('jobSubPhaseStrip');
  if (!strip) return;
  if (!phase) { strip.style.display = 'none'; return; }

  if (!phase.subPhases || !phase.subPhases.length) {
    strip.style.display = 'block';
    strip.innerHTML = '<button type="button" class="job-phase-strip-btn" data-min-tier="projectAdmin" onclick="splitPhaseIntoSubPhasesUI()">+ Split into sub-phases</button>';
    applyPermissionGating();
    return;
  }

  strip.style.display = 'block';
  const subUnits = getPhaseSubUnits(phase);
  strip.innerHTML = subUnits.map(function (sub) {
    const active = (sub.id || null) === (editingSubPhaseId || null);
    // Same "last one un-splits instead of being blocked" treatment as the
    // phase strip above — see deleteSubPhaseUI().
    const kbdAttrs = ' tabindex="0" role="button" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();event.stopPropagation();this.click();}"';
    const delBtn = '<span class="job-phase-chip-del"' + kbdAttrs + ' data-min-tier="projectAdmin" onclick="event.stopPropagation(); deleteSubPhaseUI(\'' + sub.id + '\')" title="' +
      (subUnits.length > 1 ? 'Delete sub-phase' : 'Remove sub-phasing (merge back into the phase)') + '">×</span>';
    return '<span class="job-phase-chip' + (active ? ' active' : '') + '"' + kbdAttrs + ' onclick="selectJobSubPhase(\'' + sub.id + '\')" title="Click to select, click the pencil to rename">' +
      escapeHtml(sub.name) +
      '<span class="job-phase-chip-edit"' + kbdAttrs + ' data-min-tier="projectAdmin" onclick="event.stopPropagation(); renameSubPhaseUI(\'' + sub.id + '\')" title="Rename sub-phase">✎</span>' +
      delBtn + '</span>';
  }).join('') + '<button type="button" class="job-phase-strip-btn" data-min-tier="projectAdmin" onclick="addPhaseSubUnitUI()">+ Add Sub-Phase</button>';
  applyPermissionGating();
}

// Re-renders every phase-scoped part of the open job form for whichever
// phase is now selected — same fields editJob() seeds on first open.
export function renderJobFormForPhase(job: Job): void {
  const phase = getJobPhases(job).find(function (p) { return (p.id || null) === (editingPhaseId || null); }) || getJobPhases(job)[0];
  editingPhaseId = phase.id || null;
  renderJobPhaseStrip(job);
  renderJobLinkSection(job);
  ensureJobTasksMatchColumns(job);
  const subUnit = getPhaseSubUnits(phase).find(function (s) { return (s.id || null) === (editingSubPhaseId || null); }) || getPhaseSubUnits(phase)[0];
  editingSubPhaseId = subUnit.id || null;
  renderJobSubPhaseStrip(job, phase);
  renderFixedTaskGrid(subUnit.tasks);
  updateJobCurrentBoardIndicator(job, editingPhaseId);

  const primaryCard = getPrimaryPhaseCard(job);
  const phaseCard = getPhaseCard(job, editingPhaseId);
  (document.getElementById('f_due') as HTMLInputElement).value = (phaseCard && phaseCard.due) || '';
  renderJobCustomFieldsGrid((primaryCard && primaryCard.customFields) || {});
  renderJobTeamFieldsGrid((primaryCard && primaryCard.customFields) || {});
  jmDraftAttachments = JSON.parse(JSON.stringify((phaseCard && phaseCard.attachments) || []));
  renderJobAttachments();
}

export function selectJobPhase(phaseId: string): void {
  if (!editingJobId) return;
  flushAutoSaveJobForm();
  const found = findJob(editingJobId);
  if (!found) return;
  editingPhaseId = phaseId;
  renderJobFormForPhase(found.job);
}

export function splitJobIntoPhasesUI(): void {
  if (!hasMinTier('projectAdmin')) return;
  if (!editingJobId) return;
  flushAutoSaveJobForm();
  const found = findJob(editingJobId);
  if (!found) return;
  const name = window.prompt('Name for the first phase:', 'Phase 1');
  if (name === null) return; // cancelled — leave the job unphased
  splitJobIntoPhases(found.job);
  if (name.trim()) found.job.phases![0].name = name.trim();
  editingPhaseId = found.job.phases![0].id;
  saveJobs();
  logActivity('split job "' + found.job.name + '" into phases');
  renderJobFormForPhase(found.job);
  renderJobList();
  if (isPanelActive('gantt')) renderGantt();
  if (isPanelActive('calendar')) renderCalendar();
  if (isPanelActive('board')) renderBoard();
  queueSharedSync();
  showToast('Job split into phases', 'success');
}

export function addJobPhaseUI(): void {
  if (!hasMinTier('projectAdmin')) return;
  if (!editingJobId) return;
  flushAutoSaveJobForm();
  const found = findJob(editingJobId);
  if (!found) return;
  const nextNum = (found.job.phases ? found.job.phases.length : 0) + 1;
  const name = window.prompt('Name for the new phase:', 'Phase ' + nextNum);
  if (name === null) return; // cancelled — don't add a phase
  const phase = addJobPhase(found.job);
  if (name.trim()) phase.name = name.trim();
  const card = getPhaseCard(found.job, phase.id);
  if (card) card.title = found.job.name + ' — ' + phase.name;
  editingPhaseId = phase.id;
  saveJobs();
  logActivity('added phase "' + phase.name + '" to job "' + found.job.name + '"');
  renderJobFormForPhase(found.job);
  renderJobList();
  if (isPanelActive('gantt')) renderGantt();
  if (isPanelActive('calendar')) renderCalendar();
  if (isPanelActive('board')) renderBoard();
  queueSharedSync();
  showToast('Phase added', 'success');
}

export function renameJobPhaseUI(phaseId: string): void {
  if (!hasMinTier('projectAdmin')) return;
  if (!editingJobId) return;
  const found = findJob(editingJobId);
  if (!found) return;
  const phase = (found.job.phases || []).find(function (p) { return p.id === phaseId; });
  if (!phase) return;
  const newName = window.prompt('Rename phase (leave blank to clear the name):', phase.name);
  if (newName === null) return; // cancelled
  const trimmed = newName.trim();
  if (trimmed === (phase.name || '')) return; // unchanged
  phase.name = trimmed;
  // Card titles default to "Job — Phase" — keep that in sync with the rename
  // rather than leaving it stale (ensureJobHasCards() only sets it when a
  // card is first created, not on every load). No trailing " — " when the
  // phase name is blank.
  const card = getPhaseCard(found.job, phaseId);
  if (card) card.title = found.job.name + (phase.name ? ' — ' + phase.name : '');
  saveJobs();
  logActivity('renamed phase to "' + (phase.name || '(blank)') + '" on job "' + found.job.name + '"');
  renderJobPhaseStrip(found.job);
  renderJobList();
  if (isPanelActive('gantt')) renderGantt();
  if (isPanelActive('calendar')) renderCalendar();
  if (isPanelActive('board')) renderBoard();
  queueSharedSync();
}

export function deleteJobPhaseUI(phaseId: string): void {
  if (!hasMinTier('projectAdmin')) return;
  if (!editingJobId) return;
  const found = findJob(editingJobId);
  if (!found) return;
  const phases = found.job.phases || [];
  const phase = phases.find(function (p) { return p.id === phaseId; });
  if (!phase) return;

  if (phases.length <= 1) {
    // Deleting the job's only remaining phase doesn't leave it with zero
    // phases (not a valid state) — it un-splits the job back to a plain
    // unphased task list instead, the inverse of "+ Split into phases".
    if (phase.subPhases && phase.subPhases.length) {
      showToast('Delete this phase\'s sub-phases first', 'info');
      return;
    }
    if (!window.confirm('Remove phasing from "' + found.job.name + '"? Its tasks and card merge back into the job itself.')) return;
    flushAutoSaveJobForm();
    unsplitJobFromPhases(found.job);
    editingPhaseId = null;
    editingSubPhaseId = null;
    saveJobs();
    logActivity('removed phasing from job "' + found.job.name + '"');
    renderJobFormForPhase(found.job);
    renderJobList();
    if (isPanelActive('gantt')) renderGantt();
    if (isPanelActive('calendar')) renderCalendar();
    if (isPanelActive('board')) renderBoard();
    queueSharedSync();
    showToast('Job un-phased', 'success');
    return;
  }

  if (!window.confirm('Delete phase "' + phase.name + '"? This removes its card and dates.')) return;
  flushAutoSaveJobForm();
  // Copies taken before removal, for Undo. The delete itself goes out
  // right away (unlike a whole job's — see src/app/undo.ts): other devices
  // rebuild a phase that's missing but not tombstoned after a 5s grace
  // (healOrphanedPhaseCards() in src/sync/inbound.ts), so it can't wait.
  // Undo instead brings back an exact copy under fresh phase/card ids,
  // since the server keeps the old ones tombstoned for good.
  const phaseIdx = phases.indexOf(phase);
  const phaseCopy: Phase = JSON.parse(JSON.stringify(phase));
  const oldCard = getPhaseCard(found.job, phaseId);
  const cardCopy = oldCard ? JSON.parse(JSON.stringify(oldCard)) : null;
  const jobId = found.job.id;
  removeJobPhase(found.job, phaseId);
  if ((editingPhaseId || null) === phaseId) editingPhaseId = found.job.phases![0].id;
  saveJobs();
  logActivity('deleted phase "' + phase.name + '" from job "' + found.job.name + '"');
  renderJobFormForPhase(found.job);
  renderJobList();
  if (isPanelActive('gantt')) renderGantt();
  if (isPanelActive('calendar')) renderCalendar();
  if (isPanelActive('board')) renderBoard();
  queueSharedSync();
  offerUndo('Phase deleted', { commit: function () {}, undo: function () { restoreDeletedPhase(jobId, phaseIdx, phaseCopy, cardCopy); } });
}

function restoreDeletedPhase(jobId: string, phaseIdx: number, phaseCopy: Phase, cardCopy: BoardCard | null): void {
  const found = findJob(jobId);
  if (!found || !found.job.phases) { showToast('Couldn\'t restore the phase — its job is gone', 'error'); return; }
  const job = found.job;
  const newPhaseId = genId();
  const restored: Phase = Object.assign({}, phaseCopy, { id: newPhaseId });
  const phases = found.job.phases;
  phases.splice(Math.min(phaseIdx, phases.length), 0, restored);
  phases.forEach(function (p, i) { p.order = i; });
  if (cardCopy) boardCards.push(Object.assign({}, cardCopy, { id: genId(), phaseId: newPhaseId }));
  saveJobs();
  saveBoardCards();
  logActivity('restored deleted phase "' + restored.name + '" on job "' + job.name + '"');
  if (editingJobId === jobId) { editingPhaseId = newPhaseId; editingSubPhaseId = null; renderJobFormForPhase(job); }
  renderJobList();
  if (isPanelActive('gantt')) renderGantt();
  if (isPanelActive('calendar')) renderCalendar();
  if (isPanelActive('board')) renderBoard();
  queueSharedSync();
  showToast('Phase restored', 'success');
}

export function selectJobSubPhase(subId: string): void {
  if (!editingJobId) return;
  flushAutoSaveJobForm();
  const found = findJob(editingJobId);
  if (!found) return;
  editingSubPhaseId = subId;
  renderJobFormForPhase(found.job);
}

export function getCurrentEditingPhase(job: Job): Phase {
  return getJobPhases(job).find(function (p) { return (p.id || null) === (editingPhaseId || null); }) || getJobPhases(job)[0];
}

export function splitPhaseIntoSubPhasesUI(): void {
  if (!hasMinTier('projectAdmin')) return;
  if (!editingJobId) return;
  flushAutoSaveJobForm();
  const found = findJob(editingJobId);
  if (!found) return;
  const phase = getCurrentEditingPhase(found.job);
  const name = window.prompt('Name for the first sub-phase:', 'Sub-Phase 1');
  if (name === null) return;
  splitPhaseIntoSubPhases(phase);
  if (name.trim()) phase.subPhases![0].name = name.trim();
  editingSubPhaseId = phase.subPhases![0].id;
  saveJobs();
  logActivity('split phase "' + phase.name + '" into sub-phases');
  renderJobFormForPhase(found.job);
  if (isPanelActive('gantt')) renderGantt();
  if (isPanelActive('calendar')) renderCalendar();
  queueSharedSync();
  showToast('Phase split into sub-phases', 'success');
}

export function addPhaseSubUnitUI(): void {
  if (!hasMinTier('projectAdmin')) return;
  if (!editingJobId) return;
  flushAutoSaveJobForm();
  const found = findJob(editingJobId);
  if (!found) return;
  const phase = getCurrentEditingPhase(found.job);
  const nextNum = (phase.subPhases ? phase.subPhases.length : 0) + 1;
  const name = window.prompt('Name for the new sub-phase:', 'Sub-Phase ' + nextNum);
  if (name === null) return;
  const sub = addPhaseSubUnit(phase);
  if (name.trim()) sub.name = name.trim();
  editingSubPhaseId = sub.id;
  saveJobs();
  logActivity('added sub-phase "' + sub.name + '" to phase "' + phase.name + '"');
  renderJobFormForPhase(found.job);
  if (isPanelActive('gantt')) renderGantt();
  if (isPanelActive('calendar')) renderCalendar();
  queueSharedSync();
  showToast('Sub-phase added', 'success');
}

export function renameSubPhaseUI(subId: string): void {
  if (!hasMinTier('projectAdmin')) return;
  if (!editingJobId) return;
  const found = findJob(editingJobId);
  if (!found) return;
  const phase = getCurrentEditingPhase(found.job);
  const sub = (phase.subPhases || []).find(function (s) { return s.id === subId; });
  if (!sub) return;
  const newName = window.prompt('Rename sub-phase:', sub.name);
  if (!newName || !newName.trim() || newName.trim() === sub.name) return;
  sub.name = newName.trim();
  saveJobs();
  logActivity('renamed sub-phase to "' + sub.name + '" on phase "' + phase.name + '"');
  renderJobSubPhaseStrip(found.job, phase);
  if (isPanelActive('gantt')) renderGantt();
  if (isPanelActive('calendar')) renderCalendar();
  queueSharedSync();
}

export function deleteSubPhaseUI(subId: string): void {
  if (!hasMinTier('projectAdmin')) return;
  if (!editingJobId) return;
  const found = findJob(editingJobId);
  if (!found) return;
  const phase = getCurrentEditingPhase(found.job);
  const subUnits = phase.subPhases || [];
  const sub = subUnits.find(function (s) { return s.id === subId; });
  if (!sub) return;

  if (subUnits.length <= 1) {
    // Same "last one un-splits instead of being blocked" treatment as
    // deleteJobPhaseUI() one level up — merges back into phase.tasks.
    if (!window.confirm('Remove sub-phasing from "' + phase.name + '"? Its dates merge back into the phase itself.')) return;
    flushAutoSaveJobForm();
    unsplitPhaseFromSubPhases(phase);
    editingSubPhaseId = null;
    saveJobs();
    logActivity('removed sub-phasing from phase "' + phase.name + '"');
    renderJobFormForPhase(found.job);
    if (isPanelActive('gantt')) renderGantt();
    if (isPanelActive('calendar')) renderCalendar();
    queueSharedSync();
    showToast('Phase un-sub-phased', 'success');
    return;
  }

  if (!window.confirm('Delete sub-phase "' + sub.name + '"? This removes its dates.')) return;
  flushAutoSaveJobForm();
  removePhaseSubUnit(phase, subId);
  if ((editingSubPhaseId || null) === subId) editingSubPhaseId = phase.subPhases![0].id;
  saveJobs();
  logActivity('deleted sub-phase "' + sub.name + '" from phase "' + phase.name + '"');
  renderJobFormForPhase(found.job);
  if (isPanelActive('gantt')) renderGantt();
  if (isPanelActive('calendar')) renderCalendar();
  queueSharedSync();
  showToast('Sub-phase deleted', 'success');
}

// ===== Linked Job section (Job Manager) =====
// Only shown once the job actually exists (mirrors the phase strip's own
// "not for the blank Add-New-Job draft" rule — nothing to link yet).
let jobLinkPickerOpen = false;
// Which other project the link picker is showing jobs from.
let jobLinkPickerProjectId: string | null = null;

export function renderJobLinkSection(job: Job | null): void {
  const section = document.getElementById('jobLinkSection');
  const body = document.getElementById('jobLinkBody');
  if (!section || !body) return;
  if (!job) { section.style.display = 'none'; jobLinkPickerOpen = false; return; }
  section.style.display = 'block';

  const link = job.link as { jobId: string; projectId: string } | null | undefined;
  if (link) {
    const otherProj = projects[link.projectId];
    const otherJob = otherProj && (otherProj.jobs || []).find(function (j: Job) { return j.id === link.jobId; });
    const label = otherJob ? otherJob.name : 'Unknown job';
    const projLabel = otherProj ? otherProj.name : '';
    body.innerHTML = '<div class="job-link-active-row">' +
      '<span class="job-link-name" title="' + escapeHtml(label + (projLabel ? ' (' + projLabel + ')' : '')) + '">🔗 ' + escapeHtml(label) + (projLabel ? ' <span style="opacity:0.65;">(' + escapeHtml(projLabel) + ')</span>' : '') + '</span>' +
      '<span class="board-col-gantt-switch' + (isLinkEnabledLocally(job.id) ? ' on' : '') + '" data-min-tier="projectAdmin" tabindex="0" role="button" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();this.click();}" onclick="toggleJobLinkEnabledUI()" title="Show on the other project\'s Gantt & Calendar (just for you — this doesn\'t change what anyone else sees)"><span class="knob"></span></span>' +
      '<button type="button" class="btn btn-secondary" data-min-tier="projectAdmin" style="padding: var(--s-1) var(--s-2-5);font-size: var(--t-xs);" onclick="unlinkJobUI()">Unlink</button>' +
      '</div>';
    applyPermissionGating();
    return;
  }

  // Any other (not archived) project. With just one, the button names it.
  const otherIds = getOtherProjectIds(activeProjectId);
  if (!otherIds.length) { section.style.display = 'none'; return; }
  if (!jobLinkPickerProjectId || otherIds.indexOf(jobLinkPickerProjectId) === -1) jobLinkPickerProjectId = otherIds[0];
  const otherProjectId = jobLinkPickerProjectId;
  const otherProj = projects[otherProjectId];

  if (!jobLinkPickerOpen) {
    const label = otherIds.length === 1 ? '+ Link to ' + escapeHtml(otherProj.name) + ' job' : '+ Link to a job in another project';
    body.innerHTML = '<button type="button" class="job-phase-strip-btn" data-min-tier="projectAdmin" onclick="openJobLinkPickerUI()">' + label + '</button>';
    applyPermissionGating();
    return;
  }

  const projectSelect = otherIds.length > 1
    ? '<select id="jobLinkProjectSelect" aria-label="Project" onchange="pickJobLinkProjectUI(this.value)">' + otherIds.map(function (id) {
        return '<option value="' + escapeHtml(id) + '"' + (id === otherProjectId ? ' selected' : '') + '>' + escapeHtml(projects[id].name) + '</option>';
      }).join('') + '</select>'
    : '';
  const otherJobs = ((otherProj && otherProj.jobs) || []).filter(function (j: Job) { return !j.archived; });
  const options = otherJobs.map(function (j: Job) { return '<option value="' + j.id + '">' + escapeHtml(j.name) + '</option>'; }).join('');
  body.innerHTML = '<div class="job-link-picker-row">' + projectSelect +
    '<select id="jobLinkPickerSelect" aria-label="Job">' + (options || '<option value="">No jobs available</option>') + '</select>' +
    '<button type="button" class="btn btn-primary" data-min-tier="projectAdmin" style="padding: var(--s-1-25) var(--s-3);font-size: var(--t-xs);" onclick="confirmJobLinkUI(\'' + otherProjectId + '\')"' + (otherJobs.length ? '' : ' disabled') + '>Link</button>' +
    '<button type="button" class="btn btn-secondary" style="padding: var(--s-1-25) var(--s-3);font-size: var(--t-xs);" onclick="cancelJobLinkPickerUI()">Cancel</button>' +
    '</div>';
  applyPermissionGating();
}

export function openJobLinkPickerUI(): void {
  jobLinkPickerOpen = true;
  const found = editingJobId && findJob(editingJobId);
  if (found) renderJobLinkSection(found.job);
}

export function pickJobLinkProjectUI(projectId: string): void {
  jobLinkPickerProjectId = projectId;
  const found = editingJobId && findJob(editingJobId);
  if (found) renderJobLinkSection(found.job);
}

export function cancelJobLinkPickerUI(): void {
  jobLinkPickerOpen = false;
  const found = editingJobId && findJob(editingJobId);
  if (found) renderJobLinkSection(found.job);
}

export function confirmJobLinkUI(otherProjectId: string): void {
  if (!hasMinTier('projectAdmin')) return;
  const found = editingJobId && findJob(editingJobId);
  if (!found) return;
  const select = document.getElementById('jobLinkPickerSelect') as HTMLSelectElement | null;
  const otherJobId = select && select.value;
  if (!otherJobId) return;
  const ok = linkJobs(found.job, activeProjectId, otherJobId, otherProjectId);
  jobLinkPickerOpen = false;
  if (!ok) { showToast('Could not link — that job may have been deleted', 'error'); return; }
  logActivity('linked job "' + found.job.name + '" to another project\'s job');
  renderJobLinkSection(found.job);
  showToast('Jobs linked — turn on the switch to show it on both schedules', 'success');
}

export function toggleJobLinkEnabledUI(): void {
  // Defense-in-depth matching the switch's own data-min-tier hide above —
  // per the user, showing a linked job on your own Gantt/Calendar is
  // Admin/Project Admin only (creating the link itself was already
  // projectAdmin-gated — see confirmJobLinkUI()).
  if (!hasMinTier('projectAdmin')) return;
  const found = editingJobId && findJob(editingJobId);
  if (!found || !found.job.link) return;
  const newState = !isLinkEnabledLocally(found.job.id);
  setJobLinkEnabled(found.job.id, activeProjectId, newState);
  // No logActivity() here — this is a personal display preference now,
  // not a shared change, so it doesn't belong in the shared activity log.
  renderJobLinkSection(found.job);
  if (isPanelActive('gantt')) renderGantt();
  if (isPanelActive('calendar')) renderCalendar();
  showToast(newState ? 'Link turned on (just for you)' : 'Link turned off (just for you)', 'success');
}

export function unlinkJobUI(): void {
  if (!hasMinTier('projectAdmin')) return;
  const found = editingJobId && findJob(editingJobId);
  if (!found || !found.job.link) return;
  if (!window.confirm('Unlink this job? It will no longer show on the other project\'s schedule.')) return;
  unlinkJobById(found.job.id, activeProjectId);
  logActivity('unlinked job "' + found.job.name + '"');
  renderJobLinkSection(found.job);
  if (isPanelActive('gantt')) renderGantt();
  if (isPanelActive('calendar')) renderCalendar();
  showToast('Jobs unlinked', 'info');
}

// The job drawer (#formArea) slides in over whichever of Gantt/Board/
// Calendar is currently active — see the .manager-form-area/.open CSS.
// Opening/closing it is separate from jobForm's own display toggle (which
// autoSaveJobForm() etc. use as an "is a job actually loaded" guard) so
// the two can be called independently where it matters.
export function openJobDrawer(): void { document.getElementById('formArea')!.classList.add('open'); }
export function closeJobDrawer(): void { document.getElementById('formArea')!.classList.remove('open'); }

export function addNewJob(): void {
  // Defense-in-depth, matching promptDeleteJob()'s same pattern — its
  // trigger button is already data-min-tier gated (and hidden entirely,
  // see applyPermissionGating()), but a function-level check here doesn't
  // depend on that DOM state having been applied correctly at the moment
  // of the click.
  if (!hasMinTier('projectAdmin')) return;
  // Whatever job was open before (if any) gets its pending autosave
  // committed before we swap the form over to a blank draft.
  flushAutoSaveJobForm();
  setJobNameHint(false);
  showTaskRowWarnings([]);
  editingJobId = null;
  editingTaskId = null;
  editingPhaseId = null;
  editingSubPhaseId = null;
  renderJobPhaseStrip(null);
  renderJobSubPhaseStrip(null, null);
  renderJobLinkSection(null);
  openJobDrawer();
  collapseAllMobileFields();
  (document.getElementById('jobForm') as HTMLElement).style.display = 'block';
  document.getElementById('formTitle')!.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right: var(--s-0-75)" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" fill="#28a745"/><rect x="11" y="6.5" width="2" height="11" rx="1" fill="#fff"/><rect x="6.5" y="11" width="11" height="2" rx="1" fill="#fff"/></svg>Add New Job';
  (document.getElementById('deleteBtn') as HTMLElement).style.display = 'none';
  (document.getElementById('archiveBtn') as HTMLElement).style.display = 'none';
  (document.getElementById('duplicateJobBtn') as HTMLElement).style.display = 'none';
  (document.getElementById('f_job') as HTMLInputElement).value = '';
  (document.getElementById('f_color') as HTMLInputElement).value = '#3949ab';
  (document.getElementById('f_due') as HTMLInputElement).value = '';
  jmDraftAttachments = [];
  renderJobCustomFieldsGrid({});
  renderJobTeamFieldsGrid({});
  renderJobAttachments();
  // No job exists yet to attach comments to — the panel reappears once
  // autoSaveJobForm() materializes this draft into a real job with an id.
  (document.getElementById('jobCommentsPanel') as HTMLElement).style.display = 'none';
  updateJobCurrentBoardIndicator(null);
  const defaultTasks: Task[] = BOARD_COLUMNS.map(function (col, i) {
    return { id: genId(), name: col.label, columnId: col.id, start: '', finish: '', notes: '', color: col.color || '#3949ab', order: i };
  });
  renderFixedTaskGrid(defaultTasks);
  document.querySelectorAll('.color-preset').forEach((p) => p.classList.remove('selected'));
  updateJobColorSwatch();
  toggleJobColorPanel(false);
  renderJobList();
}

export function editJob(jobId: string, phaseId?: string | null, subPhaseId?: string | null): void {
  // Whatever job was open before (if any, and if different) gets its
  // pending autosave committed before we swap the form to this one.
  if (editingJobId !== jobId) flushAutoSaveJobForm();
  const found = findJob(jobId);
  if (!found) return;
  // Defense-in-depth to match every list-render's own filter (see
  // isJobVisibleToMe()/getVisibleJobs()) — closes the gap for any entry
  // point that resolves straight to a jobId without going through one of
  // those filtered lists (e.g. a stale reference, or calling this
  // directly). Also covers calendarOpenJob() (forwards here) and
  // jumpToLinkedJobReference() (switches project, then calls this against
  // the newly-active project's own data).
  if (!isJobVisibleToMe(found.job)) return;
  const job = found.job;

  editingJobId = jobId;
  // phaseId undefined (e.g. the sidebar's plain click) means "whatever was
  // last selected, or the first phase" — only an explicit phaseId (from a
  // Gantt/Calendar row for a specific phase) should override that. Same
  // idea one level down for subPhaseId.
  editingPhaseId = phaseId !== undefined ? phaseId : editingPhaseId;
  editingSubPhaseId = subPhaseId !== undefined ? subPhaseId : editingSubPhaseId;
  setJobNameHint(false);
  showTaskRowWarnings([]);

  openJobDrawer();
  collapseAllMobileFields();
  (document.getElementById('jobForm') as HTMLElement).style.display = 'block';
  document.getElementById('formTitle')!.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right: var(--s-0-75)" xmlns="http://www.w3.org/2000/svg"><path d="M4 20l1-4.5L15.5 5 19 8.5 8.5 19 4 20z" fill="#f0ad4e"/><path d="M15.5 5L19 8.5" stroke="#fff" stroke-width="1"/></svg> Edit Job';
  (document.getElementById('deleteBtn') as HTMLElement).style.display = 'inline-flex';
  (document.getElementById('duplicateJobBtn') as HTMLElement).style.display = 'flex';
  (document.getElementById('f_job') as HTMLInputElement).value = job.name;
  (document.getElementById('f_color') as HTMLInputElement).value = job.color;
  syncCardColumns();

  // Phase strip + task grid + description/due/customFields/checklists/
  // attachments + board indicator, all scoped to editingPhaseId — see
  // renderJobFormForPhase(). Also resolves editingPhaseId to a valid phase
  // (defaulting to the first one) if it wasn't set to a real one above.
  renderJobFormForPhase(job);
  const firstPhaseTasks = (getJobPhases(job).find(function (p) { return (p.id || null) === (editingPhaseId || null); }) || { tasks: undefined as Task[] | undefined }).tasks;
  editingTaskId = firstPhaseTasks && firstPhaseTasks[0] ? firstPhaseTasks[0].id : null;

  const commentsPanel = document.getElementById('jobCommentsPanel') as HTMLElement;
  commentsPanel.style.display = 'flex';
  commentsPanel.classList.add('collapsed'); // collapsed is the resting state each time a job opens — see toggleJobCommentsPanel()
  document.getElementById('formArea')!.classList.add('comments-collapsed');
  (document.getElementById('newJobCommentText') as HTMLTextAreaElement).value = '';
  const newCommentImportantEl = document.getElementById('newJobCommentImportant') as HTMLInputElement | null;
  if (newCommentImportantEl) newCommentImportantEl.checked = false;
  renderJobComments(job);
  document.querySelectorAll('.color-preset').forEach((p) => {
    (p as HTMLElement).classList.toggle('selected', (p as HTMLElement).dataset.color === job.color);
  });
  updateJobColorSwatch();
  toggleJobColorPanel(false);

  const archiveBtn = document.getElementById('archiveBtn') as HTMLElement;
  archiveBtn.style.display = 'inline-flex';
  if (job.archived) {
    archiveBtn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right: var(--s-0-75)" xmlns="http://www.w3.org/2000/svg"><path d="M6 8H3V5" stroke="#3949ab" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 8a9 9 0 1 1 2 8" stroke="#3949ab" stroke-width="2" fill="none" stroke-linecap="round"/></svg> Restore';
    archiveBtn.onclick = function () { restoreJob(jobId); };
  } else {
    archiveBtn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right: var(--s-0-75)" xmlns="http://www.w3.org/2000/svg"><path d="M3 8l9-4 9 4-9 4-9-4z" fill="#d7ccc8"/><path d="M3 8v9l9 4V12L3 8z" fill="#bcaaa4"/><path d="M21 8v9l-9 4V12l9-4z" fill="#a1887f"/></svg> Archive';
    archiveBtn.onclick = function () { archiveJob(jobId); };
  }

  renderJobList();
}

// Dragging/resizing a bar on the Gantt or Calendar edits job.tasks directly,
// bypassing the Job Manager's own Save button. If that same job's form is
// open, its date inputs would otherwise keep showing the pre-drag values
// until the user closes and reopens it — so re-render the grid in place.
// Anything that edits a job's tasks or its linked card from outside the
// job form itself (Gantt/Calendar drags, or the Board's quick-edit card
// popup — saveCard()) needs to call this, or the open form keeps showing
// whatever was there when it was first opened.
export function refreshJobFormIfOpen(jobId: string): void {
  if (editingJobId !== jobId) return;
  const found = findJob(jobId);
  if (!found) {
    // Deleted (or this browser switched to a project that no longer has
    // it) while it was open here — close cleanly instead of leaving a
    // ghost form whose next autosave would treat it as a blank new draft
    // and resurrect it with whatever stale data was still in the fields.
    cancelPendingJobAutosave();
    editingJobId = null;
    editingTaskId = null;
    setJobNameHint(false);
    showTaskRowWarnings([]);
    closeJobDrawer();
    (document.getElementById('jobForm') as HTMLElement).style.display = 'none';
    (document.getElementById('jobCommentsPanel') as HTMLElement).style.display = 'none';
    renderJobList();
    showToast('This job is no longer available — it may have been deleted', 'info');
    return;
  }
  const job = found.job;
  const phase = getJobPhases(job).find(function (p) { return (p.id || null) === (editingPhaseId || null); }) || getJobPhases(job)[0];
  editingPhaseId = phase.id || null;
  renderJobPhaseStrip(job);
  renderJobLinkSection(job);
  const subUnit = getPhaseSubUnits(phase).find(function (s) { return (s.id || null) === (editingSubPhaseId || null); }) || getPhaseSubUnits(phase)[0];
  editingSubPhaseId = subUnit.id || null;
  renderJobSubPhaseStrip(job, phase);
  renderFixedTaskGrid(subUnit.tasks);
  const card = getPhaseCard(job, editingPhaseId);
  if (!card) return;
  const dueEl = document.getElementById('f_due') as HTMLInputElement | null;
  if (dueEl) dueEl.value = card.due || '';
  const primaryCard = getPrimaryPhaseCard(job);
  renderJobCustomFieldsGrid((primaryCard && primaryCard.customFields) || {});
  renderJobTeamFieldsGrid((primaryCard && primaryCard.customFields) || {});
  jmDraftAttachments = JSON.parse(JSON.stringify(card.attachments || []));
  renderJobAttachments();
}

// ===== JOB FORM AUTOSAVE =====
// Replaces the old explicit "Save Job" button. Every field change schedules
// a debounced save; leaving a field, switching jobs, changing tabs, or the
// tab closing/hiding all flush it immediately (see the listener wiring
// below and the visibilitychange/pagehide handlers near queueSharedSync).
// Bulletproofing rules, since nothing here is gated by a button anymore:
//  - A brand-new job is never pushed into `jobs` (and never synced to the
//    team) until it has a non-blank name — so an abandoned "+ Add Job"
//    with nothing typed leaves no trace.
//  - An EXISTING job's name is never overwritten with blank — clearing the
//    field just shows a hint and keeps the last saved name until it's
//    fixed, instead of corrupting shared data other people can see.
//  - A task row with an invalid date pairing (only one of start/finish
//    set, or start after finish) is skipped — that row keeps its last
//    valid start/finish rather than saving the bad value — while every
//    other valid row still saves normally.
const jobAutosave = createAutosaveController(function () { autoSaveJobForm(); }, 500);
export function scheduleAutoSaveJobForm(): void { jobAutosave.schedule(); }
export function flushAutoSaveJobForm(): void { jobAutosave.flush(); }
// Use before destructive transitions (deleting/clearing the job this form
// is open on) so a pending timer can't fire afterward and resurrect it
// from stale form values.
export function cancelPendingJobAutosave(): void { jobAutosave.cancel(); }

export function setJobNameHint(show: boolean): void {
  const hint = document.getElementById('f_job_hint');
  if (hint) hint.style.display = show ? 'block' : 'none';
}
export function showTaskRowWarnings(labels: string[]): void {
  const el = document.getElementById('taskRowsWarning');
  if (!el) return;
  if (!labels.length) { el.style.display = 'none'; el.textContent = ''; return; }
  el.style.display = 'block';
  el.textContent = labels.join(', ') + (labels.length === 1 ? ' needs' : ' need') +
    ' both a start and finish date (start before finish), or both left blank — not saved until fixed.';
}

export function autoSaveJobForm(): void {
  // Nothing to save against — either no job is open, or the panel that
  // hosts these fields isn't even in the DOM (defensive; shouldn't happen).
  if ((document.getElementById('jobForm') as HTMLElement).style.display === 'none') return;
  if (!BOARD_COLUMNS.length) return;

  const name = (document.getElementById('f_job') as HTMLInputElement).value.trim();
  const color = (document.getElementById('f_color') as HTMLInputElement).value;
  const existing = editingJobId ? findJob(editingJobId) : null;
  let job: Job | null = existing ? existing.job : null;
  const isNewDraft = !job;
  // A brand-new draft has no phases yet (opt-in, added afterward via the
  // phase strip once the job is real) — always editingPhaseId=null then.
  // IMPORTANT: getJobPhases()/getPhaseSubUnits() always return SOMETHING
  // (a synthetic single-entry wrapper when there's no real phases/
  // subPhases array) so every OTHER read-only consumer can stay agnostic
  // to whether a job is split. That wrapper is a fresh, thrown-away object
  // each call though — writing to its .tasks only reassigns the wrapper's
  // own property, never job.tasks/phase.tasks itself. So unlike every
  // read-only use of these helpers elsewhere, the actual SAVE target here
  // must only ever be a real array entry — targetPhase/targetSubUnit stay
  // null (falling through to job.tasks) unless job.phases/phase.subPhases
  // genuinely exist, never just because the helper always returns *a*
  // phase-shaped object. (Bug found in review: this used to check
  // `if (targetPhase)` — always truthy since the helper never returns
  // null — so an unphased job's date edits silently never reached
  // job.tasks at all.)
  const targetPhase = (job && job.phases && job.phases.length)
    ? getJobPhases(job).find(function (p) { return (p.id || null) === (editingPhaseId || null); })
    : null;
  const targetSubUnit = (targetPhase && targetPhase.subPhases && targetPhase.subPhases.length)
    ? getPhaseSubUnits(targetPhase).find(function (s) { return (s.id || null) === (editingSubPhaseId || null); })
    : null;
  const taskSaveTarget = targetSubUnit || targetPhase; // null falls through to job.tasks below

  if (isNewDraft && !name) {
    // Waiting on a name before this draft becomes a real, shared job.
    setJobNameHint(true);
    return;
  }
  setJobNameHint(false);

  const warnings: string[] = [];
  const cleanedTasks: Task[] = [];
  for (let i = 0; i < BOARD_COLUMNS.length; i++) {
    const col = BOARD_COLUMNS[i];
    const label = col.label;
    // Prior known-good value for this slot: the live phase's task if one
    // exists, otherwise whatever the grid was last rendered with (covers
    // a still-unmaterialized draft, which has no tasks yet).
    const priorTask = (taskSaveTarget && taskSaveTarget.tasks && taskSaveTarget.tasks[i]) || currentGridTasks[i] || null;

    if ((col as any).hideFromSchedule) {
      cleanedTasks.push(priorTask ? Object.assign({}, priorTask, { columnId: col.id, order: i }) : {
        id: genId(), name: label, columnId: col.id, start: '', finish: '', notes: '', color: col.color || '#3949ab', order: i,
      });
      continue;
    }

    const row = document.querySelector('#taskRows .task-fixed-row[data-index="' + i + '"]') as HTMLElement | null;
    if (!row) continue; // shouldn't happen while col is visible, but don't block save over it

    const rowStart = ((row.querySelector('.task-fixed-start') as HTMLInputElement).value || '').trim();
    const rowFinish = ((row.querySelector('.task-fixed-finish') as HTMLInputElement).value || '').trim();

    let useStart = rowStart, useFinish = rowFinish;
    const badRange = !!(rowStart && rowFinish && new Date(rowStart) > new Date(rowFinish));
    const halfSet = (rowStart && !rowFinish) || (!rowStart && rowFinish);
    if (badRange || halfSet) {
      warnings.push(label);
      useStart = (priorTask && priorTask.start) || '';
      useFinish = (priorTask && priorTask.finish) || '';
    }

    cleanedTasks.push({
      id: row.dataset.taskId || (priorTask && priorTask.id) || genId(),
      name: label,
      columnId: col.id,
      start: useStart,
      finish: useFinish,
      // No per-task notes column in this compact grid anymore — carry
      // forward whatever was already there (e.g. from before this change,
      // or the description field) rather than a UI wiping it silently.
      notes: (priorTask && priorTask.notes) || '',
      color: row.dataset.color || color,
      order: i,
    });
  }
  showTaskRowWarnings(warnings);

  let justCreated = false;
  if (job) {
    if (name) job.name = name; // never blank an existing job's name
    job.color = color;
    if (taskSaveTarget) {
      taskSaveTarget.tasks = cleanedTasks;
    } else {
      job.tasks = cleanedTasks;
    }
    // A date change counts as "the schedule changed" (Section 5) — release
    // any manual column override so auto-sync resumes right away instead
    // of waiting out the 24h window.
    const linkedCard = getPhaseCard(job, editingPhaseId);
    if (linkedCard) { (linkedCard as any).manualColumn = null; (linkedCard as any).manualColumnUntil = null; }
  } else {
    job = { id: genId(), name: name, color: color, archived: false, comments: [], tasks: cleanedTasks };
    jobs.push(job);
    editingJobId = job.id;
    editingTaskId = job.tasks![0] ? job.tasks![0].id : null;
    ensureJobHasCards(job); // give it a board card immediately, not just on next load
    editingPhaseId = null;
    justCreated = true;
  }

  // The selected phase's card carries due/attachments — the same fields
  // the Board's quick-edit popup manages, so whichever place last saved
  // wins (same last-write-wins model already used everywhere else in this
  // app). Checklists are no longer edited here at all — see the "My
  // Checklist" tab — so this never touches card.checklists/
  // checklistAssignees; whatever's there stays exactly as My Checklist
  // last left it. Custom fields (PM/Foreman/etc.) are job-wide, not
  // per-phase, so they always go on the primary (first-phase) card
  // regardless of which phase tab is selected — see getPrimaryPhaseCard().
  const cardToUpdate = getPhaseCard(job, editingPhaseId);
  if (cardToUpdate) {
    cardToUpdate.due = (document.getElementById('f_due') as HTMLInputElement).value;
    cardToUpdate.attachments = jmDraftAttachments as any;
  }
  const primaryCardToUpdate = getPrimaryPhaseCard(job);
  if (primaryCardToUpdate) primaryCardToUpdate.customFields = collectJobCustomFieldValues();

  saveJobs();
  logActivity((justCreated ? 'added job' : 'updated job') + ' "' + job.name + '"');
  renderJobList();
  if (isPanelActive('gantt')) renderGantt();
  if (isPanelActive('calendar')) renderCalendar();
  syncCardColumns();
  if (isPanelActive('board')) renderBoard();
  updateJobCurrentBoardIndicator(job, editingPhaseId);
  if (justCreated) { renderJobPhaseStrip(job); renderJobLinkSection(job); }

  if (justCreated) {
    // These previously only appeared after the explicit Save Job click —
    // now that the job is real, unlock them the same way.
    (document.getElementById('deleteBtn') as HTMLElement).style.display = 'inline-flex';
    (document.getElementById('duplicateJobBtn') as HTMLElement).style.display = 'flex';
    const archiveBtn = document.getElementById('archiveBtn') as HTMLElement;
    archiveBtn.style.display = 'inline-flex';
    archiveBtn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right: var(--s-0-75)" xmlns="http://www.w3.org/2000/svg"><path d="M3 8l9-4 9 4-9 4-9-4z" fill="#d7ccc8"/><path d="M3 8v9l9 4V12L3 8z" fill="#bcaaa4"/><path d="M21 8v9l-9 4V12l9-4z" fill="#a1887f"/></svg> Archive';
    archiveBtn.onclick = function () { archiveJob(job!.id); };
    const commentsPanel = document.getElementById('jobCommentsPanel') as HTMLElement;
    commentsPanel.style.display = 'flex';
    commentsPanel.classList.add('collapsed');
    document.getElementById('formArea')!.classList.add('comments-collapsed');
    renderJobComments(job);
    showToast('Job created', 'success');
  }
}

// Attached once at init — these are static elements (f_job/f_color/etc.)
// that never get recreated, unlike the task grid rows (which wire their
// own listeners fresh on every renderFixedTaskGrid()). Using addEventListener
// here — rather than an inline oninput= that also does other things —
// means programmatic population in editJob()/addNewJob() (plain
// `.value = ...`, which never fires input/change events) never triggers
// a spurious autosave just from opening a job.
export function initJobFormAutosaveListeners(): void {
  const nameEl = document.getElementById('f_job') as HTMLInputElement;
  nameEl.addEventListener('input', function () {
    setJobNameHint(!nameEl.value.trim());
    scheduleAutoSaveJobForm();
  });

  document.getElementById('f_color')!.addEventListener('input', scheduleAutoSaveJobForm);
  document.getElementById('f_due')!.addEventListener('change', scheduleAutoSaveJobForm);

  // Custom field inputs/selects are rebuilt on every renderJobCustomFieldsGrid()
  // call, so delegate from the static parent instead of binding per-field.
  const grid = document.getElementById('jmCustomFieldsGrid')!;
  grid.addEventListener('input', function (e) { if ((e.target as HTMLElement).dataset.field) scheduleAutoSaveJobForm(); });
  grid.addEventListener('change', function (e) { if ((e.target as HTMLElement).dataset.field) scheduleAutoSaveJobForm(); });

  const teamGrid = document.getElementById('jmTeamFieldsGrid')!;
  teamGrid.addEventListener('input', function (e) { if ((e.target as HTMLElement).dataset.field) scheduleAutoSaveJobForm(); });
  teamGrid.addEventListener('change', function (e) { if ((e.target as HTMLElement).dataset.field) scheduleAutoSaveJobForm(); });

  // Leaving any field in the form (tab/click to another field, or away
  // entirely) flushes immediately instead of waiting out the debounce.
  document.getElementById('jobForm')!.addEventListener('focusout', flushAutoSaveJobForm);
}

export function cancelEdit(): void {
  // Closing the form still commits whatever was last typed — there's no
  // "discard" anymore now that edits save as you go.
  flushAutoSaveJobForm();
  editingJobId = null;
  editingTaskId = null;
  setJobNameHint(false);
  showTaskRowWarnings([]);
  closeJobDrawer();
  (document.getElementById('jobForm') as HTMLElement).style.display = 'none';
  (document.getElementById('jobCommentsPanel') as HTMLElement).style.display = 'none';
  renderJobList();
}

// ===== JOB MANAGER: color picker/mobile-accordion chrome =====
export function buildColorPresets(): void {
  const container = document.getElementById('colorPresets')!;
  container.innerHTML = '';
  COLOR_PRESETS.forEach((c: string) => {
    const div = document.createElement('div');
    div.className = 'color-preset';
    div.style.background = c;
    div.dataset.color = c;
    div.onclick = () => {
      (document.getElementById('f_color') as HTMLInputElement).value = c;
      container.querySelectorAll('.color-preset').forEach((p) => p.classList.remove('selected'));
      div.classList.add('selected');
      updateJobColorSwatch();
      scheduleAutoSaveJobForm();
    };
    container.appendChild(div);
  });
}

export function updateJobColorSwatch(): void {
  (document.getElementById('jobColorToggleSwatch') as HTMLElement).style.background = (document.getElementById('f_color') as HTMLInputElement).value;
}

export function toggleJobColorPanel(forceOpen?: boolean): void {
  const panel = document.getElementById('jobColorPickerPanel')!;
  const arrow = document.getElementById('jobColorToggleArrow')!;
  const open = forceOpen != null ? forceOpen : !panel.classList.contains('open');
  panel.classList.toggle('open', open);
  arrow.classList.toggle('open', open);
}

// Mobile-only accordion for the job drawer's fields (Job Name/Tasks/
// Description/Due Date/Custom Fields/Checklist/Attachments/Comments) — see
// the .mobile-collapsible rules under @media (max-width:480px). Harmless
// on desktop: nothing there hides .mobile-field-body regardless of this
// class, so toggling it has no visual effect above that width.
export function toggleMobileField(headerEl: HTMLElement): void {
  const section = headerEl.closest('.mobile-collapsible');
  if (section) section.classList.toggle('expanded');
}

// Every field collapsed is the resting state each time a job is opened —
// called from editJob()/addNewJob(), not just once, since the same
// drawer/section elements are reused (repopulated in place) across jobs
// rather than rebuilt, so a section left expanded on one job would
// otherwise still be expanded when the next one opens.
export function collapseAllMobileFields(): void {
  document.querySelectorAll('.mobile-collapsible.expanded').forEach(function (el) {
    el.classList.remove('expanded');
  });
}

// ===== JOB MANAGER: same card fields as the card modal (see
// src/views/board.ts's renderCustomFieldsGrid()/renderTeamFieldsGrid()),
// mirrored onto the job form so a job's linked card can be fully edited
// from either place. Both read/write the same boardCards entry, so edits
// made in one show up in the other next time it's opened. =====
export function renderJobCustomFieldsGrid(values: Record<string, unknown>): void {
  values = values || {};
  const grid = document.getElementById('jmCustomFieldsGrid');
  if (!grid) return;
  const defs = CUSTOM_FIELD_DEFS.filter((d) => TEAM_FIELD_KEYS.indexOf(d.key) === -1);
  grid.innerHTML = defs.map((def) => renderFieldDefHtml(def, values[def.key] || '', function () { renderJobCustomFieldsGrid(collectJobCustomFieldValues()); }, 'jm')).join('');
  applyPermissionGating(); // rebuilt on every job-form open, outside renderAll()'s own sweep
}

// See renderJobCustomFieldsGrid() above for why pm/foreman/members are
// split out here (mirrors board.ts's renderTeamFieldsGrid()).
export function renderJobTeamFieldsGrid(values: Record<string, unknown>): void {
  values = values || {};
  const grid = document.getElementById('jmTeamFieldsGrid');
  if (!grid) return;
  const defs = CUSTOM_FIELD_DEFS.filter((d) => TEAM_FIELD_KEYS.indexOf(d.key) !== -1);
  grid.innerHTML = defs.map((def) => renderFieldDefHtml(def, values[def.key] || '', function () { renderJobTeamFieldsGrid(collectJobCustomFieldValues()); }, 'jm')).join('');
  applyPermissionGating();
}

export function collectJobCustomFieldValues(): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  document.querySelectorAll('#jmCustomFieldsGrid [data-field], #jmTeamFieldsGrid [data-field]').forEach((el) => {
    const input = el as HTMLInputElement;
    if (input.type === 'checkbox') {
      if (!values[input.dataset.field!]) values[input.dataset.field!] = [];
      if (input.checked) (values[input.dataset.field!] as string[]).push(input.value);
    } else {
      values[input.dataset.field!] = input.value.trim();
    }
  });
  return values;
}

const JM_ATTACHMENT_PANEL_CONFIG = {
  draftArrayGetter: function () { return jmDraftAttachments as any[]; },
  draftArraySetter: function (arr: unknown[]) { jmDraftAttachments = arr; },
  containerId: 'jmAttachmentItems',
  removeHandlerName: 'removeJobAttachment',
  flushFn: flushAutoSaveJobForm,
};
export function renderJobAttachments(): void { renderAttachmentPanel(JM_ATTACHMENT_PANEL_CONFIG); }
export function handleJobAttachmentUpload(e: Event): void { handleAttachmentPanelUpload(e, JM_ATTACHMENT_PANEL_CONFIG); }
export function removeJobAttachment(id: number): void { removeAttachmentPanelItem(id, JM_ATTACHMENT_PANEL_CONFIG); }
