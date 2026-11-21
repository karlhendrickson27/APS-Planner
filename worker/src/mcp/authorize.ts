// --- CLAUDE CONNECTOR: the sign-in and consent page (/authorize) ---
// When someone adds TeamSync in claude.ai, Claude opens this page. The
// person signs in with their normal TeamSync login, then says whether
// Claude may act as them:
//   GET  /authorize?response_type=code&client_id=…   start: checked by the
//        OAuth library (parseAuthRequest), redirect URI must be Claude's
//        (policy.ts), remembered for 15 minutes under a random `rid`
//   POST /authorize step=password  username/email + password
//   POST /authorize step=mfa       the two-step code, if the account has it
//   POST /authorize step=google    the one-time code "Sign in with Google"
//        leaves in this page's #fragment (sso.ts sends it back here)
//   POST /authorize step=consent   Allow or Cancel
// Each step after the first carries a short-lived signed ticket (the same
// signRoomToken() tickets the app's sign-in uses, with a purpose that
// names this rid), so the consent form can't be posted by another site
// and a ticket can't be used as a session. The same lockout counters,
// audit entries and two-step rules as the app's sign-in apply.
import { signRoomToken, base64UrlEncode } from '../room-token.ts';
import { resolveSignInName, verifyCredentials, putUser, bumpAuthFailure } from '../users.ts';
import { failKeys, isLockedOut, later, recordSignIn, resolveTicket, checkSecondFactor, MFA_TICKET_TTL_MS } from '../auth.ts';
import { getSecurityPolicy } from '../mfa.ts';
import { googleActive, redeemSsoCode } from '../sso.ts';
import { recordAudit, clientIp } from '../audit.ts';
import { oauthHelpers, isAllowedRedirectUri, allowLocalhost, grantUserId, OAUTH_SCOPE, CLAUDE_REDIRECT_URIS } from './policy.ts';
import type { AuthRequestLike, GrantProps, GrantMetadata } from './policy.ts';
import type { UserRecord } from '../types.ts';

const AUTH_REQ_PREFIX = 'mcp-authreq:';
const AUTH_REQ_TTL_SECONDS = 15 * 60;
const CONSENT_TICKET_TTL_MS = 10 * 60 * 1000;
const RID_RE = /^[A-Za-z0-9_-]{20,64}$/;

interface StoredAuthRequest { authRequest: AuthRequestLike; clientName: string; createdAt: number }

const ROLE_LABEL: Record<string, string> = { viewer: 'Viewer', commenter: 'Commenter', editor: 'Editor', projectAdmin: 'Project Admin', admin: 'Admin' };

const SSO_ERRORS: Record<string, string> = {
  not_enabled: 'Sign in with Google isn\'t turned on for TeamSync.',
  expired: 'That Google sign-in took too long. Try again.',
  cancelled: 'Google sign-in was cancelled.',
  domain: 'That Google account isn\'t from an allowed company domain.',
  no_account: 'That Google account isn\'t linked to a TeamSync account.',
  unconfirmed: 'That email isn\'t confirmed on your TeamSync account yet.',
};

function esc(s: unknown): string {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function randomId(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(24)));
}

// ---- Page ----
function pageHeaders(env: Env, nonce: string): Record<string, string> {
  const formTargets = ["'self'"].concat(CLAUDE_REDIRECT_URIS.map((u) => new URL(u).origin));
  if (allowLocalhost(env)) formTargets.push('http://localhost:*', 'http://127.0.0.1:*');
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'nonce-" + nonce + "'; script-src 'nonce-" + nonce + "'; img-src data:; form-action " + formTargets.join(' ') + "; frame-ancestors 'none'; base-uri 'none'",
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
}

