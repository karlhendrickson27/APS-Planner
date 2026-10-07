// Unit tests for ApsRoom using hand-rolled fakes for state.storage and
// state.getWebSockets() — no real Durable Objects runtime available in
// plain Node, so anything touching WebSocketPair/acceptWebSocket
// (handleWebSocketUpgrade() specifically) is NOT covered here; that path
// is instead verified manually against a real `wrangler dev` runtime
// (see the worker split's commit history) before every deploy. Everything
// else ApsRoom does only touches storage.get/put and a list of fake
// socket-like objects, which plain objects can stand in for just fine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ApsRoom } from './room-do.ts';
import { readItemizedRoom } from './room-storage.ts';
import { makeFakeState, makeFakeWs } from './test-fakes.mjs';

async function storedRoom(state) { return readItemizedRoom(state.storage); }

// ── loadRoomState / persist ──

test('loadRoomState returns an empty room when nothing is stored yet, and caches it', async () => {
  const state = makeFakeState();
  const room = new ApsRoom(state, {});
  const first = await room.loadRoomState();
  assert.deepEqual(first, { projects: {} });
  await room.loadRoomState();
  const callsAfterFirst = state._getCalls;
  await room.loadRoomState();
  assert.equal(state._getCalls, callsAfterFirst, 'later calls should use the cached value, not re-read storage');
});

test('persist writes the current roomState to storage (per-item layout)', async () => {
  const state = makeFakeState();
  const room = new ApsRoom(state, {});
  await room.loadRoomState();
  const prev = room.roomState;
  room.roomState = { projects: { p1: { name: 'Test', jobs: { j1: { id: 'j1' } } } } };
  await room.persist(prev);
  assert.deepEqual(await storedRoom(state), { projects: { p1: { name: 'Test', jobs: { j1: { id: 'j1' } }, boardCards: {}, calendarEvents: {} } } });
  assert.deepEqual(state._store.get('p|p1|j|j1'), { id: 'j1' }, 'each job is its own storage entry');
  assert.equal(state._store.get('room'), undefined, 'nothing is written to the old single-value key');
});

// ── broadcastPresence ──

test('broadcastPresence excludes stale entries and sends the live roster to everyone', () => {
  const fresh = makeFakeWs({ username: 'alice', displayName: 'Alice', lastSeen: Date.now() });
  const stale = makeFakeWs({ username: 'bob', displayName: 'Bob', lastSeen: Date.now() - 200 * 1000 });
  const state = makeFakeState([fresh, stale]);
  const room = new ApsRoom(state, {});
  room.broadcastPresence();

  const payloadFresh = fresh._sent[0];
  assert.equal(payloadFresh.type, 'presence');
  assert.deepEqual(payloadFresh.users.map(u => u.username), ['alice']);
  // Broadcast goes to every socket, including the stale one being pruned FROM the list.
  assert.deepEqual(stale._sent[0].users.map(u => u.username), ['alice']);
});

// ── webSocketMessage: authorization gates ──

test('webSocketMessage rejects a message below the required tier without persisting or broadcasting', async () => {
  const viewerWs = makeFakeWs({ username: 'v', role: 'viewer', assignedProjectId: null });
  const state = makeFakeState([viewerWs]);
  const room = new ApsRoom(state, {});

  await room.webSocketMessage(viewerWs, JSON.stringify({ type: 'upsertJob', projectId: 'p1', job: { id: 'job-1' }, msgId: 1 }));

  const response = viewerWs._sent[0];
  assert.equal(response.type, 'error');
  assert.match(response.message, /Forbidden: requires editor/);
  assert.deepEqual(await storedRoom(state), { projects: {} }, 'a rejected message must not persist anything');
});

