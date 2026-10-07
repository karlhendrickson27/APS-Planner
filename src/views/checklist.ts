// Checklist system: per-card checklists, cross-cutting rather than
// Board-specific — Board's card-move gate, this file's own dedicated
// "Checklist" tab/rail-tab, a per-column "Manage Column Checklist"
// modal, and small Home-dashboard widgets all read/write the same
// per-card checklist data.
//
// Core primitives: ensureCardChecklists/normalizeChecklistAssignees/
// isChecklistStageVisibleToMe — pure data-shape helpers with no
// rendering and minimal mutation (a one-time legacy-data migration).
// src/views/board.ts declares ambient `declare function` signatures for
// all three and calls into these real implementations, which must stay
// structurally identical to those signatures.
//
// Board's card-move gate: getOpenChecklistItemsForCard/
// confirmChecklistBeforeMove. board.ts's own ambient signature for
// confirmChecklistBeforeMove() must match this file's real one exactly.
//
// canAssignChecklistStages() (standalone one-liner), the "Manage Column
// Checklist" modal (managingChecklistColumnId/openManageColumnChecklist/
// closeManageColumnChecklist/renderManageColumnChecklistBody/
// addColumnChecklistDefaultItem/removeColumnChecklistDefaultItem/
// getChecklistForStageInProject), and the entire "My Checklist" tab
// (buildMyChecklistRows through setMyChecklistStageAssignee).
import type { BoardCard, BoardColumn, ChecklistItem, ChecklistSubItem, Job, Phase } from '../core/types';
import { escapeHtml } from '../utils/html';
import { genId } from '../utils/id';
import { findJob, getJobPhases } from '../core/models';
import { pushProjectToShared } from '../sync/outbound';
import { closeAllColSettings, openEditCard } from './board';
import { openModal, closeModal, showToast, toggleMsDropdown, msSetAll, msDropdownLabelText } from '../utils/ui';
import { getEffectiveRole, hasMinTier } from '../auth/permissions';
import { getStoredUsername } from '../auth/session';
import { ensureUserRosterLoaded } from '../app/user-roster';
import { renderMyChecklistListInto, renderMyChecklistAssigneeDropdownInto, type MyChecklistItemRowProps, type MyChecklistAssigneeDropdownProps, type MyChecklistAssigneeOptionProps } from './checklist-mylist';
import { renderManageColumnChecklistBodyInto } from './checklist-manage-column';

// Ambient globals this file shares verbatim with other src/ files
// (BOARD_COLUMNS, activeProjectId, saveJobs(), etc.) are declared once
// in src/shared-globals.d.ts, not repeated here.
declare global {
  function switchProject(projectId: string): void;
}

// card.checklists (one array per board-column stage, keyed by column id)
// replaced a single flat card.checklist array — see BOARD_COLUMNS'
// defaultChecklist and getChecklistForStageInProject() (the My Checklist
// tab). Whatever legacy items existed land in the card's CURRENT column,
// since that's the best guess for which stage they belonged to. Mirrors
// the job.comments/job.notes migration pattern in
// src/core/jobs.ts's ensureJobAndTaskIds(). Idempotent and cheap (one
// property check) — call defensively anywhere card.checklists gets read
// or written.
function ensureCardChecklists(card: BoardCard): void {
  if (!card || card.checklists) return;
  card.checklists = {};
  const legacy = (card as { checklist?: ChecklistItem[] }).checklist;
  if (Array.isArray(legacy) && legacy.length) {
    card.checklists[card.column] = legacy;
  }
  delete (card as { checklist?: ChecklistItem[] }).checklist;
}

// ===== CHECKLIST STAGE VISIBILITY (whole-checklist-per-stage assignment) =====
// A board-column stage's whole checklist can optionally be restricted to
// one or more real user accounts (see setMyChecklistStageAssignee()
// below, the "My Checklist" tab) — everyone else, except admins,
// doesn't see that stage's checklist at all. This mirrors
// card.checklists' shape: card.checklistAssignees is a plain
// { [columnId]: username[] } map; an absent/empty array means "everyone
// can see it" (unchanged from before this existed — was originally a
// single username string, now an array so a stage can be shared by more
// than one person; normalizeChecklistAssignees() below coerces any
// still-stored legacy single-string values). This is a display-only
// filter, not real access control — the Durable Object still syncs the
// full card to every connected client, same trust model as the rest of
// this app (e.g. currentUserRole is likewise "UI convenience only").
function normalizeChecklistAssignees(assignedTo: unknown): string[] {
  if (Array.isArray(assignedTo)) return assignedTo as string[];
  return assignedTo ? [assignedTo as string] : [];
}
function isChecklistStageVisibleToMe(assigneesMap: Record<string, unknown> | undefined, columnId: string): boolean {
  const assignedTo = normalizeChecklistAssignees((assigneesMap || {})[columnId]);
  if (!assignedTo.length) return true;
  // While previewing (viewAsUsername set), the bypass reflects the
  // SIMULATED account's own role, not the real admin's — see hasMinTier()
  // and src/app/users-admin.ts's setViewAs() for the fuller rationale.
  const effectiveRole = getEffectiveRole();
  if (effectiveRole === 'admin') return true;
  const asUsername = viewAsUsername || getStoredUsername();
  return assignedTo.indexOf(asUsername) !== -1;
}

