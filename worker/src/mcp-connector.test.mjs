// Tests for the Claude connector (src/mcp/): the MCP protocol, the OAuth
// sign-in flow end to end through the real Worker entry point and the real
// OAuth library, and every tool against a real ApsRoom (with the fake
// storage from test-fakes.mjs) so writes go through applyAsUser() exactly
// as the app's do.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.ts';
import { ApsRoom } from './room-do.ts';
import { makeFakeState, makeFakeWs } from './test-fakes.mjs';
import { hashPasswordPBKDF2, genSaltHex } from './users.ts';
import { handleRpcMessage, handleMcpHttp, INSTRUCTIONS } from './mcp/protocol.ts';
import { TOOLS, findTool, runTool } from './mcp/tools.ts';
import { roomGateway, currentConnectorUser } from './mcp/handler.ts';
import { isAllowedRedirectUri } from './mcp/policy.ts';
import { buildNewJob } from './mcp/schedule.ts';
import { MAINTENANCE_KV_KEY } from './maintenance.ts';
import { runDueDeletion, DELETION_KV_KEY } from './compliance.ts';
import { AUDIT_PREFIX } from './audit.ts';

// ---- Fakes ----
function makeKv() {
  const store = new Map();
  return {
    _store: store,
    async get(key, opts) {
      const v = store.get(key);
      if (v === undefined) return null;
      const type = typeof opts === 'string' ? opts : opts && opts.type;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) { store.set(key, typeof value === 'string' ? value : JSON.stringify(value)); },
    async delete(key) { store.delete(key); },
    async list({ prefix = '', limit = 1000, cursor } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit);
      const done = start + limit >= keys.length;
      return { keys: page.map((name) => ({ name })), list_complete: done, cursor: done ? undefined : String(start + limit) };
    },
  };
}

const COLUMNS = [
  { id: 'bid', label: 'Bid', hideFromSchedule: true, color: '#b3bac5' },
  { id: 'design', label: 'Design', color: '#579dff' },
  { id: 'cut', label: 'Cut', color: '#4bce97' },
  { id: 'panel', label: 'Panel', color: '#f5cd47', autoAssignChecklist: true, checklistAssigneeOverride: 'karl', defaultChecklist: [{ id: 'chk1', text: 'Check lumber' }] },
  { id: 'deliver', label: 'Deliver', color: '#f87168' },
];
const task = (id, columnId, start, finish, order, extra) => Object.assign({ id, name: COLUMNS.find((c) => c.id === columnId).label, columnId, start, finish, notes: '', order, color: '#3949ab' }, extra || {});

function seedRoom() {
  return {
    projects: {
      p1: {
        name: 'Advanced Precut', jobs: {
          highland: {
            id: 'highland', name: 'Highland (3 F2)', color: '#3949ab', archived: false, updatedAt: 1000, comments: [],
            phases: [{ id: 'ph1', name: '3 F2', order: 0, isDefault: false, tasks: [], subPhases: [
              { id: 'sub-ext', name: 'Ext', order: 0, isDefault: false, tasks: [task('t-ext-design', 'design', '2026-11-02', '2026-11-04', 1), task('t-ext-deliver', 'deliver', '2026-11-24', '2026-11-24', 4)] },
              { id: 'sub-int', name: 'Int', order: 1, isDefault: false, tasks: [task('t-int-deliver', 'deliver', '2026-11-26', '2026-11-26', 4)] },
            ] }],
            unrelatedField: 'keep me',
          },
          members: {
            id: 'members', name: 'Members Only Job', color: '#3949ab', archived: false, updatedAt: 5, comments: [],
            tasks: [task('t-m-cut', 'cut', '2026-11-23', '2026-11-25', 2)],
          },
          old: { id: 'old', name: 'Old Archived Job', color: '#3949ab', archived: true, updatedAt: 1, tasks: [task('t-old', 'cut', '2026-11-23', '2026-11-23', 2)] },
        },
        boardCards: {
          c1: { id: 'c1', jobId: 'highland', phaseId: 'ph1', column: 'design', customFields: { customer: 'Smith, Inc.', members: ['karl'] }, attachments: [{ name: 'plans.pdf', key: 'secret/key' }] },
          c2: { id: 'c2', jobId: 'members', phaseId: null, column: 'cut', customFields: { members: ['ed', 'cora', 'vic'] } },
        },
        calendarEvents: {}, boardColumns: COLUMNS, fieldOptions: { customer: ['Smith, Inc.', 'Acme Homes'] }, deletedIds: {},
        header: { title: 'Advanced Precut', logo: 'data:image/png;base64,AAAA' }, activityLog: [], rev: 1,
        fieldRevisions: { boardColumns: 0, fieldOptions: 0, header: 0, workflowItems: 0 },
      },
      p2: {
        name: 'Second Project', jobs: { other: { id: 'other', name: 'Other Job', color: '#3949ab', archived: false, updatedAt: 1, tasks: [task('t-o', 'cut', '2026-11-23', '2026-11-23', 2)] } },
        boardCards: {}, calendarEvents: {}, boardColumns: COLUMNS, fieldOptions: {}, deletedIds: {}, header: {}, activityLog: [], rev: 1,
        fieldRevisions: { boardColumns: 0, fieldOptions: 0, header: 0, workflowItems: 0 },
      },
    },
  };
}

const USERS = {
  karl: { displayName: 'Karl Hendrickson', role: 'admin' },
  pam: { displayName: 'Pam Admin', role: 'projectAdmin' },
  ed: { displayName: 'Ed Editor', role: 'editor' },
  cora: { displayName: 'Cora Commenter', role: 'commenter' },
  vic: { displayName: 'Vic Viewer', role: 'viewer' },
  rita: { displayName: 'Rita Restricted', role: 'projectAdmin', assignedProjectId: 'p2' },
};

async function setup(opts = {}) {
  const usersKv = makeKv();
  for (const [username, u] of Object.entries(USERS)) {
    const salt = genSaltHex();
    await usersKv.put('user:' + username, JSON.stringify({
      username, displayName: u.displayName, role: u.role, assignedProjectId: u.assignedProjectId || null,
      salt, passwordHash: opts.passwords ? await hashPasswordPBKDF2('pw-' + username, salt) : 'x', createdAt: 1,
    }));
  }
  const sockets = opts.sockets || [];
  const state = makeFakeState(sockets);
  const env = { USERS_KV: usersKv, ROOM_TOKEN_SECRET: 'test-secret' };
  const room = new ApsRoom(state, env);
  env.APS_ROOM = { idFromName: () => 'id', get: () => ({ fetch: (input, init) => room.fetch(input instanceof Request ? input : new Request(input, init)) }) };
  if (opts.oauth) env.OAUTH_KV = makeKv();
  const imported = await room.fetch(new Request('https://internal/internal/import', { method: 'POST', body: JSON.stringify(seedRoom()) }));
  assert.equal(imported.status, 200);
  sockets.forEach((ws) => { ws._sent.length = 0; });
  return { env, room, state, usersKv };
}

