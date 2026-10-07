// Settings > Live calendar link (#calendarFeedModal, roadmap J6 part 1): a
// private address for this project's schedule that Outlook or Google
// Calendar subscribes to once and keeps re-checking on its own, instead of
// the one-time .ics download (src/app/ics.ts). The server builds the feed
// with the same visibility rules as the app: worker/src/calendar-feed.ts.
// One secret per person, shared by all their projects' links; "Reset link"
// swaps it for a new one (old links stop working), "Turn off" removes it.
import { openModal, closeModal, showToast } from '../utils/ui';
import { postUsersEndpoint } from './worker-client';
import { getActiveProject } from './project';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function feedUrl(feedToken: string): string {
  return API_BASE_URL + 'cal/' + feedToken + '/' + encodeURIComponent(activeProjectId || '') + '.ics';
}

function render(feedToken: string | null): void {
  const on = !!feedToken;
  el<HTMLInputElement>('calFeedUrl').value = on ? feedUrl(feedToken!) : '';
  el('calFeedOnPart').hidden = !on;
  el('calFeedOffPart').hidden = on;
  el('calFeedResetBtn').hidden = !on;
  el('calFeedOffBtn').hidden = !on;
}

async function request(action: 'get' | 'reset' | 'off'): Promise<void> {
  const data = await postUsersEndpoint('calendar-feed/link', { action: action });
  render(data.feedToken || null);
}

export async function openCalendarFeedModal(): Promise<void> {
  const project = getActiveProject();
  el('calFeedProject').textContent = project && project.name ? String(project.name) : 'this project';
  el<HTMLInputElement>('calFeedUrl').value = 'Loading…';
  el('calFeedOnPart').hidden = false;
  el('calFeedOffPart').hidden = true;
  openModal('calendarFeedModal');
  try { await request('get'); } catch (err: any) {
    el<HTMLInputElement>('calFeedUrl').value = '';
    showToast('Could not load your calendar link: ' + err.message, 'error');
  }
}

export function closeCalendarFeedModal(): void {
  closeModal('calendarFeedModal');
}

export function copyCalendarFeedUrl(): void {
  const input = el<HTMLInputElement>('calFeedUrl');
  if (!input.value) return;
  const done = () => showToast('Calendar link copied', 'success');
  const fallback = () => { input.select(); document.execCommand('copy'); done(); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(input.value).then(done, fallback);
  else fallback();
}

export async function resetCalendarFeed(): Promise<void> {
  try {
    await request('reset');
    showToast('New link made. The old one has stopped working, so update any calendar that used it.', 'success');
  } catch (err: any) { showToast('Could not reset the link: ' + err.message, 'error'); }
}

export async function turnOffCalendarFeed(): Promise<void> {
  try {
    await request('off');
    showToast('Calendar link turned off', 'success');
  } catch (err: any) { showToast('Could not turn off the link: ' + err.message, 'error'); }
}

export async function createCalendarFeed(): Promise<void> {
  try { await request('get'); } catch (err: any) { showToast('Could not make a link: ' + err.message, 'error'); }
}
