// Unit tests for the pure room-state reducer. Node's built-in test runner,
// no new dependency — run with:
//   node --test worker/src/room-state.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPlainObject, isArrayIfPresent, isPlainObjectIfPresent,
  isArrayOfPlainObjectsIfPresent, isChecklistsShapeIfPresent,
  isSafeIdString, isSafeIdValue, isSafeColorIfPresent, hasSafeNestedTaskPhaseFields,
  ensureProject, blankProject, emptyRoomState,
  handleUpsertJob, handleUpsertCard, handleUpsertCalendarEvent,
  handleUpsertProjectBatch, handleSetWholeField,
  applyMessage, removeProject
} from './room-state.ts';

function freshProject() {
  return blankProject('Test Project');
}

// ── isPlainObject / isArrayIfPresent / isPlainObjectIfPresent ──

test('isPlainObject rejects arrays and null, accepts plain objects', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject('x'), false);
});

test('isArrayIfPresent/isPlainObjectIfPresent accept an absent (undefined) value', () => {
  assert.equal(isArrayIfPresent(undefined), true);
  assert.equal(isPlainObjectIfPresent(undefined), true);
});

// ── isArrayOfPlainObjectsIfPresent / isChecklistsShapeIfPresent (new — deepened shape guards) ──

test('isArrayOfPlainObjectsIfPresent accepts absent, [], and an array of plain objects', () => {
  assert.equal(isArrayOfPlainObjectsIfPresent(undefined), true);
  assert.equal(isArrayOfPlainObjectsIfPresent([]), true);
  assert.equal(isArrayOfPlainObjectsIfPresent([{ id: 't1' }, { id: 't2' }]), true);
});

test('isArrayOfPlainObjectsIfPresent rejects a non-array, and an array containing a null/primitive element', () => {
  assert.equal(isArrayOfPlainObjectsIfPresent('oops'), false);
  assert.equal(isArrayOfPlainObjectsIfPresent([{ id: 't1' }, null]), false);
  assert.equal(isArrayOfPlainObjectsIfPresent([{ id: 't1' }, 'oops']), false);
  assert.equal(isArrayOfPlainObjectsIfPresent([{ id: 't1' }, ['nested-array']]), false);
});

test('isChecklistsShapeIfPresent accepts absent, {}, and per-column arrays of plain objects', () => {
  assert.equal(isChecklistsShapeIfPresent(undefined), true);
  assert.equal(isChecklistsShapeIfPresent({}), true);
  assert.equal(isChecklistsShapeIfPresent({ done: [{ id: 'i1' }], inProgress: [] }), true);
});

test('isChecklistsShapeIfPresent rejects a non-object, and a per-column value that is not an array of plain objects', () => {
  assert.equal(isChecklistsShapeIfPresent('oops'), false);
  assert.equal(isChecklistsShapeIfPresent([]), false);
  assert.equal(isChecklistsShapeIfPresent({ done: 'oops' }), false);
  assert.equal(isChecklistsShapeIfPresent({ done: [{ id: 'i1' }, null] }), false);
});

// ── isSafeIdString / isSafeIdValue / isSafeColorIfPresent / hasSafeNestedTaskPhaseFields (stored-XSS guard) ──

test('isSafeIdString accepts a real crypto.randomUUID() and the id-<base36>-<base36> fallback shape', () => {
  assert.equal(isSafeIdString('3fa85f64-5717-4562-b3fc-2c963f66afa6'), true);
  assert.equal(isSafeIdString('id-l3k2j1-9f8e7d6c'), true);
});

test('isSafeIdString rejects anything that could break out of an HTML attribute or a JS string literal', () => {
  assert.equal(isSafeIdString('x" onmouseover="alert(1)'), false);
  assert.equal(isSafeIdString("x' onclick='alert(1)"), false);
  assert.equal(isSafeIdString('<img src=x onerror=alert(1)>'), false);
  assert.equal(isSafeIdString(''), false);
  assert.equal(isSafeIdString(undefined), false);
  assert.equal(isSafeIdString(123), false);
  assert.equal(isSafeIdString('a'.repeat(201)), false);
});

test('isSafeIdValue accepts a finite number (inherently safe once stringified) in addition to a safe id string', () => {
  assert.equal(isSafeIdValue(42), true);
  assert.equal(isSafeIdValue(NaN), false);
  assert.equal(isSafeIdValue('card-1'), true);
  assert.equal(isSafeIdValue('x" onmouseover="alert(1)'), false);
});