function ctxFor(env, username, overrides = {}) {
  const u = USERS[username];
  const user = { username, displayName: u.displayName, role: u.role, assignedProjectId: u.assignedProjectId || null };
  let n = 0;
  return Object.assign({
    user,
    room: roomGateway(env, user),
    maintenance: async () => { const raw = await env.USERS_KV.get(MAINTENANCE_KV_KEY); return raw ? JSON.parse(raw) : { active: false, message: '' }; },
    now: () => Date.UTC(2026, 10, 21, 12),
    newId: () => 'new-id-' + (++n),
  }, overrides);
}

async function call(ctx, name, args) {
  return runTool(findTool(name), ctx, args);
}

async function job(room, pid, id) {
  return (await room.loadRoomState()).projects[pid].jobs[id];
}

function findTaskIn(j, taskId) {
  const all = [].concat(j.tasks || [], ...(j.phases || []).map((p) => [].concat(p.tasks || [], ...(p.subPhases || []).map((s) => s.tasks || []))));
  return all.find((t) => t.id === taskId);
}

async function auditRows(state) {
  return [...state._store.entries()].filter(([k]) => k.startsWith(AUDIT_PREFIX)).map(([, v]) => v);
}

// ── MCP protocol ──

test('initialize answers with the server name, tools capability, instructions and a negotiated version', async () => {
  const r = await handleRpcMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } } }, async () => assert.fail('no context needed'));
  assert.equal(r.id, 1);
  assert.equal(r.result.protocolVersion, '2025-06-18');
  assert.equal(r.result.serverInfo.name, 'TeamSync');
  assert.deepEqual(r.result.capabilities, { tools: { listChanged: false } });
  assert.match(r.result.instructions, /YYYY-MM-DD/);
  assert.match(INSTRUCTIONS, /dryRun/);
  assert.match(INSTRUCTIONS, /Never invent/);
  const odd = await handleRpcMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, async () => ({}));
  assert.equal(odd.result.protocolVersion, '2025-11-25', 'an unknown version gets the newest one this server speaks');
});

test('notifications get no reply (202), ping answers {}, unknown methods are -32601', async () => {
  const http = await handleMcpHttp(new Request('https://w/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }), async () => ({}));
  assert.equal(http.status, 202);
  assert.equal((await handleRpcMessage({ jsonrpc: '2.0', id: 'a', method: 'ping' }, async () => ({}))).result && true, true);
  const unknown = await handleRpcMessage({ jsonrpc: '2.0', id: 3, method: 'resources/list' }, async () => ({}));
  assert.equal(unknown.error.code, -32601);
  const bad = await handleMcpHttp(new Request('https://w/mcp', { method: 'POST', body: '{nope' }), async () => ({}));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, -32700);
});

test('GET /mcp is 405 (no server-to-client stream); oversized bodies are refused', async () => {
  const get = await handleMcpHttp(new Request('https://w/mcp', { method: 'GET' }), async () => ({}));
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('Allow'), 'POST');
  const big = await handleMcpHttp(new Request('https://w/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(70000) } }) }), async () => ({}));
  assert.equal(big.status, 413);
});

test('tools/list: exactly the nine v1 tools, each with a schema and annotations; reads are read-only, nothing is destructive', async () => {
  const r = await handleRpcMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, async () => ({}));
  const names = r.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['add_job_comment', 'create_job', 'get_job', 'get_schedule', 'list_projects', 'search_jobs', 'set_task_notes', 'shift_tasks', 'update_task_dates']);
  for (const t of r.result.tools) {
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.equal(t.annotations.destructiveHint, false, t.name);
    assert.ok(t.description.length > 40, t.name);
  }
  const ro = r.result.tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name).sort();
  assert.deepEqual(ro, ['get_job', 'get_schedule', 'list_projects', 'search_jobs']);
  assert.ok(!names.some((n) => /delete|archive|user|role|backup|export|maintenance/.test(n)));
});

test('tools/call with an unknown tool or non-object arguments is an invalid-params error', async () => {
  const r = await handleRpcMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delete_job', arguments: {} } }, async () => ({}));
  assert.equal(r.error.code, -32602);
  const r2 = await handleRpcMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_projects', arguments: [1] } }, async () => ({}));
  assert.equal(r2.error.code, -32602);
});

// ── OAuth: through the real Worker entry point and the real library ──

function b64url(bytes) { return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}
const ORIGIN = 'https://teamsync.example';
const CB = 'https://claude.ai/api/mcp/auth_callback';
const go = (env, path, init) => worker.fetch(new Request(ORIGIN + path, init), env, { waitUntil() {}, passThroughOnException() {} });
const form = (fields) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
const hidden = (html, name) => { const m = new RegExp('name="' + name + '" value="([^"]*)"').exec(html); return m ? m[1].replace(/&amp;/g, '&') : null; };

async function registerClaude(env) {
  const res = await go(env, '/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CB], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).client_id;
}

async function startAuthorize(env, clientId, p) {
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CB, state: 'st-123', code_challenge: p.challenge, code_challenge_method: 'S256', scope: 'teamsync', resource: ORIGIN + '/mcp' });
  return go(env, '/authorize?' + q.toString());
}

async function connect(env, username) {
  const clientId = await registerClaude(env);
  const p = await pkce();
  const page = await startAuthorize(env, clientId, p);
  assert.equal(page.status, 200);
  const rid = hidden(await page.text(), 'rid');
  const consent = await go(env, '/authorize', form({ rid, step: 'password', username, password: 'pw-' + username }));
  const html = await consent.text();
  assert.equal(consent.status, 200, html);
  const done = await go(env, '/authorize', form({ rid, step: 'consent', ticket: hidden(html, 'ticket'), decision: 'allow' }));
  assert.equal(done.status, 302);
  const to = new URL(done.headers.get('Location'));
  const tok = await go(env, '/token', form({ grant_type: 'authorization_code', code: to.searchParams.get('code'), redirect_uri: CB, client_id: clientId, code_verifier: p.verifier, resource: ORIGIN + '/mcp' }));
  assert.equal(tok.status, 200, await tok.clone().text());
  return { clientId, tokens: await tok.json(), redirect: to, consentHtml: html };
}

const rpc = (env, token, body) => go(env, '/mcp', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, token ? { Authorization: 'Bearer ' + token } : {}), body: JSON.stringify(body) });