test('webSocketMessage rejects a write outside a restricted account\'s assigned project', async () => {
  const restrictedWs = makeFakeWs({ username: 'e', role: 'editor', assignedProjectId: 'p1' });
  const state = makeFakeState([restrictedWs]);
  const room = new ApsRoom(state, {});

  await room.webSocketMessage(restrictedWs, JSON.stringify({ type: 'upsertJob', projectId: 'p2', job: { id: 'job-1' }, msgId: 2 }));

  const response = restrictedWs._sent[0];
  assert.equal(response.type, 'error');
  assert.match(response.message, /outside your assigned project/);
});

test('an admin bypasses project scoping even with a stale assignedProjectId', async () => {
  const adminWs = makeFakeWs({ username: 'a', role: 'admin', assignedProjectId: 'p1' });
  const state = makeFakeState([adminWs]);
  const room = new ApsRoom(state, {});

  await room.webSocketMessage(adminWs, JSON.stringify({ type: 'upsertJob', projectId: 'p2', job: { id: 'job-1', updatedAt: 1 }, msgId: 3 }));

  const ack = adminWs._sent.find(m => m.type === 'ack');
  assert.ok(ack, 'a valid cross-project admin write should be accepted and acked');
  assert.equal(ack.msgId, 3);
});

// ── webSocketMessage: a valid write persists and broadcasts to every connection ──

test('a valid, authorized write persists to storage and broadcasts a scoped snapshot to all connections', async () => {
  const writerWs = makeFakeWs({ username: 'e', role: 'editor', assignedProjectId: null });
  const observerWs = makeFakeWs({ username: 'o', role: 'viewer', assignedProjectId: null });
  const state = makeFakeState([writerWs, observerWs]);
  const room = new ApsRoom(state, {});

  await room.webSocketMessage(writerWs, JSON.stringify({
    type: 'upsertJob', projectId: 'p1', job: { id: 'job-1', updatedAt: 1 }, msgId: 5
  }));

  assert.ok((await storedRoom(state)).projects.p1.jobs['job-1'], 'the write should have persisted');
  const observerSnapshot = observerWs._sent.find(m => m.type === 'snapshot');
  assert.ok(observerSnapshot, 'every connection, not just the writer, should receive the new snapshot');
  assert.ok(observerSnapshot.projects.p1.jobs['job-1']);
});

// ── webSocketMessage: a failed persist must not ack (the ack-before-
// persist bug — the client treats an ack as "durably saved" and clears
// its own retry tracking the moment one arrives) ──

test('webSocketMessage sends an error, not an ack, when storage.put() fails, and rolls back in-memory state', async () => {
  const writerWs = makeFakeWs({ username: 'e', role: 'editor', assignedProjectId: null });
  const state = makeFakeState([writerWs], { putFails: true });
  const room = new ApsRoom(state, {});
  room.roomState = { projects: {} };
  const previousState = room.roomState;

  await room.webSocketMessage(writerWs, JSON.stringify({
    type: 'upsertJob', projectId: 'p1', job: { id: 'job-1', updatedAt: 1 }, msgId: 7
  }));

  assert.equal(writerWs._sent.find(m => m.type === 'ack'), undefined, 'must not ack a write that was never durably saved');
  const errorMsg = writerWs._sent.find(m => m.type === 'error');
  assert.ok(errorMsg, 'the client should be told the save failed so its own retry logic can act');
  assert.equal(errorMsg.msgId, 7);
  assert.equal(room.roomState, previousState, 'in-memory roomState must roll back to match what is actually on disk');
});

test('webSocketMessage acks only after persist() actually succeeds', async () => {
  const writerWs = makeFakeWs({ username: 'e', role: 'editor', assignedProjectId: null });
  const state = makeFakeState([writerWs]);
  const room = new ApsRoom(state, {});

  await room.webSocketMessage(writerWs, JSON.stringify({
    type: 'upsertJob', projectId: 'p1', job: { id: 'job-1', updatedAt: 1 }, msgId: 8
  }));

  const ack = writerWs._sent.find(m => m.type === 'ack');
  assert.ok(ack, 'a successful, durably-persisted write should still be acked');
  assert.ok((await storedRoom(state)).projects.p1.jobs['job-1'], 'the write must actually be in storage by the time the ack is sent');
});

