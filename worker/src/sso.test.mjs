import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedReturn, verifyGoogleIdToken, resetJwksCache, handleGoogleStart, handleGoogleCallback,
  handleSsoRedeem, handleSsoSettings, handleSsoConfig, handleSsoLinkTicket, GOOGLE_JWKS_URL, GOOGLE_TOKEN_URL
} from './sso.ts';
import { handleAuth } from './auth.ts';
import { handleAccountEmail, handleAccountMe } from './account.ts';
import { handleUsersAdd, handleUsersUpdate, handleUsersRemove } from './users-admin.ts';
import { hashPasswordPBKDF2, genSaltHex, resolveIdentityFromToken } from './users.ts';
import { base64UrlEncode } from './room-token.ts';

const CLIENT_ID = 'client-123.apps.googleusercontent.com';
const APP = 'https://app.useteamsync.com/';
const WORKER = 'https://aps-planner-staging.production-db3.workers.dev';

// ---- a fake Google: an RSA key, its JWKS, and a token endpoint ----
const keyPair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const pubJwk = Object.assign(await crypto.subtle.exportKey('jwk', keyPair.publicKey), { kid: 'k1', alg: 'RS256', use: 'sig' });
const otherPair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);

const b64json = (o) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(o)));
async function signIdToken(claims, opts = {}) {
  const head = b64json({ alg: 'RS256', kid: opts.kid || 'k1', typ: 'JWT' });
  const body = b64json(claims);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', (opts.key || keyPair).privateKey, new TextEncoder().encode(head + '.' + body));
  return head + '.' + body + '.' + base64UrlEncode(new Uint8Array(sig));
}
function claimsFor(email, nonce, extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  return Object.assign({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '1' + email.length, email, email_verified: true, nonce, iat: now, exp: now + 3600 }, extra);
}

// Replaces fetch for Google's URLs; `google.nextIdToken(nonce)` builds the
// token the token endpoint returns.
const google = { nextIdToken: null, tokenRequests: [] };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url) === GOOGLE_JWKS_URL) return new Response(JSON.stringify({ keys: [pubJwk] }), { status: 200 });
  if (String(url) === GOOGLE_TOKEN_URL) {
    const form = new URLSearchParams(init.body);
    google.tokenRequests.push(Object.fromEntries(form));
    return new Response(JSON.stringify({ id_token: await google.nextIdToken() }), { status: 200 });
  }
  return realFetch(url, init);
};

