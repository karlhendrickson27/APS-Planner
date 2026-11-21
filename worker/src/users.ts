// --- USER ACCOUNTS ---
import { verifyRoomToken, DEFAULT_TOKEN_TTL_MS } from './room-token.ts';
import type { UserRecord, Identity } from './types.ts';

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}
export function hexToBytes(hex: string): Uint8Array {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr;
}
export function genSaltHex(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}
export async function hashPasswordPBKDF2(password: string, saltHex: string): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(saltHex), iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

// Compares in time independent of where the strings first differ, so
// response timing can't reveal how much of a hash matched.
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function normalizeUsername(username: unknown): string {
  return (typeof username === "string" ? username : "").trim().toLowerCase();
}

// Lazy migration: pre-tier accounts stored role:"member" (the old binary
// scheme) — coerced to "editor" (the closest match to what an unrestricted
// member could already do) at read time, never rewritten back to KV, so
// there's no separate one-off migration script to run. assignedProjectId
// defaults to null (unrestricted — sees both fixed projects) for anyone who
// predates the field entirely.
export function normalizeUserRecord(u: UserRecord | null | undefined): UserRecord | null | undefined {
  if (!u) return u;
  if (u.role === "member") u.role = "editor";
  if (u.assignedProjectId === undefined) u.assignedProjectId = null;
  // Briefly (2026-09-23) the email was stored as googleEmail.
  if (!u.email && typeof u.googleEmail === "string") u.email = u.googleEmail;
  // Emails from before confirmation existed were all set by an admin.
  if (u.email && u.emailConfirmed === undefined) u.emailConfirmed = true;
  return u;
}

export async function getUser(env: Env, username: string): Promise<UserRecord | null> {
  const key = normalizeUsername(username);
  if (!key) return null;
  const raw = await env.USERS_KV.get("user:" + key);
  return raw ? (normalizeUserRecord(JSON.parse(raw)) as UserRecord) : null;
}
export async function putUser(env: Env, user: UserRecord): Promise<void> {
  await env.USERS_KV.put("user:" + normalizeUsername(user.username), JSON.stringify(user));
}
export async function deleteUser(env: Env, username: string): Promise<void> {
  await env.USERS_KV.delete("user:" + normalizeUsername(username));
}

export interface RosterEntry {
  username: string;
  displayName: string;
  role: string;
  assignedProjectId: string | null;
  createdAt: number;
  isLead: boolean;
  mfaEnabled: boolean;
  email: string;
  emailConfirmed: boolean;
}

export async function listAllUsers(env: Env): Promise<RosterEntry[]> {
  const list = await env.USERS_KV.list({ prefix: "user:" });
  const users: RosterEntry[] = [];
  for (const k of list.keys) {
    const raw = await env.USERS_KV.get(k.name);
    if (!raw) continue;
    const u = normalizeUserRecord(JSON.parse(raw)) as UserRecord;
    users.push({ username: u.username, displayName: u.displayName, role: u.role, assignedProjectId: u.assignedProjectId, createdAt: u.createdAt, isLead: !!u.isLead, mfaEnabled: !!u.mfa, email: u.email || '', emailConfirmed: !!u.emailConfirmed });
  }
  users.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return users;
}

// ---- Account email ----
// Optional, any provider. People can sign in with it instead of their
// username (the password is the proof there), "Sign in with Google" matches
// on it (sso.ts), and password reset emails will go to it.
// "email:<address>" -> username lets a sign-in find the account without
// reading every user, and keeps one address to one account.
//
// Confirmed vs not: an admin-entered email, or one proven by signing in to
// that Google account, is confirmed. One people type in for themselves
// (Settings > My email) isn't until they prove it, since it could be a typo
// or someone else's address. Only confirmed emails work for Google sign-in
// (and, later, reset emails), and a confirmed claim takes an address over
// from another account's unconfirmed one, so nobody can squat on it.
export function normalizeEmail(email: unknown): string {
  return (typeof email === "string" ? email : "").trim().toLowerCase();
}
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}
function emailKey(email: string): string {
  return "email:" + normalizeEmail(email);
}
// Sets (or, with '', clears) the account's email and keeps the index in
// step. Returns an error message, or null. The caller saves the user.
export async function setAccountEmail(env: Env, user: UserRecord, email: unknown, confirmed: boolean): Promise<string | null> {
  const next = normalizeEmail(email);
  const prev = normalizeEmail(user.email);
  const me = normalizeUsername(user.username);
  if (next === prev) {
    if (next && confirmed) user.emailConfirmed = true;
    return null;
  }
  if (next) {
    if (!isValidEmail(next)) return "That email address doesn't look right";
    const ownerName = await env.USERS_KV.get(emailKey(next));
    if (ownerName && ownerName !== me) {
      const owner = await getUser(env, ownerName);
      if (owner && normalizeEmail(owner.email) === next) {
        if (owner.emailConfirmed || !confirmed) {
          return confirmed ? "That email is already used by @" + ownerName : "That email is already used by another account";
        }
        delete owner.email;
        delete owner.emailConfirmed;
        await putUser(env, owner);
      }
    }
    await env.USERS_KV.put(emailKey(next), me);
  }
  if (prev) await clearAccountEmail(env, user);
  if (next) { user.email = next; user.emailConfirmed = confirmed; } else { delete user.email; delete user.emailConfirmed; }
  delete user.googleEmail;
  return null;
}
export async function clearAccountEmail(env: Env, user: UserRecord): Promise<void> {
  const prev = normalizeEmail(user.email);
  if (!prev) return;
  for (const key of [emailKey(prev), "sso-email:" + prev]) {
    const owner = await env.USERS_KV.get(key);
    if (owner === normalizeUsername(user.username)) await env.USERS_KV.delete(key);
  }
}
export async function findUserByEmail(env: Env, email: string): Promise<UserRecord | null> {
  const address = normalizeEmail(email);
  if (!address) return null;
  const username = (await env.USERS_KV.get(emailKey(address))) || (await env.USERS_KV.get("sso-email:" + address));
  if (!username) return null;
  const user = await getUser(env, username);
  // The index is only a pointer; the account itself must still agree.
  return user && normalizeEmail(user.email) === address ? user : null;
}
// What someone typed in the sign-in box: a username, or an account email.
export async function resolveSignInName(env: Env, typed: unknown): Promise<string> {
  const name = normalizeUsername(typed);
  if (name.indexOf("@") === -1) return name;
  const user = await findUserByEmail(env, name);
  return user ? normalizeUsername(user.username) : name;
}