// ── fetch(): /internal/kick-user ──

test('fetch /internal/kick-user closes only the sockets matching the target username', async () => {
  const target = makeFakeWs({ username: 'bob' });
  const other = makeFakeWs({ username: 'alice' });
  const state = makeFakeState([target, other]);
  const room = new ApsRoom(state, {});

  const res = await room.fetch(new Request('https://internal/internal/kick-user?username=bob', { method: 'POST' }));
  const body = await res.json();

  assert.equal(body.kicked, 1);
  assert.ok(target._closed, 'the matching socket should be closed');
  assert.equal(other._closed, null, 'a non-matching socket should be left alone');
});

// ── fetch(): /internal/export and /internal/import round trip ──

test('fetch /internal/export then /internal/import round-trips the room state', async () => {
  const state = makeFakeState();
  const room = new ApsRoom(state, {});
  room.roomState = { projects: { p1: { name: 'Original' } } };

  const exportRes = await room.fetch(new Request('https://internal/internal/export'));
  const exported = await exportRes.json();
  assert.deepEqual(exported, { projects: { p1: { name: 'Original' } } });

  const importRes = await room.fetch(new Request('https://internal/internal/import', {
    method: 'POST', body: JSON.stringify({ projects: { p2: { name: 'Imported' } } })
  }));
  const importBody = await importRes.json();
  assert.equal(importBody.success, true);
  assert.deepEqual(room.roomState, { projects: { p2: { name: 'Imported' } } });
});

test('fetch /internal/import returns 500 and rolls back roomState when storage.put() fails', async () => {
  const state = makeFakeState([], { putFails: true });
  const room = new ApsRoom(state, {});
  room.roomState = { projects: { p1: { name: 'Original' } } };
  const previousState = room.roomState;

  const res = await room.fetch(new Request('https://internal/internal/import', {
    method: 'POST', body: JSON.stringify({ projects: { p2: { name: 'Imported' } } })
  }));

  assert.equal(res.status, 500);
  assert.equal(room.roomState, previousState, 'a failed restore must not leave the in-memory state pointing at data that was never saved');
});

test('fetch /internal/import rejects a body that is not { projects: {...} }', async () => {
  const state = makeFakeState();
  const room = new ApsRoom(state, {});
  const res = await room.fetch(new Request('https://internal/internal/import', {
    method: 'POST', body: JSON.stringify({ notProjects: true })
  }));
  assert.equal(res.status, 400);
});

// ── Projects (roadmap A1): only an admin can add one ──

test('a non-admin cannot start a new project once the room has projects; an admin can', async () => {
  const editorWs = makeFakeWs({ username: 'e', role: 'editor', assignedProjectId: null });
  const adminWs = makeFakeWs({ username: 'a', role: 'admin', assignedProjectId: null });
  const state = makeFakeState([editorWs, adminWs]);
  const room = new ApsRoom(state, {});
  await room.webSocketMessage(editorWs, JSON.stringify({ type: 'upsertJob', projectId: 'p1', job: { id: 'job-1', updatedAt: 1 }, msgId: 1 }));
  assert.ok((await storedRoom(state)).projects.p1, 'the very first project of an empty room can still be made');

  await room.webSocketMessage(editorWs, JSON.stringify({ type: 'upsertJob', projectId: 'p2', job: { id: 'job-2', updatedAt: 1 }, msgId: 2 }));
  assert.match(editorWs._sent.find(m => m.msgId === 2).message, /only an admin can add a project/);
  assert.equal((await storedRoom(state)).projects.p2, undefined);

  await room.webSocketMessage(adminWs, JSON.stringify({ type: 'upsertProjectBatch', projectId: 'p2', name: 'Third Co', jobs: [], boardCards: [], calendarEvents: [], header: { title: 'Third Co', subtitle: '', theme: '#3949ab' }, msgId: 3 }));
  assert.equal((await storedRoom(state)).projects.p2.name, 'Third Co');
});
