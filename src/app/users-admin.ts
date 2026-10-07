// Manage Users (CRUD, password reset, "view as") via the Cloudflare Worker.
import { openModal, closeModal, showToast } from '../utils/ui';
import { escapeHtml } from '../utils/html';
import { getStoredUsername, setStoredSessionToken } from '../auth/session';
import { postUsersEndpoint } from './worker-client';
import { resetUserTwoStep } from './two-step';
import { renderAll } from './project';

// Lets an Admin preview the ENTIRE app — Job Manager, Board, Calendar,
// Gantt — exactly as a specific Member would see it: both their DATA
// visibility (see isJobVisibleToMe()/isCalendarEventVisibleToMe()/
// isChecklistStageVisibleToMe()) and their actual PERMISSION TIER (see
// hasMinTier() in src/auth/permissions.ts, which checks viewAsRole instead
// of currentUserRole whenever viewAsUsername is set) — so the whole UI
// gates itself exactly the way it would for that account, buttons and all.
// This function itself is the one deliberate exception: it tests
// currentUserRole directly rather than going through hasMinTier(), so the
// admin can always change or exit the simulation regardless of how
// restrictive the tier being previewed is. Session-only, like
// ganttFocusedJobId — not persisted, and cleared on project switch (see
// switchProject() in src/app/project.ts).
export function setViewAs(username: string, role: string): void {
  if (currentUserRole !== 'admin') return;
  viewAsUsername = username || null;
  viewAsRole = viewAsUsername ? (role || null) : null;
  renderAll();
}

export function openManageUsersModal(): void {
  openModal('manageUsersModal');
  loadUsersList();
}
export function closeManageUsersModal(): void {
  closeModal('manageUsersModal');
}

export const TIER_LABELS: Record<string, string> = { admin: 'Admin', projectAdmin: 'Project Admin', editor: 'Editor', commenter: 'Commenter', viewer: 'Viewer' };

