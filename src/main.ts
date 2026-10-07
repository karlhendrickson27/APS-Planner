// Entry point for the esbuild bundle (see package.json's "build" script).
// index.html expects every one of these as a bare global — its inline
// <script> block calls genId()/toIsoDate()/etc. directly, as does the
// existing Playwright suite (tests/helpers.js's seedSession() and
// several specs read/call these as window-level globals too). Native ES
// modules would NOT expose these as globals on their own, which is why
// this app bundles everything into one IIFE instead of using
// <script type="module">. Every src/ module that needs to be callable
// from index.html imports here and gets assigned the same way; this
// file is the one place that has to know the whole list.
import { genId, safeJsonParse } from './utils/id';
import { getDaysDiff, toIsoDate, addMonths, getBusinessDaysDiff, addBusinessDays, formatTimeLabel, timeToMinutes, formatDate } from './utils/date';
import { darkenColor, softenColor, SOFTEN_AMOUNT } from './utils/color';
import { escapeHtml } from './utils/html';
import { createAutosaveController } from './utils/autosave';
import { openModal, closeModal, showToast, moveTooltip, hideTooltip, toggleMsDropdown, closeAllMsDropdowns, msSetAll, msDropdownLabelText } from './utils/ui';
import { checkForNewerVersion } from './app/version-check';
import './app/offline';
import { createProject, setProjectArchived, renameProject, openProjectsModal } from './app/projects-admin';
import { checkMaintenanceStatus, applyMaintenanceStatus, toggleMaintenancePanel, setMaintenanceMode } from './app/maintenance';
import { reportClientError } from './app/error-reporting';
import { positionSettingsMenu, toggleSettingsMenu, toggleAccountMenu, closeSettingsMenu, armSettingsMenuAutoClose, cancelSettingsMenuAutoClose, showSettingsTab } from './app/settings-menu';
import './app/page-controls';
import { applyDarkMode, loadDarkModePref, toggleDarkMode, DEFAULT_THEME_COLOR, normalizeThemeColor, getSavedThemeColor, applyThemeColor, buildThemePresets, updateThemePreview, openThemeModal, closeThemeModal, applyTheme, resetThemeDefault, applyProjectBgVisual } from './app/theme';
import {
  tutorialStateKey, getTutorialState, saveTutorialState,
  maybeShowTutorialPrompt, showTutorialNotification, hideTutorialNotification, tutorialNotifShow, tutorialNotifLater,
  tutorialNotifNever, renderTutorialSlide, openTutorialSlides, closeTutorialSlides, tutorialSlideBack, tutorialSlideNext,
  tutorialSlideSkip, findCoachmarkTarget, findNextCoachmarkIndex, renderCoachmarkStep, openCoachmarkTour,
  closeCoachmarkTour, coachmarkBack, coachmarkNext,
} from './app/onboarding';
import { DISPLAY_NAME_KEY, getStoredDisplayName, getStoredUsername, getStoredSessionToken, setStoredSessionToken, decodeSessionTokenPayload, isSessionTokenUsable } from './auth/session';
import { PERMISSION_TIERS, getEffectiveRole, hasMinTier, applyIdentityFromTokenPayload } from './auth/permissions';
import { reauthenticate, reauthenticateOnce, getSessionToken, fetchRoomToken, buildRoomWsUrl } from './auth/login';
import { fetchWithReauth, postUsersEndpoint } from './app/worker-client';
import { openBackupsModal, closeBackupsModal, triggerBackupNow, loadBackupsList, downloadBackupFile, restoreBackupFile } from './app/backups';
import { openErrorsModal, closeErrorsModal, loadErrorsList } from './app/errors';
import {
  openManageUsersModal, closeManageUsersModal, TIER_LABELS, loadUsersList, populateUserFormProjectSelect,
  onUserFormTierChange, showAddUserForm, showEditUserForm, hideUserFormPanel, submitUserForm,
  resetUserPasswordUI, removeUserUI, changeMyPasswordUI, setViewAs,
} from './app/users-admin';
import { displayNameForUsername, getLeadRoster, ensureUserRosterLoaded } from './app/user-roster';
import { toggleActivitySidebar, timeAgo, getLogProp, renderActivityLogSidebar } from './app/activity-log';
import { findJob, findTask, getJobPhases, getPhaseSubUnits, getPhaseCard, getJobCards, getPrimaryPhaseCard } from './core/models';
import {
  normalizeTasksToColumns, ensureJobTasksMatchColumns, dedupeTaskIdsAcrossPhases, makeBlankPhaseTasks, makePhaseCard,
  splitJobIntoPhases, addJobPhase, removeJobPhase, unsplitJobFromPhases, splitPhaseIntoSubPhases, addPhaseSubUnit,
  removePhaseSubUnit, unsplitPhaseFromSubPhases, ensureJobHasCards, migrateOrphanedCards, deriveColumnForTasks,
  setCardColumn, runColumnEntryActions, syncCardColumns, ensureCardIds, isJobVisibleToMe, getVisibleJobs,
  isJobFinished, isTaskFinished, ensureJobAndTaskIds,
} from './core/jobs';
import {
  migrateFromLegacy, loadProjects, saveProjects, flushProjectsToLocalCache, getActiveProject, switchProject, enforceProjectScopeForRole,
  slugifyFixedProjectName, enforceFixedProjectSet, loadActiveProjectData, saveActiveProject, toggleProject,
  updateProjectToggle, renderAll, applyPermissionGating, saveJobs, saveBoardColumns,
  saveWorkflowItems, saveBoardCards, saveCalendarEvents, saveFieldOptions, saveHeader, loadLinkEnabledPref,
  saveLinkEnabledPref, isLinkEnabledLocally, setLinkEnabledLocally, getOtherFixedProjectId, getOtherProjectIds, getLinkedReferenceJobs,
  jumpToLinkedJobReference, linkJobs, setJobLinkEnabled, unlinkJobById,
} from './app/project';
import { mergeTombstones, showFreshLoadOverlay, hideFreshLoadOverlay, init, boot } from './app/boot';
import {
  handleColumnDragStart, handleColumnDragEnd, handleColumnReorderOver, handleColumnReorderLeave, handleColumnReorderDrop,
  getDragAfterColumn, syncColumnsFromDOM, handleCardDragStart, handleCardDragEnd, handleColumnDragOver, applyColumnDragOver,
  handleColumnDragLeave, dropNeedsManualOverride, handleColumnDrop, moveCardToColumn, getDragAfterElement, syncBoardCardsFromDOM,
  slugifyColumnId, addBoardColumn, showAddColumnForm, hideAddColumnForm, handleAddColumnKey, submitAddColumn,
  deleteBoardColumn, renameBoardColumn, buildWorkflowStageData, renderBoardWorkflowStrip, scrollToBoardColumn,
  isCardFromArchivedJob, isCardVisibleToMe,
  openWorkflowItemsModal, closeWorkflowItemsModal, renderWorkflowItemsBody, toggleWorkflowItemColorPanel, changeWorkflowItemColor,
  addWorkflowItem, removeWorkflowItem, handleColorSwatchKeydown,
  resolveCardNameTarget, openEditCard, closeCardModal, scheduleCardAutosave, flushCardAutosave, cancelPendingCardAutosave,
  setCardTitleHint, autoSaveCardForm, initCardFormAutosaveListeners, deleteCardFromModal, renderBoard, buildCardEl,
  isDarkColor, toggleColSettings, toggleColColorPanel, changeColumnColor, closeAllColSettings,
  toggleColumnScheduleVisibility, toggleColumnScheduleSync, toggleColumnFinishedTrigger, setColumnWorkflowItem,
  toggleColumnAutoAssignChecklist, setColumnChecklistAssignee, setColumnDefaultDuration, setColumnStalledThreshold,
  reconnectCard,
  renderFieldDefHtml, renderCustomFieldsGrid, renderTeamFieldsGrid, collectCustomFieldValues,
  MAX_ATTACHMENT_SIZE, attachmentDownloadUrl, attachmentSrc, uploadAttachmentFile, deleteAttachmentFile, formatFileSize,
  renderAttachmentPanel, handleAttachmentPanelUpload, removeAttachmentPanelItem,
  renderAttachments, handleAttachmentUpload, removeAttachment,
  openManageFields, closeManageFields, renderManageFieldsBody, buildManageFieldGroup, addFieldOption, removeFieldOption,
  BOARD_COLOR_PRESETS, DEFAULT_TASK_DURATION_DAYS, CUSTOM_FIELD_DEFS, TEAM_FIELD_KEYS,
} from './views/board';
import {
  API_BASE_URL, COLOR_PRESETS, DEFAULT_BOARD_COLUMNS, CAL_BAR_H, CAL_BAR_GAP, CAL_DAYNUM_H,
  DEFAULT_STALLED_AFTER_DAYS, ARCHIVE_CUTOFF_DAYS,
} from './core/constants';
import {
  isCalendarEventTaskId, parseCalendarEventTaskId, defaultRepeatUntil, getCalendarEventOccurrences,
  isCalendarEventVisibleToMe, flattenCalendarEventsForRange, ensureCalendarEventIds,
  openAddCalendarEvent, openEditCalendarEvent, closeCalendarEventModal, toggleRepeatUntilField,
  toggleCalendarEventVisibilityFields, collectCalendarEventVisibilityMembers, toggleCalendarEventColorPanel,
  updateCalendarEventColorSwatch, buildCalendarEventColorPresets, saveCalendarEventFromModal, deleteCalendarEventFromModal,
  setCalendarView, calendarPrev, calendarNext, calendarToday, calendarExitDayView, renderCalendar,
  buildCalBarHtml, renderMonthCalendar, renderWeekCalendar, renderWeekHourGrid, calendarOpenJob,
  getScheduledItemsForDate, openDayView, renderDayCalendarView,
  handleCalBarMouseDown, handleCalBarMouseMove, applyCalBarMouseMove, handleCalBarMouseUp,
  initCalendarDragHandlers, calSwipeTargets, handleCalSwipeStart, handleCalSwipeMove,
  slideCalendarTargets, handleCalSwipeEnd, animateCalendarWheelChange, handleCalWheel,
} from './views/calendar';
import {
  cascadeShiftLaterTasks, startBarResizeRight, startBarResizeLeft, onBarResizeMove, applyBarResizeMove,
  onBarResizeEnd, startTickResize, onTickResizeMove, applyTickResizeMove, onTickResizeEnd,
  startBarMove, onBarMoveMove, applyBarMoveMove, onBarMoveEnd, buildVisibleTaskRows, renderGantt,
  scrollToToday, ganttTouchDist, setGanttDayWidthAnchored, requestGanttZoom, handleGanttTouchStart,
  handleGanttTouchMove, handleGanttTouchEnd, handleGanttWheelZoom, zoomGanttCentered, zoomIn, zoomOut,
  resetZoom, fitToView, togglePhaseCollapse, getSubUnitKey, toggleTasksPhaseExpanded,
  toggleTasksSubPhaseExpanded, expandAllGantt, collapseAllGantt, toggleGanttBulkFold, toggleGanttJobFocus, clearGanttJobFocus,
  toggleGanttTaskFocus, clearGanttTaskFocus, syncGanttFocusBanner,
  computeDateRange, showDatePopover, hideDatePopover, showTooltip,
  setHeaderScroll, setupScrollSync,
  DUE_MARKER_TASK_ID, getJobDueMarkerTask, forEachVisibleSubUnit, flattenJobs, getHiddenTaskOrders,
  buildSubUnitClusters, isCalendarJobSpanTaskId, buildCalendarJobRows, collapsedPhaseIds,
} from './views/gantt';
import {
  sendPresenceUpdate, presenceAvatarColor, presenceInitials, presenceAnimDelay, renderPresenceAvatars,
} from './sync/presence';
import {
  initSyncIndicator, setSyncIndicator, scheduleOfflineEscalation, cancelOfflineEscalation, isBusyEditing,
  handleRoomOpen, handleRoomClose, handleRoomSocketError, handleRoomSocketMessageEvent, setupRoomSync,
} from './sync/connection';
import {
  queueSharedSync, flushPendingRoomPush, flushPendingSync, logout, sendRoomMessage, armStuckWriteWatch,
  clearPendingWrite, hasPendingWriteForProject, pushProjectToShared, removeProjectFromShared,
  pruneStrayEmptyProjects, deleteFromSharedMap, deleteJobFromShared, deleteCardFromShared,
  deleteCalendarEventFromShared, recordTombstone, pushFieldToShared, pushBoardColumnsToShared,
  pushFieldOptionsToShared, pushWorkflowItemsToShared, pushHeaderToShared, logActivity, pushRoomState,
  pendingWrites,
} from './sync/outbound';
import {
  handleRoomMessage, synthesizeJobFromOrphanCard, safeMergeInto, scheduleOrphanRecovery, healOrphanedJobCards,
  healOrphanedPhaseCards, healOrphanedCardsForProject, applyRoomSnapshot, refreshActiveProjectFromShared,
} from './sync/inbound';
import {
  ensureCardChecklists, normalizeChecklistAssignees, isChecklistStageVisibleToMe,
  getOpenChecklistItemsForCard, confirmChecklistBeforeMove, canAssignChecklistStages,
  openManageColumnChecklist, closeManageColumnChecklist, renderManageColumnChecklistBody,
  addColumnChecklistDefaultItem, removeColumnChecklistDefaultItem, getChecklistForStageInProject,
  buildMyChecklistRows, toggleMyChecklistHideDone,
  myChecklistAddableCards, renderMyChecklistToolbar, renderMyChecklistFilterBar, onMyChecklistContextChange,
  addMyChecklistItemFromBar, buildMyChecklistJobRows, renderMyChecklist, updateMyChecklistBadge,
  openMyChecklistItem, resolveMyChecklistCard, persistMyChecklistChange, withMyChecklistItem,
  toggleMyChecklistItemDone, toggleMyChecklistItemRequired, toggleMyChecklistSubItemDone,
  addMyChecklistSubItem, deleteMyChecklistSubItem, addMyChecklistItem, deleteMyChecklistItem,
  setMyChecklistItemAssignee, setMyChecklistStageAssignee,
} from './views/checklist';
import {
  formatCommentWhen, renderJobComments, toggleReplyBox, postJobReply, addJobReply,
  deleteJobReply, handleReplyKey, postJobComment, addJobComment, deleteJobComment, handleJobCommentKey,
  toggleJobCommentsPanel,
} from './views/job-comments';
import {
  renderJobList, filterJobList, updateJobCount, archiveJob, restoreJob, openArchivedJobsModal,
  closeArchivedJobsModal, refreshArchivedJobsListIfOpen, renderArchivedJobsList, archiveCurrentJob,
  duplicateJob, promptDeleteJob, confirmDelete, executeDelete, closeDeleteJobModal,
} from './views/job-list';
import {
  renderFixedTaskGrid, updateJobCurrentBoardIndicator, renderJobPhaseStrip, renderJobSubPhaseStrip,
  renderJobFormForPhase, selectJobPhase, splitJobIntoPhasesUI, addJobPhaseUI, renameJobPhaseUI,
  deleteJobPhaseUI, selectJobSubPhase, getCurrentEditingPhase, splitPhaseIntoSubPhasesUI,
  addPhaseSubUnitUI, renameSubPhaseUI, deleteSubPhaseUI, renderJobLinkSection, openJobLinkPickerUI,
  cancelJobLinkPickerUI, pickJobLinkProjectUI, confirmJobLinkUI, toggleJobLinkEnabledUI, unlinkJobUI, openJobDrawer,
  closeJobDrawer, addNewJob, editJob, refreshJobFormIfOpen, scheduleAutoSaveJobForm,
  flushAutoSaveJobForm, cancelPendingJobAutosave, setJobNameHint, showTaskRowWarnings,
  autoSaveJobForm, initJobFormAutosaveListeners, cancelEdit,
  buildColorPresets, updateJobColorSwatch, toggleJobColorPanel, toggleMobileField, collapseAllMobileFields,
  renderJobCustomFieldsGrid, renderJobTeamFieldsGrid, collectJobCustomFieldValues, renderJobAttachments,
  handleJobAttachmentUpload, removeJobAttachment,
} from './views/job-form';
import {
  getActiveTab, switchTabMorphed, homeWidgetGoTo, clearHomeTabMorphNames, switchTab, toggleJobRail, setMobileView,
  applyHomeReflowTracks, toggleHomeWidgetExpand, buildHomeOverdueRows, buildHomeStalledRows, buildHomeStageSummary,
  buildHomeTodayScheduleRows, buildHomeUpcomingScheduleRows, buildHomeGanttUnclosedRows, renderHomeGreeting,
  getDismissedHomeWidgetAlerts,
  isHomeWidgetAlertDismissed, dismissHomeWidgetAlert, renderHomeWorkflowMiniBoard,
  renderHomeWorkflowExpandedBoard, buildHomeJobChatFeed,
  renderHomeJobChatComposeOptions, renderHomeJobChat, postHomeJobChatComment,
  updateHomeJobChatComposeState,
  toggleHomeReplyBox, addHomeJobReply, handleHomeReplyKey, renderHomeDashboard,
} from './views/home';

