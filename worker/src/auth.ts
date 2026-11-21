// --- AUTH HANDLER — verifies credentials (verifyCredentials, in users.ts)
// and mints a signed room token used to authenticate the client's
// WebSocket connection. ---
//
// With two-step verification (mfa.ts) sign-in can take two requests:
//   POST /auth      {username, password}
//     -> {token, user}                           done
//     -> {mfaRequired: true, ticket}             account has two-step on:
//        POST /auth/mfa {ticket, code}  -> {token, user}
//     -> {mfaSetupRequired: true, ticket}        the company requires
//        two-step and this account hasn't set it up: the app walks them
//        through /mfa/setup + /mfa/enable with the ticket, and /mfa/enable
//        returns the session.
// A ticket is a short-lived signed token with a `purpose`; it proves the
// password was right and is refused everywhere a session is expected.
import { jsonResponse } from './http.ts';
import { signRoomToken, verifyRoomToken } from './room-token.ts';
import { recordAudit, clientIp } from './audit.ts';
import {
  normalizeUsername, verifyCredentials, getUser, putUser, resolveSignInName,
  AUTH_MAX_FAILURES_PER_USERNAME, AUTH_MAX_FAILURES_PER_IP,
  getAuthFailureCount, bumpAuthFailure
} from './users.ts';
import { getSecurityPolicy, verifyTotp, decryptSecret, looksLikeRecoveryCode, hashRecoveryCode } from './mfa.ts';
import type { UserRecord } from './types.ts';

export const MFA_TICKET_TTL_MS = 5 * 60 * 1000;
export const MFA_SETUP_TICKET_TTL_MS = 15 * 60 * 1000;

export function failKeys(request: Request, username: string): { user: string; ip: string } {
  return { user: "authfail:" + normalizeUsername(username), ip: "authfail-ip:" + (request.headers.get("CF-Connecting-IP") || "unknown") };
}

export async function isLockedOut(env: Env, keys: { user: string; ip: string }): Promise<boolean> {
  const [userFailures, ipFailures] = await Promise.all([getAuthFailureCount(env, keys.user), getAuthFailureCount(env, keys.ip)]);
  return userFailures >= AUTH_MAX_FAILURES_PER_USERNAME || ipFailures >= AUTH_MAX_FAILURES_PER_IP;
}

export function later(ctx: ExecutionContext | undefined, p: Promise<unknown>): Promise<unknown> | undefined {
  if (ctx) { ctx.waitUntil(p); return undefined; }
  return p;
}

// Finishes a sign-in: clears the failure count, records it, and returns
// the session token. `how` goes in the audit entry's details.
// Clears the failure count and records the sign-in. Shared by
// issueSession() and the Claude connector's sign-in page (mcp/authorize.ts).
export async function recordSignIn(env: Env, request: Request, ctx: ExecutionContext | undefined, user: UserRecord, how: string): Promise<void> {
  const done = Promise.all([env.USERS_KV.delete(failKeys(request, user.username).user),
    recordAudit(env, { user: user.username, role: user.role, action: 'Signed in', ip: clientIp(request), details: how })]);
  const wait = later(ctx, done);
  if (wait) await wait;
}

export async function issueSession(env: Env, request: Request, ctx: ExecutionContext | undefined, user: UserRecord, how: string, corsHeaders: Record<string, string>, extra?: Record<string, unknown>): Promise<Response> {
  await recordSignIn(env, request, ctx, user, how);
  const identity = { username: user.username, displayName: user.displayName, role: user.role, assignedProjectId: user.assignedProjectId || null };
  const token = await signRoomToken(env.ROOM_TOKEN_SECRET, identity);
  return jsonResponse(Object.assign({ token, user: identity }, extra || {}), 200, corsHeaders);
}

// The account a sign-in ticket was issued for, or null if the ticket is
// invalid, expired, for another purpose, or older than the account's last
// password reset.
export async function resolveTicket(env: Env, ticket: unknown, purpose: string): Promise<UserRecord | null> {
  const payload = await verifyRoomToken(env.ROOM_TOKEN_SECRET, typeof ticket === "string" ? ticket : null);
  if (!payload || payload.purpose !== purpose || typeof payload.username !== "string") return null;
  const user = await getUser(env, payload.username);
  if (!user) return null;
  if (typeof user.tokensValidAfter === "number" && typeof payload.iat === "number" && payload.iat < user.tokensValidAfter) return null;
  return user;
}

// Checks a 6-digit authenticator code or an unused recovery code against
// the account's two-step settings. On success the account record is
// updated in place (lastStep advanced / recovery code used up) and the
// caller must save it. Returns how it matched, or null.
export async function checkSecondFactor(env: Env, user: UserRecord, code: unknown): Promise<'code' | 'recovery' | null> {
  if (!user.mfa || typeof code !== "string") return null;
  if (looksLikeRecoveryCode(code)) {
    const hash = await hashRecoveryCode(code);
    const idx = user.mfa.recovery.indexOf(hash);
    if (idx === -1) return null;
    user.mfa.recovery.splice(idx, 1);
    return 'recovery';
  }
  const secret = await decryptSecret(env, user.mfa.secret);
  if (!secret) return null;
  const step = await verifyTotp(secret, code, Date.now(), user.mfa.lastStep);
  if (step === null) return null;
  user.mfa.lastStep = step;
  return 'code';
}

// ---- The sign-in rules, shared by the app's /auth + /auth/mfa and the
// Claude connector's sign-in page (mcp/authorize.ts). Each returns what
// happened; the caller only chooses how to answer. `via` (e.g. "Claude
// connector") goes in the audit entries' details. ----