export async function loadUsersList(): Promise<void> {
  const statusEl = document.getElementById('usersListStatus')!;
  const listEl = document.getElementById('usersList')!;
  statusEl.textContent = 'Loading…';
  listEl.innerHTML = '';
  try {
    const data = await postUsersEndpoint('users/list');
    const myUsername = getStoredUsername();
    statusEl.textContent = data.users.length + ' user(s)';
    if (!data.users.length) {
      listEl.innerHTML = '<div style="padding: var(--s-3-5); color:var(--text-secondary);">No accounts yet — add one below.</div>';
      return;
    }
    data.users.forEach(function(u: any) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding: var(--s-2-5) var(--s-3); border-bottom:1px solid var(--border); gap: var(--s-2);';
      const isMe = u.username === myUsername;
      const tierLabel = TIER_LABELS[u.role] || u.role;
      // Not persisted for the 'admin' tier server-side, but defensively
      // check the tier here too — an unrestricted admin should never show
      // a stale project label even if assignedProjectId somehow lingered.
      const projectLabel = (u.role !== 'admin' && u.assignedProjectId)
        ? (' — ' + ((projects[u.assignedProjectId] && projects[u.assignedProjectId].name) || '(unknown project)'))
        : '';
      const leadLabel = u.isLead ? ' — Lead' : '';
      const mfaLabel = u.mfaEnabled ? ' — 2-step on' : '';
      const emailLabel = u.email ? ' — ' + u.email + (u.emailConfirmed ? '' : ' (not confirmed)') : '';
      // "View as" (see setViewAs()) — previews the whole app exactly as
      // this account would see it. Meaningless on your own row (isMe),
      // so it's the one action button omitted there. Toggles: clicking
      // it again while already previewing this account stops the
      // simulation instead of restarting it.
      const viewAsActive = !isMe && u.username === viewAsUsername;
      const viewAsBtn = isMe ? '' :
        '<button class="btn ' + (viewAsActive ? 'btn-primary' : 'btn-secondary') + '" style="padding: var(--s-1) var(--s-2-5); font-size: var(--t-sm);" data-action="viewas">' + (viewAsActive ? 'Viewing ✓' : 'View as') + '</button>';
      row.innerHTML =
        '<div style="min-width:0;">' +
          '<div style="font-size: var(--t-base); font-weight:600;">' + escapeHtml(u.displayName) + (isMe ? ' <span style="font-weight:400; color:var(--text-secondary);">(you)</span>' : '') + '</div>' +
          '<div style="font-size: var(--t-sm); color:var(--text-secondary);">@' + escapeHtml(u.username) + ' — ' + escapeHtml(tierLabel) + escapeHtml(projectLabel) + escapeHtml(leadLabel) + escapeHtml(emailLabel) + escapeHtml(mfaLabel) + '</div>' +
        '</div>' +
        '<div style="display:flex; gap: var(--s-1-5); flex-shrink:0;">' +
          viewAsBtn +
          '<button class="btn btn-secondary" style="padding: var(--s-1) var(--s-2-5); font-size: var(--t-sm);" data-action="edit">Edit</button>' +
          '<button class="btn btn-secondary" style="padding: var(--s-1) var(--s-2-5); font-size: var(--t-sm);" data-action="reset">Reset Password</button>' +
          (u.mfaEnabled ? '<button class="btn btn-secondary" style="padding: var(--s-1) var(--s-2-5); font-size: var(--t-sm);" data-action="resetmfa" title="Turn off two-step verification (lost phone)">Reset 2-step</button>' : '') +
          '<button class="btn btn-danger" style="padding: var(--s-1) var(--s-2-5); font-size: var(--t-sm);" data-action="remove">Remove</button>' +
        '</div>';
      if (!isMe) {
        (row.querySelector('[data-action="viewas"]') as HTMLButtonElement).onclick = function() {
          setViewAs(viewAsActive ? '' : u.username, u.role);
          loadUsersList();
        };
      }
      (row.querySelector('[data-action="edit"]') as HTMLButtonElement).onclick = function() { showEditUserForm(u.username, u.displayName, u.role, u.assignedProjectId, u.isLead, u.email || ''); };
      (row.querySelector('[data-action="reset"]') as HTMLButtonElement).onclick = function() { resetUserPasswordUI(u.username, u.displayName); };
      (row.querySelector('[data-action="remove"]') as HTMLButtonElement).onclick = function() { removeUserUI(u.username, u.displayName); };
      const resetMfaBtn = row.querySelector('[data-action="resetmfa"]') as HTMLButtonElement | null;
      if (resetMfaBtn) resetMfaBtn.onclick = async function() { if (await resetUserTwoStep(u.username, u.displayName)) loadUsersList(); };
      listEl.appendChild(row);
    });
  } catch (err: any) {
    statusEl.textContent = '';
    listEl.innerHTML = '<div style="padding: var(--s-3-5); color:var(--text-secondary);">' + escapeHtml(err.message) + '</div>';
  }
}

// Populates the project <select> from the app's fixed two-project set, with
// a leading "unrestricted" option — shared by both the Add and Edit forms.
export function populateUserFormProjectSelect(selectedId: string): void {
  const sel = document.getElementById('userFormProject') as HTMLSelectElement;
  const options = ['<option value="">All projects (unrestricted)</option>'];
  Object.keys(projects).forEach(function(id) {
    const archived = projects[id].header && projects[id].header.archived;
    if (archived && id !== selectedId) return;   // archived projects aren't offered, unless already picked
    options.push('<option value="' + escapeHtml(id) + '"' + (id === selectedId ? ' selected' : '') + '>' + escapeHtml(projects[id].name) + (archived ? ' (archived)' : '') + '</option>');
  });
  sel.innerHTML = options.join('');
}

// Admin is never project-scoped — hide the project picker entirely rather
// than just leaving it meaningless when that tier's selected.
export function onUserFormTierChange(): void {
  const tier = (document.getElementById('userFormTier') as HTMLSelectElement).value;
  (document.getElementById('userFormProjectGroup') as HTMLElement).style.display = tier === 'admin' ? 'none' : '';
}

// null = the form is adding a new account; a username string = editing that
// existing one (submitUserForm() branches on this).
export let editingUserFormUsername: string | null = null;