function makeFakeKV() {
  const store = new Map();
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list({ prefix } = {}) { return { keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
    _store: store,
  };
}
async function makeEnv({ configured = true } = {}) {
  const kv = makeFakeKV();
  const audit = [];
  const env = {
    USERS_KV: kv, ROOM_TOKEN_SECRET: 'test-secret',
    GOOGLE_CLIENT_ID: configured ? CLIENT_ID : undefined, GOOGLE_CLIENT_SECRET: configured ? 'shh' : undefined,
    APS_ROOM: { idFromName: (n) => ({ n }), get: () => ({ fetch: async (url, init) => { if (String(url).includes('/internal/audit')) audit.push(...JSON.parse(init.body).entries); return new Response('{}'); } }) },
  };
  for (const [username, role, email] of [['boss', 'admin', 'boss@aps-cut.com'], ['bob', 'editor', 'bob@aps-cut.com'], ['eve', 'editor', null], ['ola', 'editor', 'ola@outlook.com']]) {
    const salt = genSaltHex();
    const u = { username, displayName: username, role, assignedProjectId: null, salt, passwordHash: await hashPasswordPBKDF2('pw-' + username, salt), createdAt: 1 };
    if (email) { u.email = email; kv._store.set('email:' + email, username); }
    kv._store.set('user:' + username, JSON.stringify(u));
  }
  return { env, audit };
}
const jreq = (body, extra = {}) => ({ method: 'POST', url: WORKER + '/x', headers: { get: (n) => extra[n] || (n === 'CF-Connecting-IP' ? '1.2.3.4' : null) }, json: async () => body });
const getReq = (path, cookie) => ({ method: 'GET', url: WORKER + path, headers: { get: (n) => (n === 'Cookie' ? cookie || null : n === 'CF-Connecting-IP' ? '1.2.3.4' : null) } });
async function tokenOf(env, username) { return (await (await handleAuth(jreq({ username, password: 'pw-' + username }), env, {}, undefined)).json()).token; }
async function enable(env, extra = {}) {
  const t = await tokenOf(env, 'boss');
  return handleSsoSettings(jreq(Object.assign({ token: t, googleEnabled: true }, extra)), env, {});
}

// Runs start + callback like a browser would. Returns the final redirect.
async function browserSignIn(env, email, opts = {}) {
  const start = await handleGoogleStart(getReq('/sso/google/start?return=' + encodeURIComponent(APP)), env, new URL(WORKER + '/sso/google/start?return=' + encodeURIComponent(APP)));
  assert.equal(start.status, 302);
  const to = new URL(start.headers.get('Location'));
  const state = to.searchParams.get('state');
  const nonce = to.searchParams.get('nonce');
  const cookie = start.headers.get('Set-Cookie').split(';')[0];
  google.nextIdToken = () => signIdToken(claimsFor(email, opts.nonce || nonce, opts.claims), opts.sign);
  const cbUrl = WORKER + '/sso/google/callback?code=abc&state=' + state + (opts.error ? '&error=access_denied' : '');
  const cb = await handleGoogleCallback(getReq(cbUrl, opts.noCookie ? '' : cookie), env, new URL(cbUrl), undefined);
  return { start, to, cb, location: cb.headers.get('Location') || '', fragment: new URLSearchParams((cb.headers.get('Location') || '').split('#')[1] || '') };
}

// ---- return address allowlist ----
test('only TeamSync pages (and localhost for development) can receive the sign-in', () => {
  assert.ok(isAllowedReturn(APP));
  assert.ok(isAllowedReturn(APP + 'index.html?x=1#y'));
  assert.ok(isAllowedReturn('http://localhost:8080/'));
  assert.ok(!isAllowedReturn('https://production27.github.io/Other/'));
  assert.ok(!isAllowedReturn('https://evil.example/APS-Planner/'));
  assert.ok(!isAllowedReturn('https://production27.github.io.evil.example/APS-Planner/'));
  assert.ok(!isAllowedReturn('javascript:alert(1)'));
});

// ---- ID token checks ----
test('ID tokens: a correctly signed one passes; every kind of tampering is refused', async () => {
  resetJwksCache();
  const now = Date.now();
  const ok = await verifyGoogleIdToken(await signIdToken(claimsFor('a@b.com', 'n1')), CLIENT_ID, 'n1', now);
  assert.equal(ok.claims.email, 'a@b.com');
  const cases = [
    [await signIdToken(claimsFor('a@b.com', 'n1'), { key: otherPair }), 'bad signature'],
    [await signIdToken(claimsFor('a@b.com', 'n1', { aud: 'someone-else' })), 'wrong audience'],
    [await signIdToken(claimsFor('a@b.com', 'n1', { iss: 'https://evil.example' })), 'wrong issuer'],
    [await signIdToken(claimsFor('a@b.com', 'other-nonce')), 'nonce mismatch'],
    [await signIdToken(claimsFor('a@b.com', 'n1', { exp: Math.floor(now / 1000) - 3600 })), 'expired'],
    [await signIdToken(claimsFor('a@b.com', 'n1', { email_verified: false })), 'email not verified by Google'],
    [await signIdToken(claimsFor('a@b.com', 'n1'), { kid: 'nope' }), 'unknown signing key'],
  ];
  for (const [tok, reason] of cases) assert.equal((await verifyGoogleIdToken(tok, CLIENT_ID, 'n1', now)).error, reason);
  const [h, b, s] = (await signIdToken(claimsFor('a@b.com', 'n1'))).split('.');
  const forged = b64json(Object.assign(claimsFor('boss@aps-cut.com', 'n1')));
  assert.equal((await verifyGoogleIdToken(h + '.' + forged + '.' + s, CLIENT_ID, 'n1', now)).error, 'bad signature');
});

// ---- settings ----
test('Google sign-in is off until the server keys exist and an admin turns it on; only admins can change it', async () => {
  const { env } = await makeEnv({ configured: false });
  assert.deepEqual(await (await handleSsoConfig(getReq('/sso/config'), env, {})).json(), { google: false });
  const res = await (await enable(env)).json();
  assert.equal(res.configured, false);
  assert.equal(res.redirectUri, WORKER + '/sso/google/callback');
  assert.equal((await (await handleSsoConfig(getReq('/sso/config'), env, {})).json()).google, false, 'still off without keys');

  const { env: env2, audit } = await makeEnv();
  const bobToken = await tokenOf(env2, 'bob');
  assert.equal((await handleSsoSettings(jreq({ token: bobToken, googleEnabled: true }), env2, {})).status, 403);
  const bad = await enable(env2, { allowedDomains: ['not a domain'] });
  assert.equal(bad.status, 400);
  const good = await (await enable(env2, { allowedDomains: ['@APS-cut.com', 'aps-cut.com'] })).json();
  assert.deepEqual(good.settings.allowedDomains, ['aps-cut.com']);
  assert.equal((await (await handleSsoConfig(getReq('/sso/config'), env2, {})).json()).google, true);
  assert.ok(audit.some((e) => e.action === 'Changed Google sign-in settings'));
});

// ---- the full browser flow ----
test('a linked Google account signs in: state + PKCE sent, one-time code returned in the fragment, redeemed once', async () => {
  resetJwksCache();
  const { env, audit } = await makeEnv();
  await enable(env, { allowedDomains: ['aps-cut.com'] });
  const r = await browserSignIn(env, 'bob@aps-cut.com', { claims: { hd: 'aps-cut.com' } });
  assert.equal(r.to.origin + r.to.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(r.to.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(r.to.searchParams.get('redirect_uri'), WORKER + '/sso/google/callback');
  assert.equal(r.to.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(r.to.searchParams.get('hd'), 'aps-cut.com');
  assert.match(r.start.headers.get('Set-Cookie'), /HttpOnly; Secure; SameSite=Lax/);
  assert.ok(google.tokenRequests.at(-1).code_verifier, 'PKCE verifier sent to Google');
  assert.equal(google.tokenRequests.at(-1).client_secret, 'shh');

  assert.ok(r.location.startsWith(APP + '#sso_code='), r.location);
  const code = r.fragment.get('sso_code');
  const redeemed = await handleSsoRedeem(jreq({ code }), env, {}, undefined);
  assert.equal(redeemed.status, 200);
  const data = await redeemed.json();
  assert.equal((await resolveIdentityFromToken(env, data.token)).username, 'bob');
  assert.equal((await handleSsoRedeem(jreq({ code }), env, {}, undefined)).status, 401, 'one-time code is single use');
  assert.ok(audit.some((e) => e.action === 'Signed in' && e.details === 'Google (bob@aps-cut.com)'));
});

test('refused: no linked account, wrong Workspace domain, cancelled, and a callback from another browser', async () => {
  resetJwksCache();
  const { env, audit } = await makeEnv();
  await enable(env, { allowedDomains: ['aps-cut.com'] });
  assert.equal((await browserSignIn(env, 'stranger@aps-cut.com', { claims: { hd: 'aps-cut.com' } })).fragment.get('sso_error'), 'no_account');
  assert.equal((await browserSignIn(env, 'bob@aps-cut.com', { claims: { hd: 'gmail-lookalike.com' } })).fragment.get('sso_error'), 'domain');
  assert.equal((await browserSignIn(env, 'bob@aps-cut.com')).fragment.get('sso_error'), 'domain', 'a personal Google account has no hd claim');
  assert.equal((await browserSignIn(env, 'bob@aps-cut.com', { error: true, claims: { hd: 'aps-cut.com' } })).fragment.get('sso_error'), 'cancelled');
  assert.equal((await browserSignIn(env, 'bob@aps-cut.com', { noCookie: true, claims: { hd: 'aps-cut.com' } })).fragment.get('sso_error'), 'expired');
  assert.equal((await browserSignIn(env, 'bob@aps-cut.com', { nonce: 'replayed', claims: { hd: 'aps-cut.com' } })).fragment.get('sso_error'), 'failed');
  assert.ok(audit.filter((e) => e.action === 'Failed Google sign-in').length >= 4);
});

test('a used or made-up state is refused, and start refuses non-TeamSync return pages', async () => {
  const { env } = await makeEnv();
  await enable(env);
  const cbUrl = WORKER + '/sso/google/callback?code=abc&state=made-up';
  assert.equal((await handleGoogleCallback(getReq(cbUrl, 'ts_sso_state=made-up'), env, new URL(cbUrl), undefined)).status, 400);
  const evil = WORKER + '/sso/google/start?return=' + encodeURIComponent('https://evil.example/');
  assert.equal((await handleGoogleStart(getReq(evil), env, new URL(evil))).status, 400);
});

test('with no domain list, any linked Google account works (including personal Gmail)', async () => {
  resetJwksCache();
  const { env } = await makeEnv();
  await enable(env);
  assert.ok((await browserSignIn(env, 'bob@aps-cut.com')).fragment.get('sso_code'));
});

test('password sign-in keeps working for everyone, with a username or any email address', async () => {
  const { env, audit } = await makeEnv();
  await enable(env);
  for (const typed of ['bob', 'BOB', 'bob@aps-cut.com', ' Bob@APS-cut.com ']) {
    const res = await handleAuth(jreq({ username: typed, password: 'pw-bob' }), env, {}, undefined);
    assert.equal(res.status, 200, typed);
    assert.equal((await res.json()).user.username, 'bob');
  }
  const outlook = await (await handleAuth(jreq({ username: 'ola@outlook.com', password: 'pw-ola' }), env, {}, undefined)).json();
  assert.equal(outlook.user.username, 'ola', 'a non-Google address works the same');
  assert.equal((await handleAuth(jreq({ username: 'nobody@example.com', password: 'pw-bob' }), env, {}, undefined)).status, 401);
  // Wrong passwords count against the account whichever name is typed.
  await handleAuth(jreq({ username: 'bob@aps-cut.com', password: 'wrong' }), env, {}, undefined);
  await handleAuth(jreq({ username: 'bob', password: 'wrong' }), env, {}, undefined);
  assert.equal(env.USERS_KV._store.get('authfail:bob'), '2');
  assert.ok(audit.some((e) => e.action === 'Failed sign-in' && e.user === 'bob'));
  // An old "Google only" setting is ignored.
  env.USERS_KV._store.set('sso-settings', JSON.stringify({ googleEnabled: true, allowedDomains: [], requireGoogle: true }));
  assert.equal((await handleAuth(jreq({ username: 'bob', password: 'pw-bob' }), env, {}, undefined)).status, 200);
});

test('an account saved during the brief googleEmail naming is still found', async () => {
  resetJwksCache();
  const { env } = await makeEnv();
  await enable(env);
  const eve = JSON.parse(env.USERS_KV._store.get('user:eve'));
  eve.googleEmail = 'eve@aps-cut.com';
  env.USERS_KV._store.set('user:eve', JSON.stringify(eve));
  env.USERS_KV._store.set('email:eve@aps-cut.com', 'eve');
  assert.ok((await browserSignIn(env, 'eve@aps-cut.com')).fragment.get('sso_code'));
  assert.equal((await (await handleAuth(jreq({ username: 'eve@aps-cut.com', password: 'pw-eve' }), env, {}, undefined)).json()).user.username, 'eve');
});

// ---- linking accounts ----
test('admins set each account\'s email in Manage Users; one email can\'t be on two accounts; removal frees it', async () => {
  resetJwksCache();
  const { env } = await makeEnv();
  await enable(env);
  const boss = await tokenOf(env, 'boss');
  const dup = await handleUsersUpdate(jreq({ token: boss, targetUsername: 'eve', newRole: 'editor', newEmail: 'BOB@aps-cut.com' }), env, {});
  assert.equal(dup.status, 400);
  assert.match((await dup.json()).error, /already used by @bob/);
  assert.equal((await handleUsersUpdate(jreq({ token: boss, targetUsername: 'eve', newRole: 'editor', newEmail: 'Eve@APS-cut.com ' }), env, {})).status, 200);
  assert.equal(JSON.parse(env.USERS_KV._store.get('user:eve')).email, 'eve@aps-cut.com');
  assert.ok((await browserSignIn(env, 'eve@aps-cut.com')).fragment.get('sso_code'));

  // Relinking bob to a new address frees the old one.
  await handleUsersUpdate(jreq({ token: boss, targetUsername: 'bob', newRole: 'editor', newEmail: 'robert@aps-cut.com' }), env, {});
  assert.equal(env.USERS_KV._store.get('email:bob@aps-cut.com'), undefined);
  assert.equal((await browserSignIn(env, 'bob@aps-cut.com')).fragment.get('sso_error'), 'no_account');
  // Leaving newEmail out keeps it.
  await handleUsersUpdate(jreq({ token: boss, targetUsername: 'bob', newRole: 'viewer' }), env, {});
  assert.equal(JSON.parse(env.USERS_KV._store.get('user:bob')).email, 'robert@aps-cut.com');

  assert.equal((await handleUsersAdd(jreq({ token: boss, newUsername: 'newbie', newPassword: 'secret1', newEmail: 'newbie@aps-cut.com' }), env, {})).status, 200);
  assert.equal(env.USERS_KV._store.get('email:newbie@aps-cut.com'), 'newbie');
  assert.equal((await handleUsersAdd(jreq({ token: boss, newUsername: 'other', newPassword: 'secret1', newEmail: 'newbie@aps-cut.com' }), env, {})).status, 400);
  assert.equal(env.USERS_KV._store.get('user:other'), undefined, 'not created when the email is taken');

  await handleUsersRemove(jreq({ token: boss, targetUsername: 'newbie' }), env, {});
  assert.equal(env.USERS_KV._store.get('email:newbie@aps-cut.com'), undefined);
});

// ---- people adding their own email (Settings > My email) ----

// Runs "Connect Google account" for a signed-in person, like a browser would.
async function browserConnect(env, sessionToken, googleEmail, claims) {
  const { ticket } = await (await handleSsoLinkTicket(jreq({ token: sessionToken }), env, {})).json();
  const startUrl = WORKER + '/sso/google/start?return=' + encodeURIComponent(APP) + '&link=' + encodeURIComponent(ticket);
  const start = await handleGoogleStart(getReq(startUrl), env, new URL(startUrl));
  const to = new URL(start.headers.get('Location'));
  const state = to.searchParams.get('state');
  google.nextIdToken = () => signIdToken(claimsFor(googleEmail, to.searchParams.get('nonce'), claims));
  const cbUrl = WORKER + '/sso/google/callback?code=abc&state=' + state;
  const cb = await handleGoogleCallback(getReq(cbUrl, start.headers.get('Set-Cookie').split(';')[0]), env, new URL(cbUrl), undefined);
  return new URLSearchParams((cb.headers.get('Location') || '').split('#')[1] || '');
}

test('people can add their own email: needs their password, works for email sign-in at once, but not for Google until confirmed', async () => {
  resetJwksCache();
  const { env, audit } = await makeEnv();
  await enable(env);
  const eve = await tokenOf(env, 'eve');
  assert.equal((await handleAccountEmail(jreq({ token: eve, password: 'wrong', email: 'eve@yahoo.com' }), env, {})).status, 403);
  const set = await (await handleAccountEmail(jreq({ token: eve, password: 'pw-eve', email: 'Eve@Yahoo.com' }), env, {})).json();
  assert.deepEqual(set, { email: 'eve@yahoo.com', emailConfirmed: false });
  assert.deepEqual(await (await handleAccountMe(jreq({ token: eve }), env, {})).json(), { username: 'eve', displayName: 'eve', email: 'eve@yahoo.com', emailConfirmed: false });
  assert.ok(audit.some((e) => e.action === 'Changed own email' && e.user === 'eve'));
  assert.equal((await (await handleAuth(jreq({ username: 'eve@yahoo.com', password: 'pw-eve' }), env, {}, undefined)).json()).user.username, 'eve');
  assert.equal((await browserSignIn(env, 'eve@yahoo.com')).fragment.get('sso_error'), 'unconfirmed');
});

test('"Connect Google account" confirms the email from Google, and then Google sign-in works', async () => {
  resetJwksCache();
  const { env, audit } = await makeEnv();
  await enable(env);
  const eve = await tokenOf(env, 'eve');
  await handleAccountEmail(jreq({ token: eve, password: 'pw-eve', email: 'eve.typo@gmail.com' }), env, {});
  const back = await browserConnect(env, eve, 'eve@gmail.com');
  assert.equal(back.get('sso_linked'), 'eve@gmail.com');
  const me = await (await handleAccountMe(jreq({ token: eve }), env, {})).json();
  assert.deepEqual([me.email, me.emailConfirmed], ['eve@gmail.com', true]);
  assert.equal(env.USERS_KV._store.get('email:eve.typo@gmail.com'), undefined, 'the old address is freed');
  assert.ok(audit.some((e) => e.action === 'Connected Google account' && e.user === 'eve'));
  assert.ok((await browserSignIn(env, 'eve@gmail.com')).fragment.get('sso_code'));
  // Changing it by hand again makes it unconfirmed again.
  await handleAccountEmail(jreq({ token: eve, password: 'pw-eve', email: 'eve@other.com' }), env, {});
  assert.equal((await (await handleAccountMe(jreq({ token: eve }), env, {})).json()).emailConfirmed, false);
});

test('connecting respects the allowed domains, and needs a live session', async () => {
  resetJwksCache();
  const { env } = await makeEnv();
  await enable(env, { allowedDomains: ['aps-cut.com'] });
  const eve = await tokenOf(env, 'eve');
  assert.equal((await browserConnect(env, eve, 'eve@gmail.com')).get('sso_error'), 'domain');
  assert.equal((await handleSsoLinkTicket(jreq({ token: 'nope' }), env, {})).status, 401);
  const bad = WORKER + '/sso/google/start?return=' + encodeURIComponent(APP) + '&link=forged';
  const res = await handleGoogleStart(getReq(bad), env, new URL(bad));
  assert.match(res.headers.get('Location'), /#sso_error=expired$/);
});

test('nobody can squat on an address: a confirmed claim takes it over from an unconfirmed one, never the other way', async () => {
  resetJwksCache();
  const { env } = await makeEnv();
  await enable(env);
  const eve = await tokenOf(env, 'eve');
  // Eve can't take bob's (admin-set, confirmed) address, and isn't told whose it is.
  const taken = await handleAccountEmail(jreq({ token: eve, password: 'pw-eve', email: 'bob@aps-cut.com' }), env, {});
  assert.equal(taken.status, 400);
  assert.equal((await taken.json()).error, 'That email is already used by another account');
  // Eve squats on a new person's address; the admin gives it to them anyway.
  await handleAccountEmail(jreq({ token: eve, password: 'pw-eve', email: 'newbie@aps-cut.com' }), env, {});
  const boss = await tokenOf(env, 'boss');
  assert.equal((await handleUsersAdd(jreq({ token: boss, newUsername: 'newbie', newPassword: 'secret1', newEmail: 'newbie@aps-cut.com' }), env, {})).status, 200);
  assert.equal(JSON.parse(env.USERS_KV._store.get('user:eve')).email, undefined, 'removed from the squatter');
  assert.equal(env.USERS_KV._store.get('email:newbie@aps-cut.com'), 'newbie');
  // Google-confirming also wins over an unconfirmed claim.
  await handleAccountEmail(jreq({ token: eve, password: 'pw-eve', email: 'zed@gmail.com' }), env, {});
  const ola = await tokenOf(env, 'ola');
  assert.equal((await browserConnect(env, ola, 'zed@gmail.com')).get('sso_linked'), 'zed@gmail.com');
  // ...but not over a confirmed one.
  assert.equal((await browserConnect(env, eve, 'zed@gmail.com')).get('sso_error'), 'email_taken');
});

test('admin-set emails (including ones saved before confirmation existed) are confirmed', async () => {
  resetJwksCache();
  const { env } = await makeEnv();
  await enable(env);
  const raw = JSON.parse(env.USERS_KV._store.get('user:bob'));
  assert.equal(raw.emailConfirmed, undefined, 'fixture predates the flag');
  assert.ok((await browserSignIn(env, 'bob@aps-cut.com')).fragment.get('sso_code'));
  const boss = await tokenOf(env, 'boss');
  await handleUsersUpdate(jreq({ token: boss, targetUsername: 'eve', newRole: 'editor', newEmail: 'eve@aps-cut.com' }), env, {});
  assert.equal(JSON.parse(env.USERS_KV._store.get('user:eve')).emailConfirmed, true);
});
