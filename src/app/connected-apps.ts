// Account > Connected apps (#connectedAppsModal): the Claude connections
// this person has made (worker/src/mcp/, docs/claude-connector.md). Each
// one can act as them in TeamSync with their role; Disconnect revokes it
// (the server deletes the grant and its tokens; Claude's next call is
// refused, within about a minute at most).
import { openModal, closeModal, showToast } from '../utils/ui';
import { postUsersEndpoint } from './worker-client';
import { timeAgo } from './activity-log';

interface ConnectedApp {
  grantId: string;
  clientName: string;
  connectedAt: number;
  lastUsedAt: number | null;
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function day(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function render(apps: ConnectedApp[]): void {
  const list = el('connectedAppsList');
  list.textContent = '';
  el('connectedAppsLoading').hidden = true;
  el('connectedAppsEmpty').hidden = apps.length > 0;
  list.hidden = apps.length === 0;
  apps.forEach((app) => {
    const li = document.createElement('li');
    const text = document.createElement('div');
    text.className = 'connected-app-text';
    const name = document.createElement('div');
    name.className = 'connected-app-name';
    name.textContent = app.clientName;
    const meta = document.createElement('div');
    meta.className = 'connected-app-meta';
    meta.textContent = 'Connected ' + day(app.connectedAt) + ' · ' + (app.lastUsedAt ? 'last used ' + timeAgo(app.lastUsedAt) : 'not used yet');
    text.append(name, meta);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-secondary';
    btn.textContent = 'Disconnect';
    btn.title = 'Stop ' + app.clientName + ' from using TeamSync as you';
    btn.setAttribute('aria-label', 'Disconnect ' + app.clientName + ', connected ' + day(app.connectedAt));
    btn.addEventListener('click', () => disconnect(app, btn));
    li.append(text, btn);
    list.appendChild(li);
  });
}

async function disconnect(app: ConnectedApp, btn: HTMLButtonElement): Promise<void> {
  if (!window.confirm('Disconnect ' + app.clientName + '?\n\nIt stops working within a minute. You can connect it again from Claude later.')) return;
  btn.disabled = true;
  try {
    const data = await postUsersEndpoint('connected-apps', { action: 'disconnect', grantId: app.grantId });
    render(data.apps || []);
    showToast(app.clientName + ' disconnected', 'success');
    // Keep keyboard focus inside the window after the row disappears.
    el('connectedAppsCloseBtn').focus();
  } catch (err: any) {
    btn.disabled = false;
    showToast('Could not disconnect: ' + err.message, 'error');
  }
}

export async function openConnectedAppsModal(): Promise<void> {
  el('connectedAppsList').textContent = '';
  el('connectedAppsList').hidden = true;
  el('connectedAppsEmpty').hidden = true;
  el('connectedAppsLoading').hidden = false;
  openModal('connectedAppsModal');
  try {
    const data = await postUsersEndpoint('connected-apps', {});
    render(data.apps || []);
  } catch (err: any) {
    el('connectedAppsLoading').hidden = true;
    showToast('Could not load connected apps: ' + err.message, 'error');
  }
}

export function closeConnectedAppsModal(): void {
  closeModal('connectedAppsModal');
}