declare global {
  interface Window {
    genId: typeof genId;
    safeJsonParse: typeof safeJsonParse;
    getDaysDiff: typeof getDaysDiff;
    toIsoDate: typeof toIsoDate;
    formatDate: typeof formatDate;
    addMonths: typeof addMonths;
    getBusinessDaysDiff: typeof getBusinessDaysDiff;
    addBusinessDays: typeof addBusinessDays;
    formatTimeLabel: typeof formatTimeLabel;
    timeToMinutes: typeof timeToMinutes;
    darkenColor: typeof darkenColor;
    softenColor: typeof softenColor;
    SOFTEN_AMOUNT: typeof SOFTEN_AMOUNT;
    findJob: typeof findJob;
    findTask: typeof findTask;
    getJobPhases: typeof getJobPhases;
    getPhaseSubUnits: typeof getPhaseSubUnits;
    getPhaseCard: typeof getPhaseCard;
    getJobCards: typeof getJobCards;
    getPrimaryPhaseCard: typeof getPrimaryPhaseCard;
    handleColumnDragStart: typeof handleColumnDragStart;
    handleColumnDragEnd: typeof handleColumnDragEnd;
    handleColumnReorderOver: typeof handleColumnReorderOver;
    handleColumnReorderLeave: typeof handleColumnReorderLeave;
    handleColumnReorderDrop: typeof handleColumnReorderDrop;
    getDragAfterColumn: typeof getDragAfterColumn;
    syncColumnsFromDOM: typeof syncColumnsFromDOM;
    handleCardDragStart: typeof handleCardDragStart;
    handleCardDragEnd: typeof handleCardDragEnd;
    handleColumnDragOver: typeof handleColumnDragOver;
    applyColumnDragOver: typeof applyColumnDragOver;
    handleColumnDragLeave: typeof handleColumnDragLeave;
    dropNeedsManualOverride: typeof dropNeedsManualOverride;
    handleColumnDrop: typeof handleColumnDrop;
    moveCardToColumn: typeof moveCardToColumn;
    getDragAfterElement: typeof getDragAfterElement;
    syncBoardCardsFromDOM: typeof syncBoardCardsFromDOM;
    slugifyColumnId: typeof slugifyColumnId;
    addBoardColumn: typeof addBoardColumn;
    showAddColumnForm: typeof showAddColumnForm;
    hideAddColumnForm: typeof hideAddColumnForm;
    handleAddColumnKey: typeof handleAddColumnKey;
    submitAddColumn: typeof submitAddColumn;
    deleteBoardColumn: typeof deleteBoardColumn;
    renameBoardColumn: typeof renameBoardColumn;
    buildWorkflowStageData: typeof buildWorkflowStageData;
    renderBoardWorkflowStrip: typeof renderBoardWorkflowStrip;
    scrollToBoardColumn: typeof scrollToBoardColumn;
    isCardFromArchivedJob: typeof isCardFromArchivedJob;
    isCardVisibleToMe: typeof isCardVisibleToMe;
    escapeHtml: typeof escapeHtml;
    createAutosaveController: typeof createAutosaveController;
    openModal: typeof openModal;
    closeModal: typeof closeModal;
    showToast: typeof showToast;
    moveTooltip: typeof moveTooltip;
    hideTooltip: typeof hideTooltip;
    toggleMsDropdown: typeof toggleMsDropdown;
    closeAllMsDropdowns: typeof closeAllMsDropdowns;
    msSetAll: typeof msSetAll;
    msDropdownLabelText: typeof msDropdownLabelText;
    checkForNewerVersion: typeof checkForNewerVersion;
    checkMaintenanceStatus: typeof checkMaintenanceStatus;
    applyMaintenanceStatus: typeof applyMaintenanceStatus;
    toggleMaintenancePanel: typeof toggleMaintenancePanel;
    setMaintenanceMode: typeof setMaintenanceMode;
    reportClientError: typeof reportClientError;
    DISPLAY_NAME_KEY: typeof DISPLAY_NAME_KEY;
    getStoredDisplayName: typeof getStoredDisplayName;
    getStoredUsername: typeof getStoredUsername;
    getStoredSessionToken: typeof getStoredSessionToken;
    setStoredSessionToken: typeof setStoredSessionToken;
    decodeSessionTokenPayload: typeof decodeSessionTokenPayload;
    isSessionTokenUsable: typeof isSessionTokenUsable;
    PERMISSION_TIERS: typeof PERMISSION_TIERS;
    getEffectiveRole: typeof getEffectiveRole;
    hasMinTier: typeof hasMinTier;
    applyIdentityFromTokenPayload: typeof applyIdentityFromTokenPayload;
    reauthenticate: typeof reauthenticate;
    reauthenticateOnce: typeof reauthenticateOnce;
    getSessionToken: typeof getSessionToken;
    fetchRoomToken: typeof fetchRoomToken;
    buildRoomWsUrl: typeof buildRoomWsUrl;
    fetchWithReauth: typeof fetchWithReauth;
    postUsersEndpoint: typeof postUsersEndpoint;
    openBackupsModal: typeof openBackupsModal;
    closeBackupsModal: typeof closeBackupsModal;
    triggerBackupNow: typeof triggerBackupNow;
    loadBackupsList: typeof loadBackupsList;
    downloadBackupFile: typeof downloadBackupFile;
    restoreBackupFile: typeof restoreBackupFile;
    openErrorsModal: typeof openErrorsModal;
    closeErrorsModal: typeof closeErrorsModal;
    loadErrorsList: typeof loadErrorsList;
    openManageUsersModal: typeof openManageUsersModal;
    closeManageUsersModal: typeof closeManageUsersModal;
    TIER_LABELS: typeof TIER_LABELS;
    loadUsersList: typeof loadUsersList;
    populateUserFormProjectSelect: typeof populateUserFormProjectSelect;
    onUserFormTierChange: typeof onUserFormTierChange;
    showAddUserForm: typeof showAddUserForm;
    showEditUserForm: typeof showEditUserForm;
    hideUserFormPanel: typeof hideUserFormPanel;
    submitUserForm: typeof submitUserForm;
    resetUserPasswordUI: typeof resetUserPasswordUI;
    removeUserUI: typeof removeUserUI;
    changeMyPasswordUI: typeof changeMyPasswordUI;
    setViewAs: typeof setViewAs;
    displayNameForUsername: typeof displayNameForUsername;
    getLeadRoster: typeof getLeadRoster;
    ensureUserRosterLoaded: typeof ensureUserRosterLoaded;
    toggleActivitySidebar: typeof toggleActivitySidebar;
    timeAgo: typeof timeAgo;
    getLogProp: typeof getLogProp;
    renderActivityLogSidebar: typeof renderActivityLogSidebar;
    positionSettingsMenu: typeof positionSettingsMenu;
    toggleSettingsMenu: typeof toggleSettingsMenu;
    toggleAccountMenu: typeof toggleAccountMenu;
    closeSettingsMenu: typeof closeSettingsMenu;
    armSettingsMenuAutoClose: typeof armSettingsMenuAutoClose;
    cancelSettingsMenuAutoClose: typeof cancelSettingsMenuAutoClose;
    showSettingsTab: typeof showSettingsTab;
    applyDarkMode: typeof applyDarkMode;
    loadDarkModePref: typeof loadDarkModePref;
    toggleDarkMode: typeof toggleDarkMode;
    DEFAULT_THEME_COLOR: typeof DEFAULT_THEME_COLOR;
    normalizeThemeColor: typeof normalizeThemeColor;
    getSavedThemeColor: typeof getSavedThemeColor;
    applyThemeColor: typeof applyThemeColor;
    buildThemePresets: typeof buildThemePresets;
    updateThemePreview: typeof updateThemePreview;
    openThemeModal: typeof openThemeModal;
    closeThemeModal: typeof closeThemeModal;
    applyTheme: typeof applyTheme;
    resetThemeDefault: typeof resetThemeDefault;
    applyProjectBgVisual: typeof applyProjectBgVisual;
    tutorialStateKey: typeof tutorialStateKey;
    getTutorialState: typeof getTutorialState;
    saveTutorialState: typeof saveTutorialState;
    maybeShowTutorialPrompt: typeof maybeShowTutorialPrompt;
    showTutorialNotification: typeof showTutorialNotification;
    hideTutorialNotification: typeof hideTutorialNotification;
    tutorialNotifShow: typeof tutorialNotifShow;
    tutorialNotifLater: typeof tutorialNotifLater;
    tutorialNotifNever: typeof tutorialNotifNever;
    renderTutorialSlide: typeof renderTutorialSlide;
    openTutorialSlides: typeof openTutorialSlides;
    closeTutorialSlides: typeof closeTutorialSlides;
    tutorialSlideBack: typeof tutorialSlideBack;
    tutorialSlideNext: typeof tutorialSlideNext;
    tutorialSlideSkip: typeof tutorialSlideSkip;
    findCoachmarkTarget: typeof findCoachmarkTarget;
    findNextCoachmarkIndex: typeof findNextCoachmarkIndex;
    renderCoachmarkStep: typeof renderCoachmarkStep;
    openCoachmarkTour: typeof openCoachmarkTour;
    closeCoachmarkTour: typeof closeCoachmarkTour;
    coachmarkBack: typeof coachmarkBack;
    coachmarkNext: typeof coachmarkNext;
    openWorkflowItemsModal: typeof openWorkflowItemsModal;
    closeWorkflowItemsModal: typeof closeWorkflowItemsModal;
    renderWorkflowItemsBody: typeof renderWorkflowItemsBody;
    toggleWorkflowItemColorPanel: typeof toggleWorkflowItemColorPanel;
    changeWorkflowItemColor: typeof changeWorkflowItemColor;
    addWorkflowItem: typeof addWorkflowItem;
    removeWorkflowItem: typeof removeWorkflowItem;
    handleColorSwatchKeydown: typeof handleColorSwatchKeydown;
    resolveCardNameTarget: typeof resolveCardNameTarget;
    openEditCard: typeof openEditCard;
    closeCardModal: typeof closeCardModal;
    scheduleCardAutosave: typeof scheduleCardAutosave;
    flushCardAutosave: typeof flushCardAutosave;
    cancelPendingCardAutosave: typeof cancelPendingCardAutosave;
    setCardTitleHint: typeof setCardTitleHint;
    autoSaveCardForm: typeof autoSaveCardForm;
    initCardFormAutosaveListeners: typeof initCardFormAutosaveListeners;
    deleteCardFromModal: typeof deleteCardFromModal;
    renderBoard: typeof renderBoard;
    buildCardEl: typeof buildCardEl;
    isDarkColor: typeof isDarkColor;
    toggleColSettings: typeof toggleColSettings;
    toggleColColorPanel: typeof toggleColColorPanel;
    changeColumnColor: typeof changeColumnColor;
    closeAllColSettings: typeof closeAllColSettings;
    toggleColumnScheduleVisibility: typeof toggleColumnScheduleVisibility;
    toggleColumnScheduleSync: typeof toggleColumnScheduleSync;
    toggleColumnFinishedTrigger: typeof toggleColumnFinishedTrigger;
    setColumnWorkflowItem: typeof setColumnWorkflowItem;
    toggleColumnAutoAssignChecklist: typeof toggleColumnAutoAssignChecklist;
    setColumnChecklistAssignee: typeof setColumnChecklistAssignee;
    setColumnDefaultDuration: typeof setColumnDefaultDuration;
    setColumnStalledThreshold: typeof setColumnStalledThreshold;
    reconnectCard: typeof reconnectCard;
    normalizeTasksToColumns: typeof normalizeTasksToColumns;
    ensureJobTasksMatchColumns: typeof ensureJobTasksMatchColumns;
    dedupeTaskIdsAcrossPhases: typeof dedupeTaskIdsAcrossPhases;
    makeBlankPhaseTasks: typeof makeBlankPhaseTasks;
    makePhaseCard: typeof makePhaseCard;
    splitJobIntoPhases: typeof splitJobIntoPhases;
    addJobPhase: typeof addJobPhase;
    removeJobPhase: typeof removeJobPhase;
    unsplitJobFromPhases: typeof unsplitJobFromPhases;
    splitPhaseIntoSubPhases: typeof splitPhaseIntoSubPhases;
    addPhaseSubUnit: typeof addPhaseSubUnit;
    removePhaseSubUnit: typeof removePhaseSubUnit;
    unsplitPhaseFromSubPhases: typeof unsplitPhaseFromSubPhases;
    ensureJobHasCards: typeof ensureJobHasCards;
    migrateOrphanedCards: typeof migrateOrphanedCards;
    deriveColumnForTasks: typeof deriveColumnForTasks;
    setCardColumn: typeof setCardColumn;
    runColumnEntryActions: typeof runColumnEntryActions;
    syncCardColumns: typeof syncCardColumns;
    ensureCardIds: typeof ensureCardIds;
    isJobVisibleToMe: typeof isJobVisibleToMe;
    getVisibleJobs: typeof getVisibleJobs;
    isJobFinished: typeof isJobFinished;
    // Declared loosely (not `typeof isTaskFinished`) — gantt.ts/calendar.ts
    // each declare their own stricter ambient `isTaskFinished` (GanttJob/
    // GanttTask, CalJob/CalTask) for their own row-building code, which
    // merges into this Window property's type too, as an intersection
    // with whatever's declared here — the assignment below casts through
    // `any` for the same reason (the real function's plain Job/Task
    // signature can't satisfy that intersection; GanttTask/CalTask aren't
    // structurally assignable to Task).
    isTaskFinished: (job: any, task: any) => boolean;
    ensureJobAndTaskIds: typeof ensureJobAndTaskIds;
    migrateFromLegacy: typeof migrateFromLegacy;
    loadProjects: typeof loadProjects;
    saveProjects: typeof saveProjects;
    flushProjectsToLocalCache: typeof flushProjectsToLocalCache;
    getActiveProject: typeof getActiveProject;
    switchProject: typeof switchProject;
    enforceProjectScopeForRole: typeof enforceProjectScopeForRole;
    slugifyFixedProjectName: typeof slugifyFixedProjectName;
    enforceFixedProjectSet: typeof enforceFixedProjectSet;
    loadActiveProjectData: typeof loadActiveProjectData;
    saveActiveProject: typeof saveActiveProject;
    toggleProject: typeof toggleProject;
    createProject: typeof createProject;
    setProjectArchived: typeof setProjectArchived;
    renameProject: typeof renameProject;
    openProjectsModal: typeof openProjectsModal;
    updateProjectToggle: typeof updateProjectToggle;
    renderAll: typeof renderAll;
    applyPermissionGating: typeof applyPermissionGating;
    saveJobs: typeof saveJobs;
    saveBoardColumns: typeof saveBoardColumns;
    saveWorkflowItems: typeof saveWorkflowItems;
    saveBoardCards: typeof saveBoardCards;
    saveCalendarEvents: typeof saveCalendarEvents;
    saveFieldOptions: typeof saveFieldOptions;
    saveHeader: typeof saveHeader;
    loadLinkEnabledPref: typeof loadLinkEnabledPref;
    saveLinkEnabledPref: typeof saveLinkEnabledPref;
    isLinkEnabledLocally: typeof isLinkEnabledLocally;
    setLinkEnabledLocally: typeof setLinkEnabledLocally;
    getOtherFixedProjectId: typeof getOtherFixedProjectId;
    getOtherProjectIds: typeof getOtherProjectIds;
    pickJobLinkProjectUI: typeof pickJobLinkProjectUI;
    getLinkedReferenceJobs: typeof getLinkedReferenceJobs;
    jumpToLinkedJobReference: typeof jumpToLinkedJobReference;
    linkJobs: typeof linkJobs;
    setJobLinkEnabled: typeof setJobLinkEnabled;
    unlinkJobById: typeof unlinkJobById;
    mergeTombstones: typeof mergeTombstones;
    showFreshLoadOverlay: typeof showFreshLoadOverlay;
    hideFreshLoadOverlay: typeof hideFreshLoadOverlay;
    init: typeof init;
    boot: typeof boot;
    renderFieldDefHtml: typeof renderFieldDefHtml;
    renderCustomFieldsGrid: typeof renderCustomFieldsGrid;
    renderTeamFieldsGrid: typeof renderTeamFieldsGrid;
    collectCustomFieldValues: typeof collectCustomFieldValues;
    MAX_ATTACHMENT_SIZE: typeof MAX_ATTACHMENT_SIZE;
    attachmentDownloadUrl: typeof attachmentDownloadUrl;
    attachmentSrc: typeof attachmentSrc;
    uploadAttachmentFile: typeof uploadAttachmentFile;
    deleteAttachmentFile: typeof deleteAttachmentFile;
    formatFileSize: typeof formatFileSize;
    renderAttachmentPanel: typeof renderAttachmentPanel;
    handleAttachmentPanelUpload: typeof handleAttachmentPanelUpload;
    removeAttachmentPanelItem: typeof removeAttachmentPanelItem;
    renderAttachments: typeof renderAttachments;
    handleAttachmentUpload: typeof handleAttachmentUpload;
    removeAttachment: typeof removeAttachment;
    openManageFields: typeof openManageFields;
    closeManageFields: typeof closeManageFields;
    renderManageFieldsBody: typeof renderManageFieldsBody;
    buildManageFieldGroup: typeof buildManageFieldGroup;
    addFieldOption: typeof addFieldOption;
    removeFieldOption: typeof removeFieldOption;
    BOARD_COLOR_PRESETS: typeof BOARD_COLOR_PRESETS;
    DEFAULT_TASK_DURATION_DAYS: typeof DEFAULT_TASK_DURATION_DAYS;
    CUSTOM_FIELD_DEFS: typeof CUSTOM_FIELD_DEFS;
    TEAM_FIELD_KEYS: typeof TEAM_FIELD_KEYS;
    API_BASE_URL: typeof API_BASE_URL;
    COLOR_PRESETS: typeof COLOR_PRESETS;
    DEFAULT_BOARD_COLUMNS: typeof DEFAULT_BOARD_COLUMNS;
    CAL_BAR_H: typeof CAL_BAR_H;
    CAL_BAR_GAP: typeof CAL_BAR_GAP;
    CAL_DAYNUM_H: typeof CAL_DAYNUM_H;
    DEFAULT_STALLED_AFTER_DAYS: typeof DEFAULT_STALLED_AFTER_DAYS;
    ARCHIVE_CUTOFF_DAYS: typeof ARCHIVE_CUTOFF_DAYS;
    formatCommentWhen: typeof formatCommentWhen;
    renderJobComments: typeof renderJobComments;
    toggleReplyBox: typeof toggleReplyBox;
    postJobReply: typeof postJobReply;
    addJobReply: typeof addJobReply;
    deleteJobReply: typeof deleteJobReply;
    handleReplyKey: typeof handleReplyKey;
    postJobComment: typeof postJobComment;
    addJobComment: typeof addJobComment;
    deleteJobComment: typeof deleteJobComment;
    handleJobCommentKey: typeof handleJobCommentKey;
    toggleJobCommentsPanel: typeof toggleJobCommentsPanel;
    renderJobList: typeof renderJobList;
    filterJobList: typeof filterJobList;
    updateJobCount: typeof updateJobCount;
    archiveJob: typeof archiveJob;
    restoreJob: typeof restoreJob;
    openArchivedJobsModal: typeof openArchivedJobsModal;
    closeArchivedJobsModal: typeof closeArchivedJobsModal;
    refreshArchivedJobsListIfOpen: typeof refreshArchivedJobsListIfOpen;
    renderArchivedJobsList: typeof renderArchivedJobsList;
    archiveCurrentJob: typeof archiveCurrentJob;
    duplicateJob: typeof duplicateJob;
    promptDeleteJob: typeof promptDeleteJob;
    confirmDelete: typeof confirmDelete;
    executeDelete: typeof executeDelete;
    closeDeleteJobModal: typeof closeDeleteJobModal;
    renderFixedTaskGrid: typeof renderFixedTaskGrid;
    updateJobCurrentBoardIndicator: typeof updateJobCurrentBoardIndicator;
    renderJobPhaseStrip: typeof renderJobPhaseStrip;
    renderJobSubPhaseStrip: typeof renderJobSubPhaseStrip;
    renderJobFormForPhase: typeof renderJobFormForPhase;
    selectJobPhase: typeof selectJobPhase;
    splitJobIntoPhasesUI: typeof splitJobIntoPhasesUI;
    addJobPhaseUI: typeof addJobPhaseUI;
    renameJobPhaseUI: typeof renameJobPhaseUI;
    deleteJobPhaseUI: typeof deleteJobPhaseUI;
    selectJobSubPhase: typeof selectJobSubPhase;
    getCurrentEditingPhase: typeof getCurrentEditingPhase;
    splitPhaseIntoSubPhasesUI: typeof splitPhaseIntoSubPhasesUI;
    addPhaseSubUnitUI: typeof addPhaseSubUnitUI;
    renameSubPhaseUI: typeof renameSubPhaseUI;
    deleteSubPhaseUI: typeof deleteSubPhaseUI;
    renderJobLinkSection: typeof renderJobLinkSection;
    openJobLinkPickerUI: typeof openJobLinkPickerUI;
    cancelJobLinkPickerUI: typeof cancelJobLinkPickerUI;
    confirmJobLinkUI: typeof confirmJobLinkUI;
    toggleJobLinkEnabledUI: typeof toggleJobLinkEnabledUI;
    unlinkJobUI: typeof unlinkJobUI;
    openJobDrawer: typeof openJobDrawer;
    closeJobDrawer: typeof closeJobDrawer;
    addNewJob: typeof addNewJob;
    editJob: typeof editJob;
    refreshJobFormIfOpen: typeof refreshJobFormIfOpen;
    scheduleAutoSaveJobForm: typeof scheduleAutoSaveJobForm;
    flushAutoSaveJobForm: typeof flushAutoSaveJobForm;
    cancelPendingJobAutosave: typeof cancelPendingJobAutosave;
    setJobNameHint: typeof setJobNameHint;
    showTaskRowWarnings: typeof showTaskRowWarnings;
    autoSaveJobForm: typeof autoSaveJobForm;
    initJobFormAutosaveListeners: typeof initJobFormAutosaveListeners;
    cancelEdit: typeof cancelEdit;
    buildColorPresets: typeof buildColorPresets;
    updateJobColorSwatch: typeof updateJobColorSwatch;
    toggleJobColorPanel: typeof toggleJobColorPanel;
    toggleMobileField: typeof toggleMobileField;
    collapseAllMobileFields: typeof collapseAllMobileFields;
    renderJobCustomFieldsGrid: typeof renderJobCustomFieldsGrid;
    renderJobTeamFieldsGrid: typeof renderJobTeamFieldsGrid;
    collectJobCustomFieldValues: typeof collectJobCustomFieldValues;
    renderJobAttachments: typeof renderJobAttachments;
    handleJobAttachmentUpload: typeof handleJobAttachmentUpload;
    removeJobAttachment: typeof removeJobAttachment;
    isCalendarEventTaskId: typeof isCalendarEventTaskId;
    parseCalendarEventTaskId: typeof parseCalendarEventTaskId;
    defaultRepeatUntil: typeof defaultRepeatUntil;
    getCalendarEventOccurrences: typeof getCalendarEventOccurrences;
    isCalendarEventVisibleToMe: typeof isCalendarEventVisibleToMe;
    flattenCalendarEventsForRange: typeof flattenCalendarEventsForRange;
    ensureCalendarEventIds: typeof ensureCalendarEventIds;
    openAddCalendarEvent: typeof openAddCalendarEvent;
    openEditCalendarEvent: typeof openEditCalendarEvent;
    closeCalendarEventModal: typeof closeCalendarEventModal;
    toggleRepeatUntilField: typeof toggleRepeatUntilField;
    toggleCalendarEventVisibilityFields: typeof toggleCalendarEventVisibilityFields;
    collectCalendarEventVisibilityMembers: typeof collectCalendarEventVisibilityMembers;
    toggleCalendarEventColorPanel: typeof toggleCalendarEventColorPanel;
    updateCalendarEventColorSwatch: typeof updateCalendarEventColorSwatch;
    buildCalendarEventColorPresets: typeof buildCalendarEventColorPresets;
    saveCalendarEventFromModal: typeof saveCalendarEventFromModal;
    deleteCalendarEventFromModal: typeof deleteCalendarEventFromModal;
    setCalendarView: typeof setCalendarView;
    calendarPrev: typeof calendarPrev;
    calendarNext: typeof calendarNext;
    calendarToday: typeof calendarToday;
    calendarExitDayView: typeof calendarExitDayView;
    renderCalendar: typeof renderCalendar;
    buildCalBarHtml: typeof buildCalBarHtml;
    renderMonthCalendar: typeof renderMonthCalendar;
    renderWeekCalendar: typeof renderWeekCalendar;
    renderWeekHourGrid: typeof renderWeekHourGrid;
    calendarOpenJob: typeof calendarOpenJob;
    getScheduledItemsForDate: typeof getScheduledItemsForDate;
    openDayView: typeof openDayView;
    renderDayCalendarView: typeof renderDayCalendarView;
    handleCalBarMouseDown: typeof handleCalBarMouseDown;
    handleCalBarMouseMove: typeof handleCalBarMouseMove;
    applyCalBarMouseMove: typeof applyCalBarMouseMove;
    handleCalBarMouseUp: typeof handleCalBarMouseUp;
    initCalendarDragHandlers: typeof initCalendarDragHandlers;
    calSwipeTargets: typeof calSwipeTargets;
    handleCalSwipeStart: typeof handleCalSwipeStart;
    handleCalSwipeMove: typeof handleCalSwipeMove;
    slideCalendarTargets: typeof slideCalendarTargets;
    handleCalSwipeEnd: typeof handleCalSwipeEnd;
    animateCalendarWheelChange: typeof animateCalendarWheelChange;
    handleCalWheel: typeof handleCalWheel;
    cascadeShiftLaterTasks: typeof cascadeShiftLaterTasks;
    startBarResizeRight: typeof startBarResizeRight;
    startBarResizeLeft: typeof startBarResizeLeft;
    onBarResizeMove: typeof onBarResizeMove;
    applyBarResizeMove: typeof applyBarResizeMove;
    onBarResizeEnd: typeof onBarResizeEnd;
    startTickResize: typeof startTickResize;
    onTickResizeMove: typeof onTickResizeMove;
    applyTickResizeMove: typeof applyTickResizeMove;
    onTickResizeEnd: typeof onTickResizeEnd;
    startBarMove: typeof startBarMove;
    onBarMoveMove: typeof onBarMoveMove;
    applyBarMoveMove: typeof applyBarMoveMove;
    onBarMoveEnd: typeof onBarMoveEnd;
    buildVisibleTaskRows: typeof buildVisibleTaskRows;
    renderGantt: typeof renderGantt;
    scrollToToday: typeof scrollToToday;
    ganttTouchDist: typeof ganttTouchDist;
    setGanttDayWidthAnchored: typeof setGanttDayWidthAnchored;
    requestGanttZoom: typeof requestGanttZoom;
    handleGanttTouchStart: typeof handleGanttTouchStart;
    handleGanttTouchMove: typeof handleGanttTouchMove;
    handleGanttTouchEnd: typeof handleGanttTouchEnd;
    handleGanttWheelZoom: typeof handleGanttWheelZoom;
    zoomGanttCentered: typeof zoomGanttCentered;
    zoomIn: typeof zoomIn;
    zoomOut: typeof zoomOut;
    resetZoom: typeof resetZoom;
    fitToView: typeof fitToView;
    togglePhaseCollapse: typeof togglePhaseCollapse;
    getSubUnitKey: typeof getSubUnitKey;
    toggleTasksPhaseExpanded: typeof toggleTasksPhaseExpanded;
    toggleTasksSubPhaseExpanded: typeof toggleTasksSubPhaseExpanded;
    expandAllGantt: typeof expandAllGantt;
    collapseAllGantt: typeof collapseAllGantt;
    toggleGanttBulkFold: typeof toggleGanttBulkFold;
    toggleGanttJobFocus: typeof toggleGanttJobFocus;
    clearGanttJobFocus: typeof clearGanttJobFocus;
    toggleGanttTaskFocus: typeof toggleGanttTaskFocus;
    clearGanttTaskFocus: typeof clearGanttTaskFocus;
    syncGanttFocusBanner: typeof syncGanttFocusBanner;
    computeDateRange: typeof computeDateRange;
    showDatePopover: typeof showDatePopover;
    hideDatePopover: typeof hideDatePopover;
    showTooltip: typeof showTooltip;
    DUE_MARKER_TASK_ID: typeof DUE_MARKER_TASK_ID;
    collapsedPhaseIds: typeof collapsedPhaseIds;
    // Declared loosely (not `typeof getJobDueMarkerTask`/`flattenJobs`/
    // `buildCalendarJobRows`) — shared-globals.d.ts and calendar.ts each
    // declare their own, differently-typed ambient versions of these names
    // for their own bare references, which TS merges into an intersection
    // with whatever's declared here; the real gantt.ts functions' plain
    // Job[]-based signatures can't satisfy that intersection, so the
    // assignments below cast through `any` for the same reason as
    // `isTaskFinished` above.
    getJobDueMarkerTask: (job: any, phaseId: string | null) => any;
    forEachVisibleSubUnit: typeof forEachVisibleSubUnit;
    flattenJobs: (jobsArr: any[]) => any[];
    getHiddenTaskOrders: typeof getHiddenTaskOrders;
    buildSubUnitClusters: typeof buildSubUnitClusters;
    isCalendarJobSpanTaskId: typeof isCalendarJobSpanTaskId;
    buildCalendarJobRows: (jobsArr: any[]) => any[];
    setHeaderScroll: typeof setHeaderScroll;
    setupScrollSync: typeof setupScrollSync;
    sendPresenceUpdate: typeof sendPresenceUpdate;
    presenceAvatarColor: typeof presenceAvatarColor;
    presenceInitials: typeof presenceInitials;
    presenceAnimDelay: typeof presenceAnimDelay;
    renderPresenceAvatars: typeof renderPresenceAvatars;
    initSyncIndicator: typeof initSyncIndicator;
    setSyncIndicator: typeof setSyncIndicator;
    scheduleOfflineEscalation: typeof scheduleOfflineEscalation;
    cancelOfflineEscalation: typeof cancelOfflineEscalation;
    isBusyEditing: typeof isBusyEditing;
    handleRoomOpen: typeof handleRoomOpen;
    handleRoomClose: typeof handleRoomClose;
    handleRoomSocketError: typeof handleRoomSocketError;
    handleRoomSocketMessageEvent: typeof handleRoomSocketMessageEvent;
    setupRoomSync: typeof setupRoomSync;
    queueSharedSync: typeof queueSharedSync;
    flushPendingRoomPush: typeof flushPendingRoomPush;
    flushPendingSync: typeof flushPendingSync;
    logout: typeof logout;
    sendRoomMessage: typeof sendRoomMessage;
    armStuckWriteWatch: typeof armStuckWriteWatch;
    clearPendingWrite: typeof clearPendingWrite;
    hasPendingWriteForProject: typeof hasPendingWriteForProject;
    pushProjectToShared: typeof pushProjectToShared;
    removeProjectFromShared: typeof removeProjectFromShared;
    pruneStrayEmptyProjects: typeof pruneStrayEmptyProjects;
    deleteFromSharedMap: typeof deleteFromSharedMap;
    deleteJobFromShared: typeof deleteJobFromShared;
    deleteCardFromShared: typeof deleteCardFromShared;
    deleteCalendarEventFromShared: typeof deleteCalendarEventFromShared;
    recordTombstone: typeof recordTombstone;
    pushFieldToShared: typeof pushFieldToShared;
    pushBoardColumnsToShared: typeof pushBoardColumnsToShared;
    pushFieldOptionsToShared: typeof pushFieldOptionsToShared;
    pushWorkflowItemsToShared: typeof pushWorkflowItemsToShared;
    pushHeaderToShared: typeof pushHeaderToShared;
    logActivity: typeof logActivity;
    pushRoomState: typeof pushRoomState;
    pendingWrites: typeof pendingWrites;
    handleRoomMessage: typeof handleRoomMessage;
    synthesizeJobFromOrphanCard: typeof synthesizeJobFromOrphanCard;
    safeMergeInto: typeof safeMergeInto;
    scheduleOrphanRecovery: typeof scheduleOrphanRecovery;
    healOrphanedJobCards: typeof healOrphanedJobCards;
    healOrphanedPhaseCards: typeof healOrphanedPhaseCards;
    healOrphanedCardsForProject: typeof healOrphanedCardsForProject;
    applyRoomSnapshot: typeof applyRoomSnapshot;
    refreshActiveProjectFromShared: typeof refreshActiveProjectFromShared;
    ensureCardChecklists: typeof ensureCardChecklists;
    normalizeChecklistAssignees: typeof normalizeChecklistAssignees;
    isChecklistStageVisibleToMe: typeof isChecklistStageVisibleToMe;
    getOpenChecklistItemsForCard: typeof getOpenChecklistItemsForCard;
    confirmChecklistBeforeMove: typeof confirmChecklistBeforeMove;
    canAssignChecklistStages: typeof canAssignChecklistStages;
    openManageColumnChecklist: typeof openManageColumnChecklist;
    closeManageColumnChecklist: typeof closeManageColumnChecklist;
    renderManageColumnChecklistBody: typeof renderManageColumnChecklistBody;
    addColumnChecklistDefaultItem: typeof addColumnChecklistDefaultItem;
    removeColumnChecklistDefaultItem: typeof removeColumnChecklistDefaultItem;
    getChecklistForStageInProject: typeof getChecklistForStageInProject;
    buildMyChecklistRows: typeof buildMyChecklistRows;
    toggleMyChecklistHideDone: typeof toggleMyChecklistHideDone;
    myChecklistAddableCards: typeof myChecklistAddableCards;
    renderMyChecklistToolbar: typeof renderMyChecklistToolbar;
    renderMyChecklistFilterBar: typeof renderMyChecklistFilterBar;
    onMyChecklistContextChange: typeof onMyChecklistContextChange;
    addMyChecklistItemFromBar: typeof addMyChecklistItemFromBar;
    buildMyChecklistJobRows: typeof buildMyChecklistJobRows;
    renderMyChecklist: typeof renderMyChecklist;
    updateMyChecklistBadge: typeof updateMyChecklistBadge;
    openMyChecklistItem: typeof openMyChecklistItem;
    resolveMyChecklistCard: typeof resolveMyChecklistCard;
    persistMyChecklistChange: typeof persistMyChecklistChange;
    withMyChecklistItem: typeof withMyChecklistItem;
    toggleMyChecklistItemDone: typeof toggleMyChecklistItemDone;
    toggleMyChecklistItemRequired: typeof toggleMyChecklistItemRequired;
    toggleMyChecklistSubItemDone: typeof toggleMyChecklistSubItemDone;
    addMyChecklistSubItem: typeof addMyChecklistSubItem;
    deleteMyChecklistSubItem: typeof deleteMyChecklistSubItem;
    addMyChecklistItem: typeof addMyChecklistItem;
    deleteMyChecklistItem: typeof deleteMyChecklistItem;
    setMyChecklistItemAssignee: typeof setMyChecklistItemAssignee;
    setMyChecklistStageAssignee: typeof setMyChecklistStageAssignee;
    getActiveTab: typeof getActiveTab;
    switchTabMorphed: typeof switchTabMorphed;
    homeWidgetGoTo: typeof homeWidgetGoTo;
    clearHomeTabMorphNames: typeof clearHomeTabMorphNames;
    switchTab: typeof switchTab;
    toggleJobRail: typeof toggleJobRail;
    setMobileView: typeof setMobileView;
    applyHomeReflowTracks: typeof applyHomeReflowTracks;
    toggleHomeWidgetExpand: typeof toggleHomeWidgetExpand;
    buildHomeOverdueRows: typeof buildHomeOverdueRows;
    buildHomeStalledRows: typeof buildHomeStalledRows;
    buildHomeStageSummary: typeof buildHomeStageSummary;
    buildHomeTodayScheduleRows: typeof buildHomeTodayScheduleRows;
    buildHomeUpcomingScheduleRows: typeof buildHomeUpcomingScheduleRows;
    buildHomeGanttUnclosedRows: typeof buildHomeGanttUnclosedRows;
    renderHomeGreeting: typeof renderHomeGreeting;
    getDismissedHomeWidgetAlerts: typeof getDismissedHomeWidgetAlerts;
    isHomeWidgetAlertDismissed: typeof isHomeWidgetAlertDismissed;
    dismissHomeWidgetAlert: typeof dismissHomeWidgetAlert;
    renderHomeWorkflowMiniBoard: typeof renderHomeWorkflowMiniBoard;
    renderHomeWorkflowExpandedBoard: typeof renderHomeWorkflowExpandedBoard;
    buildHomeJobChatFeed: typeof buildHomeJobChatFeed;
    renderHomeJobChatComposeOptions: typeof renderHomeJobChatComposeOptions;
    renderHomeJobChat: typeof renderHomeJobChat;
    postHomeJobChatComment: typeof postHomeJobChatComment;
    updateHomeJobChatComposeState: typeof updateHomeJobChatComposeState;
    toggleHomeReplyBox: typeof toggleHomeReplyBox;
    addHomeJobReply: typeof addHomeJobReply;
    handleHomeReplyKey: typeof handleHomeReplyKey;
    renderHomeDashboard: typeof renderHomeDashboard;
  }
}

