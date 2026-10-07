// The Projects window (#projectsModal, roadmap A1): the list of projects,
// opened from the account menu (#projectToggleBtn). Everyone who can see
// more than one project picks one here to switch to it. Admins also add
// projects (optionally copying this project's stages, workflow and field
// lists), rename them, give each its own board logo, and archive or
// restore them. Archiving hides a project from everyone's list but keeps
// all of its data; nothing here deletes a project.
// A project's logo and archived flag live in its header (header.logo,
// header.archived), which the server checks (isSafeHeader() in
// worker/src/room-state.ts) and keeps when an older app leaves them out.
import { openModal, closeModal, showToast } from '../utils/ui';
import { escapeHtml } from '../utils/html';
import { genId } from '../utils/id';
import {
  switchProject, saveProjects, saveActiveProject, isProjectArchived, activeProjectIds, updateProjectToggle,
} from './project';
import { pushProjectToShared, pushBoardColumnsToShared, pushFieldOptionsToShared, pushWorkflowItemsToShared, logActivity } from '../sync/outbound';
import { isSyncLive } from '../sync/connection';
import { DEFAULT_THEME_COLOR, normalizeThemeColor, projectLogoUrl, applyProjectBgVisual } from './theme';

const MODAL_ID = 'projectsModal';
const SEARCH_FROM = 6;          // the search box shows once there are this many projects
const LOGO_MAX_PX = 600;
const LOGO_MAX_CHARS = 600000;  // the server allows 700k

let renamingId: string | null = null;
let logoOpenId: string | null = null;
let adding = false;
let query = '';

function isAdmin(): boolean { return currentUserRole === 'admin'; }
function el<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)); }

function jobCount(p: any): number {
  return ((p && p.jobs) || []).filter(function (j: any) { return !j.archived; }).length;
}

function sortedIds(ids: string[]): string[] {
  return ids.slice().sort(function (a, b) { return String(projects[a].name || '').localeCompare(String(projects[b].name || '')); });
}

function rowHtml(id: string, archived: boolean): string {
  const p = projects[id];
  const current = id === activeProjectId;
  const color = normalizeThemeColor(p.header && p.header.theme) || DEFAULT_THEME_COLOR;
  const count = jobCount(p);
  const meta = count + (count === 1 ? ' job' : ' jobs') + (current ? ' · Open now' : '');
  if (renamingId === id) {
    return '<li class="proj-row editing" data-id="' + escapeHtml(id) + '">' +
      '<input type="text" id="projRenameInput" maxlength="80" aria-label="Project name" value="' + escapeHtml(p.name || '') + '">' +
      '<button type="button" class="btn btn-primary" data-act="rename-save">Save</button>' +
      '<button type="button" class="btn btn-secondary" data-act="rename-cancel">Cancel</button></li>';
  }
  const logo = projectLogoUrl(p);
  const actions = !isAdmin() ? '' : archived
    ? '<div class="proj-actions"><button type="button" class="proj-act" data-act="restore">Restore</button></div>'
    : '<div class="proj-actions">' +
        '<button type="button" class="proj-act" data-act="rename">Rename</button>' +
        '<button type="button" class="proj-act" data-act="logo" aria-expanded="' + (logoOpenId === id) + '">Logo</button>' +
        '<button type="button" class="proj-act" data-act="archive">Archive</button></div>';
  const logoPanel = (isAdmin() && logoOpenId === id && !archived)
    ? '<div class="proj-logo-panel">' +
        (logo ? '<img src="' + escapeHtml(logo) + '" alt="' + escapeHtml(p.name + ' logo') + '">' : '<span class="proj-logo-none">No logo</span>') +
        '<div><p>Shown behind the Board, Checklist, Calendar and Gantt for this project. A square image on white works best.</p>' +
        '<button type="button" class="btn btn-secondary" data-act="logo-upload">' + (logo ? 'Change logo' : 'Add logo') + '</button>' +
        (logo ? ' <button type="button" class="btn btn-secondary" data-act="logo-remove">Remove</button>' : '') + '</div></div>'
    : '';
  return '<li class="proj-row' + (current ? ' current' : '') + (archived ? ' archived' : '') + '" data-id="' + escapeHtml(id) + '">' +
    '<button type="button" class="proj-open" data-act="open"' + (archived ? ' disabled' : '') + '>' +
      '<span class="proj-dot" style="background:' + escapeHtml(color) + '"></span>' +
      '<span class="proj-text"><span class="proj-name">' + escapeHtml(p.name || 'Untitled') + '</span><span class="proj-meta">' + escapeHtml(meta) + '</span></span>' +
    '</button>' + actions + logoPanel + '</li>';
}