test('unauthenticated /mcp is 401 with a WWW-Authenticate header pointing at the resource metadata, which names this server', async () => {
  const { env } = await setup({ oauth: true });
  const res = await rpc(env, null, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(res.status, 401);
  const www = res.headers.get('WWW-Authenticate');
  assert.match(www, /^Bearer /);
  assert.match(www, /resource_metadata="https:\/\/teamsync\.example\/\.well-known\/oauth-protected-resource\/mcp"/);
  const meta = await go(env, '/.well-known/oauth-protected-resource/mcp');
  assert.equal(meta.status, 200);
  const m = await meta.json();
  assert.equal(m.resource, ORIGIN + '/mcp');
  assert.deepEqual(m.authorization_servers, [ORIGIN]);
  const as = await (await go(env, '/.well-known/oauth-authorization-server')).json();
  assert.equal(as.authorization_endpoint, ORIGIN + '/authorize');
  assert.equal(as.token_endpoint, ORIGIN + '/token');
  assert.equal(as.registration_endpoint, ORIGIN + '/register');
  assert.ok(as.code_challenge_methods_supported.includes('S256'));
});

test('existing routes behave as before with the connector in front: health, CORS preflight, 404s', async () => {
  const { env } = await setup({ oauth: true });
  const health = await go(env, '/health');
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('Cache-Control'), 'no-store');
  const pre = await go(env, '/users/list', { method: 'OPTIONS' });
  assert.equal(pre.status, 200);
  assert.equal(pre.headers.get('Access-Control-Allow-Headers'), 'Content-Type, X-Aps-Token');
  const nf = await go(env, '/nope');
  assert.equal(nf.status, 404);
  assert.equal(await nf.text(), 'Not found');
});

test('without OAUTH_KV bound, the connector paths answer 503 and every other route still works', async () => {
  const { env } = await setup();
  assert.equal((await go(env, '/mcp', { method: 'POST', body: '{}' })).status, 503);
  assert.equal((await go(env, '/.well-known/oauth-authorization-server')).status, 503);
  assert.equal((await go(env, '/health')).status, 200);
});

test('dynamic registration only accepts Claude\'s callback; the allowlist takes localhost only with the dev flag', async () => {
  const { env } = await setup({ oauth: true });
  const res = await go(env, '/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Evil', redirect_uris: ['https://evil.example/cb'], token_endpoint_auth_method: 'none' }) });
  assert.equal(res.status, 400);
  const mixed = await go(env, '/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Sneaky', redirect_uris: [CB, 'https://evil.example/cb'], token_endpoint_auth_method: 'none' }) });
  assert.equal(mixed.status, 400);
  assert.equal(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback', false), true);
  assert.equal(isAllowedRedirectUri('https://claude.com/api/mcp/auth_callback', false), true);
  assert.equal(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback/../x', false), false);
  assert.equal(isAllowedRedirectUri('http://localhost:6274/oauth/callback', false), false);
  assert.equal(isAllowedRedirectUri('http://localhost:6274/oauth/callback', true), true);
  assert.equal(isAllowedRedirectUri('http://localhost.evil.example/cb', true), false);
  assert.equal(isAllowedRedirectUri('https://localhost/cb', true), false);
});

test('full connect: register, sign in, consent, token; then tools work as that person, and the grant shows in Connected apps', async () => {
  const { env, state } = await setup({ oauth: true, passwords: true });
  const { tokens, redirect, consentHtml } = await connect(env, 'ed');
  assert.match(consentHtml, /Allow Claude to read and edit TeamSync as Ed Editor \(Editor\)\?/);
  assert.equal(redirect.origin + redirect.pathname, CB);
  assert.equal(redirect.searchParams.get('state'), 'st-123');
  assert.ok(tokens.access_token && tokens.refresh_token);
  assert.ok(tokens.expires_in <= 3600);

  const init = await rpc(env, tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.status, 200);
  assert.equal((await init.json()).result.serverInfo.name, 'TeamSync');
  const listed = await (await rpc(env, tokens.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_projects', arguments: {} } })).json();
  assert.equal(listed.result.isError, false);
  assert.deepEqual(listed.result.structuredContent.projects.map((p) => p.projectId), ['p1', 'p2']);
  const get = await go(env, '/mcp', { headers: { Authorization: 'Bearer ' + tokens.access_token } });
  assert.equal(get.status, 405);

  // Signed in and connected are both in the audit trail.
  const actions = (await auditRows(state)).map((r) => r.action + '|' + (r.details || ''));
  assert.ok(actions.includes('Signed in|password (Claude connector)'), actions.join(','));
  assert.ok(actions.includes('Connected Claude|Claude'));

  // Settings > Connected apps: listed, then disconnected; the token stops working.
  const login = await go(env, '/auth', { method: 'POST', body: JSON.stringify({ username: 'ed', password: 'pw-ed' }) });
  const session = (await login.json()).token;
  const apps = await (await go(env, '/connected-apps', { method: 'POST', body: JSON.stringify({ token: session }) })).json();
  assert.equal(apps.available, true);
  assert.equal(apps.apps.length, 1);
  assert.equal(apps.apps[0].clientName, 'Claude');
  assert.ok(apps.apps[0].lastUsedAt > 0, 'the tool calls above count as use');
  const off = await (await go(env, '/connected-apps', { method: 'POST', body: JSON.stringify({ token: session, action: 'disconnect', grantId: apps.apps[0].grantId }) })).json();
  assert.deepEqual(off.apps, []);
  const after = await rpc(env, tokens.access_token, { jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.equal(after.status, 401);
  // Someone else's grant id can't be disconnected through your session.
  const nope = await go(env, '/connected-apps', { method: 'POST', body: JSON.stringify({ token: session, action: 'disconnect', grantId: 'not-mine' }) });
  assert.equal(nope.status, 404);
});

test('authorize refuses a redirect that isn\'t Claude\'s, a wrong password, and Cancel sends access_denied back to Claude', async () => {
  const { env } = await setup({ oauth: true, passwords: true });
  const clientId = await registerClaude(env);
  const p = await pkce();
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'https://evil.example/cb', state: 's', code_challenge: p.challenge, code_challenge_method: 'S256' });
  const bad = await go(env, '/authorize?' + q.toString());
  assert.equal(bad.status, 400);

  const page = await startAuthorize(env, clientId, p);
  const html = await page.text();
  assert.equal(page.headers.get('X-Frame-Options'), 'DENY');
  assert.match(page.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  const rid = hidden(html, 'rid');
  const wrong = await go(env, '/authorize', form({ rid, step: 'password', username: 'ed', password: 'nope' }));
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /username or password isn/);
  // A consent post with a forged/missing ticket is refused.
  const forged = await go(env, '/authorize', form({ rid, step: 'consent', ticket: 'abc.def', decision: 'allow' }));
  assert.equal(forged.status, 401);
  const cancel = await go(env, '/authorize', form({ rid, step: 'cancel' }));
  assert.equal(cancel.status, 302);
  const loc = new URL(cancel.headers.get('Location'));
  assert.equal(loc.searchParams.get('error'), 'access_denied');
  assert.equal(loc.searchParams.get('state'), 'st-123');
  const again = await go(env, '/authorize', form({ rid, step: 'password', username: 'ed', password: 'pw-ed' }));
  assert.equal(again.status, 400, 'the request is used up after Cancel');
});

test('a password reset or removing the account ends the connection on the next call', async () => {
  const { env, usersKv } = await setup({ oauth: true, passwords: true });
  const { tokens } = await connect(env, 'vic');
  assert.equal((await rpc(env, tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 200);
  const rec = JSON.parse(await usersKv.get('user:vic'));
  rec.tokensValidAfter = Date.now() + 1;
  await usersKv.put('user:vic', JSON.stringify(rec));
  const res = await rpc(env, tokens.access_token, { jsonrpc: '2.0', id: 2, method: 'ping' });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('WWW-Authenticate'), /invalid_token/);
  assert.equal(await currentConnectorUser(env, { username: 'nobody', grantedAt: Date.now() }), null);
  await usersKv.delete('user:ed');
  assert.equal(await currentConnectorUser(env, { username: 'ed', grantedAt: Date.now() }), null);
  assert.equal(await currentConnectorUser(env, null), null);
});

test('the role is read fresh on every call: demoting an editor stops their writes at once', async () => {
  const { env, usersKv } = await setup({ oauth: true, passwords: true });
  const { tokens } = await connect(env, 'ed');
  const move = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'set_task_notes', arguments: { projectId: 'p1', jobId: 'members', taskId: 't-m-cut', notes: 'hi' } } };
  assert.equal((await (await rpc(env, tokens.access_token, move)).json()).result.isError, false);
  const rec = JSON.parse(await usersKv.get('user:ed'));
  rec.role = 'viewer';
  await usersKv.put('user:ed', JSON.stringify(rec));
  const r = (await (await rpc(env, tokens.access_token, move)).json()).result;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /role \(viewer\)/);
});