// Open (not-done) checklist items on a card's CURRENT stage, respecting
// per-stage visibility the same way buildCardEl()'s progress badge does —
// feeds confirmChecklistBeforeMove() below, used by both drag-and-drop
// (handleColumnDrop) and the mobile column <select> (moveCardToColumn) to
// warn before a card leaves a stage with unfinished items still on it. A
// checklist that's easy to ignore on a separate tab doesn't get used;
// tying it to the actual moment the job moves on is what makes it a real
// pause point instead of a suggestion.
function getOpenChecklistItemsForCard(card: BoardCard): string[] {
  ensureCardChecklists(card);
  if (!isChecklistStageVisibleToMe(card.checklistAssignees, card.column)) return [];
  const stageCol = BOARD_COLUMNS.find(function (c) { return c.id === card.column; });
  const templ = (stageCol && stageCol.defaultChecklist) || [];
  const stored = (card.checklists && card.checklists[card.column]) || [];
  const storedIds = stored.map(function (i) { return i.id; });
  const checklist: ChecklistItem[] = stored.filter(function (i) { return !i.removed; }).concat(
    templ.filter(function (d) { return storedIds.indexOf(d.id) === -1; }).map(function (d): ChecklistItem { return { id: d.id, text: d.text, done: false, assignee: '' }; })
  );
  // Once any item on this stage has been flagged required (the "killer
  // item" set — see toggleMyChecklistItemRequired() below), only THOSE
  // gate a move; a stage nobody's triaged yet still gates on
  // everything so this never silently goes quiet just because required
  // flags haven't been set up.
  const hasRequired = checklist.some(function (i) { return i.required; });
  const gating = hasRequired ? checklist.filter(function (i) { return i.required; }) : checklist;
  const open: string[] = [];
  gating.forEach(function (item) {
    if (!item.done) open.push(item.text);
    (item.subItems || []).forEach(function (sub: ChecklistSubItem) {
      if (!sub.done) open.push(item.text + ' → ' + sub.text);
    });
  });
  return open;
}

// Soft gate, not a hard block — a confirm dialog naming what's still open
// so leaving a stage with unfinished items is a deliberate choice, not an
// invisible default. Returns true (nothing to confirm, or user accepted).
function confirmChecklistBeforeMove(card: BoardCard): boolean {
  const open = getOpenChecklistItemsForCard(card);
  if (!open.length) return true;
  const preview = open.slice(0, 5).map(function (t) { return '- ' + t; }).join('\n');
  const more = open.length > 5 ? '\n...and ' + (open.length - 5) + ' more' : '';
  return window.confirm('"' + card.title + '" still has ' + open.length + ' open checklist item' + (open.length === 1 ? '' : 's') + ' on this stage:\n\n' + preview + more + '\n\nMove it anyway?');
}

// Who a stage's checklist is visible to takes >= Project Admin to set
// (everyone can still see the current value, read-only, since it's
// genuinely useful context — just can't change it). Project Admin gets the
// same content-editing powers as Admin within their assigned project; only
// true Admin bypasses a checklist's own per-stage privacy restriction (see
// isChecklistStageVisibleToMe()'s own effectiveRole === 'admin' check,
// via getEffectiveRole() — same View-As-aware resolution as hasMinTier()
// uses, not a hardcoded currentUserRole read). Same "UI convenience"
// caveat as currentUserRole itself: nothing server-side actually
// enforces this.
function canAssignChecklistStages(): boolean {
  return hasMinTier('projectAdmin');
}

// ===== BOARD COLUMN: DEFAULT CHECKLIST =====
// A column's default checklist template — see BOARD_COLUMNS[].
// defaultChecklist and getChecklistForStageInProject() below, which
// materializes these into a job's actual checklist the first time that
// stage's checklist is viewed. Reuses the same chip-list UI as Manage
// Custom Fields' option editor, just against {id, text} objects instead
// of plain strings, so an item stays individually removable even if its
// text duplicates another's.
let managingChecklistColumnId: string | null = null;

function openManageColumnChecklist(colId: string, event?: Event): void {
  if (event) event.stopPropagation();
  closeAllColSettings();
  const col = BOARD_COLUMNS.find(function (c) { return c.id === colId; });
  if (!col) return;
  managingChecklistColumnId = colId;
  document.getElementById('manageColumnChecklistTitle')!.textContent = col.label;
  renderManageColumnChecklistBody();
  openModal('manageColumnChecklistModal');
}

function closeManageColumnChecklist(): void {
  closeModal('manageColumnChecklistModal', function () {
    managingChecklistColumnId = null;
  });
}

function renderManageColumnChecklistBody(): void {
  const container = document.getElementById('manageColumnChecklistBody')!;
  const col = BOARD_COLUMNS.find(function (c) { return c.id === managingChecklistColumnId; });
  if (!col) return;
  const items = col.defaultChecklist || [];
  renderManageColumnChecklistBodyInto(container, {
    items: items.map(function (item) { return { itemId: item.id, text: item.text }; }),
    onRemove: removeColumnChecklistDefaultItem,
    onAddKeyDown: function (e: KeyboardEvent) { if (e.key === 'Enter') { e.preventDefault(); addColumnChecklistDefaultItem(); } },
    onAddClick: addColumnChecklistDefaultItem,
  });
}

