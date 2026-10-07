import { render, Fragment } from 'preact';

// The real "My Checklist" tab's own list (#myChecklistListBody) — a
// static, empty element from index.html exclusively written to by
// renderMyChecklist() (see checklist.ts) and nothing else, same "safe to
// hand over directly, no wrapper needed" case as every other converted
// list in this app.
//
// The per-item assignee dropdown (.ms-dropdown, see MyChecklistAssignee
// Dropdown below) has its OPEN/CLOSED state toggled entirely outside
// Preact (toggleMsDropdown() in utils/ui.ts just flips a classList, and a
// document-level delegated 'change' listener there keeps its toggle-
// button label in sync with its checkboxes) — this component never
// declares that class, so it's not fighting that mechanism, just
// rendering markup for it to keep working against. Same for the
// sub-item "add" input: no `value` prop is declared, so whatever the
// user has typed survives a re-render triggered by something else
// (another item's checkbox, a remote sync) landing mid-type — a plain
// behavioral improvement over the old full-teardown version, not a
// deliberate old behavior anything else depended on.
//
// Item/sub-item checkboxes ARE declared controlled (`checked={p.done}`),
// unlike that dropdown — every checkbox's own onChange already mutates
// the underlying data and calls back into a fresh render synchronously,
// so the prop Preact diffs against next already matches what the user
// just clicked; this isn't fighting the user, just confirming their own
// action, the same reasoning Board's own card checkboxes already rely on.

export interface MyChecklistAssigneeOptionProps {
  optKey: string;
  username: string;
  displayName: string;
  checked: boolean;
}

export interface MyChecklistAssigneeDropdownProps {
  dropdownId: string;
  optionsId: string;
  loading: boolean;
  options: MyChecklistAssigneeOptionProps[];
  // Pre-formatted via msDropdownLabelText() (utils/ui.ts) — same helper
  // the old string-based myChecklistMsDropdownHtml() used, so the
  // pluralization/empty-text logic lives in exactly one place.
  labelText: string;
  extraClass?: string;
  minTier: string;
  onToggle: () => void;
  onSelectAll: () => void;
  onUnselectAll: () => void;
  onChangeOption: (username: string, checked: boolean) => void;
}

export interface MyChecklistSubItemProps {
  subKey: string;
  text: string;
  done: boolean;
  onToggleDone: () => void;
  onDelete: () => void;
}

export interface MyChecklistItemRowProps {
  rowKey: string;
  isGroupStart: boolean;
  groupJobName: string;
  groupJobColor: string;
  done: boolean;
  required: boolean;
  text: string;
  jobName: string;
  jobColor: string;
  columnLabel: string;
  assigneeDropdown: MyChecklistAssigneeDropdownProps;
  subItems: MyChecklistSubItemProps[];
  subAddInputId: string;
  onToggleDone: () => void;
  onToggleRequired: () => void;
  onOpenItem: () => void;
  onDelete: () => void;
  onAddSubItemKeyDown: (e: KeyboardEvent) => void;
}

export interface MyChecklistListProps {
  rows: MyChecklistItemRowProps[];
  emptyMessage: string;
  emptyCaption?: string;
}

function onEnterOrSpace(fn: () => void) {
  return (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } };
}