// ── Reads ──

test('list_projects: a restricted account sees only its own project', async () => {
  const { env } = await setup();
  const all = await call(ctxFor(env, 'karl'), 'list_projects', {});
  assert.deepEqual(all.structured.projects.map((p) => p.projectId), ['p1', 'p2']);
  const rita = await call(ctxFor(env, 'rita'), 'list_projects', {});
  assert.deepEqual(rita.structured.projects.map((p) => p.projectId), ['p2']);
});

test('get_schedule: overlapping, non-archived tasks sorted by start, with the stage name and customer', async () => {
  const { env } = await setup();
  const r = await call(ctxFor(env, 'karl'), 'get_schedule', { projectId: 'p1', from: '2026-11-23', to: '2026-11-29' });
  assert.equal(r.isError, undefined);
  const rows = r.structured.tasks;
  assert.deepEqual(rows.map((x) => x.taskId), ['t-m-cut', 't-ext-deliver', 't-int-deliver']);
  const ext = rows.find((x) => x.taskId === 't-ext-deliver');
  assert.deepEqual(ext, { projectId: 'p1', jobId: 'highland', jobName: 'Highland (3 F2)', customer: 'Smith, Inc.', phase: '3 F2', subPhase: 'Ext', taskId: 't-ext-deliver', stage: 'Deliver', start: '2026-11-24', finish: '2026-11-24', notes: '' });
  assert.ok(!rows.some((x) => x.jobId === 'old'), 'archived jobs are left out');
  const q = await call(ctxFor(env, 'karl'), 'get_schedule', { from: '2026-11-01', to: '2026-11-30', query: 'ext' });
  assert.deepEqual(q.structured.tasks.map((x) => x.taskId), ['t-ext-design', 't-ext-deliver']);
  const both = await call(ctxFor(env, 'karl'), 'get_schedule', { from: '2026-11-23', to: '2026-11-23' });
  assert.ok(both.structured.tasks.some((x) => x.projectId === 'p2'), 'no projectId covers every project');
});

test('get_schedule: below Project Admin you only see jobs you are a member of (same rule as the app)', async () => {
  const { env } = await setup();
  const ed = await call(ctxFor(env, 'ed'), 'get_schedule', { projectId: 'p1', from: '2026-11-01', to: '2026-11-30' });
  assert.deepEqual([...new Set(ed.structured.tasks.map((x) => x.jobId))], ['members']);
  const pam = await call(ctxFor(env, 'pam'), 'get_schedule', { projectId: 'p1', from: '2026-11-01', to: '2026-11-30' });
  assert.deepEqual([...new Set(pam.structured.tasks.map((x) => x.jobId))].sort(), ['highland', 'members']);
  const hidden = await call(ctxFor(env, 'ed'), 'get_job', { projectId: 'p1', jobId: 'highland' });
  assert.equal(hidden.isError, true);
});

test('get_schedule caps the rows and says so', async () => {
  const { env, room } = await setup();
  const s = await room.loadRoomState();
  const many = {};
  for (let i = 0; i < 520; i++) many['j' + i] = { id: 'j' + i, name: 'Job ' + i, archived: false, tasks: [task('t' + i, 'cut', '2026-12-01', '2026-12-01', 2)] };
  await room.fetch(new Request('https://internal/internal/import', { method: 'POST', body: JSON.stringify({ projects: { p1: Object.assign({}, s.projects.p1, { jobs: many }) } }) }));
  const r = await call(ctxFor(env, 'karl'), 'get_schedule', { projectId: 'p1', from: '2026-12-01', to: '2026-12-01' });
  assert.equal(r.structured.tasks.length, 500);
  assert.equal(r.structured.truncated, true);
  assert.equal(r.structured.total, 520);
  assert.match(r.text, /first 500 of 520/);
});

test('search_jobs and get_job: details, custom fields, attachment names only, comments', async () => {
  const { env } = await setup();
  const s = await call(ctxFor(env, 'karl'), 'search_jobs', { query: 'smith' });
  assert.deepEqual(s.structured.jobs.map((j) => j.jobId), ['highland']);
  assert.equal(s.structured.jobs[0].start, '2026-11-02');
  assert.equal(s.structured.jobs[0].finish, '2026-11-26');
  const arch = await call(ctxFor(env, 'karl'), 'search_jobs', { query: 'old', includeArchived: true });
  assert.deepEqual(arch.structured.jobs.map((j) => j.jobId), ['old']);
  assert.equal((await call(ctxFor(env, 'karl'), 'search_jobs', { query: 'old' })).structured.jobs.length, 0);
  const g = await call(ctxFor(env, 'karl'), 'get_job', { projectId: 'p1', jobId: 'highland' });
  assert.equal(g.structured.customFields.customer, 'Smith, Inc.');
  assert.deepEqual(g.structured.attachments, ['plans.pdf']);
  assert.ok(!JSON.stringify(g.structured).includes('secret/key'), 'attachment storage keys are not exposed');
  assert.equal(g.structured.units.length, 2);
  assert.equal(g.structured.units[0].subPhase, 'Ext');
});

// ── Writes ──

