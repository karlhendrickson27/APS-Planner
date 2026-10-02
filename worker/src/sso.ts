// --- SINGLE SIGN-ON: "Sign in with Google" (OpenID Connect) ---
//
// The flow, all through this Worker so the app never sees a Google token:
//   1. GET  /sso/google/start?return=<app page>
//        Remembers a random `state` (KV, 10 minutes, plus a cookie on this
//        Worker's own domain so the sign-in has to finish in the same
//        browser that started it), and redirects to Google.
//   2. GET  /sso/google/callback?code&state
//        Google sends the browser back here. The code is exchanged for an
//        ID token (with the client secret and a PKCE verifier), the token's
//        signature and claims are checked against Google's published keys,
//        and its email is matched to a TeamSync account's confirmed email
//        (see users.ts). The browser is
//        sent back to the app with a one-time code in the #fragment,
//        never the session itself.
//   3. POST /sso/redeem {code}  -> {token, user}
//        The app swaps the one-time code (2 minutes, single use) for a
//        session, exactly like a password sign-in would give.
// Google sign-in is an extra way in: password sign-in (with a username or
// email) always keeps working. Nobody gets in just by having a Google
// account: its email has to be an existing TeamSync account's email, and
// (if the admin set one) the Google Workspace domain has to be on the
// allowed list.
//
// "Connect Google account" (Settings > My email) runs the same flow for
// someone already signed in: POST /sso/link-ticket gives a 5-minute ticket,
// /sso/google/start?link=<ticket> carries it through Google, and the
// callback sets that account's email to the Google address, confirmed,
// instead of signing in. Google sign-in itself only accepts confirmed
// emails (see users.ts).
//
// Setup (once): a Google Cloud "OAuth client ID" of type Web application,
// with this Worker's /sso/google/callback as an authorized redirect URI.
// Its ID and secret are Worker secrets GOOGLE_CLIENT_ID and
// GOOGLE_CLIENT_SECRET; without them Google sign-in stays unavailable.
// Microsoft (Entra ID) can be added later as a second provider with the
// same shape.
import { jsonResponse } from './http.ts';
import { base64UrlEncode, base64UrlDecode, signRoomToken } from './room-token.ts';
import { recordAudit, clientIp } from './audit.ts';
import { getUser, putUser, resolveCaller, normalizeEmail, findUserByEmail, setAccountEmail } from './users.ts';
import { requireAdmin } from './users-admin.ts';
import { issueSession, resolveTicket } from './auth.ts';

declare global {
  interface Env {
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
  }
}

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const STATE_TTL_SECONDS = 600;
const CODE_TTL_SECONDS = 120;
const STATE_COOKIE = 'ts_sso_state';

// Where the browser may be sent back to after signing in. Anything else is
// refused, so the one-time code can't be delivered to someone else's page.
export const ALLOWED_RETURN_PREFIXES = [
  'https://app.useteamsync.com/',
  // The old address, kept until everyone has moved to the new one.
  'https://production27.github.io/APS-Planner/',
];
const LOCAL_RETURN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//;

export function isAllowedReturn(url: string): boolean {
  if (typeof url !== 'string' || url.length > 2000) return false;
  let parsed: URL;
  try { parsed = new URL(url); } catch (e) { return false; }
  const clean = parsed.origin + parsed.pathname;
  return ALLOWED_RETURN_PREFIXES.some(function (p) { return clean.startsWith(p); }) || LOCAL_RETURN.test(clean);
}

// ---- Company settings (KV, one record) ----
export const SSO_SETTINGS_KEY = 'sso-settings';
export interface SsoSettings {
  googleEnabled: boolean;
  // Google Workspace domains allowed to sign in (the ID token's `hd`
  // claim). Empty = any Google account whose email is linked to a user.
  allowedDomains: string[];
  updatedBy?: string;
  updatedAt?: number;
}
export async function getSsoSettings(env: Env): Promise<SsoSettings> {
  let s: Partial<SsoSettings> = {};
  try { const raw = await env.USERS_KV.get(SSO_SETTINGS_KEY); s = raw ? JSON.parse(raw) : {}; } catch (e) { s = {}; }
  return {
    googleEnabled: !!s.googleEnabled,
    allowedDomains: Array.isArray(s.allowedDomains) ? s.allowedDomains.filter(function (d) { return typeof d === 'string'; }) : [],
    updatedBy: s.updatedBy, updatedAt: s.updatedAt,
  };
}
export function googleConfigured(env: Env): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}
// Google sign-in is offered only when both the server keys exist and an
// admin has switched it on.
export async function googleActive(env: Env): Promise<{ active: boolean; settings: SsoSettings }> {
  const settings = await getSsoSettings(env);
  return { active: googleConfigured(env) && settings.googleEnabled, settings };
}