function MyChecklistAssigneeDropdown(p: MyChecklistAssigneeDropdownProps) {
  return (
    <div class={'ms-dropdown' + (p.extraClass ? ' ' + p.extraClass : '')} id={p.dropdownId}>
      <button type="button" class="ms-dropdown-toggle" onClick={p.onToggle}>
        <span>{p.labelText}</span>
        <span class="ms-dropdown-arrow">▾</span>
      </button>
      <div class="ms-dropdown-panel">
        {p.options.length ? (
          <div class="ms-dropdown-actions">
            <button type="button" data-min-tier={p.minTier} onClick={p.onSelectAll}>Select All</button>
            <button type="button" data-min-tier={p.minTier} onClick={p.onUnselectAll}>Unselect All</button>
          </div>
        ) : null}
        <div class="cf-multiselect" id={p.optionsId}>
          {p.loading ? <span class="cf-multiselect-loading">Loading teammates…</span> : null}
          {!p.loading && !p.options.length ? <span class="cf-multiselect-empty">No team accounts yet</span> : null}
          {p.options.map((o) => (
            <label key={o.optKey} class="cf-multiselect-option">
              <input type="checkbox" value={o.username} data-min-tier={p.minTier} checked={o.checked} onChange={() => p.onChangeOption(o.username, !o.checked)} /> {o.displayName}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

function MyChecklistSubItem(p: MyChecklistSubItemProps) {
  return (
    <div class={'checklist-subitem' + (p.done ? ' done' : '')}>
      <input type="checkbox" checked={p.done} onChange={p.onToggleDone} />
      <span class="ci-text">{p.text}</span>
      <button class="ci-delete" data-min-tier="editor" onClick={p.onDelete}>×</button>
    </div>
  );
}

function MyChecklistItemRow(p: MyChecklistItemRowProps) {
  return (
    <Fragment key={p.rowKey}>
      {p.isGroupStart ? (
        <div class="my-checklist-group-header"><span class="home-row-dot" style={{ background: p.groupJobColor }} />{p.groupJobName}</div>
      ) : null}
      <div class={'checklist-item my-checklist-item' + (p.done ? ' done' : '') + (p.required ? ' required' : '')}>
        <input type="checkbox" checked={p.done} onChange={p.onToggleDone} />
        <button
          class={'ci-required' + (p.required ? ' is-required' : '')}
          data-min-tier="editor"
          title={p.required ? 'Required — click to unflag' : 'Mark as required'}
          onClick={p.onToggleRequired}
        >{p.required ? '★' : '☆'}</button>
        {/* Only ci-text gets tabIndex, not the job-name bubble right after
            it even though its onClick does the identical thing (open the
            same item) — both stay independently mouse-clickable, but
            giving both a tab stop would just be two ways to Tab to the
            same action in a row already busy with a real checkbox + two
            buttons. */}
        <span class="ci-text" tabIndex={0} role="button" onKeyDown={onEnterOrSpace(p.onOpenItem)} onClick={p.onOpenItem}>{p.text}</span>
        <span class="my-checklist-job-bubble" style={{ background: p.jobColor }} onClick={p.onOpenItem}>{p.jobName}</span>
        <span class="my-checklist-stage-tag">{p.columnLabel}</span>
        <MyChecklistAssigneeDropdown {...p.assigneeDropdown} />
        <button class="ci-delete" data-min-tier="editor" onClick={p.onDelete}>×</button>
      </div>
      {p.subItems.length ? (
        <div class="checklist-subitems">
          {p.subItems.map((s) => <MyChecklistSubItem key={s.subKey} {...s} />)}
        </div>
      ) : null}
      <div class="checklist-subitem-add-row">
        <input type="text" id={p.subAddInputId} data-min-tier="editor" placeholder="Add sub-item…" onKeyDown={p.onAddSubItemKeyDown} />
      </div>
    </Fragment>
  );
}

function MyChecklistEmpty({ message, caption }: { message: string; caption?: string }) {
  return (
    <div class="my-checklist-empty">
      <svg viewBox="0 0 24 24" width="22" height="22" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="18" height="18" rx="4" fill="none" stroke="currentColor" stroke-width="1.6" /><path d="M7.5 12.5l3 3 6-6.5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>
      <div>
        <div>{message}</div>
        {caption && <div class="my-checklist-empty-caption">{caption}</div>}
      </div>
    </div>
  );
}

function MyChecklistList(p: MyChecklistListProps) {
  if (!p.rows.length) return <MyChecklistEmpty message={p.emptyMessage} caption={p.emptyCaption} />;
  return <>{p.rows.map((r) => <MyChecklistItemRow key={r.rowKey} {...r} />)}</>;
}

export function renderMyChecklistListInto(container: HTMLElement, props: MyChecklistListProps): void {
  render(<MyChecklistList {...props} />, container);
}

// Reused as-is by the toolbar's own "Visible to" dropdown
// (renderMyChecklistToolbar() in checklist.ts) — genuinely the same
// .ms-dropdown UI in a second context, not a specialized rendering, so
// this shares the component directly rather than forking it (same
// reasoning that made the comments-drawer reuse of Home's Job Chat
// components a clean win — see SESSION_HANDOFF.md). `props: null` clears
// the container (no job selected in the toolbar yet).
export function renderMyChecklistAssigneeDropdownInto(container: HTMLElement, props: MyChecklistAssigneeDropdownProps | null): void {
  render(props ? <MyChecklistAssigneeDropdown {...props} /> : null, container);
}