const STYLE = `
:root { --primary:#1a237e; --primary-light:#3949ab; --bg:#f5f5f5; --card:#fff; --border:#e0e0e0; --text:#172b4d; --text-light:#44546f; --danger:#c62828; }
@media (prefers-color-scheme: dark) { :root { --bg:#161616; --card:#1f1f1f; --border:#353535; --text:#e7e9ee; --text-light:#98a0ae; --danger:#ef9a9a; } }
* { box-sizing:border-box; }
body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px 16px; font-family:"Public Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; background:linear-gradient(135deg,var(--primary) 0%,var(--primary-light) 100%); color:var(--text); }
.card { width:100%; max-width:400px; background:var(--card); border-radius:10px; box-shadow:0 8px 28px rgba(0,0,0,.25); padding:32px 28px 28px; }
.brand { display:flex; flex-direction:column; align-items:center; margin-bottom:20px; text-align:center; }
.mark { width:46px; height:46px; border-radius:12px; margin-bottom:12px; background:#2c3e50; display:flex; align-items:center; justify-content:center; }
h1 { font-size:20px; margin:0; font-weight:700; }
.sub { font-size:14px; color:var(--text-light); margin-top:4px; }
label { display:block; font-size:12px; font-weight:600; color:var(--text-light); margin:0 0 6px; text-transform:uppercase; letter-spacing:.5px; }
.field { margin-bottom:16px; }
input[type=text], input[type=password] { width:100%; padding:11px 13px; font-size:16px; font-family:inherit; color:var(--text); background:var(--bg); border:1.5px solid var(--border); border-radius:8px; }
input:focus-visible, button:focus-visible, a:focus-visible { outline:3px solid var(--primary-light); outline-offset:2px; }
button, .btn { width:100%; padding:12px; font-size:16px; font-weight:600; font-family:inherit; border-radius:8px; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px; text-decoration:none; }
.primary { color:#fff; background:var(--primary); border:none; }
.primary:hover { background:var(--primary-light); }
.secondary { color:var(--text); background:transparent; border:1.5px solid var(--border); margin-top:10px; }
.secondary:hover { background:rgba(0,0,0,.05); }
.or { text-align:center; color:var(--text-light); font-size:13px; margin:14px 0; }
.banner { font-size:14px; line-height:1.45; padding:10px 12px; border-radius:8px; margin-bottom:16px; background:rgba(220,53,69,.1); color:var(--danger); border:1px solid rgba(220,53,69,.3); }
.ask { font-size:17px; font-weight:600; line-height:1.4; margin:0 0 12px; }
ul { margin:0 0 18px; padding-left:20px; font-size:14px; line-height:1.55; color:var(--text-light); }
.small { font-size:13px; color:var(--text-light); text-align:center; margin-top:16px; line-height:1.45; }
.row { display:flex; gap:10px; } .row > * { flex:1; margin-top:0; }
`;

const MARK = '<svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true"><rect x="6.4" y="10.4" width="12" height="4.6" rx="2.3" fill="#e53935"/><rect x="6.4" y="17.2" width="19.2" height="4.6" rx="2.3" fill="#fff" fill-opacity=".92"/></svg>';

function page(env: Env, title: string, sub: string, body: string, opts?: { status?: number; script?: string }): Response {
  const nonce = randomId();
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex"><title>' + esc(title) + ' · TeamSync</title><style nonce="' + nonce + '">' + STYLE + '</style></head>' +
    '<body><main class="card"><div class="brand"><div class="mark">' + MARK + '</div><h1>TeamSync</h1><div class="sub">' + esc(sub) + '</div></div>' +
    body + '</main>' + (opts && opts.script ? '<script nonce="' + nonce + '">' + opts.script + '</script>' : '') + '</body></html>';
  return new Response(html, { status: (opts && opts.status) || 200, headers: pageHeaders(env, nonce) });
}

function errorPage(env: Env, message: string, status = 400): Response {
  return page(env, 'Can\'t connect', 'Connect Claude', '<div class="banner" role="alert">' + esc(message) + '</div><p class="small">Close this window and start again from Claude.</p>', { status });
}

function banner(error: string): string {
  return error ? '<div class="banner" role="alert">' + esc(error) + '</div>' : '';
}

