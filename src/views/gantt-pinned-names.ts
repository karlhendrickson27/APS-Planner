// Phone Gantt: job names that stay on screen (roadmap I1). Phones hide the
// Job column (the .left-panel rule under @media (max-width: 480px),
// (max-height: 480px)), so the bar's own name tag is the only label a row
// has, and it used to scroll off with the start of the bar. On every
// scroll/zoom/render (called from setHeaderScroll() in gantt.ts) this:
//   1. slides each bar's name tags along so they sit at the left screen
//      edge while the start of the bar is scrolled off (`translate` via
//      --pin-shift, so it never fights the tags' own hover `transform`);
//   2. when the visible part of a bar is too short for its name, hides the
//      in-bar name and shows it just beside the bar instead (right, else
//      left, else it stays squeezed in the bar with an ellipsis);
//   3. gives a row whose bars are all off screen a grey "‹ Name" / "Name ›"
//      label at that edge, so no row is ever blank.
// Mockup Karl approved: https://claude.ai/artifact/Gsn1ZLt6sMA3gVBAMfEh8j
// Labels from 2 and 3 live in their own layer at the end of #timelineGrid
// (not inside the Preact-rendered barsLayer) and ignore pointer events, so
// dragging and tapping bars works exactly as before.

const PHONE_QUERY = '(max-width: 480px), (max-height: 480px)';
const EDGE = 8;
let lastLayerHtml = '';

interface Host { el: HTMLElement; tag: HTMLElement; left: number; right: number; top: number; height: number; nameW: number; name: string; color: string }

function tagName(tag: HTMLElement): string {
  return (tag.textContent || '').replace(/^[▸▾]\s*/, '').trim();
}

function getLayer(grid: HTMLElement): HTMLElement {
  let layer = grid.querySelector<HTMLElement>(':scope > .gantt-pin-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'gantt-pin-layer';
    layer.setAttribute('aria-hidden', 'true');
    grid.appendChild(layer);
  }
  return layer;
}

function label(cls: string, text: string, left: number, top: number, color?: string, side?: 'l' | 'r'): string {
  const dot = color ? '<span class="gantt-pin-dot" style="background:' + color + '"></span>' : '';
  const body = side === 'l' ? '‹ ' + dot + escapeText(text) : side === 'r' ? escapeText(text) + ' ' + dot + ' ›' : escapeText(text);
  return '<span class="' + cls + '" style="left:' + left + 'px;top:' + top + 'px">' + body + '</span>';
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clearPins(grid: HTMLElement): void {
  grid.querySelectorAll<HTMLElement>('[data-pin-hidden]').forEach((el) => el.removeAttribute('data-pin-hidden'));
  grid.querySelectorAll<HTMLElement>('.task-bar, .job-span-name-wrap').forEach((el) => el.style.removeProperty('--pin-shift'));
  const layer = grid.querySelector<HTMLElement>(':scope > .gantt-pin-layer');
  if (layer) layer.innerHTML = '';
  lastLayerHtml = '';
}

function updateGanttPinnedNames(scrollLeft?: number): void {
  const body = document.getElementById('timelineBody');
  const grid = document.getElementById('timelineGrid');
  if (!body || !grid) return;
  if (!window.matchMedia(PHONE_QUERY).matches || !body.clientWidth) { clearPins(grid); return; }

  const x = scrollLeft !== undefined ? scrollLeft : body.scrollLeft;
  const viewR = x + body.clientWidth;

  // Read everything first, then write, so a scroll frame lays out once.
  const hosts: Host[] = [];
  grid.querySelectorAll<HTMLElement>('.task-bar, .job-span-name-wrap').forEach((el) => {
    const tag = el.querySelector<HTMLElement>(':scope > .task-bar-job-tag');
    if (!tag || el.classList.contains('milestone')) return;
    const left = parseFloat(el.style.left), width = parseFloat(el.style.width), top = parseFloat(el.style.top);
    if (!isFinite(left) || !isFinite(width) || !isFinite(top)) return;
    hosts.push({ el, tag, left, right: left + width, top, height: el.offsetHeight || 26, nameW: tag.scrollWidth, name: tagName(tag), color: tag.style.color });
  });

  let html = '';
  const rows = new Map<number, Host[]>();
  hosts.forEach((h) => {
    const row = rows.get(h.top);
    if (row) row.push(h); else rows.set(h.top, [h]);

    const visL = Math.max(h.left, x), visR = Math.min(h.right, viewR);
    h.el.style.setProperty('--pin-shift', Math.max(0, visL - h.left) + 'px');
    h.el.removeAttribute('data-pin-hidden');
    if (visR <= visL) return;
    if (visR - visL >= h.nameW + 2 * EDGE) return;
    // Not enough of the bar on screen for the whole name: put it beside.
    const labelTop = h.top + h.height / 2 - 9;
    if (h.right + 6 + h.nameW <= viewR - EDGE) {
      h.el.setAttribute('data-pin-hidden', '');
      html += label('gantt-pin-out', h.name, h.right + 6, labelTop);
    } else if (h.left - 6 - h.nameW >= x + EDGE) {
      h.el.setAttribute('data-pin-hidden', '');
      html += label('gantt-pin-out', h.name, h.left - 6 - h.nameW, labelTop);
    }
  });

  rows.forEach((row) => {
    if (row.some((h) => h.right > x && h.left < viewR)) return;
    const before = row.filter((h) => h.right <= x).sort((a, b) => b.right - a.right)[0];
    const after = row.filter((h) => h.left >= viewR).sort((a, b) => a.left - b.left)[0];
    if (before) html += label('gantt-pin-edge', before.name, x + EDGE, before.top + before.height / 2 - 9, before.color, 'l');
    if (after) html += label('gantt-pin-edge gantt-pin-edge-r', after.name, viewR - EDGE, after.top + after.height / 2 - 9, after.color, 'r');
  });

  const layer = getLayer(grid);
  if (html !== lastLayerHtml || !layer.isConnected) { layer.innerHTML = html; lastLayerHtml = html; }
}

export { updateGanttPinnedNames };