export type PasswordStep =
  | { kind: 'locked' }
  | { kind: 'bad' }
  | { kind: 'mfa'; user: UserRecord }        // right password, two-step code next
  | { kind: 'mfaSetup'; user: UserRecord }   // company requires two-step, not set up
  | { kind: 'ok'; user: UserRecord };        // right password, nothing more needed

export async function passwordStep(env: Env, request: Request, ctx: ExecutionContext | undefined, typed: unknown, password: string | undefined, via?: string): Promise<PasswordStep> {
  const details = via ? { details: via } : {};
  // The box takes a username or the account's email. Failures count
  // against the account either way, so switching between the two doesn't
  // get extra tries.
  const signInName = await resolveSignInName(env, typed);
  const keys = failKeys(request, signInName);
  if (await isLockedOut(env, keys)) {
    // Skips verifyCredentials()/the PBKDF2 hash entirely once locked out.
    const blocked = recordAudit(env, Object.assign({ user: signInName, action: 'Sign-in blocked (too many attempts)', ip: clientIp(request) }, details));
    const wait = later(ctx, blocked); if (wait) await wait;
    return { kind: 'locked' };
  }
  const user = signInName ? await verifyCredentials(env, signInName, password) : null;
  if (!user) {
    const bump = Promise.all([bumpAuthFailure(env, keys.user), bumpAuthFailure(env, keys.ip),
      recordAudit(env, Object.assign({ user: signInName, action: 'Failed sign-in', ip: clientIp(request) }, details))]);
    const wait = later(ctx, bump); if (wait) await wait;
    return { kind: 'bad' };
  }
  // Password right; the failure count is only cleared once the whole
  // sign-in succeeds, so wrong codes keep counting toward the lockout.
  if (user.mfa) return { kind: 'mfa', user };
  if ((await getSecurityPolicy(env)).requireMfa) return { kind: 'mfaSetup', user };
  return { kind: 'ok', user };
}

// The two-step code for an account whose password was already right. On a
// match the account is saved (code step advanced / recovery code used up).
export async function mfaStep(env: Env, request: Request, ctx: ExecutionContext | undefined, user: UserRecord, code: unknown, via?: string): Promise<'locked' | 'bad' | 'code' | 'recovery'> {
  const details = via ? { details: via } : {};
  const keys = failKeys(request, user.username);
  if (await isLockedOut(env, keys)) {
    const wait = later(ctx, recordAudit(env, Object.assign({ user: user.username, action: 'Sign-in blocked (too many attempts)', ip: clientIp(request) }, details))); if (wait) await wait;
    return 'locked';
  }
  const matched = await checkSecondFactor(env, user, code);
  if (!matched) {
    const bump = Promise.all([bumpAuthFailure(env, keys.user), bumpAuthFailure(env, keys.ip),
      recordAudit(env, Object.assign({ user: user.username, role: user.role, action: 'Failed two-step code', ip: clientIp(request) }, details))]);
    const wait = later(ctx, bump); if (wait) await wait;
    return 'bad';
  }
  await putUser(env, user);
  return matched;
}

export async function handleAuth(request: Request, env: Env, corsHeaders: Record<string, string>, ctx: ExecutionContext | undefined): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
  }

  let body: { username?: string; password?: string; name?: string };
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
  }

  const step = await passwordStep(env, request, ctx, body.username, body.password);
  if (step.kind === 'locked') return jsonResponse({ error: "Too many attempts — try again in a few minutes." }, 429, corsHeaders);
  if (step.kind === 'bad') return jsonResponse({ error: "Invalid credentials" }, 401, corsHeaders);
  if (step.kind === 'mfa') {
    const ticket = await signRoomToken(env.ROOM_TOKEN_SECRET, { purpose: 'mfa', username: step.user.username }, MFA_TICKET_TTL_MS);
    return jsonResponse({ mfaRequired: true, ticket }, 200, corsHeaders);
  }
  if (step.kind === 'mfaSetup') {
    const ticket = await signRoomToken(env.ROOM_TOKEN_SECRET, { purpose: 'mfa-setup', username: step.user.username }, MFA_SETUP_TICKET_TTL_MS);
    return jsonResponse({ mfaSetupRequired: true, ticket }, 200, corsHeaders);
  }
  return issueSession(env, request, ctx, step.user, 'password', corsHeaders);
}

// POST /auth/mfa {ticket, code} — the second half of a two-step sign-in.
export async function handleAuthMfa(request: Request, env: Env, corsHeaders: Record<string, string>, ctx: ExecutionContext | undefined): Promise<Response> {
  let body: { ticket?: string; code?: string };
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }

  const user = await resolveTicket(env, body.ticket, 'mfa');
  if (!user) return jsonResponse({ error: "Your sign-in timed out — enter your password again.", restart: true }, 401, corsHeaders);
  if (!user.mfa) return jsonResponse({ error: "Two-step verification is no longer on for this account — sign in again.", restart: true }, 401, corsHeaders);

  const matched = await mfaStep(env, request, ctx, user, body.code);
  if (matched === 'locked') return jsonResponse({ error: "Too many attempts — try again in a few minutes." }, 429, corsHeaders);
  if (matched === 'bad') return jsonResponse({ error: "That code didn't work — check your authenticator app and try again." }, 401, corsHeaders);
  const remaining = user.mfa.recovery.length;
  return issueSession(env, request, ctx, user,
    matched === 'recovery' ? 'password + recovery code (' + remaining + ' left)' : 'password + authenticator code',
    corsHeaders, matched === 'recovery' ? { recoveryCodesLeft: remaining } : undefined);
}
