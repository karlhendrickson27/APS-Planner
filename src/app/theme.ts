// Dark mode, the theme-color picker, and per-project background photos —
// bundled together since applyDarkMode()/the theme modal both end up
// calling applyProjectBgVisual() to keep the panel backgrounds' overlay
// tint in sync with whichever mode is active.
import { darkenColor } from '../utils/color';
import { openModal, closeModal, showToast } from '../utils/ui';
import { pushHeaderToShared } from '../sync/outbound';

declare global {
  // logActivity() is declared once in src/shared-globals.d.ts instead
  // (every src/ file sees it automatically) — not repeated here.
  function getActiveProject(): any;
  function saveActiveProject(): void;
}

// ===== DARK MODE =====
export function applyDarkMode(on: boolean): void {
  document.body.classList.toggle('dark-mode', on);
  const toggle = document.getElementById('darkModeToggle');
  if (toggle) toggle.classList.toggle('active', on);
  applyProjectBgVisual();
}

export function loadDarkModePref(): void {
  applyDarkMode(localStorage.getItem('gantt_dark_mode_v1') === '1');
}

export function toggleDarkMode(): void {
  const isOn = !document.body.classList.contains('dark-mode');
  localStorage.setItem('gantt_dark_mode_v1', isOn ? '1' : '0');
  applyDarkMode(isOn);
}

// ===== THEME COLOR =====
// .app-header is display:none (see its own rule), so this picker drives
// --primary/--primary-light instead — what buttons, active tabs, badges,
// and the Home banner actually render from. A single picked color
// becomes --primary-light (what most of those render as flat); --primary
// (the darker anchor
// gradients pair it with) is derived via darkenColor() rather than
// picked separately, since one color is simpler for the person picking
// it, and every existing --primary/--primary-light consumer already
// composes the two the same way regardless of exactly how dark
// --primary is.
// `var` — src/sync/inbound.ts's bundled applyRoomSnapshot() reads this.
export var DEFAULT_THEME_COLOR = '#3949ab';
const THEME_PRESETS = [
  '#3949ab', // Indigo (default)
  '#2e7d32', // Forest
  '#c62828', // Maroon
  '#546e7a', // Slate
  '#424242', // Charcoal
  '#00897b', // Teal
  '#7b1fa2', // Purple
  '#fb8c00',  // Amber
];

// A project's own header.theme may still be the old {c1,c2} gradient
// shape (every project's default was DEFAULT_THEME = {c1,c2} for as
// long as the header-gradient picker existed, so most real project
// records predate this switch to a single color) — collapses either
// shape down to one hex string.
export function normalizeThemeColor(theme: unknown): string {
  if (typeof theme === 'string') return theme;
  if (theme && typeof theme === 'object') return (theme as any).c2 || (theme as any).c1 || DEFAULT_THEME_COLOR;
  return DEFAULT_THEME_COLOR;
}

export function getSavedThemeColor(): string {
  return localStorage.getItem('gantt_theme_color_v1') || DEFAULT_THEME_COLOR;
}

export function applyThemeColor(): void {
  const color = getSavedThemeColor();
  document.documentElement.style.setProperty('--primary-light', color);
  document.documentElement.style.setProperty('--primary', darkenColor(color, 0.3));
}

export function buildThemePresets(selected?: string): void {
  const container = document.getElementById('themePresets')!;
  container.innerHTML = '';
  THEME_PRESETS.forEach(c => {
    const div = document.createElement('div');
    div.className = 'theme-preset';
    div.style.background = c;
    if (selected && selected.toLowerCase() === c.toLowerCase()) div.classList.add('selected');
    div.onclick = () => {
      (document.getElementById('theme_color') as HTMLInputElement).value = c;
      container.querySelectorAll('.theme-preset').forEach(el => el.classList.remove('selected'));
      div.classList.add('selected');
      updateThemePreview();
    };
    container.appendChild(div);
  });
}

