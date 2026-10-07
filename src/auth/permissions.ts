// The 5-tier permission system (viewer < commenter < editor < projectAdmin
// < admin) plus the identity state a successful login/token-refresh
// establishes. hasMinTier() is the one function nearly every permission
// check in the app should go through, so the tier ordering only needs to
// be correct in exactly one place.
import { DISPLAY_NAME_KEY } from './session';
import { loadNotificationState } from '../app/notifications';
import { checkMaintenanceStatus } from '../app/maintenance';
import { refreshAdminNotices } from '../app/admin-notices';
import { updateAccountButton } from '../app/account-nav';

declare global {
  // eslint-disable-next-line no-var
  var viewAsRole: string | null;
  function enforceProjectScopeForRole(): void;
  // applyPermissionGating()/updateProjectToggle() are declared once in
  // src/shared-globals.d.ts instead (every src/ file sees them
  // automatically) — not repeated here.
  // currentAssignedProjectId stays a real `var` in index.html (not owned
  // here) — src/app/project.ts's switchProject()/enforceProjectScopeForRole()
  // read/write it directly, so a real module-local binding here would
  // silently diverge from what that code sees. currentUserRole/
  // roleConfirmed are the same situation but declared once in
  // src/shared-globals.d.ts instead, since src/app/maintenance.ts also
  // needs them.
  // eslint-disable-next-line no-var
  var currentAssignedProjectId: string | null;
}

export const PERMISSION_TIERS = ['viewer', 'commenter', 'editor', 'projectAdmin', 'admin'];

// While "View as" is active (see viewAsUsername/viewAsRole, both still in
// index.html — Board's "View As" feature), every hasMinTier() check
// throughout the app — nearly all of them, including the data-min-tier
// sweep in applyPermissionGating() — reflects the SIMULATED account's own
// tier instead of the real admin's. Only 2 places deliberately read
// currentUserRole directly instead of going through this: setViewAs()
// (guarded by a literal currentUserRole === 'admin' check) and
// enforceProjectScopeForRole() (must react to the REAL account's
// assignment, not a simulated one).
export function getEffectiveRole(): string | null {
  return viewAsUsername ? viewAsRole : currentUserRole;
}
export function hasMinTier(tier: string): boolean {
  const effectiveRole = getEffectiveRole();
  const mine = PERMISSION_TIERS.indexOf(effectiveRole as string);
  const need = PERMISSION_TIERS.indexOf(tier);
  if (mine === -1 || need === -1) return false;
  return mine >= need;
}

// Applies the identity side effects a token's payload implies — shared by
// both a brand-new login response and a reused cached token, so gating/
// scoping/toggle state gets (re)asserted from whichever token is actually
// in play, not just at the moments a network call happens to mint one.
export function applyIdentityFromTokenPayload(payload: any): void {
  if (!payload) return;
  if (payload.displayName) localStorage.setItem(DISPLAY_NAME_KEY, payload.displayName);
  currentUserRole = payload.role || null;
  currentAssignedProjectId = payload.assignedProjectId || null;
  roleConfirmed = true;
  enforceProjectScopeForRole();
  applyPermissionGating();
  updateProjectToggle();
  updateAccountButton();
  // Re-evaluate now that the real role is known — checkMaintenanceStatus()
  // may have already run once before this resolved (roleConfirmed was
  // still false then, so it deliberately didn't block anyone yet).
  checkMaintenanceStatus();
  refreshAdminNotices();
  loadNotificationState();
}