async function signInPage(env: Env, origin: string, rid: string, stored: StoredAuthRequest, error: string, status = 200): Promise<Response> {
  const google = (await googleActive(env)).active;
  const back = origin + '/authorize?rid=' + rid;
  const googleBlock = google
    ? '<div class="or">or</div><a class="btn secondary" href="/sso/google/start?return=' + esc(encodeURIComponent(back)) + '">Sign in with Google</a>'
    : '';
  const body = banner(error) + '<div id="ssoMsg" class="banner" role="alert" hidden></div>' +
    '<form method="post" action="/authorize" autocomplete="on">' +
    '<input type="hidden" name="rid" value="' + esc(rid) + '"><input type="hidden" name="step" value="password">' +
    '<div class="field"><label for="u">Username or email</label><input id="u" name="username" type="text" autocomplete="username" required autofocus></div>' +
    '<div class="field"><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required></div>' +
    '<button class="primary" type="submit">Sign in</button></form>' + googleBlock +
    '<form method="post" action="/authorize" id="ssoForm" hidden><input type="hidden" name="rid" value="' + esc(rid) + '"><input type="hidden" name="step" value="google"><input type="hidden" name="code" id="ssoCode"></form>' +
    cancelForm(rid, '') +
    '<p class="small">' + esc(stored.clientName) + ' wants to connect to your TeamSync account. Sign in with your usual TeamSync login.</p>';
  // "Sign in with Google" comes back to this page with a one-time code in
  // the #fragment (never sent to a server); hand it in with the form.
  const script = '(function(){var h=new URLSearchParams(location.hash.slice(1));if(!h.toString())return;history.replaceState(null,"",location.pathname+location.search);' +
    'var c=h.get("sso_code");if(c){document.getElementById("ssoCode").value=c;document.getElementById("ssoForm").submit();return;}' +
    'var e=h.get("sso_error");if(e){var m=' + JSON.stringify(SSO_ERRORS) + ';var el=document.getElementById("ssoMsg");el.textContent=m[e]||"Google sign-in didn\\u2019t work. Try again or use your password.";el.hidden=false;}})();';
  return page(env, 'Connect Claude', 'Connect ' + stored.clientName, body, { status, script });
}

function cancelForm(rid: string, ticket: string): string {
  return '<form method="post" action="/authorize"><input type="hidden" name="rid" value="' + esc(rid) + '"><input type="hidden" name="step" value="cancel">' +
    (ticket ? '<input type="hidden" name="ticket" value="' + esc(ticket) + '">' : '') + '<button class="secondary" type="submit">Cancel</button></form>';
}

function mfaPage(env: Env, rid: string, ticket: string, error: string, status = 200): Response {
  const body = banner(error) + '<form method="post" action="/authorize" autocomplete="off">' +
    '<input type="hidden" name="rid" value="' + esc(rid) + '"><input type="hidden" name="step" value="mfa"><input type="hidden" name="ticket" value="' + esc(ticket) + '">' +
    '<div class="field"><label for="c">Code from your authenticator app</label><input id="c" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" required autofocus></div>' +
    '<button class="primary" type="submit">Continue</button></form>' + cancelForm(rid, '') +
    '<p class="small">Lost your phone? Enter one of your recovery codes instead.</p>';
  return page(env, 'Two-step verification', 'Two-step verification', body, { status });
}

function consentPage(env: Env, rid: string, ticket: string, stored: StoredAuthRequest, user: UserRecord): Response {
  const role = user.role;
  const verb = role === 'viewer' ? 'read' : role === 'commenter' ? 'read and comment on' : 'read and edit';
  const can: string[] = ['See the projects, jobs and schedule you can see'];
  if (role !== 'viewer') can.push('Comment on jobs, under your name, marked "via Claude"');
  if (role !== 'viewer' && role !== 'commenter') can.push('Change task dates and notes');
  if (role === 'projectAdmin' || role === 'admin') can.push('Create jobs');
  const body = '<p class="ask">Allow ' + esc(stored.clientName) + ' to ' + verb + ' TeamSync as ' + esc(user.displayName) + ' (' + esc(ROLE_LABEL[role] || role) + ')?</p>' +
    '<ul>' + can.map((c) => '<li>' + esc(c) + '</li>').join('') +
    '<li>Never delete or archive anything, or change users, settings or backups</li>' +
    '<li>Every change shows in the activity log as made via Claude</li></ul>' +
    '<div class="row">' +
    '<form method="post" action="/authorize"><input type="hidden" name="rid" value="' + esc(rid) + '"><input type="hidden" name="step" value="consent"><input type="hidden" name="ticket" value="' + esc(ticket) + '"><input type="hidden" name="decision" value="cancel"><button class="secondary" type="submit">Cancel</button></form>' +
    '<form method="post" action="/authorize"><input type="hidden" name="rid" value="' + esc(rid) + '"><input type="hidden" name="step" value="consent"><input type="hidden" name="ticket" value="' + esc(ticket) + '"><input type="hidden" name="decision" value="allow"><button class="primary" type="submit" autofocus>Allow</button></form>' +
    '</div><p class="small">You can disconnect any time in TeamSync: Settings &gt; Connected apps.</p>';
  return page(env, 'Allow Claude?', 'Connect ' + stored.clientName, body);
}