export function updateThemePreview(): void {
  const c = (document.getElementById('theme_color') as HTMLInputElement).value;
  (document.getElementById('themePreview') as HTMLElement).style.background = 'linear-gradient(135deg, ' + c + ' 0%, ' + darkenColor(c, 0.3) + ' 100%)';
  document.querySelectorAll('#themePresets .theme-preset').forEach(el => el.classList.remove('selected'));
  const idx = THEME_PRESETS.findIndex(p => p.toLowerCase() === c.toLowerCase());
  if (idx !== -1) document.querySelectorAll('#themePresets .theme-preset')[idx].classList.add('selected');
}

export function openThemeModal(): void {
  const color = getSavedThemeColor();
  (document.getElementById('theme_color') as HTMLInputElement).value = color;
  buildThemePresets(color);
  updateThemePreview();
  openModal('themeModal');
}

export function closeThemeModal(): void {
  closeModal('themeModal');
}

export function applyTheme(): void {
  const color = (document.getElementById('theme_color') as HTMLInputElement).value;
  localStorage.setItem('gantt_theme_color_v1', color);
  applyThemeColor();
  closeThemeModal();
  showToast('Theme color updated', 'success');
  logActivity('changed theme color');
  // saveActiveProject() picks the new color up from localStorage (via
  // getSavedThemeColor()) into proj.header, then the staleness-protected
  // setHeader path (not the routine batch's unprotected header field)
  // actually pushes it — see the comment on pushHeaderToShared().
  saveActiveProject();
  pushHeaderToShared(activeProjectId as string);
}

export function resetThemeDefault(): void {
  localStorage.removeItem('gantt_theme_color_v1');
  applyThemeColor();
  closeThemeModal();
  showToast('Theme color reset to default', 'info');
  logActivity('reset theme color to default');
  saveActiveProject();
  pushHeaderToShared(activeProjectId as string);
}