test('update_task_dates saves, writes audit rows marked via Claude, broadcasts live, and logs activity in plain words', async () => {
  const watcher = makeFakeWs({ username: 'pam', displayName: 'Pam Admin', role: 'projectAdmin', assignedProjectId: null, proto: 2 });
  const { env, room, state } = await setup({ sockets: [watcher] });
  const r = await call(ctxFor(env, 'karl'), 'update_task_dates', { projectId: 'p1', jobId: 'highland', taskId: 't-ext-deliver', start: '2026-11-25', finish: '2026-11-25', reason: 'truck moved' });
  assert.equal(r.isError, undefined, r.text);
  assert.equal(r.structured.saved, true);
  const j = await job(room, 'p1', 'highland');
  assert.equal(findTaskIn(j, 't-ext-deliver').start, '2026-11-25');
  assert.equal(findTaskIn(j, 't-int-deliver').start, '2026-11-26', 'other tasks untouched');
  assert.equal(j.unrelatedField, 'keep me', 'unrelated fields untouched');
  assert.ok(j.updatedAt > 1000);
  const p = (await room.loadRoomState()).projects.p1;
  const last = p.activityLog[p.activityLog.length - 1];
  assert.equal(last.who, 'Karl Hendrickson (via Claude)');
  assert.equal(last.what, 'moved Highland (3 F2) › 3 F2 › Ext › Deliver to Nov 25–Nov 25 (truck moved)');
  await new Promise((res) => setTimeout(res, 0));
  const rows = (await auditRows(state)).filter((x) => x.action === 'Updated job');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user, 'karl');
  assert.equal(rows[0].ip, 'claude-connector');
  assert.equal(rows[0].details, 'via Claude');
  const deltas = watcher._sent.filter((m) => m.type === 'delta');
  assert.ok(deltas.some((d) => d.projects.p1 && d.projects.p1.jobs && d.projects.p1.jobs.highland), 'connected app received the change');
});

test('dryRun shows the exact before/after and saves nothing', async () => {
  const { env, room } = await setup();
  const before = JSON.stringify(await room.loadRoomState());
  const r = await call(ctxFor(env, 'karl'), 'update_task_dates', { projectId: 'p1', jobId: 'highland', taskId: 't-ext-deliver', start: '2026-12-01', finish: '2026-12-02', dryRun: true });
  assert.equal(r.structured.saved, false);
  assert.deepEqual(r.structured.changes[0].before, { start: '2026-11-24', finish: '2026-11-24' });
  assert.deepEqual(r.structured.changes[0].after, { start: '2026-12-01', finish: '2026-12-02' });
  assert.match(r.text, /Preview only/);
  assert.equal(JSON.stringify(await room.loadRoomState()), before);
});

test('shift_tasks moves several tasks together, keeping lengths; refuses undated tasks and too many', async () => {
  const { env, room } = await setup();
  const r = await call(ctxFor(env, 'karl'), 'shift_tasks', { projectId: 'p1', jobId: 'highland', taskIds: ['t-ext-design', 't-int-deliver'], days: -3 });
  assert.equal(r.isError, undefined, r.text);
  const j = await job(room, 'p1', 'highland');
  assert.deepEqual([findTaskIn(j, 't-ext-design').start, findTaskIn(j, 't-ext-design').finish], ['2026-10-30', '2026-11-01']);
  assert.equal(findTaskIn(j, 't-int-deliver').start, '2026-11-23');
  assert.equal(findTaskIn(j, 't-ext-deliver').start, '2026-11-24');
  const tooMany = await call(ctxFor(env, 'karl'), 'shift_tasks', { projectId: 'p1', jobId: 'highland', taskIds: Array.from({ length: 51 }, (_, i) => 't' + i), days: 1 });
  assert.equal(tooMany.isError, true);
  const dup = await call(ctxFor(env, 'karl'), 'shift_tasks', { projectId: 'p1', jobId: 'highland', taskIds: ['t-ext-design', 't-ext-design'], days: 1 });
  assert.equal(dup.isError, true);
});

test('set_task_notes replaces one task\'s notes', async () => {
  const { env, room } = await setup();
  const r = await call(ctxFor(env, 'ed'), 'set_task_notes', { projectId: 'p1', jobId: 'members', taskId: 't-m-cut', notes: 'Saw 2' });
  assert.equal(r.isError, undefined, r.text);
  assert.equal(findTaskIn(await job(room, 'p1', 'members'), 't-m-cut').notes, 'Saw 2');
});

test('viewer can read but not write; commenter can comment but not move tasks', async () => {
  const { env, room } = await setup();
  const vic = ctxFor(env, 'vic');
  assert.equal((await call(vic, 'get_job', { projectId: 'p1', jobId: 'members' })).isError, undefined);
  const vw = await call(vic, 'update_task_dates', { projectId: 'p1', jobId: 'members', taskId: 't-m-cut', start: '2026-12-01', finish: '2026-12-01' });
  assert.equal(vw.isError, true);
  assert.match(vw.text, /role \(viewer\)/);
  assert.equal((await call(vic, 'add_job_comment', { projectId: 'p1', jobId: 'members', text: 'hi' })).isError, true);

  const cora = ctxFor(env, 'cora');
  const move = await call(cora, 'shift_tasks', { projectId: 'p1', jobId: 'members', taskIds: ['t-m-cut'], days: 1 });
  assert.equal(move.isError, true);
  const c = await call(cora, 'add_job_comment', { projectId: 'p1', jobId: 'members', text: 'Lumber is on site' });
  assert.equal(c.isError, undefined, c.text);
  const j = await job(room, 'p1', 'members');
  assert.equal(j.comments.length, 1);
  assert.equal(j.comments[0].text, 'Lumber is on site');
  assert.equal(j.comments[0].author, 'Cora Commenter (via Claude)', 'author comes from the verified identity');
  assert.equal(j.comments[0].by, 'cora');
  assert.equal(findTaskIn(j, 't-m-cut').start, '2026-11-23');
});

test('assigned-project restriction: a restricted account can\'t read or write another project', async () => {
  const { env } = await setup();
  const rita = ctxFor(env, 'rita');
  assert.equal((await call(rita, 'get_job', { projectId: 'p1', jobId: 'highland' })).isError, true);
  const w = await call(rita, 'update_task_dates', { projectId: 'p1', jobId: 'highland', taskId: 't-ext-deliver', start: '2026-12-01', finish: '2026-12-01' });
  assert.equal(w.isError, true);
  assert.match(w.text, /No project/);
  const ok = await call(rita, 'update_task_dates', { projectId: 'p2', jobId: 'other', taskId: 't-o', start: '2026-12-01', finish: '2026-12-01' });
  assert.equal(ok.isError, undefined, ok.text);
});

test('the room itself enforces the assigned project too (applyAsUser), even if a tool were wrong', async () => {
  const { env, room } = await setup();
  const r = await room.fetch(new Request('https://internal/internal/mcp-apply', { method: 'POST', body: JSON.stringify({
    attachment: { username: 'rita', displayName: 'Rita (via Claude)', role: 'projectAdmin', assignedProjectId: 'p2', via: 'Claude' },
    messages: [{ type: 'upsertJob', projectId: 'p1', job: { id: 'highland', updatedAt: 99999 } }],
  }) }));
  const body = await r.json();
  assert.equal(body.result.ok, false);
  assert.match(body.result.error, /outside your assigned project/);
  assert.equal((await job(room, 'p1', 'highland')).name, 'Highland (3 F2)');
});