// ---- Small crypto helpers ----
function randomToken(bytes: number): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}
async function sha256B64Url(text: string): Promise<string> {
  return base64UrlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

// ---- ID token verification (RS256 against Google's published keys) ----
interface Jwk { kid: string; kty: string; n: string; e: string; alg?: string }
let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;
const JWKS_MAX_AGE_MS = 60 * 60 * 1000;
export function resetJwksCache(): void { jwksCache = null; }

async function googleKey(kid: string): Promise<Jwk | null> {
  const fresh = jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_MAX_AGE_MS;
  let key = fresh ? jwksCache!.keys.find(function (k) { return k.kid === kid; }) : undefined;
  if (key) return key;
  // Unknown kid: Google rotated its keys, so fetch them again.
  const res = await fetch(GOOGLE_JWKS_URL);
  if (!res.ok) return null;
  const body = await res.json() as { keys: Jwk[] };
  jwksCache = { keys: body.keys || [], fetchedAt: Date.now() };
  key = jwksCache.keys.find(function (k) { return k.kid === kid; });
  return key || null;
}

export interface GoogleClaims {
  iss: string; aud: string; sub: string; email?: string; email_verified?: boolean; hd?: string;
  nonce?: string; exp: number; iat: number; name?: string;
}

// Returns the claims, or a reason it was refused.
export async function verifyGoogleIdToken(idToken: string, clientId: string, nonce: string, now: number): Promise<{ claims?: GoogleClaims; error?: string }> {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) return { error: 'malformed token' };
  let header: { alg?: string; kid?: string };
  let claims: GoogleClaims;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
  } catch (e) { return { error: 'malformed token' }; }
  if (header.alg !== 'RS256' || !header.kid) return { error: 'unexpected signing algorithm' };
  const jwk = await googleKey(header.kid);
  if (!jwk) return { error: 'unknown signing key' };
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true } as JsonWebKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlDecode(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!ok) return { error: 'bad signature' };
  if (GOOGLE_ISSUERS.indexOf(claims.iss) === -1) return { error: 'wrong issuer' };
  if (claims.aud !== clientId) return { error: 'wrong audience' };
  // A minute of slack for clock differences.
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < now - 60000) return { error: 'expired' };
  if (!nonce || claims.nonce !== nonce) return { error: 'nonce mismatch' };
  if (!claims.email || claims.email_verified !== true) return { error: 'email not verified by Google' };
  return { claims };
}

// ---- Handlers ----

function redirect(location: string, headers?: Record<string, string>): Response {
  return new Response(null, { status: 302, headers: Object.assign({ Location: location, 'Cache-Control': 'no-store' }, headers || {}) });
}

// Sends the browser back to the app with a result in the #fragment
// (fragments never reach a server log or a Referer header).
function backToApp(returnUrl: string, params: Record<string, string>): Response {
  const base = returnUrl.split('#')[0];
  const frag = Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
  return redirect(base + '#' + frag, { 'Set-Cookie': STATE_COOKIE + '=; Path=/sso; Max-Age=0; HttpOnly; Secure; SameSite=Lax' });
}

function readCookie(request: Request, name: string): string {
  const header = request.headers.get('Cookie') || '';
  const match = header.split(/;\s*/).find(function (c) { return c.indexOf(name + '=') === 0; });
  return match ? match.slice(name.length + 1) : '';
}

// Public: what the sign-in screen should offer.
export async function handleSsoConfig(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const { active, settings } = await googleActive(env);
  return jsonResponse({ google: active }, 200, corsHeaders);
}