function addColumnChecklistDefaultItem(): void {
  const input = document.getElementById('mcc_new_item') as HTMLInputElement;
  const text = input.value.trim();
  if (!text) return;
  const col = BOARD_COLUMNS.find(function (c) { return c.id === managingChecklistColumnId; });
  if (!col) return;
  if (!col.defaultChecklist) col.defaultChecklist = [];
  col.defaultChecklist.push({ id: genId(), text: text });
  input.value = '';
  saveBoardColumns();
  renderManageColumnChecklistBody();
}

function removeColumnChecklistDefaultItem(itemId: string): void {
  const col = BOARD_COLUMNS.find(function (c) { return c.id === managingChecklistColumnId; });
  if (!col) return;
  col.defaultChecklist = (col.defaultChecklist || []).filter(function (i) { return i.id !== itemId; });
  saveBoardColumns();
  renderManageColumnChecklistBody();
}

// ===== MY CHECKLIST =====
// Flat list of every checklist item assigned to the current account,
// within the ACTIVE project only — same scope as every other tab
// (Board/Calendar/Gantt); switching projects is what changes what shows
// here. No longer the default landing tab (Home is). A checklist buried
// in a card's edit modal is easy to forget exists; this surfaces "what's
// actually on you" the moment the app opens.
//
// Scoped to each card's CURRENT stage only (card.checklists[card.column])
// — the same scope buildCardEl()'s own checklist-progress badge already
// uses. A stage the job has already passed through isn't actionable
// right now.

// Returns the checklist array for one stage of a checklists map (a real
// card's card.checklists), seeding it from that board column's
// defaultChecklist template the first time it's asked for. Mutates
// checklists in place and returns the array. Reads defaultChecklist from
// the GIVEN project's own boardColumns, not the global BOARD_COLUMNS
// (which only ever reflects the active project) — needed since an
// interaction from My Checklist may be the first time a non-active
// project's stage checklist has ever been materialized.
function getChecklistForStageInProject(checklists: Record<string, ChecklistItem[]>, columnId: string, boardCols: BoardColumn[]): ChecklistItem[] {
  if (!checklists[columnId]) checklists[columnId] = [];
  const items = checklists[columnId];
  const col = (boardCols || []).find(function (c) { return c.id === columnId; });
  const defaults = (col && col.defaultChecklist) || [];
  const existingIds = items.map(function (i) { return i.id; });
  defaults.forEach(function (d) {
    if (existingIds.indexOf(d.id) === -1) items.push({ id: d.id, text: d.text, done: false, assignee: '' });
  });
  return items;
}

interface MyChecklistRow {
  job: Job;
  card: BoardCard;
  columnId: string;
  columnLabel: string;
  item: ChecklistItem;
  subItems: ChecklistSubItem[];
}

// Flat list of every checklist item assigned to the current user, for the
// ACTIVE project only — same scope as every other tab (Board/Calendar/
// Gantt), so switching projects is what changes what shows here. Uses the
// plain globals (boardCards/BOARD_COLUMNS/findJob()/isJobVisibleToMe())
// like the rest of the app, not the cross-project "...InProject" twins a
// prior version of this view needed.
function buildMyChecklistRows(): MyChecklistRow[] {
  const myUsername = viewAsUsername || getStoredUsername();
  const rows: MyChecklistRow[] = [];
  boardCards.forEach(function (card) {
    if (!card.column) return;
    const found = findJob(card.jobId as string);
    if (!found || found.job.archived) return;
    const job = found.job;
    if (!isJobVisibleToMe(job)) return;
    ensureCardChecklists(card);
    if (!isChecklistStageVisibleToMe(card.checklistAssignees, card.column)) return;
    const stageCol = BOARD_COLUMNS.find(function (c) { return c.id === card.column; });
    const stageLabel = stageCol ? stageCol.label : card.column;
    const templ = (stageCol && stageCol.defaultChecklist) || [];
    const stored = (card.checklists && card.checklists[card.column]) || [];
    const storedIds = stored.map(function (i) { return i.id; });
    const items: ChecklistItem[] = stored.filter(function (i) { return !i.removed; }).concat(
      templ.filter(function (d) { return storedIds.indexOf(d.id) === -1; })
        .map(function (d): ChecklistItem { return { id: d.id, text: d.text, done: false, assignee: [] }; })
    );
    items.forEach(function (item) {
      if (item.done) return;
      if (normalizeChecklistAssignees(item.assignee).indexOf(myUsername) === -1) return;
      rows.push({
        job: job, card: card, columnId: card.column, columnLabel: stageLabel,
        item: item, subItems: (item.subItems || []).filter(function (s) { return !s.done; })
      });
    });
  });
  rows.sort(function (a, b) { return a.job.name.localeCompare(b.job.name); });
  return rows;
}