test('stale write: a change landing between read and save is retried once on fresh data, never overwritten', async () => {
  const { env, room } = await setup();
  const ctx = ctxFor(env, 'karl');
  const real = ctx.room;
  let interfered = 0;
  ctx.room = {
    read: real.read,
    async apply(messages) {
      if (!interfered++) {
        // Someone edits another task of the same job in the app meanwhile.
        const s = await room.loadRoomState();
        const other = JSON.parse(JSON.stringify(s.projects.p1.jobs.highland));
        findTaskIn(other, 't-int-deliver').notes = 'edited in the app';
        other.updatedAt = 2000;
        const res = await room.applyAsUser({ type: 'upsertJob', projectId: 'p1', job: other }, { username: 'pam', displayName: 'Pam Admin', role: 'projectAdmin', assignedProjectId: null });
        assert.equal(res.ok, true);
      }
      return real.apply(messages);
    },
  };
  const r = await call(ctx, 'update_task_dates', { projectId: 'p1', jobId: 'highland', taskId: 't-ext-deliver', start: '2026-11-27', finish: '2026-11-27' });
  assert.equal(r.isError, undefined, r.text);
  assert.equal(interfered, 2, 'tried twice');
  const j = await job(room, 'p1', 'highland');
  assert.equal(findTaskIn(j, 't-ext-deliver').start, '2026-11-27');
  assert.equal(findTaskIn(j, 't-int-deliver').notes, 'edited in the app', 'the other person\'s edit survived');
});

test('stale twice gives a clear error and saves nothing', async () => {
  const { env, room } = await setup();
  const ctx = ctxFor(env, 'karl');
  ctx.room = { read: ctx.room.read, apply: async () => ({ result: { ok: false, changed: false, rejected: { reason: 'stale' } } }) };
  const r = await call(ctx, 'set_task_notes', { projectId: 'p1', jobId: 'highland', taskId: 't-ext-deliver', notes: 'x' });
  assert.equal(r.isError, true);
  assert.match(r.text, /Someone else changed this job/);
  assert.equal(findTaskIn(await job(room, 'p1', 'highland'), 't-ext-deliver').notes, '');
});

test('maintenance mode blocks writes with a clear message (previews and reads still work)', async () => {
  const { env, usersKv, room } = await setup();
  await usersKv.put(MAINTENANCE_KV_KEY, JSON.stringify({ active: true, message: 'Moving servers' }));
  const ctx = ctxFor(env, 'karl');
  const w = await call(ctx, 'update_task_dates', { projectId: 'p1', jobId: 'highland', taskId: 't-ext-deliver', start: '2026-12-01', finish: '2026-12-01' });
  assert.equal(w.isError, true);
  assert.match(w.text, /maintenance mode.*Moving servers/);
  assert.equal((await call(ctx, 'create_job', { projectId: 'p1', name: 'X' })).isError, true);
  assert.equal((await call(ctx, 'update_task_dates', { projectId: 'p1', jobId: 'highland', taskId: 't-ext-deliver', start: '2026-12-01', finish: '2026-12-01', dryRun: true })).isError, undefined);
  assert.equal(findTaskIn(await job(room, 'p1', 'highland'), 't-ext-deliver').start, '2026-11-24');
});

test('bad dates, unknown ids and oversized inputs are refused with friendly messages', async () => {
  const { env } = await setup();
  const ctx = ctxFor(env, 'karl');
  const base = { projectId: 'p1', jobId: 'highland', taskId: 't-ext-deliver' };
  const cases = [
    [Object.assign({}, base, { start: '2026-02-30', finish: '2026-03-01' }), /real date/],
    [Object.assign({}, base, { start: '11/25/2026', finish: '2026-11-25' }), /real date/],
    [Object.assign({}, base, { start: '2026-11-26', finish: '2026-11-25' }), /on or after/],
    [Object.assign({}, base, { taskId: 'nope', start: '2026-11-25', finish: '2026-11-25' }), /No task/],
    [Object.assign({}, base, { jobId: 'nope', start: '2026-11-25', finish: '2026-11-25' }), /No job/],
    [Object.assign({}, base, { projectId: 'nope', start: '2026-11-25', finish: '2026-11-25' }), /No project/],
    [Object.assign({}, base, { jobId: '<script>', start: '2026-11-25', finish: '2026-11-25' }), /not a TeamSync id/],
  ];
  for (const [args, re] of cases) {
    const r = await call(ctx, 'update_task_dates', args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.text, re);
  }
  const longNotes = await call(ctx, 'set_task_notes', Object.assign({}, base, { notes: 'x'.repeat(5001) }));
  assert.match(longNotes.text, /too long/);
  const longComment = await call(ctx, 'add_job_comment', { projectId: 'p1', jobId: 'highland', text: 'x'.repeat(5001) });
  assert.match(longComment.text, /too long/);
  const range = await call(ctx, 'get_schedule', { from: '2026-01-01', to: '2027-12-31' });
  assert.match(range.text, /too long/);
  const archived = await call(ctx, 'update_task_dates', { projectId: 'p1', jobId: 'old', taskId: 't-old', start: '2026-12-01', finish: '2026-12-01' });
  assert.match(archived.text, /archived/);
});

test('a tool that hits an unexpected error says so without a stack trace', async () => {
  const { env } = await setup();
  const ctx = ctxFor(env, 'karl');
  ctx.room = { read: async () => { throw new Error('boom at room.ts:12'); }, apply: async () => ({}) };
  const r = await call(ctx, 'list_projects', {});
  assert.equal(r.isError, true);
  assert.doesNotMatch(r.text, /boom|room\.ts/);
});

test('rate limit: past the hourly write limit, writes are refused and nothing is saved', async () => {
  const { env, room, state } = await setup();
  await state.storage.put('mcp-rate|karl', { start: Date.now(), count: ApsRoom.MCP_WRITES_PER_HOUR });
  const r = await call(ctxFor(env, 'karl'), 'set_task_notes', { projectId: 'p1', jobId: 'highland', taskId: 't-ext-deliver', notes: 'x' });
  assert.equal(r.isError, true);
  assert.match(r.text, /limit/);
  assert.equal(findTaskIn(await job(room, 'p1', 'highland'), 't-ext-deliver').notes, '');
  // Another person isn't affected, and the window resets after an hour.
  assert.equal((await call(ctxFor(env, 'ed'), 'set_task_notes', { projectId: 'p1', jobId: 'members', taskId: 't-m-cut', notes: 'ok' })).isError, undefined);
  await state.storage.put('mcp-rate|karl', { start: Date.now() - 61 * 60 * 1000, count: 999 });
  assert.equal((await call(ctxFor(env, 'karl'), 'set_task_notes', { projectId: 'p1', jobId: 'highland', taskId: 't-ext-deliver', notes: 'x' })).isError, undefined);
});

// ── create_job ──