export async function handleGoogleStart(request: Request, env: Env, url: URL): Promise<Response> {
  const returnUrl = url.searchParams.get('return') || '';
  if (!isAllowedReturn(returnUrl)) return new Response('Sign-in was started from a page that isn\'t TeamSync.', { status: 400 });
  const { active, settings } = await googleActive(env);
  if (!active) return backToApp(returnUrl, { sso_error: 'not_enabled' });
  // "Connect Google account": the ticket names the signed-in account.
  let linkUsername: string | undefined;
  if (url.searchParams.get('link')) {
    const linkUser = await resolveTicket(env, url.searchParams.get('link'), 'sso-link');
    if (!linkUser) return backToApp(returnUrl, { sso_error: 'expired' });
    linkUsername = linkUser.username;
  }

  const state = randomToken(24);
  const nonce = randomToken(24);
  const verifier = randomToken(48);
  await env.USERS_KV.put('sso-state:' + state, JSON.stringify({ nonce, verifier, returnUrl, linkUsername, createdAt: Date.now() }), { expirationTtl: STATE_TTL_SECONDS });
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID as string,
    redirect_uri: url.origin + '/sso/google/callback',
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: await sha256B64Url(verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  // A hint only (Google shows that domain's accounts first); the domain
  // is enforced on the way back.
  if (settings.allowedDomains.length === 1) params.set('hd', settings.allowedDomains[0]);
  return redirect(GOOGLE_AUTH_URL + '?' + params.toString(), {
    'Set-Cookie': STATE_COOKIE + '=' + state + '; Path=/sso; Max-Age=' + STATE_TTL_SECONDS + '; HttpOnly; Secure; SameSite=Lax',
  });
}

export async function handleGoogleCallback(request: Request, env: Env, url: URL, ctx: ExecutionContext | undefined): Promise<Response> {
  const state = url.searchParams.get('state') || '';
  const raw = state ? await env.USERS_KV.get('sso-state:' + state) : null;
  if (!raw) return new Response('This sign-in link has expired. Go back to TeamSync and try again.', { status: 400 });
  await env.USERS_KV.delete('sso-state:' + state); // single use
  const saved = JSON.parse(raw) as { nonce: string; verifier: string; returnUrl: string; linkUsername?: string };
  const ip = clientIp(request);
  const fail = async function (reason: string, detail: string, who?: string): Promise<Response> {
    await recordAudit(env, { user: who || '', action: 'Failed Google sign-in', ip, details: detail });
    return backToApp(saved.returnUrl, { sso_error: reason });
  };

  // Must finish in the browser that started it (stops someone tricking a
  // colleague's browser into signing in as the attacker).
  if (readCookie(request, STATE_COOKIE) !== state) return fail('expired', 'state cookie missing or different');
  if (url.searchParams.get('error')) return backToApp(saved.returnUrl, { sso_error: 'cancelled' });
  const code = url.searchParams.get('code');
  const { active, settings } = await googleActive(env);
  if (!active) return backToApp(saved.returnUrl, { sso_error: 'not_enabled' });
  if (!code) return fail('failed', 'no code from Google');

  let idToken = '';
  try {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: env.GOOGLE_CLIENT_ID as string, client_secret: env.GOOGLE_CLIENT_SECRET as string,
        redirect_uri: url.origin + '/sso/google/callback', grant_type: 'authorization_code', code_verifier: saved.verifier,
      }).toString(),
    });
    const body = await res.json() as { id_token?: string; error?: string };
    if (!res.ok || !body.id_token) return fail('failed', 'token exchange: ' + (body.error || res.status));
    idToken = body.id_token;
  } catch (e) {
    return fail('failed', 'token exchange: network');
  }

  const checked = await verifyGoogleIdToken(idToken, env.GOOGLE_CLIENT_ID as string, saved.nonce, Date.now());
  if (!checked.claims) return fail('failed', 'ID token: ' + checked.error);
  const email = normalizeEmail(checked.claims.email);
  if (settings.allowedDomains.length && settings.allowedDomains.indexOf((checked.claims.hd || '').toLowerCase()) === -1) {
    return fail('domain', email + ' is not in an allowed Google Workspace domain', email);
  }
  if (saved.linkUsername) {
    const target = await getUser(env, saved.linkUsername);
    if (!target) return fail('failed', 'account to connect no longer exists', saved.linkUsername);
    const error = await setAccountEmail(env, target, email, true);
    if (error) return fail('email_taken', email + ': ' + error, target.username);
    await putUser(env, target);
    await recordAudit(env, { user: target.username, role: target.role, action: 'Connected Google account', ip, details: email + ' (email confirmed)' });
    return backToApp(saved.returnUrl, { sso_linked: email });
  }

  const user = await findUserByEmail(env, email);
  if (!user) return fail('no_account', email + ' is not linked to a TeamSync account', email);
  if (!user.emailConfirmed) return fail('unconfirmed', email + ' is on @' + user.username + ' but not confirmed', email);

  const oneTime = randomToken(24);
  await env.USERS_KV.put('sso-code:' + oneTime, JSON.stringify({ username: user.username, email }), { expirationTtl: CODE_TTL_SECONDS });
  return backToApp(saved.returnUrl, { sso_code: oneTime });
}