// One .ms-dropdown multi-select block's props — shared by the per-item
// assignee picker (checklist-mylist.tsx) AND the toolbar's own "Visible
// to" picker (renderMyChecklistToolbar() below), both of which need the
// same roster/orphaned-account handling (an assignee no longer in the
// roster still gets a checked-but-orphaned checkbox instead of silently
// vanishing). Both now render through the same MyChecklistAssigneeDropdown
// Preact component (see renderMyChecklistAssigneeDropdownInto() in
// checklist-mylist.tsx) — genuinely the same UI in two contexts, not
// specialized rendering, so this stayed one shared builder even before
// the toolbar's own usage was converted. Replaced the old string-based
// myChecklistMsDropdownHtml(); onChangeOption plays the role its
// onchangePrefix string used to (extra leading args baked in via
// closure instead of string concatenation).
function buildMyChecklistAssigneeDropdownProps(
  idBase: string, current: string[], minTier: string, emptyLabel: string, extraClass: string | undefined,
  onChangeOption: (username: string, checked: boolean) => void
): MyChecklistAssigneeDropdownProps {
  const roster = cachedUserRoster || [];
  const orphaned = current.filter(function (u) { return !roster.some(function (r) { return r.username === u; }); });
  const options: MyChecklistAssigneeOptionProps[] = roster.map(function (u) {
    return { optKey: u.username, username: u.username, displayName: u.displayName, checked: current.indexOf(u.username) !== -1 };
  }).concat(orphaned.map(function (u) {
    return { optKey: u, username: u, displayName: u, checked: true };
  }));
  return {
    dropdownId: idBase,
    optionsId: idBase + '_options',
    loading: !cachedUserRoster,
    options: options,
    labelText: msDropdownLabelText(current.length, emptyLabel),
    extraClass: extraClass,
    minTier: minTier,
    onToggle: function () { toggleMsDropdown(idBase); },
    onSelectAll: function () { msSetAll(idBase + '_options', true); },
    onUnselectAll: function () { msSetAll(idBase + '_options', false); },
    onChangeOption: onChangeOption,
  };
}

// Flat list — one row per item, no per-job group wrapper. Sorted by job
// name already (see buildMyChecklistRows()), so same-job items still land
// near each other without needing an explicit box around them. Used for
// both toolbar modes (see myChecklistSelectedContext) — job-view rows can
// include done items/sub-items (the assigned feed never does), hence the
// .done class + checked attributes below.
// groupByJob (the cross-job "assigned to me" feed only — see
// renderMyChecklist()) inserts a small job-name label wherever the job
// changes from the row before it, so a long mixed-job feed reads in
// chunks instead of one undifferentiated column. Rows already come
// sorted by job name (buildMyChecklistRows()), so same-job rows are
// always adjacent — no separate grouping pass needed, just watch for
// the id changing as the list is walked.
function buildMyChecklistRowProps(rows: MyChecklistRow[], groupByJob?: boolean): MyChecklistItemRowProps[] {
  let lastJobId: string | null = null;
  return rows.map(function (row) {
    const isGroupStart = !!groupByJob && row.job.id !== lastJobId;
    if (isGroupStart) lastJobId = row.job.id;
    const item = row.item;
    const assignDropdownId = 'myciAssign_' + row.card.id + '_' + item.id;
    const subAddInputId = 'myciSubNew_' + row.card.id + '_' + item.id;
    return {
      rowKey: row.card.id + '_' + item.id,
      isGroupStart: isGroupStart,
      groupJobName: row.job.name,
      groupJobColor: row.job.color || '#3949ab',
      done: !!item.done,
      required: !!item.required,
      text: item.text,
      jobName: row.job.name,
      jobColor: row.job.color || '#3949ab',
      columnLabel: row.columnLabel,
      assigneeDropdown: buildMyChecklistAssigneeDropdownProps(
        assignDropdownId, normalizeChecklistAssignees(item.assignee), 'editor', 'Unassigned', 'ci-assignee',
        function (username: string, checked: boolean) { setMyChecklistItemAssignee(activeProjectId as string, row.card.id, row.columnId, item.id, username, checked); }
      ),
      subItems: row.subItems.map(function (sub) {
        return {
          subKey: sub.id,
          text: sub.text,
          done: !!sub.done,
          onToggleDone: function () { toggleMyChecklistSubItemDone(activeProjectId as string, row.card.id, row.columnId, item.id, sub.id); },
          onDelete: function () { deleteMyChecklistSubItem(activeProjectId as string, row.card.id, row.columnId, item.id, sub.id); },
        };
      }),
      subAddInputId: subAddInputId,
      onToggleDone: function () { toggleMyChecklistItemDone(activeProjectId as string, row.card.id, row.columnId, item.id); },
      onToggleRequired: function () { toggleMyChecklistItemRequired(activeProjectId as string, row.card.id, row.columnId, item.id); },
      onOpenItem: function () { openMyChecklistItem(activeProjectId as string, row.card.id); },
      onDelete: function () { deleteMyChecklistItem(activeProjectId as string, row.card.id, row.columnId, item.id); },
      onAddSubItemKeyDown: function (e: KeyboardEvent) {
        if (e.key === 'Enter') { e.preventDefault(); addMyChecklistSubItem(activeProjectId as string, row.card.id, row.columnId, item.id, subAddInputId); }
      },
    };
  });
}