window.genId = genId;
window.safeJsonParse = safeJsonParse;
window.getDaysDiff = getDaysDiff;
window.toIsoDate = toIsoDate;
window.formatDate = formatDate;
window.addMonths = addMonths;
window.getBusinessDaysDiff = getBusinessDaysDiff;
window.addBusinessDays = addBusinessDays;
window.formatTimeLabel = formatTimeLabel;
window.timeToMinutes = timeToMinutes;
window.darkenColor = darkenColor;
window.softenColor = softenColor;
window.SOFTEN_AMOUNT = SOFTEN_AMOUNT;
window.findJob = findJob;
window.findTask = findTask;
window.getJobPhases = getJobPhases;
window.getPhaseSubUnits = getPhaseSubUnits;
window.getPhaseCard = getPhaseCard;
window.getJobCards = getJobCards;
window.getPrimaryPhaseCard = getPrimaryPhaseCard;
window.handleColumnDragStart = handleColumnDragStart;
window.handleColumnDragEnd = handleColumnDragEnd;
window.handleColumnReorderOver = handleColumnReorderOver;
window.handleColumnReorderLeave = handleColumnReorderLeave;
window.handleColumnReorderDrop = handleColumnReorderDrop;
window.getDragAfterColumn = getDragAfterColumn;
window.syncColumnsFromDOM = syncColumnsFromDOM;
window.handleCardDragStart = handleCardDragStart;
window.handleCardDragEnd = handleCardDragEnd;
window.handleColumnDragOver = handleColumnDragOver;
window.applyColumnDragOver = applyColumnDragOver;
window.handleColumnDragLeave = handleColumnDragLeave;
window.dropNeedsManualOverride = dropNeedsManualOverride;
window.handleColumnDrop = handleColumnDrop;
window.moveCardToColumn = moveCardToColumn;
window.getDragAfterElement = getDragAfterElement;
window.syncBoardCardsFromDOM = syncBoardCardsFromDOM;
window.slugifyColumnId = slugifyColumnId;
window.addBoardColumn = addBoardColumn;
window.showAddColumnForm = showAddColumnForm;
window.hideAddColumnForm = hideAddColumnForm;
window.handleAddColumnKey = handleAddColumnKey;
window.submitAddColumn = submitAddColumn;
window.deleteBoardColumn = deleteBoardColumn;
window.renameBoardColumn = renameBoardColumn;
window.buildWorkflowStageData = buildWorkflowStageData;
window.renderBoardWorkflowStrip = renderBoardWorkflowStrip;
window.scrollToBoardColumn = scrollToBoardColumn;
window.isCardFromArchivedJob = isCardFromArchivedJob;
window.isCardVisibleToMe = isCardVisibleToMe;
window.escapeHtml = escapeHtml;
window.createAutosaveController = createAutosaveController;
window.openModal = openModal;
window.closeModal = closeModal;
window.showToast = showToast;
window.moveTooltip = moveTooltip;
window.hideTooltip = hideTooltip;
window.toggleMsDropdown = toggleMsDropdown;
window.closeAllMsDropdowns = closeAllMsDropdowns;
window.msSetAll = msSetAll;
window.msDropdownLabelText = msDropdownLabelText;
window.checkForNewerVersion = checkForNewerVersion;
window.checkMaintenanceStatus = checkMaintenanceStatus;
window.applyMaintenanceStatus = applyMaintenanceStatus;
window.toggleMaintenancePanel = toggleMaintenancePanel;
window.setMaintenanceMode = setMaintenanceMode;
window.reportClientError = reportClientError;
window.DISPLAY_NAME_KEY = DISPLAY_NAME_KEY;
window.getStoredDisplayName = getStoredDisplayName;
window.getStoredUsername = getStoredUsername;
window.getStoredSessionToken = getStoredSessionToken;
window.setStoredSessionToken = setStoredSessionToken;
window.decodeSessionTokenPayload = decodeSessionTokenPayload;
window.isSessionTokenUsable = isSessionTokenUsable;
window.PERMISSION_TIERS = PERMISSION_TIERS;
window.getEffectiveRole = getEffectiveRole;
window.hasMinTier = hasMinTier;
window.applyIdentityFromTokenPayload = applyIdentityFromTokenPayload;
window.reauthenticate = reauthenticate;
window.reauthenticateOnce = reauthenticateOnce;
window.getSessionToken = getSessionToken;
window.fetchRoomToken = fetchRoomToken;
window.buildRoomWsUrl = buildRoomWsUrl;
window.fetchWithReauth = fetchWithReauth;
window.postUsersEndpoint = postUsersEndpoint;
window.openBackupsModal = openBackupsModal;
window.closeBackupsModal = closeBackupsModal;
window.triggerBackupNow = triggerBackupNow;
window.loadBackupsList = loadBackupsList;
window.downloadBackupFile = downloadBackupFile;
window.restoreBackupFile = restoreBackupFile;
window.openErrorsModal = openErrorsModal;
window.closeErrorsModal = closeErrorsModal;
window.loadErrorsList = loadErrorsList;
window.openManageUsersModal = openManageUsersModal;
window.closeManageUsersModal = closeManageUsersModal;
window.TIER_LABELS = TIER_LABELS;
window.loadUsersList = loadUsersList;
window.populateUserFormProjectSelect = populateUserFormProjectSelect;
window.onUserFormTierChange = onUserFormTierChange;
window.showAddUserForm = showAddUserForm;
window.showEditUserForm = showEditUserForm;
window.hideUserFormPanel = hideUserFormPanel;
window.submitUserForm = submitUserForm;
window.resetUserPasswordUI = resetUserPasswordUI;
window.removeUserUI = removeUserUI;
window.changeMyPasswordUI = changeMyPasswordUI;
window.setViewAs = setViewAs;
window.displayNameForUsername = displayNameForUsername;
window.getLeadRoster = getLeadRoster;
window.ensureUserRosterLoaded = ensureUserRosterLoaded;
window.toggleActivitySidebar = toggleActivitySidebar;
window.timeAgo = timeAgo;
window.getLogProp = getLogProp;
window.renderActivityLogSidebar = renderActivityLogSidebar;
window.positionSettingsMenu = positionSettingsMenu;
window.toggleSettingsMenu = toggleSettingsMenu;
window.toggleAccountMenu = toggleAccountMenu;
window.closeSettingsMenu = closeSettingsMenu;
window.armSettingsMenuAutoClose = armSettingsMenuAutoClose;
window.cancelSettingsMenuAutoClose = cancelSettingsMenuAutoClose;
window.showSettingsTab = showSettingsTab;
window.applyDarkMode = applyDarkMode;
window.loadDarkModePref = loadDarkModePref;
window.toggleDarkMode = toggleDarkMode;
window.DEFAULT_THEME_COLOR = DEFAULT_THEME_COLOR;
window.normalizeThemeColor = normalizeThemeColor;
window.getSavedThemeColor = getSavedThemeColor;
window.applyThemeColor = applyThemeColor;
window.buildThemePresets = buildThemePresets;
window.updateThemePreview = updateThemePreview;
window.openThemeModal = openThemeModal;
window.closeThemeModal = closeThemeModal;
window.applyTheme = applyTheme;
window.resetThemeDefault = resetThemeDefault;
window.applyProjectBgVisual = applyProjectBgVisual;
window.tutorialStateKey = tutorialStateKey;
window.getTutorialState = getTutorialState;
window.saveTutorialState = saveTutorialState;
window.maybeShowTutorialPrompt = maybeShowTutorialPrompt;
window.showTutorialNotification = showTutorialNotification;
window.hideTutorialNotification = hideTutorialNotification;
window.tutorialNotifShow = tutorialNotifShow;
window.tutorialNotifLater = tutorialNotifLater;
window.tutorialNotifNever = tutorialNotifNever;
window.renderTutorialSlide = renderTutorialSlide;
window.openTutorialSlides = openTutorialSlides;
window.closeTutorialSlides = closeTutorialSlides;
window.tutorialSlideBack = tutorialSlideBack;
window.tutorialSlideNext = tutorialSlideNext;
window.tutorialSlideSkip = tutorialSlideSkip;
window.findCoachmarkTarget = findCoachmarkTarget;
window.findNextCoachmarkIndex = findNextCoachmarkIndex;
window.renderCoachmarkStep = renderCoachmarkStep;
window.openCoachmarkTour = openCoachmarkTour;
window.closeCoachmarkTour = closeCoachmarkTour;
window.coachmarkBack = coachmarkBack;
window.coachmarkNext = coachmarkNext;
window.openWorkflowItemsModal = openWorkflowItemsModal;
window.closeWorkflowItemsModal = closeWorkflowItemsModal;
window.renderWorkflowItemsBody = renderWorkflowItemsBody;
window.toggleWorkflowItemColorPanel = toggleWorkflowItemColorPanel;
window.changeWorkflowItemColor = changeWorkflowItemColor;
window.addWorkflowItem = addWorkflowItem;
window.removeWorkflowItem = removeWorkflowItem;
window.handleColorSwatchKeydown = handleColorSwatchKeydown;
window.resolveCardNameTarget = resolveCardNameTarget;
window.openEditCard = openEditCard;
window.closeCardModal = closeCardModal;
window.scheduleCardAutosave = scheduleCardAutosave;
window.flushCardAutosave = flushCardAutosave;
window.cancelPendingCardAutosave = cancelPendingCardAutosave;
window.setCardTitleHint = setCardTitleHint;
window.autoSaveCardForm = autoSaveCardForm;
window.initCardFormAutosaveListeners = initCardFormAutosaveListeners;
window.deleteCardFromModal = deleteCardFromModal;
window.renderBoard = renderBoard;
window.buildCardEl = buildCardEl;
window.isDarkColor = isDarkColor;
window.toggleColSettings = toggleColSettings;
window.toggleColColorPanel = toggleColColorPanel;
window.changeColumnColor = changeColumnColor;
window.closeAllColSettings = closeAllColSettings;
window.toggleColumnScheduleVisibility = toggleColumnScheduleVisibility;
window.toggleColumnScheduleSync = toggleColumnScheduleSync;
window.toggleColumnFinishedTrigger = toggleColumnFinishedTrigger;
window.setColumnWorkflowItem = setColumnWorkflowItem;
window.toggleColumnAutoAssignChecklist = toggleColumnAutoAssignChecklist;
window.setColumnChecklistAssignee = setColumnChecklistAssignee;
window.setColumnDefaultDuration = setColumnDefaultDuration;
window.setColumnStalledThreshold = setColumnStalledThreshold;
window.reconnectCard = reconnectCard;
window.normalizeTasksToColumns = normalizeTasksToColumns;
window.ensureJobTasksMatchColumns = ensureJobTasksMatchColumns;
window.dedupeTaskIdsAcrossPhases = dedupeTaskIdsAcrossPhases;
window.makeBlankPhaseTasks = makeBlankPhaseTasks;
window.makePhaseCard = makePhaseCard;
window.splitJobIntoPhases = splitJobIntoPhases;
window.addJobPhase = addJobPhase;
window.removeJobPhase = removeJobPhase;
window.unsplitJobFromPhases = unsplitJobFromPhases;
window.splitPhaseIntoSubPhases = splitPhaseIntoSubPhases;
window.addPhaseSubUnit = addPhaseSubUnit;
window.removePhaseSubUnit = removePhaseSubUnit;
window.unsplitPhaseFromSubPhases = unsplitPhaseFromSubPhases;
window.ensureJobHasCards = ensureJobHasCards;
window.migrateOrphanedCards = migrateOrphanedCards;
window.deriveColumnForTasks = deriveColumnForTasks;
window.setCardColumn = setCardColumn;
window.runColumnEntryActions = runColumnEntryActions;
window.syncCardColumns = syncCardColumns;
window.ensureCardIds = ensureCardIds;
window.isJobVisibleToMe = isJobVisibleToMe;
window.getVisibleJobs = getVisibleJobs;
window.isJobFinished = isJobFinished;
window.isTaskFinished = isTaskFinished as any;
window.ensureJobAndTaskIds = ensureJobAndTaskIds;
window.migrateFromLegacy = migrateFromLegacy;
window.loadProjects = loadProjects;
window.saveProjects = saveProjects;
window.flushProjectsToLocalCache = flushProjectsToLocalCache;
window.getActiveProject = getActiveProject;
window.switchProject = switchProject;
window.enforceProjectScopeForRole = enforceProjectScopeForRole;
window.slugifyFixedProjectName = slugifyFixedProjectName;
window.enforceFixedProjectSet = enforceFixedProjectSet;
window.loadActiveProjectData = loadActiveProjectData;
window.saveActiveProject = saveActiveProject;
window.toggleProject = toggleProject;
window.createProject = createProject;
window.setProjectArchived = setProjectArchived;
window.renameProject = renameProject;
window.openProjectsModal = openProjectsModal;
window.updateProjectToggle = updateProjectToggle;
window.renderAll = renderAll;
window.applyPermissionGating = applyPermissionGating;
window.saveJobs = saveJobs;
window.saveBoardColumns = saveBoardColumns;
window.saveWorkflowItems = saveWorkflowItems;
window.saveBoardCards = saveBoardCards;
window.saveCalendarEvents = saveCalendarEvents;
window.saveFieldOptions = saveFieldOptions;
window.saveHeader = saveHeader;
window.loadLinkEnabledPref = loadLinkEnabledPref;
window.saveLinkEnabledPref = saveLinkEnabledPref;
window.isLinkEnabledLocally = isLinkEnabledLocally;
window.setLinkEnabledLocally = setLinkEnabledLocally;
window.getOtherFixedProjectId = getOtherFixedProjectId;
window.getOtherProjectIds = getOtherProjectIds;
window.pickJobLinkProjectUI = pickJobLinkProjectUI;
window.getLinkedReferenceJobs = getLinkedReferenceJobs;
window.jumpToLinkedJobReference = jumpToLinkedJobReference;
window.linkJobs = linkJobs;
window.setJobLinkEnabled = setJobLinkEnabled;
window.unlinkJobById = unlinkJobById;
window.mergeTombstones = mergeTombstones;
window.showFreshLoadOverlay = showFreshLoadOverlay;
window.hideFreshLoadOverlay = hideFreshLoadOverlay;
window.init = init;
window.boot = boot;
window.renderFieldDefHtml = renderFieldDefHtml;
window.renderCustomFieldsGrid = renderCustomFieldsGrid;
window.renderTeamFieldsGrid = renderTeamFieldsGrid;
window.collectCustomFieldValues = collectCustomFieldValues;
window.MAX_ATTACHMENT_SIZE = MAX_ATTACHMENT_SIZE;
window.attachmentDownloadUrl = attachmentDownloadUrl;
window.attachmentSrc = attachmentSrc;
window.uploadAttachmentFile = uploadAttachmentFile;
window.deleteAttachmentFile = deleteAttachmentFile;
window.formatFileSize = formatFileSize;
window.renderAttachmentPanel = renderAttachmentPanel;
window.handleAttachmentPanelUpload = handleAttachmentPanelUpload;
window.removeAttachmentPanelItem = removeAttachmentPanelItem;
window.renderAttachments = renderAttachments;
window.handleAttachmentUpload = handleAttachmentUpload;
window.removeAttachment = removeAttachment;
window.openManageFields = openManageFields;
window.closeManageFields = closeManageFields;
window.renderManageFieldsBody = renderManageFieldsBody;
window.buildManageFieldGroup = buildManageFieldGroup;
window.addFieldOption = addFieldOption;
window.removeFieldOption = removeFieldOption;
window.BOARD_COLOR_PRESETS = BOARD_COLOR_PRESETS;
window.DEFAULT_TASK_DURATION_DAYS = DEFAULT_TASK_DURATION_DAYS;
window.CUSTOM_FIELD_DEFS = CUSTOM_FIELD_DEFS;
window.TEAM_FIELD_KEYS = TEAM_FIELD_KEYS;
window.API_BASE_URL = API_BASE_URL;
window.COLOR_PRESETS = COLOR_PRESETS;
window.DEFAULT_BOARD_COLUMNS = DEFAULT_BOARD_COLUMNS;
window.CAL_BAR_H = CAL_BAR_H;
window.CAL_BAR_GAP = CAL_BAR_GAP;
window.CAL_DAYNUM_H = CAL_DAYNUM_H;
window.DEFAULT_STALLED_AFTER_DAYS = DEFAULT_STALLED_AFTER_DAYS;
window.ARCHIVE_CUTOFF_DAYS = ARCHIVE_CUTOFF_DAYS;
window.formatCommentWhen = formatCommentWhen;
window.renderJobComments = renderJobComments;
window.toggleReplyBox = toggleReplyBox;
window.postJobReply = postJobReply;
window.addJobReply = addJobReply;
window.deleteJobReply = deleteJobReply;
window.handleReplyKey = handleReplyKey;
window.postJobComment = postJobComment;
window.addJobComment = addJobComment;
window.deleteJobComment = deleteJobComment;
window.handleJobCommentKey = handleJobCommentKey;
window.toggleJobCommentsPanel = toggleJobCommentsPanel;
window.renderJobList = renderJobList;
window.filterJobList = filterJobList;
window.updateJobCount = updateJobCount;
window.archiveJob = archiveJob;
window.restoreJob = restoreJob;
window.openArchivedJobsModal = openArchivedJobsModal;
window.closeArchivedJobsModal = closeArchivedJobsModal;
window.refreshArchivedJobsListIfOpen = refreshArchivedJobsListIfOpen;
window.renderArchivedJobsList = renderArchivedJobsList;
window.archiveCurrentJob = archiveCurrentJob;
window.duplicateJob = duplicateJob;
window.promptDeleteJob = promptDeleteJob;
window.confirmDelete = confirmDelete;
window.executeDelete = executeDelete;
window.closeDeleteJobModal = closeDeleteJobModal;
window.renderFixedTaskGrid = renderFixedTaskGrid;
window.updateJobCurrentBoardIndicator = updateJobCurrentBoardIndicator;
window.renderJobPhaseStrip = renderJobPhaseStrip;
window.renderJobSubPhaseStrip = renderJobSubPhaseStrip;
window.renderJobFormForPhase = renderJobFormForPhase;
window.selectJobPhase = selectJobPhase;
window.splitJobIntoPhasesUI = splitJobIntoPhasesUI;
window.addJobPhaseUI = addJobPhaseUI;
window.renameJobPhaseUI = renameJobPhaseUI;
window.deleteJobPhaseUI = deleteJobPhaseUI;
window.selectJobSubPhase = selectJobSubPhase;
window.getCurrentEditingPhase = getCurrentEditingPhase;
window.splitPhaseIntoSubPhasesUI = splitPhaseIntoSubPhasesUI;
window.addPhaseSubUnitUI = addPhaseSubUnitUI;
window.renameSubPhaseUI = renameSubPhaseUI;
window.deleteSubPhaseUI = deleteSubPhaseUI;
window.renderJobLinkSection = renderJobLinkSection;
window.openJobLinkPickerUI = openJobLinkPickerUI;
window.cancelJobLinkPickerUI = cancelJobLinkPickerUI;
window.confirmJobLinkUI = confirmJobLinkUI;
window.toggleJobLinkEnabledUI = toggleJobLinkEnabledUI;
window.unlinkJobUI = unlinkJobUI;
window.openJobDrawer = openJobDrawer;
window.closeJobDrawer = closeJobDrawer;
window.addNewJob = addNewJob;
window.editJob = editJob;
window.refreshJobFormIfOpen = refreshJobFormIfOpen;
window.scheduleAutoSaveJobForm = scheduleAutoSaveJobForm;
window.flushAutoSaveJobForm = flushAutoSaveJobForm;
window.cancelPendingJobAutosave = cancelPendingJobAutosave;
window.setJobNameHint = setJobNameHint;
window.showTaskRowWarnings = showTaskRowWarnings;
window.autoSaveJobForm = autoSaveJobForm;
window.initJobFormAutosaveListeners = initJobFormAutosaveListeners;
window.cancelEdit = cancelEdit;
window.buildColorPresets = buildColorPresets;
window.updateJobColorSwatch = updateJobColorSwatch;
window.toggleJobColorPanel = toggleJobColorPanel;
window.toggleMobileField = toggleMobileField;
window.collapseAllMobileFields = collapseAllMobileFields;
window.renderJobCustomFieldsGrid = renderJobCustomFieldsGrid;
window.renderJobTeamFieldsGrid = renderJobTeamFieldsGrid;
window.collectJobCustomFieldValues = collectJobCustomFieldValues;
window.renderJobAttachments = renderJobAttachments;
window.handleJobAttachmentUpload = handleJobAttachmentUpload;
window.removeJobAttachment = removeJobAttachment;
window.isCalendarEventTaskId = isCalendarEventTaskId;
window.parseCalendarEventTaskId = parseCalendarEventTaskId;
window.defaultRepeatUntil = defaultRepeatUntil;
window.getCalendarEventOccurrences = getCalendarEventOccurrences;
window.isCalendarEventVisibleToMe = isCalendarEventVisibleToMe;
window.flattenCalendarEventsForRange = flattenCalendarEventsForRange;
window.ensureCalendarEventIds = ensureCalendarEventIds;
window.openAddCalendarEvent = openAddCalendarEvent;
window.openEditCalendarEvent = openEditCalendarEvent;
window.closeCalendarEventModal = closeCalendarEventModal;
window.toggleRepeatUntilField = toggleRepeatUntilField;
window.toggleCalendarEventVisibilityFields = toggleCalendarEventVisibilityFields;
window.collectCalendarEventVisibilityMembers = collectCalendarEventVisibilityMembers;
window.toggleCalendarEventColorPanel = toggleCalendarEventColorPanel;
window.updateCalendarEventColorSwatch = updateCalendarEventColorSwatch;
window.buildCalendarEventColorPresets = buildCalendarEventColorPresets;
window.saveCalendarEventFromModal = saveCalendarEventFromModal;
window.deleteCalendarEventFromModal = deleteCalendarEventFromModal;
window.setCalendarView = setCalendarView;
window.calendarPrev = calendarPrev;
window.calendarNext = calendarNext;
window.calendarToday = calendarToday;
window.calendarExitDayView = calendarExitDayView;
window.renderCalendar = renderCalendar;
window.buildCalBarHtml = buildCalBarHtml;
window.renderMonthCalendar = renderMonthCalendar;
window.renderWeekCalendar = renderWeekCalendar;
window.renderWeekHourGrid = renderWeekHourGrid;
window.calendarOpenJob = calendarOpenJob;
window.getScheduledItemsForDate = getScheduledItemsForDate;
window.openDayView = openDayView;
window.renderDayCalendarView = renderDayCalendarView;
window.handleCalBarMouseDown = handleCalBarMouseDown;
window.handleCalBarMouseMove = handleCalBarMouseMove;
window.applyCalBarMouseMove = applyCalBarMouseMove;
window.handleCalBarMouseUp = handleCalBarMouseUp;
window.initCalendarDragHandlers = initCalendarDragHandlers;
window.calSwipeTargets = calSwipeTargets;
window.handleCalSwipeStart = handleCalSwipeStart;
window.handleCalSwipeMove = handleCalSwipeMove;
window.slideCalendarTargets = slideCalendarTargets;
window.handleCalSwipeEnd = handleCalSwipeEnd;
window.animateCalendarWheelChange = animateCalendarWheelChange;
window.handleCalWheel = handleCalWheel;
window.cascadeShiftLaterTasks = cascadeShiftLaterTasks;
window.startBarResizeRight = startBarResizeRight;
window.startBarResizeLeft = startBarResizeLeft;
window.onBarResizeMove = onBarResizeMove;
window.applyBarResizeMove = applyBarResizeMove;
window.onBarResizeEnd = onBarResizeEnd;
window.startTickResize = startTickResize;
window.onTickResizeMove = onTickResizeMove;
window.applyTickResizeMove = applyTickResizeMove;
window.onTickResizeEnd = onTickResizeEnd;
window.startBarMove = startBarMove;
window.onBarMoveMove = onBarMoveMove;
window.applyBarMoveMove = applyBarMoveMove;
window.onBarMoveEnd = onBarMoveEnd;
window.buildVisibleTaskRows = buildVisibleTaskRows;
window.renderGantt = renderGantt;
window.scrollToToday = scrollToToday;
window.ganttTouchDist = ganttTouchDist;
window.setGanttDayWidthAnchored = setGanttDayWidthAnchored;
window.requestGanttZoom = requestGanttZoom;
window.handleGanttTouchStart = handleGanttTouchStart;
window.handleGanttTouchMove = handleGanttTouchMove;
window.handleGanttTouchEnd = handleGanttTouchEnd;
window.handleGanttWheelZoom = handleGanttWheelZoom;
window.zoomGanttCentered = zoomGanttCentered;
window.zoomIn = zoomIn;
window.zoomOut = zoomOut;
window.resetZoom = resetZoom;
window.fitToView = fitToView;
window.togglePhaseCollapse = togglePhaseCollapse;
window.getSubUnitKey = getSubUnitKey;
window.toggleTasksPhaseExpanded = toggleTasksPhaseExpanded;
window.toggleTasksSubPhaseExpanded = toggleTasksSubPhaseExpanded;
window.expandAllGantt = expandAllGantt;
window.collapseAllGantt = collapseAllGantt;
window.toggleGanttBulkFold = toggleGanttBulkFold;
window.toggleGanttJobFocus = toggleGanttJobFocus;
window.clearGanttJobFocus = clearGanttJobFocus;
window.toggleGanttTaskFocus = toggleGanttTaskFocus;
window.clearGanttTaskFocus = clearGanttTaskFocus;
window.syncGanttFocusBanner = syncGanttFocusBanner;
window.computeDateRange = computeDateRange;
window.showDatePopover = showDatePopover;
window.hideDatePopover = hideDatePopover;
window.showTooltip = showTooltip;
window.DUE_MARKER_TASK_ID = DUE_MARKER_TASK_ID;
window.collapsedPhaseIds = collapsedPhaseIds;
window.getJobDueMarkerTask = getJobDueMarkerTask as any;
window.forEachVisibleSubUnit = forEachVisibleSubUnit;
window.flattenJobs = flattenJobs as any;
window.getHiddenTaskOrders = getHiddenTaskOrders;
window.buildSubUnitClusters = buildSubUnitClusters;
window.isCalendarJobSpanTaskId = isCalendarJobSpanTaskId;
window.buildCalendarJobRows = buildCalendarJobRows as any;
window.setHeaderScroll = setHeaderScroll;
window.setupScrollSync = setupScrollSync;
window.sendPresenceUpdate = sendPresenceUpdate;
window.presenceAvatarColor = presenceAvatarColor;
window.presenceInitials = presenceInitials;
window.presenceAnimDelay = presenceAnimDelay;
window.renderPresenceAvatars = renderPresenceAvatars;
window.initSyncIndicator = initSyncIndicator;
window.setSyncIndicator = setSyncIndicator;
window.scheduleOfflineEscalation = scheduleOfflineEscalation;
window.cancelOfflineEscalation = cancelOfflineEscalation;
window.isBusyEditing = isBusyEditing;
window.handleRoomOpen = handleRoomOpen;
window.handleRoomClose = handleRoomClose;
window.handleRoomSocketError = handleRoomSocketError;
window.handleRoomSocketMessageEvent = handleRoomSocketMessageEvent;
window.setupRoomSync = setupRoomSync;
window.queueSharedSync = queueSharedSync;
window.flushPendingRoomPush = flushPendingRoomPush;
window.flushPendingSync = flushPendingSync;
window.logout = logout;
window.sendRoomMessage = sendRoomMessage;
window.armStuckWriteWatch = armStuckWriteWatch;
window.clearPendingWrite = clearPendingWrite;
window.hasPendingWriteForProject = hasPendingWriteForProject;
window.pushProjectToShared = pushProjectToShared;
window.removeProjectFromShared = removeProjectFromShared;
window.pruneStrayEmptyProjects = pruneStrayEmptyProjects;
window.deleteFromSharedMap = deleteFromSharedMap;
window.deleteJobFromShared = deleteJobFromShared;
window.deleteCardFromShared = deleteCardFromShared;
window.deleteCalendarEventFromShared = deleteCalendarEventFromShared;
window.recordTombstone = recordTombstone;
window.pushFieldToShared = pushFieldToShared;
window.pushBoardColumnsToShared = pushBoardColumnsToShared;
window.pushFieldOptionsToShared = pushFieldOptionsToShared;
window.pushWorkflowItemsToShared = pushWorkflowItemsToShared;
window.pushHeaderToShared = pushHeaderToShared;
window.logActivity = logActivity;
window.pushRoomState = pushRoomState;
window.pendingWrites = pendingWrites;
window.handleRoomMessage = handleRoomMessage;
window.synthesizeJobFromOrphanCard = synthesizeJobFromOrphanCard;
window.safeMergeInto = safeMergeInto;
window.scheduleOrphanRecovery = scheduleOrphanRecovery;
window.healOrphanedJobCards = healOrphanedJobCards;
window.healOrphanedPhaseCards = healOrphanedPhaseCards;
window.healOrphanedCardsForProject = healOrphanedCardsForProject;
window.applyRoomSnapshot = applyRoomSnapshot;
window.refreshActiveProjectFromShared = refreshActiveProjectFromShared;
window.ensureCardChecklists = ensureCardChecklists;
window.normalizeChecklistAssignees = normalizeChecklistAssignees;
window.isChecklistStageVisibleToMe = isChecklistStageVisibleToMe;
window.getOpenChecklistItemsForCard = getOpenChecklistItemsForCard;
window.confirmChecklistBeforeMove = confirmChecklistBeforeMove;
window.canAssignChecklistStages = canAssignChecklistStages;
window.openManageColumnChecklist = openManageColumnChecklist;
window.closeManageColumnChecklist = closeManageColumnChecklist;
window.renderManageColumnChecklistBody = renderManageColumnChecklistBody;
window.addColumnChecklistDefaultItem = addColumnChecklistDefaultItem;
window.removeColumnChecklistDefaultItem = removeColumnChecklistDefaultItem;
window.getChecklistForStageInProject = getChecklistForStageInProject;
window.buildMyChecklistRows = buildMyChecklistRows;
window.toggleMyChecklistHideDone = toggleMyChecklistHideDone;
window.myChecklistAddableCards = myChecklistAddableCards;
window.renderMyChecklistToolbar = renderMyChecklistToolbar;
window.renderMyChecklistFilterBar = renderMyChecklistFilterBar;
window.onMyChecklistContextChange = onMyChecklistContextChange;
window.addMyChecklistItemFromBar = addMyChecklistItemFromBar;
window.buildMyChecklistJobRows = buildMyChecklistJobRows;
window.renderMyChecklist = renderMyChecklist;
window.updateMyChecklistBadge = updateMyChecklistBadge;
window.openMyChecklistItem = openMyChecklistItem;
window.resolveMyChecklistCard = resolveMyChecklistCard;
window.persistMyChecklistChange = persistMyChecklistChange;
window.withMyChecklistItem = withMyChecklistItem;
window.toggleMyChecklistItemDone = toggleMyChecklistItemDone;
window.toggleMyChecklistItemRequired = toggleMyChecklistItemRequired;
window.toggleMyChecklistSubItemDone = toggleMyChecklistSubItemDone;
window.addMyChecklistSubItem = addMyChecklistSubItem;
window.deleteMyChecklistSubItem = deleteMyChecklistSubItem;
window.addMyChecklistItem = addMyChecklistItem;
window.deleteMyChecklistItem = deleteMyChecklistItem;
window.setMyChecklistItemAssignee = setMyChecklistItemAssignee;
window.setMyChecklistStageAssignee = setMyChecklistStageAssignee;
window.getActiveTab = getActiveTab;
window.switchTabMorphed = switchTabMorphed;
window.homeWidgetGoTo = homeWidgetGoTo;
window.clearHomeTabMorphNames = clearHomeTabMorphNames;
window.switchTab = switchTab;
window.toggleJobRail = toggleJobRail;
window.setMobileView = setMobileView;
window.applyHomeReflowTracks = applyHomeReflowTracks;
window.toggleHomeWidgetExpand = toggleHomeWidgetExpand;
window.buildHomeOverdueRows = buildHomeOverdueRows;
window.buildHomeStalledRows = buildHomeStalledRows;
window.buildHomeStageSummary = buildHomeStageSummary;
window.buildHomeTodayScheduleRows = buildHomeTodayScheduleRows;
window.buildHomeUpcomingScheduleRows = buildHomeUpcomingScheduleRows;
window.buildHomeGanttUnclosedRows = buildHomeGanttUnclosedRows;
window.renderHomeGreeting = renderHomeGreeting;
window.getDismissedHomeWidgetAlerts = getDismissedHomeWidgetAlerts;
window.isHomeWidgetAlertDismissed = isHomeWidgetAlertDismissed;
window.dismissHomeWidgetAlert = dismissHomeWidgetAlert;
window.renderHomeWorkflowMiniBoard = renderHomeWorkflowMiniBoard;
window.renderHomeWorkflowExpandedBoard = renderHomeWorkflowExpandedBoard;
window.buildHomeJobChatFeed = buildHomeJobChatFeed;
window.renderHomeJobChatComposeOptions = renderHomeJobChatComposeOptions;
window.renderHomeJobChat = renderHomeJobChat;
window.postHomeJobChatComment = postHomeJobChatComment;
window.updateHomeJobChatComposeState = updateHomeJobChatComposeState;
window.toggleHomeReplyBox = toggleHomeReplyBox;
window.addHomeJobReply = addHomeJobReply;
window.handleHomeReplyKey = handleHomeReplyKey;
window.renderHomeDashboard = renderHomeDashboard;