test('create_job builds the same structure as the app\'s job form and saves job + card + activity', async () => {
  const { env, room } = await setup();
  const r = await call(ctxFor(env, 'pam'), 'create_job', { projectId: 'p1', name: 'Maple St', customer: 'acme homes', stageDates: [{ stage: 'cut', start: '2026-11-20', finish: '2026-11-22' }, { stage: 'Panel', start: '2026-11-23', finish: '2026-11-24' }] });
  assert.equal(r.isError, undefined, r.text);
  const s = await room.loadRoomState();
  const jobId = r.structured.jobId;
  const j = s.projects.p1.jobs[jobId];
  // saveJobForm(): {id, name, color, archived, comments, tasks}, one task per column in order.
  assert.deepEqual(Object.keys(j).sort(), ['archived', 'color', 'comments', 'id', 'name', 'tasks', 'updatedAt']);
  assert.equal(j.color, '#3949ab');
  assert.deepEqual(j.tasks.map((t) => [t.name, t.columnId, t.order, t.color, t.start, t.finish, t.notes]), [
    ['Bid', 'bid', 0, '#b3bac5', '', '', ''],
    ['Design', 'design', 1, '#579dff', '', '', ''],
    ['Cut', 'cut', 2, '#4bce97', '2026-11-20', '2026-11-22', ''],
    ['Panel', 'panel', 3, '#f5cd47', '2026-11-23', '2026-11-24', ''],
    ['Deliver', 'deliver', 4, '#f87168', '', '', ''],
  ]);
  j.tasks.forEach((t) => assert.deepEqual(Object.keys(t).sort(), ['color', 'columnId', 'finish', 'id', 'name', 'notes', 'order', 'start']));
  // makePhaseCard(): same fields; it starts in Bid and moves to Cut because Cut covers today (2026-11-21).
  const card = Object.values(s.projects.p1.boardCards).find((c) => c.jobId === jobId);
  assert.deepEqual(Object.keys(card).sort(), ['attachments', 'checklists', 'color', 'column', 'columnEnteredAt', 'customFields', 'description', 'due', 'id', 'jobId', 'manualColumn', 'manualColumnUntil', 'phaseId', 'title', 'updatedAt']);
  assert.equal(card.title, 'Maple St');
  assert.equal(card.phaseId, null);
  assert.equal(card.column, 'cut');
  assert.deepEqual(card.customFields, { customer: 'Acme Homes' }, 'customer matched to the existing option');
  const p = s.projects.p1;
  assert.equal(p.activityLog[p.activityLog.length - 1].what, 'added job "Maple St"');
});

test('create_job: card column automation runs like the app (checklist seeded and assigned)', async () => {
  const project = seedRoom().projects.p1;
  let n = 0;
  const { card } = buildNewJob(project, { name: 'J', color: '#3949ab', customer: '', stageDates: [{ stage: 'Panel', start: '2026-11-20', finish: '2026-11-25' }] }, Date.UTC(2026, 10, 21), () => 'id' + (++n));
  assert.equal(card.column, 'panel');
  assert.deepEqual(card.checklists.panel, [{ id: 'chk1', text: 'Check lumber', done: false, assignee: 'karl' }]);
});

test('create_job needs Project Admin (like the Add New Job button) and an existing customer and stage', async () => {
  const { env } = await setup();
  const ed = await call(ctxFor(env, 'ed'), 'create_job', { projectId: 'p1', name: 'X' });
  assert.equal(ed.isError, true);
  assert.match(ed.text, /projectAdmin/);
  const cust = await call(ctxFor(env, 'karl'), 'create_job', { projectId: 'p1', name: 'X', customer: 'Nobody LLC' });
  assert.match(cust.text, /isn't one of this project's customers.*Smith, Inc\., Acme Homes/);
  const stage = await call(ctxFor(env, 'karl'), 'create_job', { projectId: 'p1', name: 'X', stageDates: [{ stage: 'Paint', start: '2026-11-20', finish: '2026-11-20' }] });
  assert.match(stage.text, /No stage named "Paint"/);
  const hiddenStage = await call(ctxFor(env, 'karl'), 'create_job', { projectId: 'p1', name: 'X', stageDates: [{ stage: 'Bid', start: '2026-11-20', finish: '2026-11-20' }] });
  assert.match(hiddenStage.text, /not on the schedule/);
  const dry = await call(ctxFor(env, 'karl'), 'create_job', { projectId: 'p1', name: 'Dry', dryRun: true });
  assert.equal(dry.structured.saved, false);
});

// ── The shared commit path ──

test('applyAsUser keeps the app\'s order for the sender: ack after the save, before the broadcast', async () => {
  const ws = makeFakeWs({ username: 'karl', displayName: 'Karl Hendrickson', role: 'admin', assignedProjectId: null, proto: 2 });
  const { room } = await setup({ sockets: [ws] });
  const s = await room.loadRoomState();
  const j = JSON.parse(JSON.stringify(s.projects.p1.jobs.members));
  j.name = 'Renamed'; j.updatedAt = 9999;
  await room.webSocketMessage(ws, JSON.stringify({ type: 'upsertJob', projectId: 'p1', job: j, msgId: 7 }));
  assert.deepEqual(ws._sent.map((m) => m.type), ['ack', 'delta']);
  assert.equal(ws._sent[0].msgId, 7);
});

test('mcp-read leaves out logo images and other heavy parts the connector never reads', async () => {
  const { room } = await setup();
  const res = await room.fetch(new Request('https://internal/internal/mcp-read', { method: 'POST', body: JSON.stringify({ attachment: { username: 'karl', displayName: 'K', role: 'admin', assignedProjectId: null } }) }));
  const s = await res.json();
  assert.equal(s.projects.p1.header.logo, undefined);
  assert.equal(s.projects.p1.header.title, 'Advanced Precut');
  assert.ok(s.projects.p1.jobs.highland);
  const bad = await room.fetch(new Request('https://internal/internal/mcp-read', { method: 'POST', body: '{}' }));
  assert.equal(bad.status, 400);
});

test('TOOLS is the single list the protocol serves', () => {
  assert.equal(TOOLS.length, 9);
});

// ── Fixes from the review pass ──

test('create_job with only future dates stays in the first (Bid) column, like the app', async () => {
  const project = seedRoom().projects.p1;
  let n = 0;
  const { card } = buildNewJob(project, { name: 'Later', color: '#3949ab', customer: '', stageDates: [{ stage: 'Cut', start: '2026-12-07', finish: '2026-12-09' }] }, Date.UTC(2026, 10, 21), () => 'id' + (++n));
  assert.equal(card.column, 'bid', 'Bid is a hideFromSchedule holding column: only a task covering today pulls a card out');
  const noBid = Object.assign({}, project, { boardColumns: COLUMNS.filter((c) => c.id !== 'bid') });
  const later = buildNewJob(noBid, { name: 'Later', color: '#3949ab', customer: '', stageDates: [{ stage: 'Cut', start: '2026-12-07', finish: '2026-12-09' }] }, Date.UTC(2026, 10, 21), () => 'id' + (++n));
  assert.equal(later.card.column, 'cut', 'without a holding column it goes to its first dated stage');
});