function render(): void {
  const listEl = el('projectsList');
  if (!listEl) return;
  const active = sortedIds(activeProjectIds());
  const archived = isAdmin() ? sortedIds(Object.keys(projects).filter(function (id) { return isProjectArchived(projects[id]); })) : [];
  const q = query.trim().toLowerCase();
  const shown = q ? active.filter(function (id) { return String(projects[id].name || '').toLowerCase().indexOf(q) !== -1; }) : active;

  const search = el('projectsSearchWrap');
  if (search) search.hidden = active.length < SEARCH_FROM;
  listEl.innerHTML = shown.length ? shown.map(function (id) { return rowHtml(id, false); }).join('') : '<li class="proj-empty">No project matches “' + escapeHtml(query) + '”.</li>';

  const archWrap = el('projectsArchived');
  if (archWrap) {
    archWrap.hidden = !archived.length;
    el('projectsArchivedCount').textContent = String(archived.length);
    el('projectsArchivedList').innerHTML = archived.map(function (id) { return rowHtml(id, true); }).join('');
  }

  const addBtn = el('projectsAddBtn');
  const addForm = el('projectsAddForm');
  if (addBtn) addBtn.hidden = !isAdmin() || adding;
  if (addForm) addForm.hidden = !isAdmin() || !adding;
  const copyLabel = el('projectsAddCopyName');
  if (copyLabel) copyLabel.textContent = (projects[activeProjectId as string] && projects[activeProjectId as string].name) || 'this project';
  el('projectsTitle').textContent = isAdmin() ? 'Projects' : 'Switch project';
}

export function openProjectsModal(): void {
  renamingId = null; logoOpenId = null; adding = false; query = '';
  const search = el<HTMLInputElement>('projectsSearch');
  if (search) search.value = '';
  render();
  openModal(MODAL_ID);
}

export function closeProjectsModal(): void { closeModal(MODAL_ID); }

// Saves a project's own changes locally and sends them (name + header).
function saveAndPush(id: string): void {
  if (id === activeProjectId) {
    const title = document.getElementById('headerTitle');
    if (title) title.textContent = projects[id].header.title;
    saveActiveProject();
  } else {
    saveProjects();
  }
  pushProjectToShared(id);
  updateProjectToggle();
}

function needLive(): boolean {
  if (isSyncLive()) return true;
  showToast('You need to be online to change projects', 'error');
  return false;
}

// Exposed on window for tests and the console. Returns the new id.
export function createProject(name: string, copySettings: boolean): string | null {
  if (!isAdmin()) return null;
  const clean = String(name || '').trim().slice(0, 80);
  if (!clean) { showToast('Give the project a name', 'error'); return null; }
  if (Object.keys(projects).some(function (id) { return String(projects[id].name || '').trim().toLowerCase() === clean.toLowerCase(); })) {
    showToast('There is already a project called “' + clean + '”', 'error');
    return null;
  }
  if (!needLive()) return null;
  const src = copySettings ? projects[activeProjectId as string] : null;
  const id = 'project-' + genId();
  projects[id] = {
    id: id,
    name: clean,
    jobs: [],
    boardColumns: clone((src && src.boardColumns && src.boardColumns.length) ? src.boardColumns : DEFAULT_BOARD_COLUMNS),
    workflowItems: clone((src && src.workflowItems) || []),
    boardCards: [],
    calendarEvents: [],
    deletedIds: {},
    fieldOptions: clone((src && src.fieldOptions) || {
      pm: [], foreman: [],
      jobType: ['New Home', 'Remodel', 'Commercial', 'Addition', 'Service Call'],
      timeframe: ['This Week', 'Next Week', 'This Month', 'This Quarter'],
      incentivePeriod: ['Q1', 'Q2', 'Q3', 'Q4'],
    }),
    header: { title: clean, subtitle: '', theme: (src && src.header && src.header.theme) || DEFAULT_THEME_COLOR, bgPhoto: null, boardBgPhoto: null, logo: '' },
    activityLog: [],
    fieldRevisions: { boardColumns: 0, fieldOptions: 0, header: 0, workflowItems: 0 },
  };
  saveProjects();
  // The first message creates the project on the server (admins only).
  pushProjectToShared(id, undefined, { full: true });
  pushBoardColumnsToShared(id);
  pushFieldOptionsToShared(id);
  pushWorkflowItemsToShared(id);
  switchProject(id);
  logActivity('created project "' + clean + '"');
  updateProjectToggle();
  return id;
}

export function renameProject(id: string, name: string): boolean {
  const p = projects[id];
  const clean = String(name || '').trim().slice(0, 80);
  if (!isAdmin() || !p || !clean) return false;
  if (clean === p.name) return true;
  if (Object.keys(projects).some(function (o) { return o !== id && String(projects[o].name || '').trim().toLowerCase() === clean.toLowerCase(); })) {
    showToast('There is already a project called “' + clean + '”', 'error');
    return false;
  }
  if (!needLive()) return false;
  // The two original projects' logos were picked by name; keep them.
  if (typeof p.header.logo !== 'string') p.header.logo = projectLogoUrl(p);
  const old = p.name;
  p.name = clean;
  p.header.title = clean;
  saveAndPush(id);
  if (id === activeProjectId) logActivity('renamed project "' + old + '" to "' + clean + '"');
  return true;
}