// ---- Flow ----
async function loadStored(env: Env, rid: string): Promise<StoredAuthRequest | null> {
  if (!RID_RE.test(rid)) return null;
  const raw = await env.USERS_KV.get(AUTH_REQ_PREFIX + rid);
  if (!raw) return null;
  try { return JSON.parse(raw) as StoredAuthRequest; } catch (e) { return null; }
}

function deniedRedirect(stored: StoredAuthRequest): Response {
  const u = new URL(stored.authRequest.redirectUri);
  u.searchParams.set('error', 'access_denied');
  u.searchParams.set('error_description', 'The person cancelled the connection.');
  if (stored.authRequest.state) u.searchParams.set('state', stored.authRequest.state);
  if (stored.authRequest.issuer) u.searchParams.set('iss', stored.authRequest.issuer);
  return new Response(null, { status: 302, headers: { Location: u.toString(), 'Cache-Control': 'no-store' } });
}

async function toConsent(env: Env, rid: string, stored: StoredAuthRequest, user: UserRecord): Promise<Response> {
  const ticket = await signRoomToken(env.ROOM_TOKEN_SECRET, { purpose: 'mcp-consent:' + rid, username: user.username }, CONSENT_TICKET_TTL_MS);
  return consentPage(env, rid, ticket, stored, user);
}