// Which "context" the toolbar's job picker is pointed at. '__assigned__'
// (default) is the flat, cross-job, assigned-to-you-and-still-open feed
// from buildMyChecklistRows(). Any other value is a specific card id,
// which switches the list to THAT job's full current-stage checklist —
// every item visible to you, assigned to you or not, done or not — the
// closest thing left to the old per-job checklist view now that editing
// only happens here. Persists across re-renders so switching jobs, then
// toggling/adding an item, doesn't bounce the picker back to the top.
let myChecklistSelectedContext = '__assigned__';

// Job-view mode (see above) shows every item, done or not — this defaults
// that to hiding checked-off items so a long-finished stage doesn't bury
// what's actually still open, matching the "confirm what's LEFT, not what
// happened" DO-CONFIRM read the rest of the checklist follows. Toggled
// via the "Show completed" control renderMyChecklistFilterBar() renders;
// the assigned feed never has done items in it in the first place, so
// this has no effect there. Resets to hidden on reload, same as
// myChecklistSelectedContext above.
let myChecklistHideDone = true;

function toggleMyChecklistHideDone(): void {
  myChecklistHideDone = !myChecklistHideDone;
  renderMyChecklist();
}

// Every card the user could view/add to right now — same visibility/
// stage-privacy gate the assigned feed itself uses. A job with more than
// one phase gets its phase name appended, since two of its cards would
// otherwise show identical labels.
function myChecklistAddableCards(): { card: BoardCard; job: Job; label: string }[] {
  return boardCards.filter(function (card) {
    if (!card.column) return false;
    const found = findJob(card.jobId as string);
    if (!found || found.job.archived) return false;
    if (!isJobVisibleToMe(found.job)) return false;
    return isChecklistStageVisibleToMe(card.checklistAssignees, card.column);
  }).map(function (card) {
    const found = findJob(card.jobId as string)!;
    const job = found.job;
    const phases = getJobPhases(job);
    const phase = phases.find(function (p) { return (p.id || null) === (card.phaseId || null); });
    const label = job.name + (phases.length > 1 && phase && !phase.isDefault ? ' — ' + phase.name : '');
    return { card: card, job: job, label: label };
  }).sort(function (a, b) { return a.label.localeCompare(b.label); });
}

function renderMyChecklistToolbar(): void {
  const select = document.getElementById('myChecklistAddJobSelect') as HTMLSelectElement | null;
  const input = document.getElementById('myChecklistAddInput') as HTMLInputElement | null;
  const addBtn = document.getElementById('myChecklistAddBtn') as HTMLButtonElement | null;
  const visBody = document.getElementById('myChecklistAddVisibility');
  if (!select) return;
  const options = myChecklistAddableCards();
  if (myChecklistSelectedContext !== '__assigned__' && !options.some(function (o) { return o.card.id === myChecklistSelectedContext; })) {
    myChecklistSelectedContext = '__assigned__';
  }
  select.innerHTML = '<option value="__assigned__"' + (myChecklistSelectedContext === '__assigned__' ? ' selected' : '') + '>Assigned to me</option>' +
    options.map(function (o) { return '<option value="' + o.card.id + '"' + (o.card.id === myChecklistSelectedContext ? ' selected' : '') + '>' + escapeHtml(o.label) + '</option>'; }).join('');
  const current = options.find(function (o) { return o.card.id === myChecklistSelectedContext; });
  // Adding/reassigning only makes sense once a specific job is picked —
  // there's no single stage to add to (or "Visible to" list to edit)
  // while looking at the cross-job assigned feed.
  const canAdd = !!current && hasMinTier('editor');
  if (input) { input.disabled = !canAdd; input.placeholder = canAdd ? 'Add item…' : 'Pick a job to add items'; }
  if (addBtn) addBtn.disabled = !canAdd;
  // Says why Add is disabled, right next to it. Only for people who could
  // add once a job is picked (viewers can't add at all).
  const hint = document.getElementById('myChecklistAddHint');
  if (hint) hint.hidden = !!current || !hasMinTier('editor');
  if (visBody) {
    renderMyChecklistAssigneeDropdownInto(visBody, current
      ? buildMyChecklistAssigneeDropdownProps(
          'myChecklistAddVis', normalizeChecklistAssignees(current.card.checklistAssignees && current.card.checklistAssignees[current.card.column]), 'projectAdmin', 'Everyone', 'my-checklist-visibility',
          function (username: string, checked: boolean) { setMyChecklistStageAssignee(activeProjectId as string, current.card.id, current.card.column, username, checked); }
        )
      : null);
  }
}

// Only shows up in job-view mode, and only once there's actually
// something completed to hide/reveal — the assigned feed never has done
// items, and a stage with nothing done yet has nothing for the toggle to
// do.
function renderMyChecklistFilterBar(isJobView: boolean, doneCount: number): void {
  const bar = document.getElementById('myChecklistFilterBar');
  if (!bar) return;
  if (!isJobView || !doneCount) { bar.innerHTML = ''; return; }
  bar.innerHTML = '<label class="my-checklist-hide-done-toggle"><input type="checkbox"' + (myChecklistHideDone ? '' : ' checked') + ' onchange="toggleMyChecklistHideDone()"> Show completed (' + doneCount + ')</label>';
}

