// @mention picker for the comment boxes (roadmap A4): typing @ in a job
// comment, a reply, or Home's Job Chat box lists teammates; picking one
// writes "@Their Name ". The mentioned person gets a notification
// (mentionsMe() in src/app/notifications.ts looks for exactly that text).
import { ensureUserRosterLoaded } from './user-roster';
import { escapeHtml } from '../utils/html';

const FIELDS = '#newJobCommentText, #homeJobChatInput, textarea[id^="reply-ta-"]';
const MAX = 6;

let box: HTMLUListElement | null = null;
let field: HTMLInputElement | HTMLTextAreaElement | null = null;
let matches: { username: string; displayName: string }[] = [];
let active = 0;
let atIndex = -1;

function getBox(): HTMLUListElement {
  if (!box) {
    box = document.createElement('ul');
    box.className = 'mention-picker';
    box.id = 'mentionPicker';
    box.setAttribute('role', 'listbox');
    box.setAttribute('aria-label', 'People to mention');
    box.hidden = true;
    box.addEventListener('mousedown', (e) => {
      e.preventDefault();   // keep focus in the comment box
      const li = (e.target as HTMLElement).closest('li[data-i]') as HTMLElement | null;
      if (li) choose(Number(li.dataset.i));
    });
    document.body.appendChild(box);
  }
  return box;
}

export function closeMentionPicker(): void {
  if (box) box.hidden = true;
  if (field) { field.removeAttribute('aria-activedescendant'); field.setAttribute('aria-expanded', 'false'); }
  matches = [];
  atIndex = -1;
}

function render(): void {
  const b = getBox();
  if (!field || !matches.length) { closeMentionPicker(); return; }
  b.innerHTML = matches.map((u, i) =>
    '<li role="option" id="mention-opt-' + i + '" data-i="' + i + '" aria-selected="' + (i === active) + '"' + (i === active ? ' class="active"' : '') + '>' +
      escapeHtml(u.displayName || u.username) + (u.displayName && u.displayName !== u.username ? ' <span>' + escapeHtml(u.username) + '</span>' : '') + '</li>').join('');
  const r = field.getBoundingClientRect();
  b.hidden = false;
  const h = b.offsetHeight;
  const below = r.bottom + 4 + h <= window.innerHeight;
  b.style.left = Math.max(8, Math.min(r.left, window.innerWidth - b.offsetWidth - 8)) + 'px';
  b.style.top = (below ? r.bottom + 4 : Math.max(8, r.top - h - 4)) + 'px';
  field.setAttribute('aria-expanded', 'true');
  field.setAttribute('aria-activedescendant', 'mention-opt-' + active);
}

function choose(i: number): void {
  const u = matches[i];
  if (!u || !field || atIndex < 0) return;
  const caret = field.selectionStart || field.value.length;
  const name = u.displayName || u.username;
  const before = field.value.slice(0, atIndex);
  const after = field.value.slice(caret);
  field.value = before + '@' + name + ' ' + after.replace(/^ /, '');
  const pos = before.length + name.length + 2;
  field.setSelectionRange(pos, pos);
  closeMentionPicker();
  field.focus();
}

async function onInput(e: Event): Promise<void> {
  const t = e.target as HTMLElement;
  if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) || !t.matches(FIELDS)) return;
  const caret = t.selectionStart || 0;
  const m = /(^|\s)@([^\s@]{0,30})$/.exec(t.value.slice(0, caret));
  if (!m) { if (field === t) closeMentionPicker(); return; }
  field = t;
  field.setAttribute('aria-autocomplete', 'list');
  field.setAttribute('aria-controls', 'mentionPicker');
  atIndex = caret - m[2].length - 1;
  const q = m[2].toLowerCase();
  const roster = await ensureUserRosterLoaded();
  if (field !== t || atIndex < 0) return;
  matches = (roster || []).filter((u) => {
    if (!q) return true;
    const words = ((u.displayName || '') + ' ' + u.username).toLowerCase().split(/\s+/);
    return words.some((w) => w.startsWith(q));
  }).slice(0, MAX);
  active = 0;
  render();
}

// Capture phase, so it runs before the boxes' own Enter-to-post handlers.
function onKeyDown(e: KeyboardEvent): void {
  if (!box || box.hidden || e.target !== field || !matches.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    active = (active + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length;
    render();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    choose(active);
  } else if (e.key === 'Escape') {
    closeMentionPicker();
  } else {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
}

export function initMentionPicker(): void {
  document.addEventListener('input', onInput);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('focusout', (e) => { if (e.target === field) setTimeout(closeMentionPicker, 0); });
  window.addEventListener('resize', closeMentionPicker);
}