export function showAddUserForm(): void {
  editingUserFormUsername = null;
  document.getElementById('userFormTitle')!.textContent = 'Add User';
  (document.getElementById('userFormUsername') as HTMLInputElement).value = '';
  (document.getElementById('userFormUsername') as HTMLInputElement).disabled = false;
  (document.getElementById('userFormPassword') as HTMLInputElement).value = '';
  (document.getElementById('userFormPassword') as HTMLInputElement).placeholder = 'at least 6 characters';
  document.getElementById('userFormPasswordLabel')!.textContent = 'Password';
  (document.getElementById('userFormDisplayName') as HTMLInputElement).value = '';
  (document.getElementById('userFormEmail') as HTMLInputElement).value = '';
  (document.getElementById('userFormTier') as HTMLSelectElement).value = 'editor';
  (document.getElementById('userFormIsLead') as HTMLSelectElement).value = '0';
  populateUserFormProjectSelect('');
  onUserFormTierChange();
  (document.getElementById('userFormHint') as HTMLElement).style.display = 'none';
  (document.getElementById('userFormPanel') as HTMLElement).style.display = 'block';
}

export function showEditUserForm(username: string, displayName: string, role: string, assignedProjectId: string | null, isLead: boolean, email?: string): void {
  editingUserFormUsername = username;
  document.getElementById('userFormTitle')!.textContent = 'Edit ' + displayName;
  (document.getElementById('userFormUsername') as HTMLInputElement).value = username;
  (document.getElementById('userFormUsername') as HTMLInputElement).disabled = true; // usernames aren't renamable
  (document.getElementById('userFormPassword') as HTMLInputElement).value = '';
  (document.getElementById('userFormPassword') as HTMLInputElement).placeholder = 'leave blank to keep current password';
  document.getElementById('userFormPasswordLabel')!.textContent = 'Password (optional)';
  (document.getElementById('userFormDisplayName') as HTMLInputElement).value = displayName;
  (document.getElementById('userFormEmail') as HTMLInputElement).value = email || '';
  (document.getElementById('userFormTier') as HTMLSelectElement).value = role;
  (document.getElementById('userFormIsLead') as HTMLSelectElement).value = isLead ? '1' : '0';
  populateUserFormProjectSelect(assignedProjectId || '');
  onUserFormTierChange();
  (document.getElementById('userFormHint') as HTMLElement).style.display = 'none';
  (document.getElementById('userFormPanel') as HTMLElement).style.display = 'block';
}

export function hideUserFormPanel(): void {
  (document.getElementById('userFormPanel') as HTMLElement).style.display = 'none';
  editingUserFormUsername = null;
}