test('isSafeColorIfPresent accepts absent/null/empty and a lowercase #rrggbb, rejects anything else', () => {
  assert.equal(isSafeColorIfPresent(undefined), true);
  assert.equal(isSafeColorIfPresent(null), true);
  assert.equal(isSafeColorIfPresent(''), true);
  assert.equal(isSafeColorIfPresent('#3949ab'), true);
  assert.equal(isSafeColorIfPresent('#ABCDEF'), true);
  assert.equal(isSafeColorIfPresent('red'), false);
  assert.equal(isSafeColorIfPresent('#fff'), false);
  assert.equal(isSafeColorIfPresent('red;"><img src=x onerror=alert(1)>'), false);
});

test('hasSafeNestedTaskPhaseFields rejects an unsafe id/color on a nested task or phase, accepts well-formed ones', () => {
  assert.equal(hasSafeNestedTaskPhaseFields({ id: 'j1', tasks: [{ id: 't1', color: '#112233' }] }), true);
  assert.equal(hasSafeNestedTaskPhaseFields({ id: 'j1', tasks: [{ id: 'x" onmouseover="alert(1)' }] }), false);
  assert.equal(hasSafeNestedTaskPhaseFields({ id: 'j1', phases: [{ id: 'p1', color: 'red' }] }), false);
  assert.equal(hasSafeNestedTaskPhaseFields({ id: 'j1' }), true);
});

// ── handleUpsertJob ──

test('handleUpsertJob rejects a job whose tasks is not an array', () => {
  const result = handleUpsertJob(freshProject(), { job: { id: 'job-1', tasks: 'oops' } });
  assert.equal(result.changed, false);
  assert.ok(result.error);
});

test('handleUpsertJob accepts a job with tasks absent entirely', () => {
  const result = handleUpsertJob(freshProject(), { job: { id: 'job-1' } });
  assert.equal(result.changed, true);
});

test('handleUpsertJob accepts a job with correctly-typed tasks: []', () => {
  const result = handleUpsertJob(freshProject(), { job: { id: 'job-1', tasks: [] } });
  assert.equal(result.changed, true);
  assert.deepEqual(result.project.jobs['job-1'].tasks, []);
});

test('handleUpsertJob rejects a job whose tasks array contains a null element (would crash rendering downstream)', () => {
  const result = handleUpsertJob(freshProject(), { job: { id: 'job-1', tasks: [{ id: 't1' }, null] } });
  assert.equal(result.changed, false);
  assert.ok(result.error);
});

test('handleUpsertJob rejects a job whose phases array contains a non-object element', () => {
  const result = handleUpsertJob(freshProject(), { job: { id: 'job-1', phases: ['oops'] } });
  assert.equal(result.changed, false);
  assert.ok(result.error);
});

test('handleUpsertJob accepts a job with well-formed tasks/phases objects', () => {
  const result = handleUpsertJob(freshProject(), {
    job: { id: 'job-1', tasks: [{ id: 't1', start: '2026-01-01' }], phases: [{ id: 'p1' }] }
  });
  assert.equal(result.changed, true);
});

test('handleUpsertJob rejects a job.id that would break out of an HTML attribute (stored-XSS guard)', () => {
  const result = handleUpsertJob(freshProject(), { job: { id: 'x" onmouseover="alert(1)' } });
  assert.equal(result.changed, false);
  assert.ok(result.error);
});

test('handleUpsertJob rejects a job.color that is not a #rrggbb hex value (stored-XSS guard)', () => {
  const result = handleUpsertJob(freshProject(), { job: { id: 'job-1', color: 'red;"><img src=x onerror=alert(1)>' } });
  assert.equal(result.changed, false);
  assert.ok(result.error);
});

test('handleUpsertJob rejects an unsafe id/color on a nested task even when the job\'s own id/color are fine', () => {
  const result = handleUpsertJob(freshProject(), {
    job: { id: 'job-1', tasks: [{ id: 't1', color: 'javascript:alert(1)' }] }
  });
  assert.equal(result.changed, false);
  assert.ok(result.error);
});

test('handleUpsertJob accepts a job with a well-formed color and safe nested task/phase ids+colors', () => {
  const result = handleUpsertJob(freshProject(), {
    job: { id: 'job-1', color: '#3949ab', tasks: [{ id: 't1', color: '#eceef4' }], phases: [{ id: 'p1' }] }
  });
  assert.equal(result.changed, true);
});

test('handleUpsertJob staleness rejection is unaffected by the new guard', () => {
  let project = freshProject();
  const first = handleUpsertJob(project, { job: { id: 'job-1', updatedAt: 100 } });
  assert.equal(first.changed, true);
  project = first.project;

  const stale = handleUpsertJob(project, { job: { id: 'job-1', updatedAt: 50 } });
  assert.equal(stale.changed, false);
  assert.equal(stale.rejected, 'stale');
  assert.equal(project.jobs['job-1'].updatedAt, 100);
});

