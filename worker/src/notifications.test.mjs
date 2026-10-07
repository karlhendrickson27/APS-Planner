import test from 'node:test';
import assert from 'node:assert/strict';
import { handleNotificationState, mergeNotifyState } from './notifications.ts';
import { signRoomToken } from './room-token.ts';

function makeEnv(users) {
  const store = new Map();
  for (const u of users) store.set('user:' + u.username, JSON.stringify(u));
  return {
    ROOM_TOKEN_SECRET: 'test-secret',
    USERS_KV: {
      async get(k) { return store.has(k) ? store.get(k) : null; },
      async put(k, v) { store.set(k, v); },
      async delete(k) { store.delete(k); },
    },
    store,
  };
}
const user = (username) => ({ username, displayName: username, role: 'editor', assignedProjectId: null, passwordHash: '', salt: '', createdAt: 1 });
const req = (body) => ({ json: async () => body, headers: new Headers() });
async function call(env, username, patch) {
  const token = await signRoomToken(env.ROOM_TOKEN_SECRET, { username, displayName: username, role: 'editor', assignedProjectId: null });
  const res = await handleNotificationState(req({ token, patch }), env, {});
  return { status: res.status, body: await res.json() };
}

test('notifications: first call starts the state; patches merge and are kept per person', async () => {
  const env = makeEnv([user('ed'), user('amy')]);
  const T = Date.now() - 1000;
  const a = await call(env, 'ed');
  assert.equal(a.status, 200);
  assert.ok(a.body.state.since > 0);
  assert.deepEqual(a.body.state.off, []);
  await call(env, 'ed', { seen: { 'asg|x': 0, 'asg|y': T }, read: { 'cmt|1': T }, off: ['due', 'bogus'] });
  const b = await call(env, 'ed', { seen: { 'asg|y': T + 400 }, readUpTo: T });
  assert.equal(b.body.state.since, a.body.state.since);
  assert.deepEqual(b.body.state.seen, { 'asg|x': 0, 'asg|y': T }, 'the earliest sighting wins');
  assert.deepEqual(b.body.state.read, { 'cmt|1': T });
  assert.equal(b.body.state.readUpTo, T);
  assert.deepEqual(b.body.state.off, ['due']);
  assert.deepEqual((await call(env, 'amy')).body.state.seen, {});
});

test('notifications: bad token is refused', async () => {
  const env = makeEnv([user('ed')]);
  const res = await handleNotificationState(req({ token: 'nope' }), env, {});
  assert.equal(res.status, 401);
});

test('notifications: old read marks are dropped; seen times are kept however old', () => {
  const now = 100 * 24 * 3600 * 1000;
  const s = mergeNotifyState({ since: 1, seen: { old: 1000, base: 0 }, read: { oldRead: 1000, newRead: now - 5 }, readUpTo: 0, off: [] }, { seen: { fresh: now - 1000 }, readUpTo: now + 99999 }, now);
  assert.deepEqual(Object.keys(s.seen).sort(), ['base', 'fresh', 'old']);
  assert.deepEqual(Object.keys(s.read), ['newRead']);
  assert.equal(s.readUpTo, now, 'never in the future');
});