// Handles both Add and Edit — editingUserFormUsername (set by
// showAddUserForm()/showEditUserForm()) decides which endpoint(s) to call.
// Editing a role/project is a separate call (users/update) from an optional
// password change (users/reset-password) since the Worker's update endpoint
// deliberately doesn't touch passwords — same separation of concerns as the
// existing standalone "Reset Password" button.
export async function submitUserForm(): Promise<void> {
  const hintEl = document.getElementById('userFormHint') as HTMLElement;
  hintEl.style.display = 'none';
  const username = (document.getElementById('userFormUsername') as HTMLInputElement).value.trim();
  const password = (document.getElementById('userFormPassword') as HTMLInputElement).value;
  const displayName = (document.getElementById('userFormDisplayName') as HTMLInputElement).value.trim() || username;
  const role = (document.getElementById('userFormTier') as HTMLSelectElement).value;
  const assignedProjectId = (document.getElementById('userFormProject') as HTMLSelectElement).value || null;
  const isLead = (document.getElementById('userFormIsLead') as HTMLSelectElement).value === '1';
  const email = (document.getElementById('userFormEmail') as HTMLInputElement).value.trim();

  if (!username) { hintEl.textContent = 'Username is required.'; hintEl.style.display = 'block'; return; }

  try {
    if (editingUserFormUsername) {
      if (password && password.length < 6) {
        hintEl.textContent = 'Password must be at least 6 characters (leave blank to keep the current one).';
        hintEl.style.display = 'block';
        return;
      }
      await postUsersEndpoint('users/update', { targetUsername: editingUserFormUsername, newRole: role, newAssignedProjectId: assignedProjectId, newIsLead: isLead, newEmail: email });
      if (password) {
        if (editingUserFormUsername === getStoredUsername()) {
          const currentPassword = window.prompt('To change your own password, enter your current password:');
          if (!currentPassword) { showToast('Password not changed', 'info'); }
          else {
            const data = await postUsersEndpoint('users/reset-password', { targetUsername: editingUserFormUsername, newPassword: password, currentPassword: currentPassword });
            if (data.token) setStoredSessionToken(data.token);
          }
        } else {
          await postUsersEndpoint('users/reset-password', { targetUsername: editingUserFormUsername, newPassword: password });
        }
      }
      logActivity('updated user account "' + displayName + '"');
      showToast('User updated', 'success');
    } else {
      if (!password || password.length < 6) {
        hintEl.textContent = 'Password must be at least 6 characters.';
        hintEl.style.display = 'block';
        return;
      }
      await postUsersEndpoint('users/add', { newUsername: username, newPassword: password, newDisplayName: displayName, newRole: role, newAssignedProjectId: assignedProjectId, newIsLead: isLead, newEmail: email });
      logActivity('added user account "' + displayName + '"');
      showToast('User added', 'success');
    }
    cachedUserRoster = null; // force a re-fetch so PM/Foreman/Members pickers see the change immediately
    hideUserFormPanel();
    loadUsersList();
  } catch (err: any) {
    // Toast added to match every sibling account-mutation function's own
    // catch block (resetUserPasswordUI/removeUserUI/changeMyPasswordUI,
    // right below) — this one only wrote into the inline hint before,
    // which is fine for the pre-flight validation checks above (still
    // shown that way), but a genuine save failure deserves the same
    // visible-immediately toast every other account action gets.
    showToast('Could not save user: ' + err.message, 'error');
    hintEl.textContent = err.message;
    hintEl.style.display = 'block';
  }
}

export async function resetUserPasswordUI(username: string, displayName: string): Promise<void> {
  const newPassword = window.prompt('New password for ' + displayName + ' (at least 6 characters):');
  if (newPassword === null) { showToast('Cancelled — password not changed', 'info'); return; }
  if (!newPassword) { showToast('Cancelled — no password entered', 'info'); return; }
  try {
    await postUsersEndpoint('users/reset-password', { targetUsername: username, newPassword: newPassword });
    logActivity('reset password for user "' + displayName + '"');
    showToast('Password reset', 'success');
  } catch (err: any) {
    showToast('Could not reset password: ' + err.message, 'error');
  }
}

export async function removeUserUI(username: string, displayName: string): Promise<void> {
  if (!window.confirm('Remove the account for "' + displayName + '"? They\'ll need a new account to sync again.')) {
    showToast('Cancelled — user not removed', 'info');
    return;
  }
  try {
    await postUsersEndpoint('users/remove', { targetUsername: username });
    logActivity('removed user account "' + displayName + '"');
    cachedUserRoster = null;
    showToast('User removed', 'success');
    loadUsersList();
  } catch (err: any) {
    showToast('Could not remove user: ' + err.message, 'error');
  }
}

// Self-service — works for any logged-in user resetting their OWN account,
// not just admins (the worker's reset-password endpoint allows that).
export async function changeMyPasswordUI(): Promise<void> {
  const username = getStoredUsername();
  const currentPassword = window.prompt('Current password:');
  if (!currentPassword) { showToast('Cancelled — password not changed', 'info'); return; }
  const newPassword = window.prompt('New password (at least 6 characters):');
  if (newPassword === null) { showToast('Cancelled — password not changed', 'info'); return; }
  if (!newPassword) { showToast('Cancelled — no password entered', 'info'); return; }
  try {
    const data = await postUsersEndpoint('users/reset-password', { targetUsername: username, newPassword: newPassword, currentPassword: currentPassword });
    // The change signs out every existing session of this account (the
    // server rejects tokens issued before it), this one included; the
    // server returns a fresh token for this one so it carries on.
    if (data && data.token) setStoredSessionToken(data.token);
    showToast('Password changed', 'success');
  } catch (err: any) {
    showToast('Could not change password: ' + err.message, 'error');
  }
}