test('a connector write is all or nothing: if any message is refused, nothing is saved (not even the activity line)', async () => {
  const watcher = makeFakeWs({ username: 'pam', displayName: 'Pam Admin', role: 'projectAdmin', assignedProjectId: null, proto: 2 });
  const { room } = await setup({ sockets: [watcher] });
  const before = JSON.stringify(await room.loadRoomState());
  const post = (messages) => room.fetch(new Request('https://internal/internal/mcp-apply', { method: 'POST', body: JSON.stringify({ attachment: { username: 'karl', displayName: 'Karl (via Claude)', role: 'admin', assignedProjectId: null, via: 'Claude' }, messages }) })).then((r) => r.json());
  const bad = await post([{ type: 'logActivity', projectId: 'p1', what: 'did a thing' }, { type: 'upsertJob', projectId: 'p1', job: { id: 'bad id!' } }]);
  assert.equal(bad.result.ok, false);
  const stale = await post([{ type: 'upsertJob', projectId: 'p1', job: { id: 'highland', name: 'X', updatedAt: 99999 }, expect: { projectId: 'p1', jobId: 'highland', updatedAt: 1 } }, { type: 'logActivity', projectId: 'p1', what: 'x' }]);
  assert.equal(stale.result.rejected.reason, 'stale');
  const unchanged = await post([{ type: 'upsertJob', projectId: 'p1', job: { id: 'highland', updatedAt: 1 } }, { type: 'logActivity', projectId: 'p1', what: 'x' }]);
  assert.equal(unchanged.result.ok, false, 'a message that would change nothing refuses the whole write');
  assert.equal(JSON.stringify(await room.loadRoomState()), before);
  assert.equal(watcher._sent.length, 0, 'nothing broadcast');
});

test('a saved connector write reaches open apps as one delta, and only saved writes count toward the hourly limit', async () => {
  const watcher = makeFakeWs({ username: 'pam', displayName: 'Pam Admin', role: 'projectAdmin', assignedProjectId: null, proto: 2 });
  const { env, state } = await setup({ sockets: [watcher] });
  const r = await call(ctxFor(env, 'karl'), 'create_job', { projectId: 'p1', name: 'One Delta', stageDates: [{ stage: 'Cut', start: '2026-12-07', finish: '2026-12-09' }] });
  assert.equal(r.isError, undefined, r.text);
  const deltas = watcher._sent.filter((m) => m.type === 'delta');
  assert.equal(deltas.length, 1);
  const d = deltas[0].projects.p1;
  assert.ok(d.jobs[r.structured.jobId], 'job in the delta');
  assert.ok(Object.values(d.boardCards).some((c) => c.jobId === r.structured.jobId), 'its card in the same delta');
  assert.equal((await state.storage.get('mcp-rate|karl')).count, 1);
  await call(ctxFor(env, 'karl'), 'update_task_dates', { projectId: 'p1', jobId: 'nope', taskId: 'x', start: '2026-12-01', finish: '2026-12-01' });
  assert.equal((await state.storage.get('mcp-rate|karl')).count, 1, 'a refused write did not count');
});

test('if the room doesn\'t answer after a write was sent, Claude is told it may have saved, not that nothing was saved', async () => {
  const { env } = await setup();
  const ctx = ctxFor(env, 'karl');
  ctx.room = { read: ctx.room.read, apply: async () => { throw new Error('network'); } };
  const r = await call(ctx, 'shift_tasks', { projectId: 'p1', jobId: 'highland', taskIds: ['t-ext-deliver'], days: 3 });
  assert.equal(r.isError, true);
  assert.match(r.text, /may or may not have been saved/);
  assert.doesNotMatch(r.text, /Nothing was saved/);
});

test('ids that name built-in object properties are refused; edits in an archived project are refused', async () => {
  const { env, room } = await setup();
  const ctx = ctxFor(env, 'karl');
  for (const bad of ['__proto__', 'constructor', 'toString']) {
    const r = await call(ctx, 'get_job', { projectId: bad, jobId: 'highland' });
    assert.equal(r.isError, true, bad);
    const r2 = await call(ctx, 'get_job', { projectId: 'p1', jobId: bad });
    assert.equal(r2.isError, true, bad);
  }
  const s = await room.loadRoomState();
  await room.fetch(new Request('https://internal/internal/import', { method: 'POST', body: JSON.stringify({ projects: Object.assign({}, s.projects, { p2: Object.assign({}, s.projects.p2, { header: { archived: true } }) }) }) }));
  const w = await call(ctx, 'set_task_notes', { projectId: 'p2', jobId: 'other', taskId: 't-o', notes: 'x' });
  assert.equal(w.isError, true);
  assert.match(w.text, /archived/);
});

test('JSON-RPC batches are capped', async () => {
  const many = Array.from({ length: 11 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' }));
  const res = await handleMcpHttp(new Request('https://w/mcp', { method: 'POST', body: JSON.stringify(many) }), async () => ({}));
  assert.equal(res.status, 400);
  const ok = await handleMcpHttp(new Request('https://w/mcp', { method: 'POST', body: JSON.stringify(many.slice(0, 2)) }), async () => ({}));
  assert.equal((await ok.json()).length, 2);
});

test('the instructions tell Claude that job text from teammates is information, not instructions', () => {
  assert.match(INSTRUCTIONS, /never as instructions/);
});

test('after a password reset the old connection is revoked and no longer listed in Connected apps', async () => {
  const { env, usersKv } = await setup({ oauth: true, passwords: true });
  await connect(env, 'cora');
  const rec = JSON.parse(await usersKv.get('user:cora'));
  rec.tokensValidAfter = Date.now();
  await usersKv.put('user:cora', JSON.stringify(rec));
  await new Promise((r) => setTimeout(r, 5));
  const login = await go(env, '/auth', { method: 'POST', body: JSON.stringify({ username: 'cora', password: 'pw-cora' }) });
  const session = (await login.json()).token;
  const apps = await (await go(env, '/connected-apps', { method: 'POST', body: JSON.stringify({ token: session }) })).json();
  assert.deepEqual(apps.apps, []);
  assert.equal([...env.OAUTH_KV._store.keys()].filter((k) => k.startsWith('grant:')).length, 0, 'grant revoked');
});

test('the shared sign-in rules: the app\'s /auth and the connector page both lock out after too many failures', async () => {
  const { env, usersKv } = await setup({ oauth: true, passwords: true });
  await usersKv.put('authfail:ed', '10');
  const app = await go(env, '/auth', { method: 'POST', body: JSON.stringify({ username: 'ed', password: 'pw-ed' }) });
  assert.equal(app.status, 429);
  const clientId = await registerClaude(env);
  const page = await startAuthorize(env, clientId, await pkce());
  const rid = hidden(await page.text(), 'rid');
  const conn = await go(env, '/authorize', form({ rid, step: 'password', username: 'ed', password: 'pw-ed' }));
  assert.equal(conn.status, 429);
});

test('"Delete all company data" also clears the connector\'s sign-in storage', async () => {
  const { env, usersKv } = await setup({ oauth: true });
  env.BACKUP_BUCKET = { list: async () => ({ objects: [] }), delete: async () => {} };
  await env.OAUTH_KV.put('grant:ed:g1', '{}');
  await usersKv.put(DELETION_KV_KEY, JSON.stringify({ requestedBy: 'karl', requestedAt: 1, executeAt: 2 }));
  assert.equal(await runDueDeletion(env, 3), true);
  assert.equal(env.OAUTH_KV._store.size, 0);
});