// ── handleUpsertCard ──

test('handleUpsertCard rejects checklists that are an array instead of an object', () => {
  const result = handleUpsertCard(freshProject(), { card: { id: 'card-1', checklists: [] } });
  assert.equal(result.changed, false);
  assert.ok(result.error);
});

test('handleUpsertCard accepts absent/correctly-typed checklists', () => {
  const withoutField = handleUpsertCard(freshProject(), { card: { id: 'card-1' } });
  assert.equal(withoutField.changed, true);

  const withField = handleUpsertCard(freshProject(), { card: { id: 'card-2', checklists: { done: [] } } });
  assert.equal(withField.changed, true);
});

test('handleUpsertCard rejects a checklists column value that is not an array (would crash checklist.ts stored.map())', () => {
  const result = handleUpsertCard(freshProject(), { card: { id: 'card-1', checklists: { done: 'oops' } } });
  assert.equal(result.changed, false);
  assert.ok(result.error);
});

test('handleUpsertCard rejects a checklists column array containing a null item (would crash item.id/item.done reads)', () => {
  const result = handleUpsertCard(freshProject(), { card: { id: 'card-1', checklists: { done: [{ id: 'i1' }, null] } } });
  assert.equal(result.changed, false);
  assert.ok(result.error);
});

test('handleUpsertCard accepts well-formed checklists', () => {
  const result = handleUpsertCard(freshProject(), { card: { id: 'card-1', checklists: { done: [{ id: 'i1', done: false }] } } });
  assert.equal(result.changed, true);
});

test('handleUpsertCard rejects a card.id that would break out of an HTML attribute (stored-XSS guard)', () => {
  const result = handleUpsertCard(freshProject(), { card: { id: "x' onclick='alert(1)" } });
  assert.equal(result.changed, false);
  assert.ok(result.error);
});

test('handleUpsertCard accepts a numeric card.id (inherently safe once stringified)', () => {
  const result = handleUpsertCard(freshProject(), { card: { id: 42 } });
  assert.equal(result.changed, true);
});

test('handleUpsertCard rejects a card.color that is not a #rrggbb hex value (stored-XSS guard)', () => {
  const result = handleUpsertCard(freshProject(), { card: { id: 'card-1', color: 'red' } });
  assert.equal(result.changed, false);
  assert.ok(result.error);
});

test('handleUpsertCard staleness rejection is unaffected by the new guard', () => {
  let project = freshProject();
  const first = handleUpsertCard(project, { card: { id: 'card-1', updatedAt: 100 } });
  assert.equal(first.changed, true);
  project = first.project;

  const stale = handleUpsertCard(project, { card: { id: 'card-1', updatedAt: 50 } });
  assert.equal(stale.changed, false);
  assert.equal(stale.rejected, 'stale');
  assert.equal(project.boardCards['card-1'].updatedAt, 100);
});

// ── handleUpsertCalendarEvent ──

test('handleUpsertCalendarEvent rejects an event.id that would break out of an HTML attribute (stored-XSS guard)', () => {
  const result = handleUpsertCalendarEvent(freshProject(), { event: { id: '<img src=x onerror=alert(1)>' } });
  assert.equal(result.changed, false);
  assert.ok(result.error);
});

test('handleUpsertCalendarEvent rejects an event.color that is not a #rrggbb hex value (stored-XSS guard)', () => {
  const result = handleUpsertCalendarEvent(freshProject(), { event: { id: 'ev-1', color: 'red' } });
  assert.equal(result.changed, false);
  assert.ok(result.error);
});

test('handleUpsertCalendarEvent accepts a well-formed event', () => {
  const result = handleUpsertCalendarEvent(freshProject(), { event: { id: 'ev-1', color: '#7e57c2' } });
  assert.equal(result.changed, true);
});

// ── handleUpsertProjectBatch ──

test('handleUpsertProjectBatch skips one malformed item but still applies a valid sibling', () => {
  const result = handleUpsertProjectBatch(freshProject(), {
    jobs: [
      { id: 'job-good', tasks: [] },
      { id: 'job-bad', tasks: 'oops' }
    ]
  }, null);
  assert.equal(result.changed, true);
  assert.ok(result.project.jobs['job-good']);
  assert.ok(!result.project.jobs['job-bad']);
});

