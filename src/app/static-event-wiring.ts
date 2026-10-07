// Wires up every plain, static onclick="..." handler that used to live as
// an HTML attribute directly in index.html's markup — the last piece of
// closing out the split between "real modules" and "inline script" for
// event wiring specifically (see src/shared-globals.d.ts's own comment on
// the equivalent effort for data globals). Every element this touches is
// part of the app shell markup itself (never a dynamically-generated
// template string from a view's own render function — those still build
// their onclick="..." attributes inline, since they're regenerated on
// every render anyway and this file only runs once, at boot).
//
// initStaticEventListeners() is called once from src/app/boot.ts's init(),
// after the DOM this file's getElementById() calls depend on already
// exists (index.html's body, parsed before any <script> runs).
//
// A `function` expression (not an arrow) is used wherever the original
// onclick relied on `this` (toggleMobileField(this) et al.) — an
// ordinary function's `this` inside a 'click' listener is the element the
// listener is attached to, identical to an inline onclick's implicit
// `this`. Everywhere else uses an arrow for brevity.
import { showSettingsTab } from './settings-menu';
import { openExportModal, closeExportModal, runExport } from './export';
import { openPrintModal, closePrintModal, syncPrintKind, runPrint } from './print';
import { downloadIcs } from './ics';
import { openSecurityModal, closeSecurityModal, downloadAuditLog, exportAllData, scheduleDeletion, cancelDeletion } from './compliance';
import { openTwoStepModal, closeTwoStepModal, startTwoStepSetup, confirmTwoStepSetup, makeNewRecoveryCodes, turnOffTwoStep, setRequireTwoStep } from './two-step';
import { saveGoogleSettings } from './sso-settings';
import { openAccountEmailModal, closeAccountEmailModal, saveMyEmail, connectGoogleAccount } from './account-email';
import { openCalendarFeedModal, closeCalendarFeedModal, copyCalendarFeedUrl, resetCalendarFeed, turnOffCalendarFeed, createCalendarFeed } from './calendar-feed';
import { toggleHelp } from '../views/help';

declare global {
  function toggleSettingsMenu(): void;
  function toggleAccountMenu(): void;
  function setMobileView(view: string): void;
  function closeSettingsMenu(): void;
  function toggleActivitySidebar(): void;
  function toggleDarkMode(): void;
  function tutorialNotifShow(): void;
  function openThemeModal(): void;
  function openWorkflowItemsModal(): void;
  function openBackupsModal(): void;
  function openErrorsModal(): void;
  function toggleMaintenancePanel(): void;
  function openManageUsersModal(): void;
  function changeMyPasswordUI(): void;
  function toggleProject(): void;
  function logout(): void;
  function switchTabMorphed(tab: string): void;
  function toggleJobRail(): void;
  function addNewJob(): void;
  function homeWidgetGoTo(tab: string): void;
  function toggleHomeWidgetExpand(widgetId: string, event: Event): void;
  function postHomeJobChatComment(): void;
  function addMyChecklistItemFromBar(): void;
  function calendarExitDayView(): void;
  function calendarToday(): void;
  function calendarPrev(): void;
  function calendarNext(): void;
  function openAddCalendarEvent(dateStr: string): void;
  function setCalendarView(mode: string): void;
  function toIsoDate(d: Date): string;
  function toggleGanttBulkFold(): void;
  function zoomIn(): void;
  function zoomOut(): void;
  function resetZoom(): void;
  function fitToView(): void;
  function scrollToToday(): void;
  function duplicateJob(jobId: string, event?: Event): void;
  function toggleMobileField(el: HTMLElement): void;
  function toggleJobColorPanel(forceOpen?: boolean): void;
  function openManageFields(): void;
  function confirmDelete(): void;
  function cancelEdit(): void;
  function toggleJobCommentsPanel(): void;
  function addJobComment(): void;
  function resetThemeDefault(): void;
  function closeThemeModal(): void;
  function applyTheme(): void;
  function triggerBackupNow(): void;
  function loadBackupsList(): void;
  function closeBackupsModal(): void;
  function loadErrorsList(): void;
  function closeErrorsModal(): void;
  function showAddUserForm(): void;
  function loadUsersList(): void;
  function submitUserForm(): void;
  function hideUserFormPanel(): void;
  function closeManageUsersModal(): void;
  function closeArchivedJobsModal(): void;
  function toggleCalendarEventColorPanel(forceOpen: boolean | null): void;
  function toggleMsDropdown(id: string, forceOpen?: boolean): void;
  function msSetAll(listId: string, checked: boolean): void;
  function deleteCalendarEventFromModal(): void;
  function closeCalendarEventModal(): void;
  function saveCalendarEventFromModal(): void;
  function deleteCardFromModal(): void;
  function closeCardModal(): void;
  function closeManageFields(): void;
  function closeManageColumnChecklist(): void;
  function closeWorkflowItemsModal(): void;
  function closeDeleteJobModal(): void;
  function executeDelete(): void;
  var editingJobId: string | null;
  var calendarViewDate: Date;
}