export function setProjectArchived(id: string, archived: boolean): boolean {
  const p = projects[id];
  if (!isAdmin() || !p) return false;
  if (archived && activeProjectIds().length <= 1) { showToast('You need at least one project that isn’t archived', 'error'); return false; }
  if (!needLive()) return false;
  if (typeof p.header.logo !== 'string') p.header.logo = projectLogoUrl(p);
  if (archived && id === activeProjectId) {
    const next = sortedIds(activeProjectIds()).find(function (o) { return o !== id; });
    if (next) switchProject(next);
    if (activeProjectId === id) return false;   // the switch was refused
  }
  p.header.archived = archived;
  saveAndPush(id);
  showToast(archived ? '“' + p.name + '” archived. Its data is kept; restore it any time.' : '“' + p.name + '” restored', 'success');
  return true;
}

function setProjectLogo(id: string, logo: string): void {
  const p = projects[id];
  if (!isAdmin() || !p || !needLive()) return;
  p.header.logo = logo;
  saveAndPush(id);
  if (id === activeProjectId) applyProjectBgVisual();
  render();
}

// Shrinks the picked image to at most LOGO_MAX_PX on a white square-ish
// canvas and stores it as a JPEG data URL.
function readLogoFile(file: File): Promise<string> {
  return new Promise(function (resolve, reject) {
    if (!/^image\/(png|jpeg|webp|gif|bmp)$/.test(file.type)) { reject(new Error('Pick a PNG, JPG or WebP image')); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, LOGO_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      let out = canvas.toDataURL('image/jpeg', 0.85);
      if (out.length > LOGO_MAX_CHARS) out = canvas.toDataURL('image/jpeg', 0.6);
      if (out.length > LOGO_MAX_CHARS) { reject(new Error('That image is too detailed; try a simpler one')); return; }
      resolve(out);
    };
    img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That file could not be read as an image')); };
    img.src = url;
  });
}

function onListClick(e: Event): void {
  const t = e.target as HTMLElement;
  const btn = t.closest('[data-act]') as HTMLElement | null;
  const row = t.closest('.proj-row') as HTMLElement | null;
  if (!btn || !row) return;
  const id = row.dataset.id as string;
  switch (btn.dataset.act) {
    case 'open':
      if (id !== activeProjectId) switchProject(id);
      if (activeProjectId === id) closeProjectsModal();
      return;
    case 'rename': renamingId = id; logoOpenId = null; render(); (el<HTMLInputElement>('projRenameInput')).select(); return;
    case 'rename-cancel': renamingId = null; render(); return;
    case 'rename-save':
      if (renameProject(id, el<HTMLInputElement>('projRenameInput').value)) { renamingId = null; render(); }
      return;
    case 'logo': logoOpenId = logoOpenId === id ? null : id; renamingId = null; render(); return;
    case 'logo-upload': {
      const input = el<HTMLInputElement>('projectsLogoFile');
      input.dataset.projectId = id;
      input.value = '';
      input.click();
      return;
    }
    case 'logo-remove': setProjectLogo(id, ''); return;
    case 'archive': if (setProjectArchived(id, true)) render(); return;
    case 'restore': if (setProjectArchived(id, false)) render(); return;
  }
}

export function initProjectsModal(): void {
  const modal = document.getElementById(MODAL_ID);
  if (!modal) return;
  modal.addEventListener('click', onListClick);
  modal.addEventListener('keydown', function (e) {
    const t = e.target as HTMLElement;
    if (t.id === 'projRenameInput' && e.key === 'Enter') { e.preventDefault(); (modal.querySelector('[data-act="rename-save"]') as HTMLElement).click(); }
    if (t.id === 'projRenameInput' && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); renamingId = null; render(); }
    if (t.id === 'projectsAddName' && e.key === 'Enter') { e.preventDefault(); el('projectsAddCreateBtn').click(); }
  });
  el('projectsCloseBtn').addEventListener('click', closeProjectsModal);
  el<HTMLInputElement>('projectsSearch').addEventListener('input', function () { query = this.value; render(); });
  el('projectsAddBtn').addEventListener('click', function () {
    adding = true; render();
    const input = el<HTMLInputElement>('projectsAddName');
    input.value = ''; input.focus();
  });
  el('projectsAddCancelBtn').addEventListener('click', function () { adding = false; render(); });
  el('projectsAddCreateBtn').addEventListener('click', function () {
    const id = createProject(el<HTMLInputElement>('projectsAddName').value, el<HTMLInputElement>('projectsAddCopy').checked);
    if (!id) return;
    adding = false;
    closeProjectsModal();
    showToast('Project created', 'success');
  });
  el<HTMLInputElement>('projectsLogoFile').addEventListener('change', function () {
    const file = this.files && this.files[0];
    const id = this.dataset.projectId;
    if (!file || !id) return;
    readLogoFile(file).then(function (dataUrl) { setProjectLogo(id, dataUrl); showToast('Logo updated', 'success'); },
      function (err) { showToast(err.message || 'Could not use that image', 'error'); });
  });
}