test('handleUpsertProjectBatch skips a job with a null tasks-array element and a card with a malformed checklist, still applies valid siblings', () => {
  const result = handleUpsertProjectBatch(freshProject(), {
    jobs: [
      { id: 'job-good', tasks: [{ id: 't1' }] },
      { id: 'job-bad', tasks: [null] }
    ],
    boardCards: [
      { id: 'card-good', checklists: { done: [{ id: 'i1' }] } },
      { id: 'card-bad', checklists: { done: 'oops' } }
    ]
  }, null);
  assert.equal(result.changed, true);
  assert.ok(result.project.jobs['job-good']);
  assert.ok(!result.project.jobs['job-bad']);
  assert.ok(result.project.boardCards['card-good']);
  assert.ok(!result.project.boardCards['card-bad']);
});

test('handleUpsertProjectBatch skips a job/card/calendarEvent with an unsafe id or color (stored-XSS guard), still applies valid siblings', () => {
  const result = handleUpsertProjectBatch(freshProject(), {
    jobs: [
      { id: 'job-good', color: '#3949ab' },
      { id: 'x" onmouseover="alert(1)' }
    ],
    boardCards: [
      { id: 'card-good' },
      { id: 'card-bad', color: 'red' }
    ],
    calendarEvents: [
      { id: 'ev-good' },
      { id: "ev-bad', onclick='alert(1)" }
    ]
  }, null);
  assert.equal(result.changed, true);
  assert.ok(result.project.jobs['job-good']);
  assert.equal(Object.keys(result.project.jobs).length, 1);
  assert.ok(result.project.boardCards['card-good']);
  assert.equal(Object.keys(result.project.boardCards).length, 1);
  assert.ok(result.project.calendarEvents['ev-good']);
  assert.equal(Object.keys(result.project.calendarEvents).length, 1);
});

// ── handleSetWholeField ──

test('handleSetWholeField rejects a boardColumns/workflowItems item with an unsafe id or color (stored-XSS guard)', () => {
  const badId = handleSetWholeField(freshProject(), { baseFieldRevision: 0, value: [{ id: 'x" onmouseover="alert(1)' }] }, 'boardColumns');
  assert.equal(badId.changed, false);
  assert.ok(badId.error);

  const badColor = handleSetWholeField(freshProject(), { baseFieldRevision: 0, value: [{ id: 'wf1', color: 'red' }] }, 'workflowItems');
  assert.equal(badColor.changed, false);
  assert.ok(badColor.error);
});

test('handleSetWholeField accepts boardColumns/workflowItems items with a well-formed id/color', () => {
  const result = handleSetWholeField(freshProject(), { baseFieldRevision: 0, value: [{ id: 'col-1', color: '#3949ab' }] }, 'boardColumns');
  assert.equal(result.changed, true);
});

test('handleSetWholeField rejects boardColumns when the value is not an array', () => {
  const result = handleSetWholeField(freshProject(), { baseFieldRevision: 0, value: { not: 'an array' } }, 'boardColumns');
  assert.equal(result.changed, false);
  assert.ok(result.error);
});

test('handleSetWholeField rejects fieldOptions when the value is an array', () => {
  const result = handleSetWholeField(freshProject(), { baseFieldRevision: 0, value: [] }, 'fieldOptions');
  assert.equal(result.changed, false);
  assert.ok(result.error);
});

test('handleSetWholeField accepts correctly-typed values for all four guarded field names', () => {
  const project = freshProject();
  const cols = handleSetWholeField(project, { baseFieldRevision: 0, value: [{ id: 'c1' }] }, 'boardColumns');
  assert.equal(cols.changed, true);
  const items = handleSetWholeField(project, { baseFieldRevision: 0, value: [] }, 'workflowItems');
  assert.equal(items.changed, true);
  const opts = handleSetWholeField(project, { baseFieldRevision: 0, value: { pm: [] } }, 'fieldOptions');
  assert.equal(opts.changed, true);
  const header = handleSetWholeField(project, { baseFieldRevision: 0, value: { title: 'x' } }, 'header');
  assert.equal(header.changed, true);
});

// ── ensureProject idempotency (baseline safety net) ──

test('ensureProject does not reset an already-created project', () => {
  const state = { projects: {} };
  const afterCreate = ensureProject(state, 'p1', 'Seed Name');
  afterCreate.projects['p1'].name = 'Renamed Locally';

  const afterSecondCall = ensureProject(afterCreate, 'p1', 'Seed Name');
  assert.equal(afterSecondCall.projects['p1'].name, 'Renamed Locally');
});

// ── applyMessage dispatch table (new — Phase W2) ──

test('applyMessage rejects a malformed message (no type)', () => {
  const result = applyMessage(emptyRoomState(), { projectId: 'p1' });
  assert.equal(result.changed, false);
  assert.ok(result.error);
});