export async function verifyCredentials(env: Env, username: string, password: string | undefined): Promise<UserRecord | null> {
  const user = await getUser(env, username);
  if (!user || !password) return null;
  const hash = await hashPasswordPBKDF2(password, user.salt);
  if (!timingSafeEqualStr(hash, user.passwordHash)) return null;
  return user;
}

// Every caller authenticates as a real individual account — there's no
// shared team-password fallback.
export async function resolveIdentity(env: Env, username: string, password: string | undefined): Promise<Identity | null> {
  if (!username) return null;
  const user = await verifyCredentials(env, username, password);
  if (!user) return null;
  return { username: user.username, displayName: user.displayName, role: user.role, assignedProjectId: user.assignedProjectId || null };
}

// Resolves identity from a signed room token (see signRoomToken/
// verifyRoomToken in room-token.ts) instead of re-verifying a password
// against KV. Returns the same shape as resolveIdentity() so every
// downstream call site is agnostic to which path produced it.
//
// The signature alone isn't enough: a token stays valid for 24 hours, so
// it's also checked against the account as it is NOW. A removed account
// is refused, a changed role or project applies immediately, and a token
// issued before the account's last password reset (tokensValidAfter) is
// refused, so a reset signs out every existing session. Tokens from
// before iat existed are dated from their expiry.
export async function resolveIdentityFromToken(env: Env, token: string | null | undefined): Promise<Identity | null> {
  const payload = await verifyRoomToken(env.ROOM_TOKEN_SECRET, token);
  if (!payload || !payload.username) return null;
  // Tickets for a half-finished sign-in (auth.ts) carry a purpose and are
  // never a session.
  if (payload.purpose) return null;
  const user = await getUser(env, payload.username as string);
  if (!user) return null;
  const issuedAt = typeof payload.iat === "number" ? payload.iat : payload.exp - DEFAULT_TOKEN_TTL_MS;
  if (typeof user.tokensValidAfter === "number" && issuedAt < user.tokensValidAfter) return null;
  return { username: user.username, displayName: user.displayName, role: user.role, assignedProjectId: user.assignedProjectId || null };
}

// Single entry point every authenticated JSON-body endpoint uses.
// passwordStep() in auth.ts (used by the /auth login endpoint and the
// Claude connector's sign-in page) is the only remaining place a raw
// password is verified — everything past it runs on the token it leads to.
export async function resolveCaller(env: Env, body: { token?: string } | null | undefined): Promise<Identity | null> {
  return resolveIdentityFromToken(env, body && body.token);
}

// Login rate limiting (KV-backed, reuses USERS_KV — no new binding). Per-
// username lockout is the primary defense (protects an individual account
// even when a small team shares one office IP); per-IP is a blunter
// secondary layer against a spray across many usernames from one source,
// deliberately looser so it doesn't lock out the whole team over one
// person's typos. KV's own expirationTtl handles cleanup — no cron job.
// Both "wrong password" and "unknown username" charge the same counter —
// only charging the former would let someone enumerate valid usernames
// for free by noticing which attempts don't count against the limit.
export const AUTH_LOCKOUT_WINDOW_SECONDS = 900; // 15 minutes
export const AUTH_MAX_FAILURES_PER_USERNAME = 10;
export const AUTH_MAX_FAILURES_PER_IP = 30;

export async function getAuthFailureCount(env: Env, key: string): Promise<number> {
  const raw = await env.USERS_KV.get(key);
  const n = raw ? parseInt(raw, 10) : 0;
  return isNaN(n) ? 0 : n;
}
export async function bumpAuthFailure(env: Env, key: string): Promise<void> {
  const n = (await getAuthFailureCount(env, key)) + 1;
  await env.USERS_KV.put(key, String(n), { expirationTtl: AUTH_LOCKOUT_WINDOW_SECONDS });
}