function onMyChecklistContextChange(): void {
  const select = document.getElementById('myChecklistAddJobSelect') as HTMLSelectElement | null;
  myChecklistSelectedContext = select ? select.value : '__assigned__';
  renderMyChecklist();
}

// New items default to unassigned (same as addMyChecklistItem() itself,
// and the old per-job modal's addChecklistItem()) — the assignee dropdown
// is right there on the new row for picking who it's actually for, rather
// than guessing it's always the person adding it.
function addMyChecklistItemFromBar(): void {
  if (myChecklistSelectedContext === '__assigned__') return;
  const card = boardCards.find(function (c) { return String(c.id) === String(myChecklistSelectedContext); });
  if (!card) return;
  const input = document.getElementById('myChecklistAddInput') as HTMLInputElement | null;
  if (!input || !input.value.trim()) return;
  addMyChecklistItem(activeProjectId as string, card.id, card.column, 'myChecklistAddInput');
}

// All items (done or not) for one specific job's current-stage checklist —
// the job-view mode buildMyChecklistRows() itself. Read-only merge of
// stored+template items, matching buildMyChecklistRows()'s own non-
// mutating approach: materializing a template item into real storage is
// the mutation functions' job, not a side effect of merely viewing.
function buildMyChecklistJobRows(cardId: string): MyChecklistRow[] {
  const card = boardCards.find(function (c) { return String(c.id) === String(cardId); });
  if (!card || !card.column) return [];
  const found = findJob(card.jobId as string);
  if (!found || found.job.archived) return [];
  const job = found.job;
  if (!isJobVisibleToMe(job)) return [];
  ensureCardChecklists(card);
  if (!isChecklistStageVisibleToMe(card.checklistAssignees, card.column)) return [];
  const stageCol = BOARD_COLUMNS.find(function (c) { return c.id === card.column; });
  const stageLabel = stageCol ? stageCol.label : card.column;
  const templ = (stageCol && stageCol.defaultChecklist) || [];
  const stored = (card.checklists && card.checklists[card.column]) || [];
  const storedIds = stored.map(function (i) { return i.id; });
  const items: ChecklistItem[] = stored.filter(function (i) { return !i.removed; }).concat(
    templ.filter(function (d) { return storedIds.indexOf(d.id) === -1; })
      .map(function (d): ChecklistItem { return { id: d.id, text: d.text, done: false, assignee: [] }; })
  );
  return items.map(function (item) {
    return { job: job, card: card, columnId: card.column, columnLabel: stageLabel, item: item, subItems: item.subItems || [] };
  });
}

function renderMyChecklist(): void {
  const panel = document.getElementById('panel-checklist');
  if (!panel) return;
  const assignedRows = buildMyChecklistRows();
  const isJobView = myChecklistSelectedContext !== '__assigned__';
  const jobRows = isJobView ? buildMyChecklistJobRows(myChecklistSelectedContext) : [];
  const doneCount = jobRows.reduce(function (n, r) { return n + (r.item.done ? 1 : 0); }, 0);
  const rows = !isJobView ? assignedRows : (myChecklistHideDone ? jobRows.filter(function (r) { return !r.item.done; }) : jobRows);
  let emptyMessage;
  let emptyCaption: string | undefined;
  if (!isJobView) {
    emptyMessage = 'Nothing assigned to you right now.';
    emptyCaption = 'Pick a job above to see or add to its checklist.';
  }
  else if (!jobRows.length) emptyMessage = 'This checklist is empty — add the first item below.';
  else if (!rows.length) emptyMessage = 'Everything on this stage is checked off.';
  const listBody = document.getElementById('myChecklistListBody');
  if (listBody) renderMyChecklistListInto(listBody, { rows: buildMyChecklistRowProps(rows, !isJobView), emptyMessage: emptyMessage as string, emptyCaption: emptyCaption });
  renderMyChecklistFilterBar(isJobView, doneCount);
  renderMyChecklistToolbar();
  updateMyChecklistBadge(assignedRows.length);
  applyPermissionGating();
  if (!cachedUserRoster) {
    ensureUserRosterLoaded().then(function () {
      if (document.getElementById('panel-checklist')) renderMyChecklist();
    });
  }
}

function updateMyChecklistBadge(count?: number): void {
  const badge = document.getElementById('myChecklistCount');
  if (!badge) return;
  const n = typeof count === 'number' ? count : buildMyChecklistRows().length;
  badge.textContent = String(n);
  badge.hidden = n === 0;
}

// Switches to the item's own project first (if it isn't already active —
// same pattern jumpToLinkedJobReference() uses for a cross-project
// jump), then opens the real card. openEditCard() already lands on the
// card's current stage correctly, including its own private-stage
// fallback, so there's nothing else to do here.
function openMyChecklistItem(projectId: string, cardId: string): void {
  if (projectId !== activeProjectId) switchProject(projectId);
  openEditCard(cardId);
}