export async function handleAuthorize(request: Request, env: Env, ctx: ExecutionContext | undefined): Promise<Response> {
  const helpers = oauthHelpers(env);
  if (!helpers) return errorPage(env, 'The Claude connector isn\'t set up on this TeamSync server yet.', 503);
  const url = new URL(request.url);

  if (request.method === 'GET') {
    // Back from "Sign in with Google" (the code is in the #fragment).
    const ridParam = url.searchParams.get('rid');
    if (ridParam !== null && !url.searchParams.get('response_type')) {
      const stored = await loadStored(env, ridParam);
      if (!stored) return errorPage(env, 'This sign-in took too long and has expired.');
      return signInPage(env, url.origin, ridParam, stored, '');
    }
    let authRequest: AuthRequestLike;
    try { authRequest = await helpers.parseAuthRequest(request); } catch (e) {
      return errorPage(env, 'This connection request isn\'t valid' + (e instanceof Error && e.message ? ': ' + e.message : '.'));
    }
    if (!isAllowedRedirectUri(authRequest.redirectUri, allowLocalhost(env))) return errorPage(env, 'Only Claude can connect to TeamSync this way.');
    if (authRequest.responseType !== 'code' || !authRequest.codeChallenge || authRequest.codeChallengeMethod !== 'S256') return errorPage(env, 'This connection request is missing its security code (PKCE S256).');
    const client = await helpers.lookupClient(authRequest.clientId);
    if (!client) return errorPage(env, 'This app isn\'t registered with TeamSync. Start again from Claude.');
    const stored: StoredAuthRequest = { authRequest, clientName: (client.clientName || 'Claude').slice(0, 60), createdAt: Date.now() };
    const rid = randomId();
    await env.USERS_KV.put(AUTH_REQ_PREFIX + rid, JSON.stringify(stored), { expirationTtl: AUTH_REQ_TTL_SECONDS });
    return signInPage(env, url.origin, rid, stored, '');
  }

  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });
  let form: FormData;
  try { form = await request.formData(); } catch (e) { return errorPage(env, 'That form didn\'t arrive properly. Start again from Claude.'); }
  const field = (k: string) => { const v = form.get(k); return typeof v === 'string' ? v : ''; };
  const rid = field('rid');
  const stored = await loadStored(env, rid);
  if (!stored) return errorPage(env, 'This sign-in took too long and has expired.');
  const step = field('step');
  const ip = clientIp(request);

  if (step === 'cancel') {
    await env.USERS_KV.delete(AUTH_REQ_PREFIX + rid);
    return deniedRedirect(stored);
  }

  if (step === 'password') {
    const signInName = await resolveSignInName(env, field('username'));
    const keys = failKeys(request, signInName);
    if (await isLockedOut(env, keys)) {
      const w = later(ctx, recordAudit(env, { user: signInName, action: 'Sign-in blocked (too many attempts)', ip, details: 'Claude connector' })); if (w) await w;
      return signInPage(env, url.origin, rid, stored, 'Too many attempts — try again in a few minutes.', 429);
    }
    const user = signInName ? await verifyCredentials(env, signInName, field('password')) : null;
    if (!user) {
      const w = later(ctx, Promise.all([bumpAuthFailure(env, keys.user), bumpAuthFailure(env, keys.ip),
        recordAudit(env, { user: signInName, action: 'Failed sign-in', ip, details: 'Claude connector' })])); if (w) await w;
      return signInPage(env, url.origin, rid, stored, 'That username or password isn\'t right.', 401);
    }
    if (user.mfa) {
      const ticket = await signRoomToken(env.ROOM_TOKEN_SECRET, { purpose: 'mcp-mfa:' + rid, username: user.username }, MFA_TICKET_TTL_MS);
      return mfaPage(env, rid, ticket, '');
    }
    if ((await getSecurityPolicy(env)).requireMfa) {
      return errorPage(env, 'Your company requires two-step verification. Sign in to the TeamSync app once to set it up, then connect Claude again.', 403);
    }
    await recordSignIn(env, request, ctx, user, 'password (Claude connector)');
    return toConsent(env, rid, stored, user);
  }

  if (step === 'mfa') {
    const ticket = field('ticket');
    const user = await resolveTicket(env, ticket, 'mcp-mfa:' + rid);
    if (!user || !user.mfa) return signInPage(env, url.origin, rid, stored, 'That took too long. Sign in again.', 401);
    const keys = failKeys(request, user.username);
    if (await isLockedOut(env, keys)) return mfaPage(env, rid, ticket, 'Too many attempts — try again in a few minutes.', 429);
    const matched = await checkSecondFactor(env, user, field('code'));
    if (!matched) {
      const w = later(ctx, Promise.all([bumpAuthFailure(env, keys.user), bumpAuthFailure(env, keys.ip),
        recordAudit(env, { user: user.username, role: user.role, action: 'Failed two-step code', ip, details: 'Claude connector' })])); if (w) await w;
      return mfaPage(env, rid, ticket, 'That code didn\'t work. Check your authenticator app and try again.', 401);
    }
    await putUser(env, user);
    await recordSignIn(env, request, ctx, user, (matched === 'recovery' ? 'password + recovery code' : 'password + authenticator code') + ' (Claude connector)');
    return toConsent(env, rid, stored, user);
  }

  if (step === 'google') {
    const redeemed = await redeemSsoCode(env, field('code'));
    if (redeemed === 'expired' || redeemed === 'changed') return signInPage(env, url.origin, rid, stored, 'That Google sign-in expired. Try again.', 401);
    await recordSignIn(env, request, ctx, redeemed.user, 'Google (' + redeemed.email + ') (Claude connector)');
    return toConsent(env, rid, stored, redeemed.user);
  }

  if (step === 'consent') {
    const user = await resolveTicket(env, field('ticket'), 'mcp-consent:' + rid);
    if (!user) return signInPage(env, url.origin, rid, stored, 'That took too long. Sign in again.', 401);
    await env.USERS_KV.delete(AUTH_REQ_PREFIX + rid); // one use
    if (field('decision') !== 'allow') return deniedRedirect(stored);
    const now = Date.now();
    const props: GrantProps = { username: user.username, grantedAt: now };
    const metadata: GrantMetadata = { clientName: stored.clientName, connectedAt: now };
    let redirectTo: string;
    try {
      ({ redirectTo } = await helpers.completeAuthorization({ request: stored.authRequest, userId: grantUserId(user.username), metadata, scope: [OAUTH_SCOPE], props }));
    } catch (e) {
      console.error('Connector completeAuthorization failed:', e);
      return errorPage(env, 'TeamSync couldn\'t finish connecting. Start again from Claude.', 500);
    }
    await recordAudit(env, { user: user.username, role: user.role, action: 'Connected Claude', ip, details: stored.clientName });
    return new Response(null, { status: 302, headers: { Location: redirectTo, 'Cache-Control': 'no-store' } });
  }

  return errorPage(env, 'That form didn\'t arrive properly. Start again from Claude.');
}
