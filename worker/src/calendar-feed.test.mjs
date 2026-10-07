import test from 'node:test';
import assert from 'node:assert/strict';
import { handleCalendarFeedLink, handleCalendarFeed, buildFeedIcs, eventOccurrences } from './calendar-feed.ts';
import { signRoomToken } from './room-token.ts';

const PROJECT = {
  name: 'Advanced Precut',
  jobs: {
    j1: { id: 'j1', name: 'Hendricks Residence', tasks: [{ id: 't0', name: 'Design', columnId: 'design', start: '2026-10-01', finish: '2026-10-02' }, { id: 't1', name: 'Cut', columnId: 'cut', start: '2026-10-05', finish: '2026-10-07' }] },
    j2: { id: 'j2', name: 'Private Job', tasks: [{ id: 't2', name: 'Panel', start: '2026-10-08', finish: '2026-10-08' }] },
    j3: { id: 'j3', name: 'Old Job', archived: true, tasks: [{ id: 't3', name: 'Deliver', start: '2026-10-01', finish: '2026-10-01' }] },
  },
  boardCards: {
    c1: { id: 'c1', jobId: 'j1', phaseId: null, column: 'cut', customFields: { members: ['ed'], customer: 'Smith, Inc.' } },
    c2: { id: 'c2', jobId: 'j2', phaseId: null, column: 'cut', customFields: { members: [] } },
  },
  calendarEvents: {
    e1: { id: 'e1', title: 'Safety meeting', start: '2026-10-06', time: '07:30', visibility: 'all' },
    e2: { id: 'e2', title: 'Boss only', start: '2026-10-06', visibility: 'private', createdBy: 'boss' },
  },
  boardColumns: [{ id: 'design', label: 'Design' }, { id: 'cut', label: 'Cut' }],
};

function makeEnv(users) {
  const store = new Map();
  for (const u of users) store.set('user:' + u.username, JSON.stringify(u));
  return {
    ROOM_TOKEN_SECRET: 'test-secret',
    USERS_KV: {
      async get(k) { return store.has(k) ? store.get(k) : null; },
      async put(k, v) { store.set(k, v); },
      async delete(k) { store.delete(k); },
      async list({ prefix } = {}) { return { keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })) }; },
    },
    APS_ROOM: {
      idFromName(name) { return { name }; },
      get() {
        return { fetch: async (u) => String(u).endsWith('/internal/export') ? new Response(JSON.stringify({ projects: { p1: PROJECT } })) : new Response('ok') };
      },
    },
    store,
  };
}

const user = (username, role, extra = {}) => ({ username, displayName: username, role, assignedProjectId: null, passwordHash: '', salt: '', createdAt: 1, ...extra });
const req = (body) => ({ json: async () => body, headers: new Headers() });
async function link(env, u, action) {
  const token = await signRoomToken(env.ROOM_TOKEN_SECRET, { username: u.username, displayName: u.username, role: u.role, assignedProjectId: u.assignedProjectId });
  const res = await handleCalendarFeedLink(req({ token, action }), env, {});
  return { status: res.status, body: await res.json() };
}
const feed = (env, feedToken, pid = 'p1', stage) => handleCalendarFeed(env, {}, new URL('https://x/cal/' + feedToken + '/' + pid + (stage ? '/' + stage : '') + '.ics'));

test('link: get creates one and returns the same one again; reset replaces it; off removes it', async () => {
  const env = makeEnv([user('ed', 'editor')]);
  const a = await link(env, user('ed', 'editor'), 'get');
  assert.equal(a.status, 200);
  assert.match(a.body.feedToken, /^[0-9a-f]{40}$/);
  assert.equal((await link(env, user('ed', 'editor'), 'get')).body.feedToken, a.body.feedToken);

  const b = await link(env, user('ed', 'editor'), 'reset');
  assert.notEqual(b.body.feedToken, a.body.feedToken);
  assert.equal((await feed(env, a.body.feedToken)).status, 404, 'the old link stops working');
  assert.equal((await feed(env, b.body.feedToken)).status, 200);

  assert.equal((await link(env, user('ed', 'editor'), 'off')).body.feedToken, null);
  assert.equal((await feed(env, b.body.feedToken)).status, 404);
});