export async function handleSsoRedeem(request: Request, env: Env, corsHeaders: Record<string, string>, ctx: ExecutionContext | undefined): Promise<Response> {
  let body: { code?: string };
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders); }
  const code = typeof body.code === 'string' ? body.code : '';
  const raw = code ? await env.USERS_KV.get('sso-code:' + code) : null;
  if (!raw) return jsonResponse({ error: 'That sign-in has expired — try again.' }, 401, corsHeaders);
  await env.USERS_KV.delete('sso-code:' + code);
  const { username, email } = JSON.parse(raw) as { username: string; email: string };
  const user = await getUser(env, username);
  if (!user || normalizeEmail(user.email) !== email || !user.emailConfirmed) return jsonResponse({ error: 'That account has changed — try again.' }, 401, corsHeaders);
  return issueSession(env, request, ctx, user, 'Google (' + email + ')', corsHeaders);
}

// POST {token} -> {ticket}: starts "Connect Google account" for the
// signed-in person (see the top of this file).
export async function handleSsoLinkTicket(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  let body: { token?: string };
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders); }
  const caller = await resolveCaller(env, body);
  if (!caller) return jsonResponse({ error: 'Invalid credentials' }, 401, corsHeaders);
  if (!(await googleActive(env)).active) return jsonResponse({ error: 'Sign in with Google isn\'t turned on' }, 400, corsHeaders);
  const ticket = await signRoomToken(env.ROOM_TOKEN_SECRET, { purpose: 'sso-link', username: caller.username }, 5 * 60 * 1000);
  return jsonResponse({ ticket }, 200, corsHeaders);
}

// Admin: read or change the Google sign-in settings.
// POST {token, googleEnabled?, allowedDomains?}
export async function handleSsoSettings(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  let body: { token?: string; googleEnabled?: unknown; allowedDomains?: unknown };
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders); }
  const admin = await requireAdmin(env, await resolveCaller(env, body), corsHeaders);
  if (admin.error) return admin.error;
  const current = await getSsoSettings(env);
  const next: SsoSettings = Object.assign({}, current);
  if (typeof body.googleEnabled === 'boolean') next.googleEnabled = body.googleEnabled;
  if (Array.isArray(body.allowedDomains)) {
    const domains = body.allowedDomains.map(function (d) { return String(d).trim().toLowerCase().replace(/^@/, ''); }).filter(Boolean);
    const bad = domains.find(function (d) { return !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d); });
    if (bad) return jsonResponse({ error: '"' + bad + '" isn\'t a domain (like yourcompany.com)' }, 400, corsHeaders);
    next.allowedDomains = Array.from(new Set(domains));
  }
  const changed = JSON.stringify([next.googleEnabled, next.allowedDomains]) !== JSON.stringify([current.googleEnabled, current.allowedDomains]);
  if (changed) {
    next.updatedBy = admin.user!.username;
    next.updatedAt = Date.now();
    await env.USERS_KV.put(SSO_SETTINGS_KEY, JSON.stringify(next));
    await recordAudit(env, { user: admin.user!.username, role: 'admin', action: 'Changed Google sign-in settings', ip: clientIp(request),
      details: 'on: ' + (next.googleEnabled ? 'yes' : 'no') + ', domains: ' + (next.allowedDomains.join(' ') || 'any') });
  }
  return jsonResponse({
    settings: next,
    configured: googleConfigured(env),
    redirectUri: new URL(request.url).origin + '/sso/google/callback',
  }, 200, corsHeaders);
}