// Shared resolve step for every My Checklist mutation handler below —
// projectId may not be the active project, so this always goes straight
// to projects[projectId] rather than the (active-project-only) globals
// findJob()/boardCards would read.
function resolveMyChecklistCard(projectId: string, cardId: string): { proj: any; card: BoardCard } | null {
  const proj = projects[projectId];
  if (!proj) return null;
  const card = (proj.boardCards || []).find(function (c: BoardCard) { return String(c.id) === String(cardId); });
  if (!card) return null;
  ensureCardChecklists(card);
  return { proj: proj, card: card };
}

// Same dual-path linkJobs() already established: the active project's
// data is the same object the rest of the app already reads/renders
// from (loadActiveProjectData() assigns boardCards straight from
// projects[activeProjectId].boardCards, no copy), so a plain saveJobs()
// covers it; a non-active project has no such live rendering to keep in
// sync, just its own localStorage + a manual push to the room.
function persistMyChecklistChange(projectId: string): void {
  if (projectId === activeProjectId) { saveJobs(); } else { saveProjects(); pushProjectToShared(projectId); }
}

// Shared resolve→find-items→find-item→mutate→persist→render skeleton
// behind the item-level My Checklist mutations that all need an EXISTING
// item looked up by id first. mutateFn(item, items) does the
// mutation-specific work; returning `false` from it skips the
// persist+render tail (used when there's genuinely nothing to save, e.g.
// a sub-item id that no longer exists). addMyChecklistItem() (creates a
// brand-new item, nothing to look up) and deleteMyChecklistItem() (branches on template
// metadata that doesn't depend on the item still existing, and must
// still persist+render even when it doesn't) don't fit this shape and
// stay as their own separate implementations below.
function withMyChecklistItem(projectId: string, cardId: string, columnId: string, itemId: string, mutateFn: (item: ChecklistItem, items: ChecklistItem[]) => boolean | void): void {
  const resolved = resolveMyChecklistCard(projectId, cardId);
  if (!resolved) return;
  const items = getChecklistForStageInProject(resolved.card.checklists as Record<string, ChecklistItem[]>, columnId, resolved.proj.boardColumns || DEFAULT_BOARD_COLUMNS);
  const item = items.find(function (i) { return String(i.id) === String(itemId); });
  if (!item) return;
  if (mutateFn(item, items) === false) return;
  persistMyChecklistChange(projectId);
  renderMyChecklist();
}

function toggleMyChecklistItemDone(projectId: string, cardId: string, columnId: string, itemId: string): void {
  withMyChecklistItem(projectId, cardId, columnId, itemId, function (item) {
    item.done = !item.done;
  });
}

// Flags/unflags an item as a "killer item" — see the .ci-required CSS and
// confirmChecklistBeforeMove() (the board-move gate), which narrows its
// warning to just required items once any exist on a stage.
function toggleMyChecklistItemRequired(projectId: string, cardId: string, columnId: string, itemId: string): void {
  withMyChecklistItem(projectId, cardId, columnId, itemId, function (item) {
    item.required = !item.required;
  });
}

function toggleMyChecklistSubItemDone(projectId: string, cardId: string, columnId: string, itemId: string, subId: string): void {
  withMyChecklistItem(projectId, cardId, columnId, itemId, function (item) {
    const sub = (item.subItems || []).find(function (s) { return String(s.id) === String(subId); });
    if (!sub) return false;
    sub.done = !sub.done;
  });
}

// Sub-items have no assignee of their own (see myChecklistMsDropdownHtml's
// caller above them) — they just inherit whoever's on the parent item, so
// there's nothing to pick here, unlike addMyChecklistItem().
function addMyChecklistSubItem(projectId: string, cardId: string, columnId: string, itemId: string, inputId: string): void {
  const input = document.getElementById(inputId) as HTMLInputElement | null;
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  withMyChecklistItem(projectId, cardId, columnId, itemId, function (item) {
    if (!item.subItems) item.subItems = [];
    item.subItems.push({ id: genId(), text: text, done: false });
    input.value = '';
  });
}

function deleteMyChecklistSubItem(projectId: string, cardId: string, columnId: string, itemId: string, subId: string): void {
  withMyChecklistItem(projectId, cardId, columnId, itemId, function (item) {
    item.subItems = (item.subItems || []).filter(function (s) { return String(s.id) !== String(subId); });
  });
}

// Reads/clears the input by id itself (rather than taking the text as a
// parameter), so a value containing quotes never has to survive being
// embedded in an onkeydown attribute string.
function addMyChecklistItem(projectId: string, cardId: string, columnId: string, inputId: string): void {
  const input = document.getElementById(inputId) as HTMLInputElement | null;
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  const resolved = resolveMyChecklistCard(projectId, cardId);
  if (!resolved) return;
  const items = getChecklistForStageInProject(resolved.card.checklists as Record<string, ChecklistItem[]>, columnId, resolved.proj.boardColumns || DEFAULT_BOARD_COLUMNS);
  items.push({ id: genId(), text: text, done: false, assignee: [] });
  input.value = '';
  persistMyChecklistChange(projectId);
  renderMyChecklist();
}