// ===== BACKGROUND PHOTO =====
// The Settings > Header/Board Background upload UI was removed;
// gantt_header_bg_photo_v1/gantt_board_bg_photo_v1 stay: whatever was
// already uploaded keeps being stored/synced, it's just no longer
// changeable from the UI.
//
// Static, bundled per-project background images — a normal image file
// shipped alongside index.html (see /assets), not an upload stored in
// localStorage or synced project data. Sidesteps the localStorage-quota/
// base64-inflation problem and the Durable Object's single-key
// room-storage size limit entirely — the browser just requests and
// caches it like any other website asset, full resolution, no size cap.
// Keyed by the original two projects' names, as the fallback when a
// project has no header.logo of its own (projectLogoUrl() below). Originally Board-only; extended to every
// other view's own panel per explicit request. bludorn-board-bg.jpg is
// the full source logo (icon + "BLUDORN BUILDERS" lettering), centered
// on a white square canvas the same way APS's own asset is composed, so
// both behave identically under background-size:cover across every
// panel shape.
const STATIC_PROJECT_BG_BY_NAME: Record<string, string> = {
  'ADVANCED PRECUT SYSTEMS': 'assets/aps-board-bg.jpg',
  'BLUDORN BUILDERS': 'assets/bludorn-board-bg.jpg',
};
// Panels that get the plain static-image treatment — full-bleed on the
// PANEL itself, not each view's own inner content wrapper, so it reads
// consistently even where that wrapper doesn't span the full width (My
// Checklist's is a centered max-width:760px column; a background set on
// IT alone would leave the wider margins on either side untouched).
// Home is left out on purpose: its widgets sit straight on the page
// chrome, each one its own window, not inside a panel (Karl, 2026-09-29).
// A project's board logo: its own (header.logo, set in the Projects
// window, src/app/projects-admin.ts; '' means none on purpose), else the
// bundled image for the two original projects' names.
export function projectLogoUrl(proj: any): string {
  if (!proj) return '';
  const own = proj.header && proj.header.logo;
  if (typeof own === 'string') return /^(data:image\/(png|jpeg|webp);base64,|assets\/)/.test(own) ? own : '';
  return STATIC_PROJECT_BG_BY_NAME[proj.name] || '';
}
const STATIC_BG_PANEL_IDS = ['panel-checklist', 'panel-calendar', 'panel-gantt'];
export function applyProjectBgVisual(): void {
  const proj = getActiveProject();
  const staticBg = projectLogoUrl(proj);
  const dark = document.body.classList.contains('dark-mode');
  const overlay = dark ? 'rgba(10,12,16,0.6)' : 'rgba(255,255,255,0.55)';
  // Board's own exact technique (flat opacity overlay, cover) — an
  // earlier pass swapped this for background-blend-mode:multiply
  // specifically to hide the source image's solid-white background
  // showing as a pale box in dark mode, but per explicit follow-up
  // feedback that dimmed it noticeably below Board's own actual
  // brightness (multiply against a dark surface color darkens the
  // logo's ink too, not just the white background around it — confirmed
  // by rendering Board's real technique next to several multiply
  // variants side by side, not just reasoned through). Reverted to
  // Board's identical formula so these views match its brightness
  // exactly, box included — Board shows that exact same box in its own
  // dark mode today (confirmed directly), so this isn't a new problem,
  // just Board's already-shipped look applied consistently everywhere.
  // The logo's size comes from --project-logo-size (index.html): smaller on
  // a computer screen than a full cover (Karl, 2026-09-30). The logo images
  // are square on white, so a white fill behind them keeps any uncovered
  // edge the same color as the image (no visible box, even under dark
  // mode's overlay).
  const logo = staticBg ? ('url("' + staticBg + '") center / var(--project-logo-size, cover) no-repeat #fff') : '';
  const bgCss = staticBg ? ('linear-gradient(' + overlay + ', ' + overlay + '), ' + logo) : '';
  STATIC_BG_PANEL_IDS.forEach(function(id) {
    const el = document.getElementById(id) as HTMLElement | null;
    if (!el) return;
    // Checklist shows the image at full strength in light mode, like the
    // Board (Karl, 2026-09-30); Calendar and Gantt keep the haze, since
    // their grids sit right on top of it.
    el.style.background = (staticBg && !dark && id === 'panel-checklist') ? logo : bgCss;
    // background-blend-mode isn't part of the background shorthand
    // above, so a stale value from before this reverted away from
    // multiply-blend wouldn't otherwise get cleared on re-runs (project
    // switch, dark mode toggle) within the same page load.
    el.style.backgroundBlendMode = '';
  });
  // Board keeps its own richer logic (a legacy localStorage-uploaded
  // photo, from the old "Board Background" upload UI, as a fallback when
  // no static image is configured) rather than being folded into the loop
  // above, since the other views never had that upload feature and
  // shouldn't inherit a fallback that's specific to Board's own history.
  //
  // The image goes on the whole Board panel, not just #boardWrapper, so
  // the workflow strip above the columns is see-through onto it too
  // (Karl, 2026-09-30); the wrapper itself goes transparent.
  const boardPanel = document.getElementById('panel-board') as HTMLElement | null;
  const boardWrapper = document.getElementById('boardWrapper') as HTMLElement | null;
  if (boardPanel && boardWrapper) {
    const boardPhoto = staticBg || localStorage.getItem('gantt_board_bg_photo_v1');
    // Light mode shows the Board's image at full strength, the way Trello
    // does (Karl, 2026-09-30: the hazed version read as faded). Dark mode
    // keeps the overlay, since the image's own background is white.
    // An uploaded photo (the legacy fallback) still covers the panel.
    const boardImage = staticBg ? logo : ('url("' + boardPhoto + '") center/cover no-repeat');
    boardPanel.style.background = boardPhoto
      ? ((dark ? 'linear-gradient(' + overlay + ', ' + overlay + '), ' : '') + boardImage)
      : 'var(--bg)';
    boardWrapper.style.background = 'transparent';
  }
}