export function initStaticEventListeners(): void {
  const on = (id: string, handler: (this: HTMLElement, ev: MouseEvent) => void) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', handler);
  };

  on('reloadNowBtn', () => location.reload());

  // Navbar: one set of view tabs for both layouts. Phones (and landscape
  // phones) show one view full-screen at a time (setMobileView()); wider
  // screens switch panels beside the job rail (switchTabMorphed()).
  const phoneLayout = window.matchMedia('(max-width: 480px), (max-height: 480px)');
  document.querySelectorAll<HTMLElement>('#appNavNotch .nav-tab[data-tab]').forEach((el) => {
    el.addEventListener('click', () => {
      if (phoneLayout.matches) setMobileView(el.dataset.tab as string);
      else switchTabMorphed(el.dataset.tab as string);
    });
  });
  // On a phone the job list is the opening view, so Jobs starts active there.
  if (phoneLayout.matches && !document.body.dataset.mobileView) {
    document.querySelectorAll('#appNavNotch .nav-tab').forEach((b) => {
      const on = (b as HTMLElement).dataset.tab === 'jobs';
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
  }
  on('helpBtn', () => { closeSettingsMenu(); toggleHelp(); });
  on('settingsBtn', () => toggleSettingsMenu());
  on('accountBtn', () => toggleAccountMenu());

  on('activityToggleBtn', () => { closeSettingsMenu(); toggleActivitySidebar(); });
  on('darkModeBtn', () => toggleDarkMode());
  on('themeColorBtn', () => { closeSettingsMenu(); openThemeModal(); });
  on('workflowItemsBtn', () => { closeSettingsMenu(); openWorkflowItemsModal(); });
  on('backupsBtn', () => { closeSettingsMenu(); openBackupsModal(); });
  on('errorsBtn', () => { closeSettingsMenu(); openErrorsModal(); });
  on('maintenanceToggleBtn', () => toggleMaintenancePanel());
  // maintenanceEnableBtn is deliberately NOT wired here — applyMaintenanceStatus()
  // (src/app/maintenance.ts) always assigns its .onclick directly, toggling
  // between setMaintenanceMode(true)/(false) depending on current status,
  // and that assignment (not addEventListener) is what the original static
  // onclick="setMaintenanceMode(true)" attribute was ALWAYS overwritten by
  // before a real click could ever reach it — an addEventListener here
  // would coexist with, not be replaced by, that reassignment and double-fire.
  on('manageUsersBtn', () => { closeSettingsMenu(); openManageUsersModal(); });
  on('exportSpreadsheetBtn', () => { closeSettingsMenu(); openExportModal(); });
  on('securityDataBtn', () => { closeSettingsMenu(); openSecurityModal(); });
  on('securityCloseBtn', () => closeSecurityModal());
  on('auditDownloadBtn', () => downloadAuditLog());
  on('dataExportBtn', () => exportAllData());
  on('deletionScheduleBtn', () => scheduleDeletion());
  on('deletionCancelBtn', () => cancelDeletion());
  const requireMfaToggle = document.getElementById('requireMfaToggle') as HTMLInputElement | null;
  if (requireMfaToggle) requireMfaToggle.addEventListener('change', () => setRequireTwoStep(requireMfaToggle.checked));
  on('ssoSaveBtn', () => saveGoogleSettings());
  on('myEmailBtn', () => { closeSettingsMenu(); openAccountEmailModal(); });
  on('myEmailCloseBtn', () => closeAccountEmailModal());
  on('myEmailSaveBtn', () => saveMyEmail());
  on('myEmailGoogleBtn', () => connectGoogleAccount());
  on('twoStepBtn', () => { closeSettingsMenu(); openTwoStepModal(); });
  on('mfaCloseBtn', () => closeTwoStepModal());
  on('mfaStartBtn', () => startTwoStepSetup());
  on('mfaEnableBtn', () => confirmTwoStepSetup());
  on('mfaNewCodesBtn', () => makeNewRecoveryCodes());
  on('mfaDisableBtn', () => turnOffTwoStep());
  on('exportCancelBtn', () => closeExportModal());
  on('exportRunBtn', () => runExport());
  on('printBtn', () => { closeSettingsMenu(); openPrintModal(); });
  on('downloadIcsBtn', () => { closeSettingsMenu(); downloadIcs(); });
  on('calendarFeedBtn', () => { closeSettingsMenu(); openCalendarFeedModal(); });
  on('calFeedCopyBtn', () => copyCalendarFeedUrl());
  on('calFeedResetBtn', () => resetCalendarFeed());
  on('calFeedOffBtn', () => turnOffCalendarFeed());
  on('calFeedCreateBtn', () => createCalendarFeed());
  on('calFeedCloseBtn', () => closeCalendarFeedModal());
  on('printCancelBtn', () => closePrintModal());
  on('printRunBtn', () => runPrint());
  document.querySelectorAll<HTMLInputElement>('input[name="printKind"]').forEach((el) => el.addEventListener('change', () => syncPrintKind()));
  on('changePasswordBtn', () => { closeSettingsMenu(); changeMyPasswordUI(); });
  on('projectToggleBtn', () => { closeSettingsMenu(); toggleProject(); });
  on('logoutBtn', () => { closeSettingsMenu(); logout(); });

  on('settingsTabGeneral', () => showSettingsTab('general'));
  on('settingsTabAdmin', () => showSettingsTab('admin'));
  on('jobRailToggleBtn', () => toggleJobRail());
  on('jobRailAddBtn', () => addNewJob());

  document.querySelectorAll<HTMLElement>('.home-widget-header[data-goto]').forEach((el) => {
    el.addEventListener('click', () => homeWidgetGoTo(el.dataset.goto as string));
  });
  document.querySelectorAll<HTMLElement>('.home-widget-expand-btn[data-widget]').forEach((el) => {
    el.addEventListener('click', (event) => toggleHomeWidgetExpand(el.dataset.widget as string, event));
  });
  on('homeJobChatPostBtn', () => postHomeJobChatComment());

  on('myChecklistAddBtn', () => addMyChecklistItemFromBar());

  on('calBackBtn', () => calendarExitDayView());
  on('calTodayBtn', () => calendarToday());
  on('calPrevBtn', () => calendarPrev());
  on('calNextBtn', () => calendarNext());
  // toIsoDate(calendarViewDate) is recomputed fresh on each click (not
  // captured once at wiring time) — same as the inline onclick it
  // replaces, which re-evaluated its whole expression every click too.
  on('calAddEventBtn', () => openAddCalendarEvent(toIsoDate(calendarViewDate)));
  on('calViewMonth', () => setCalendarView('month'));
  on('calViewWeek', () => setCalendarView('week'));

  on('ganttBulkToggle', () => toggleGanttBulkFold());
  on('ganttBulkTogglePhone', () => toggleGanttBulkFold());

  // "Skip to main content" (A5): focus the content directly instead of
  // relying on #hash navigation, which doesn't reliably move focus here.
  const skipLink = document.querySelector('.skip-link');
  if (skipLink) skipLink.addEventListener('click', (e) => {
    e.preventDefault();
    const main = document.getElementById('panelsContainer');
    if (main) main.focus();
  });
  on('ganttZoomInBtn', () => zoomIn());
  on('ganttZoomOutBtn', () => zoomOut());
  on('ganttResetZoomBtn', () => resetZoom());
  on('ganttTodayMark', () => scrollToToday());

  // editingJobId is only ever non-null while this button is actually
  // shown (job-form.ts toggles its display alongside editingJobId being
  // set) — guarded here anyway since the real function's own param type
  // doesn't accept null the way the old untyped inline onclick silently did.
  on('duplicateJobBtn', (event) => { if (editingJobId) duplicateJob(editingJobId, event); });
  // toggleMobileField(this) took the clicked element itself as an
  // argument (not an implicit `this` inside the handler body) — passing
  // the closure-captured `el` here is the exact same thing.
  document.querySelectorAll<HTMLElement>('.mobile-field-toggle').forEach((el) => {
    el.addEventListener('click', () => toggleMobileField(el));
  });
  on('jobColorToggleRow', () => toggleJobColorPanel());
  on('jmOpenManageFieldsBtn', () => openManageFields());
  on('jmAttachmentAddBtn', () => document.getElementById('jm_attachment_input')!.click());
  on('deleteBtn', () => confirmDelete());
  // archiveBtn is deliberately NOT wired here — job-form.ts's own
  // editJob()/refreshJobFormIfOpen() etc. always assign its .onclick
  // directly (toggling between archiveJob(id)/restoreJob(id) depending on
  // the open job's current archived state), the same "overwritten before
  // a real click, so the static handler was always dead code" situation
  // as maintenanceEnableBtn above — see that one's own comment.
  on('jobFormCloseBtn', () => cancelEdit());

  on('jobCommentsTab', () => toggleJobCommentsPanel());
  // The nested collapse button sits inside the same .mobile-field-toggle
  // h4 that opens/closes this whole section — stopPropagation here (done
  // inline by the original onclick, not inside toggleJobCommentsPanel()
  // itself) keeps a click on the button from also re-triggering the
  // parent h4's own toggle.
  on('jobCommentsCollapseBtn', (event) => { event.stopPropagation(); toggleJobCommentsPanel(); });
  on('addJobCommentBtn', () => addJobComment());

  on('activitySidebarCloseBtn', () => toggleActivitySidebar());

  on('themeResetDefaultBtn', () => resetThemeDefault());
  on('themeCancelBtn', () => closeThemeModal());
  on('themeApplyBtn', () => applyTheme());

  on('backupNowBtn', () => triggerBackupNow());
  on('backupsRefreshBtn', () => loadBackupsList());
  on('backupsCloseBtn', () => closeBackupsModal());

  on('errorsRefreshBtn', () => loadErrorsList());
  on('errorsCloseBtn', () => closeErrorsModal());

  on('showAddUserFormBtn', () => showAddUserForm());
  on('usersRefreshBtn', () => loadUsersList());
  on('userFormSaveBtn', () => submitUserForm());
  on('userFormCancelBtn', () => hideUserFormPanel());
  on('manageUsersCloseBtn', () => closeManageUsersModal());
  on('archivedJobsCloseBtn', () => closeArchivedJobsModal());

  on('ceColorToggleRow', () => toggleCalendarEventColorPanel(null));
  on('ceVisibilityMsToggleBtn', () => toggleMsDropdown('ceVisibilityMsDropdown'));
  on('ceVisibilitySelectAllBtn', () => msSetAll('ce_visibility_members_list', true));
  on('ceVisibilityUnselectAllBtn', () => msSetAll('ce_visibility_members_list', false));
  on('ceDeleteBtn', () => deleteCalendarEventFromModal());
  on('ceCancelBtn', () => closeCalendarEventModal());
  on('ceSaveBtn', () => saveCalendarEventFromModal());

  on('cardAttachmentAddBtn', () => document.getElementById('c_attachment_input')!.click());
  on('cardDeleteBtn', () => deleteCardFromModal());
  on('cardCloseBtn', () => closeCardModal());
  on('manageFieldsDoneBtn', () => closeManageFields());
  on('manageColumnChecklistDoneBtn', () => closeManageColumnChecklist());
  on('workflowItemsDoneBtn', () => closeWorkflowItemsModal());
  on('deleteJobCancelBtn', () => closeDeleteJobModal());
  on('deleteJobConfirmBtn', () => executeDelete());
}