test('applyMessage rejects a message missing projectId', () => {
  const result = applyMessage(emptyRoomState(), { type: 'upsertJob', job: { id: 'job-1' } });
  assert.equal(result.changed, false);
  assert.ok(result.error);
});

test('applyMessage rejects an unrecognized message type', () => {
  const result = applyMessage(emptyRoomState(), { type: 'bogusType', projectId: 'p1' });
  assert.equal(result.changed, false);
  assert.match(result.error, /unknown message type/);
});

test('applyMessage dispatches upsertJob, creating the project on demand and acking with msgId', () => {
  const result = applyMessage(emptyRoomState(), {
    type: 'upsertJob', projectId: 'p1', seedProjectName: 'New Project', msgId: 42,
    job: { id: 'job-1', updatedAt: 100 }
  }, null);
  assert.equal(result.changed, true);
  assert.equal(result.state.projects['p1'].jobs['job-1'].id, 'job-1');
  assert.equal(result.ack.msgId, 42);
});

test('applyMessage renameProject updates the project name and bumps rev', () => {
  const seeded = ensureProject(emptyRoomState(), 'p1', 'Old Name');
  const result = applyMessage(seeded, { type: 'renameProject', projectId: 'p1', name: 'New Name', msgId: 7 });
  assert.equal(result.changed, true);
  assert.equal(result.state.projects['p1'].name, 'New Name');
  assert.equal(result.state.projects['p1'].rev, 1);
});

test('applyMessage removeProject is special-cased ahead of ensureProject (does not fabricate a project first)', () => {
  const seeded = ensureProject(emptyRoomState(), 'p1', 'To Delete');
  const result = applyMessage(seeded, { type: 'removeProject', projectId: 'p1', msgId: 9 });
  assert.equal(result.changed, true);
  assert.equal(result.state.projects['p1'], undefined);
  assert.equal(result.ack.msgId, 9);
});

// ── removeProject (new — Phase W2) ──

test('removeProject deletes an existing project', () => {
  const seeded = ensureProject(emptyRoomState(), 'p1', 'Test');
  const result = removeProject(seeded, 'p1');
  assert.equal(result.changed, true);
  assert.equal(result.state.projects['p1'], undefined);
});

test('removeProject is a no-op for a project that does not exist', () => {
  const state = emptyRoomState();
  const result = removeProject(state, 'nonexistent');
  assert.equal(result.changed, false);
  assert.equal(result.state, state);
});

// ── Project header: logo + archived (roadmap A1) ──

test('isSafeHeader accepts image data URLs, assets paths and empty logos, and rejects anything else', async () => {
  const { isSafeHeader } = await import('./room-state.ts');
  assert.equal(isSafeHeader({ title: 'x' }), true);
  assert.equal(isSafeHeader({ logo: '' }), true);
  assert.equal(isSafeHeader({ logo: 'assets/aps-board-bg.jpg' }), true);
  assert.equal(isSafeHeader({ logo: 'data:image/png;base64,iVBORw0KGgo=' }), true);
  assert.equal(isSafeHeader({ logo: 'data:image/png;base64,abc") ; background:url(x' }), false);
  assert.equal(isSafeHeader({ logo: 'https://evil.example/x.png' }), false);
  assert.equal(isSafeHeader({ logo: 'data:image/svg+xml;base64,PHN2Zz4=' }), false);
  assert.equal(isSafeHeader({ archived: 'yes' }), false);
  assert.equal(isSafeHeader({ archived: true }), true);
});

test('a batch upsert keeps the stored logo and archived flag when its header leaves them out', async () => {
  const { handleUpsertProjectBatch, blankProject } = await import('./room-state.ts');
  const p = blankProject('Co');
  p.header = { title: 'Co', subtitle: '', theme: '#111', logo: 'assets/a.jpg', archived: true };
  const r = handleUpsertProjectBatch(p, { header: { title: 'Co 2', subtitle: '', theme: '#222' } });
  assert.deepEqual(r.project.header, { title: 'Co 2', subtitle: '', theme: '#222', logo: 'assets/a.jpg', archived: true });
  const r2 = handleUpsertProjectBatch(p, { header: { title: 'Co', subtitle: '', theme: '#111', logo: '', archived: false } });
  assert.equal(r2.project.header.logo, '');
  assert.equal(r2.project.header.archived, false);
  const r3 = handleUpsertProjectBatch(p, { header: { title: 'Co', logo: 'javascript:x' } });
  assert.equal(r3.changed, false, 'an unsafe header is ignored');
});