// A template-sourced item (its id still matches one of the stage's
// current defaultChecklist entries) is soft-deleted — flagged `removed`
// and left in place, same reasoning getChecklistForStageInProject()'s own
// merge-in-new-template-items logic relies on: a deliberately-removed
// template item should never resurrect itself just because some
// unrelated item was added to the template later. A manually-added item
// has nothing to resurrect, so it's just spliced out outright. Checked
// against THIS project's own boardColumns, not the global BOARD_COLUMNS,
// so a template item from a non-active project is identified correctly.
// Deliberately NOT built on withMyChecklistItem() (see its comment) —
// the template/non-template branch depends on itemId matching the
// stage's template metadata, not on the item still existing in `items`,
// and always persists+renders either way (an already-gone item is a
// harmless no-op filter/removed-flag, not an error state to bail out of).
function deleteMyChecklistItem(projectId: string, cardId: string, columnId: string, itemId: string): void {
  const resolved = resolveMyChecklistCard(projectId, cardId);
  if (!resolved) return;
  const boardCols: BoardColumn[] = resolved.proj.boardColumns || DEFAULT_BOARD_COLUMNS;
  const items = getChecklistForStageInProject(resolved.card.checklists as Record<string, ChecklistItem[]>, columnId, boardCols);
  const col = boardCols.find(function (c) { return c.id === columnId; });
  const isFromTemplate = ((col && col.defaultChecklist) || []).some(function (d) { return String(d.id) === String(itemId); });
  if (isFromTemplate) {
    const item = items.find(function (i) { return String(i.id) === String(itemId); });
    if (item) item.removed = true;
  } else {
    resolved.card.checklists![columnId] = items.filter(function (i) { return String(i.id) !== String(itemId); });
  }
  persistMyChecklistChange(projectId);
  renderMyChecklist();
}

function setMyChecklistItemAssignee(projectId: string, cardId: string, columnId: string, itemId: string, username: string, checked: boolean): void {
  // Defense-in-depth, matching setMyChecklistStageAssignee()'s own gate
  // just below — its checkboxes are already data-min-tier="editor" gated.
  if (!hasMinTier('editor')) return;
  const resolved = resolveMyChecklistCard(projectId, cardId);
  if (!resolved) return;
  const items = getChecklistForStageInProject(resolved.card.checklists as Record<string, ChecklistItem[]>, columnId, resolved.proj.boardColumns || DEFAULT_BOARD_COLUMNS);
  const item = items.find(function (i) { return String(i.id) === String(itemId); });
  if (!item) return;
  let list = normalizeChecklistAssignees(item.assignee);
  list = checked ? (list.indexOf(username) === -1 ? list.concat([username]) : list) : list.filter(function (u) { return u !== username; });
  item.assignee = list;
  persistMyChecklistChange(projectId);
  renderMyChecklist();
}

// canAssignChecklistStages() gate — defense-in-depth beyond the
// checkboxes' own data-min-tier="projectAdmin" disable, since this is
// the more privileged (whole-stage, not per-item) restriction.
function setMyChecklistStageAssignee(projectId: string, cardId: string, columnId: string, username: string, checked: boolean): void {
  if (!canAssignChecklistStages()) { showToast('Only admins can change checklist visibility', 'error'); renderMyChecklist(); return; }
  const resolved = resolveMyChecklistCard(projectId, cardId);
  if (!resolved) return;
  const card = resolved.card;
  card.checklistAssignees = card.checklistAssignees || {};
  let list = normalizeChecklistAssignees(card.checklistAssignees[columnId]);
  list = checked ? (list.indexOf(username) === -1 ? list.concat([username]) : list) : list.filter(function (u) { return u !== username; });
  if (list.length) card.checklistAssignees[columnId] = list;
  else delete card.checklistAssignees[columnId];
  persistMyChecklistChange(projectId);
  renderMyChecklist();
}

export {
  ensureCardChecklists,
  normalizeChecklistAssignees,
  isChecklistStageVisibleToMe,
  getOpenChecklistItemsForCard,
  confirmChecklistBeforeMove,
  canAssignChecklistStages,
  openManageColumnChecklist,
  closeManageColumnChecklist,
  renderManageColumnChecklistBody,
  addColumnChecklistDefaultItem,
  removeColumnChecklistDefaultItem,
  getChecklistForStageInProject,
  buildMyChecklistRows,
  toggleMyChecklistHideDone,
  myChecklistAddableCards,
  renderMyChecklistToolbar,
  renderMyChecklistFilterBar,
  onMyChecklistContextChange,
  addMyChecklistItemFromBar,
  buildMyChecklistJobRows,
  renderMyChecklist,
  updateMyChecklistBadge,
  openMyChecklistItem,
  resolveMyChecklistCard,
  persistMyChecklistChange,
  withMyChecklistItem,
  toggleMyChecklistItemDone,
  toggleMyChecklistItemRequired,
  toggleMyChecklistSubItemDone,
  addMyChecklistSubItem,
  deleteMyChecklistSubItem,
  addMyChecklistItem,
  deleteMyChecklistItem,
  setMyChecklistItemAssignee,
  setMyChecklistStageAssignee,
};