test('link: refuses a bad session', async () => {
  const env = makeEnv([]);
  const res = await handleCalendarFeedLink(req({ token: 'nope' }), env, {});
  assert.equal(res.status, 401);
});

test('feed: an editor sees only their own jobs and the events they can see', async () => {
  const env = makeEnv([user('ed', 'editor')]);
  const { body } = await link(env, user('ed', 'editor'), 'get');
  const res = await feed(env, body.feedToken);
  assert.equal(res.headers.get('Content-Type'), 'text/calendar; charset=utf-8');
  const text = await res.text();
  assert.match(text, /^BEGIN:VCALENDAR\r\n/);
  assert.match(text, /SUMMARY:Hendricks Residence — Cut/);
  assert.match(text, /DTSTART;VALUE=DATE:20261005\r\nDTEND;VALUE=DATE:20261008/);
  assert.match(text, /Customer: Smith\\, Inc\./);
  assert.match(text, /Stage: Cut/);
  assert.doesNotMatch(text, /Private Job/);
  assert.doesNotMatch(text, /Old Job/);
  assert.match(text, /SUMMARY:Safety meeting/);
  assert.match(text, /DTSTART:20261006T073000\r\nDTEND:20261006T083000/);
  assert.doesNotMatch(text, /Boss only/);
});

test('feed: a project admin sees every job; restricted accounts only their project', async () => {
  const project = buildFeedIcs(PROJECT, user('pa', 'projectAdmin'), new Date('2026-10-07T12:00:00Z'));
  assert.match(project, /Private Job/);
  assert.match(project, /Boss only/);

  const env = makeEnv([user('r', 'editor', { assignedProjectId: 'p2' })]);
  const { body } = await link(env, user('r', 'editor', { assignedProjectId: 'p2' }), 'get');
  assert.equal((await feed(env, body.feedToken, 'p1')).status, 404);
});

test('feed: unknown tokens, removed accounts and a password reset all get 404', async () => {
  const env = makeEnv([user('ed', 'editor')]);
  assert.equal((await feed(env, 'f'.repeat(40))).status, 404);
  assert.equal((await feed(env, '../etc')).status, 404);
  const { body } = await link(env, user('ed', 'editor'), 'get');

  const rec = JSON.parse(env.store.get('user:ed'));
  rec.tokensValidAfter = Date.now() + 1000;
  env.store.set('user:ed', JSON.stringify(rec));
  assert.equal((await feed(env, body.feedToken)).status, 404, 'password reset');

  env.store.delete('user:ed');
  assert.equal((await feed(env, body.feedToken)).status, 404, 'account removed');
});

test('eventOccurrences: weekly repeats honor skipped and moved dates and the range', () => {
  const evt = { start: '2026-10-01', repeat: 'weekly', repeatUntil: '2026-10-29', exceptions: { '2026-10-08': { skip: true }, '2026-10-15': { start: '2026-10-16' } } };
  const occ = eventOccurrences(evt, '2026-10-01', '2026-10-22');
  assert.deepEqual(occ.map((o) => o.sourceDate + '>' + o.start), ['2026-10-01>2026-10-01', '2026-10-15>2026-10-16', '2026-10-22>2026-10-22']);
});

test('feed: a stage link holds only that stage tasks, no events, and is named after the stage', async () => {
  const env = makeEnv([user('ed', 'editor')]);
  const { body } = await link(env, user('ed', 'editor'), 'get');
  const res = await feed(env, body.feedToken, 'p1', 'cut');
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /X-WR-CALNAME:TeamSync — Cut/);
  assert.match(text, /Hendricks Residence — Cut/);
  assert.doesNotMatch(text, /— Design/);
  assert.doesNotMatch(text, /Safety meeting/);
  assert.match(await (await feed(env, body.feedToken)).text(), /— Design/, 'the full link still has every stage');
  assert.equal((await feed(env, body.feedToken, 'p1', 'nope')).status, 404);
});
