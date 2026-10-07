const { test, expect } = require('@playwright/test');
const { APP_URL, seedSession, mockRoomWebSocket, addSecondProject } = require('./helpers');

// Job Manager's phase/sub-phase editing, autosave, and linked-job UI
// (src/views/job-form.ts). Two real, already-fixed production bugs live
// in this code (documented in its own comments) — the autosave
// regression pin below locks in the fix for one of them.

test('REGRESSION PIN: an unphased job\'s task dates actually save via autosave (the historical targetPhase bug)', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  // Pick an unphased job (job.phases is empty/undefined) — the bug only
  // manifested for these, since getJobPhases()'s synthetic wrapper always
  // looked "truthy" even though writing to it went nowhere.
  const jobId = await page.evaluate(() => jobs.find((j) => !j.phases || !j.phases.length).id);
  await page.evaluate((id) => editJob(id), jobId);
  await expect(page.locator('#formArea')).toHaveClass(/open/);

  const row = page.locator('#taskRows .task-fixed-row[data-index="0"]');
  await row.locator('.task-fixed-start').fill('2027-03-01');
  await row.locator('.task-fixed-finish').fill('2027-03-10');
  await page.evaluate(() => flushAutoSaveJobForm());

  const savedTask = await page.evaluate((id) => findJob(id).job.tasks[0], jobId);
  expect(savedTask.start).toBe('2027-03-01');
  expect(savedTask.finish).toBe('2027-03-10');
});

test('autoSaveJobForm: a half-set date pair (only start, no finish) is rejected with a warning and falls back to the grid\'s last-rendered dates', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  // A seeded job (real start/finish dates on its first task) rather than a
  // freshly-blank one — the fallback on a bad edit is whatever the grid was
  // last RENDERED with (currentGridTasks, set by renderFixedTaskGrid()),
  // not whatever was most recently autosaved without a re-render in
  // between, so the "known good" value to fall back to has to already be
  // on screen from the initial editJob() render.
  const jobId = await page.evaluate(() => jobs[0].id);
  await page.evaluate((id) => editJob(id), jobId);

  const row = page.locator('#taskRows .task-fixed-row[data-index="0"]');
  // Give the row real, known dates first, via a real flush + re-render
  // (selectJobPhase()/editJob() re-invoke renderFixedTaskGrid(), which is
  // what actually updates currentGridTasks — a plain flush alone does not).
  await row.locator('.task-fixed-start').fill('2027-04-01');
  await row.locator('.task-fixed-finish').fill('2027-04-05');
  await page.evaluate(() => flushAutoSaveJobForm());
  await page.evaluate((id) => editJob(id), jobId); // re-render so currentGridTasks picks up the save
  const originalStart = await row.locator('.task-fixed-start').inputValue();
  const originalFinish = await row.locator('.task-fixed-finish').inputValue();
  expect(originalStart).toBe('2027-04-01');
  expect(originalFinish).toBe('2027-04-05');

  // Half-set it — clear finish only, leaving start as-is.
  await row.locator('.task-fixed-finish').fill('');
  await page.evaluate(() => flushAutoSaveJobForm());

  await expect(page.locator('#taskRowsWarning')).toBeVisible();
  const savedTask = await page.evaluate((id) => findJob(id).job.tasks[0], jobId);
  // The bad row keeps the grid's last-rendered pair rather than saving the
  // half-set value.
  expect(savedTask.start).toBe(originalStart);
  expect(savedTask.finish).toBe(originalFinish);
});

test('autoSaveJobForm: an existing job\'s name is never blanked, even if the field is cleared and saved', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const jobId = await page.evaluate(() => jobs[0].id);
  const originalName = await page.evaluate((id) => findJob(id).job.name, jobId);
  await page.evaluate((id) => editJob(id), jobId);

  await page.locator('#f_job').fill('');
  await page.evaluate(() => flushAutoSaveJobForm());

  // Note: the name-required hint (#f_job_hint) is only shown for a brand-
  // new draft (isNewDraft && !name) — for an EXISTING job, setJobNameHint(false)
  // runs unconditionally once past that check, so clearing an existing
  // job's name shows no hint at all, even though the name itself is (correctly)
  // preserved rather than blanked. That's a real mismatch against this
  // function's own top-of-file comment ("clearing the field just shows a
  // hint") — pre-existing in index.html before this extraction, not
  // introduced by it; pinned here as actual behavior, not filed as a fix.
  const nameAfter = await page.evaluate((id) => findJob(id).job.name, jobId);
  expect(nameAfter).toBe(originalName);
  await expect(page.locator('#f_job_hint')).not.toBeVisible();
});

test('phase CRUD: split into phases, add a second phase, rename it, then delete it (multi-phase path) and finally un-split back to unphased', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const jobId = await page.evaluate(() => jobs.find((j) => !j.phases || !j.phases.length).id);
  await page.evaluate((id) => editJob(id), jobId);

  page.once('dialog', (d) => d.accept('Phase A'));
  await page.evaluate(() => splitJobIntoPhasesUI());
  let job = await page.evaluate((id) => findJob(id).job, jobId);
  expect(job.phases).toHaveLength(1);
  expect(job.phases[0].name).toBe('Phase A');

  page.once('dialog', (d) => d.accept('Phase B'));
  await page.evaluate(() => addJobPhaseUI());
  job = await page.evaluate((id) => findJob(id).job, jobId);
  expect(job.phases).toHaveLength(2);
  const phaseBId = job.phases[1].id;

  page.once('dialog', (d) => d.accept('Phase B Renamed'));
  await page.evaluate((id) => renameJobPhaseUI(id), phaseBId);
  job = await page.evaluate((id) => findJob(id).job, jobId);
  expect(job.phases[1].name).toBe('Phase B Renamed');

  // Multi-phase delete: a plain confirm(), no name-loss risk since Phase A remains.
  page.once('dialog', (d) => d.accept());
  await page.evaluate((id) => deleteJobPhaseUI(id), phaseBId);
  job = await page.evaluate((id) => findJob(id).job, jobId);
  expect(job.phases).toHaveLength(1);
  expect(job.phases[0].name).toBe('Phase A');

  // Deleting the last remaining phase un-splits the job back to unphased.
  page.once('dialog', (d) => d.accept());
  await page.evaluate((id) => deleteJobPhaseUI(id), job.phases[0].id);
  job = await page.evaluate((id) => findJob(id).job, jobId);
  expect(job.phases).toEqual([]);
});

test('sub-phase CRUD: split a phase into sub-phases, add a second, rename, delete (multi path), then un-split back to un-sub-phased', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const jobId = await page.evaluate(() => jobs.find((j) => !j.phases || !j.phases.length).id);
  await page.evaluate((id) => editJob(id), jobId);
  page.once('dialog', (d) => d.accept('Only Phase'));
  await page.evaluate(() => splitJobIntoPhasesUI());
  const phaseId = await page.evaluate((id) => findJob(id).job.phases[0].id, jobId);

  page.once('dialog', (d) => d.accept('Sub A'));
  await page.evaluate(() => splitPhaseIntoSubPhasesUI());
  let phase = await page.evaluate((id) => findJob(id).job.phases[0], jobId);
  expect(phase.subPhases).toHaveLength(1);
  expect(phase.subPhases[0].name).toBe('Sub A');

  page.once('dialog', (d) => d.accept('Sub B'));
  await page.evaluate(() => addPhaseSubUnitUI());
  phase = await page.evaluate((id) => findJob(id).job.phases[0], jobId);
  expect(phase.subPhases).toHaveLength(2);
  const subBId = phase.subPhases[1].id;

  page.once('dialog', (d) => d.accept('Sub B Renamed'));
  await page.evaluate((id) => renameSubPhaseUI(id), subBId);
  phase = await page.evaluate((id) => findJob(id).job.phases[0], jobId);
  expect(phase.subPhases[1].name).toBe('Sub B Renamed');

  page.once('dialog', (d) => d.accept());
  await page.evaluate((id) => deleteSubPhaseUI(id), subBId);
  phase = await page.evaluate((id) => findJob(id).job.phases[0], jobId);
  expect(phase.subPhases).toHaveLength(1);

  page.once('dialog', (d) => d.accept());
  await page.evaluate((id) => deleteSubPhaseUI(id), phase.subPhases[0].id);
  phase = await page.evaluate((id) => findJob(id).job.phases[0], jobId);
  expect(phase.subPhases).toEqual([]);
});

test('phase switching: editing phase A\'s dates and switching to phase B does not bleed A\'s dates into B, and each keeps its own on return', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const jobId = await page.evaluate(() => jobs.find((j) => !j.phases || !j.phases.length).id);
  await page.evaluate((id) => editJob(id), jobId);
  page.once('dialog', (d) => d.accept('Phase A'));
  await page.evaluate(() => splitJobIntoPhasesUI());
  page.once('dialog', (d) => d.accept('Phase B'));
  await page.evaluate(() => addJobPhaseUI());
  const phaseIds = await page.evaluate((id) => findJob(id).job.phases.map((p) => p.id), jobId);

  // On Phase B already (addJobPhaseUI selects the new phase) — set its dates.
  let row = page.locator('#taskRows .task-fixed-row[data-index="0"]');
  await row.locator('.task-fixed-start').fill('2027-06-01');
  await row.locator('.task-fixed-finish').fill('2027-06-05');
  await page.evaluate(() => flushAutoSaveJobForm());

  // Switch to Phase A and give it different dates.
  await page.evaluate((id) => selectJobPhase(id), phaseIds[0]);
  row = page.locator('#taskRows .task-fixed-row[data-index="0"]');
  await row.locator('.task-fixed-start').fill('2027-01-01');
  await row.locator('.task-fixed-finish').fill('2027-01-05');
  await page.evaluate(() => flushAutoSaveJobForm());

  const job = await page.evaluate((id) => findJob(id).job, jobId);
  const phaseA = job.phases.find((p) => p.id === phaseIds[0]);
  const phaseB = job.phases.find((p) => p.id === phaseIds[1]);
  expect(phaseA.tasks[0].start).toBe('2027-01-01');
  expect(phaseA.tasks[0].finish).toBe('2027-01-05');
  expect(phaseB.tasks[0].start).toBe('2027-06-01');
  expect(phaseB.tasks[0].finish).toBe('2027-06-05');
});

test('linked job UI: opening the picker, linking to a job in the other project, toggling the local-only switch, and unlinking all work via the real UI', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await addSecondProject(page);

  const setup = await page.evaluate(() => {
    const [myId, otherId] = Object.keys(projects);
    return { myId, otherId, myJobId: projects[myId].jobs[0].id, otherJobName: projects[otherId].jobs[0].name };
  });

  await page.evaluate((id) => editJob(id), setup.myJobId);
  await expect(page.locator('#jobLinkBody')).toContainText('Link to');

  await page.evaluate(() => openJobLinkPickerUI());
  await expect(page.locator('#jobLinkPickerSelect')).toBeVisible();
  await page.locator('#jobLinkPickerSelect').selectOption({ label: setup.otherJobName });
  await page.evaluate((otherId) => confirmJobLinkUI(otherId), setup.otherId);

  await expect(page.locator('#jobLinkBody')).toContainText(setup.otherJobName);
  let job = await page.evaluate((id) => findJob(id).job, setup.myJobId);
  expect(job.link).toBeTruthy();
  expect(job.link.projectId).toBe(setup.otherId);

  // Toggling is local-only (isLinkEnabledLocally), not a shared field.
  let enabled = await page.evaluate((id) => isLinkEnabledLocally(id), setup.myJobId);
  expect(enabled).toBe(false);
  await page.evaluate(() => toggleJobLinkEnabledUI());
  enabled = await page.evaluate((id) => isLinkEnabledLocally(id), setup.myJobId);
  expect(enabled).toBe(true);

  page.once('dialog', (d) => d.accept());
  await page.evaluate(() => unlinkJobUI());
  job = await page.evaluate((id) => findJob(id).job, setup.myJobId);
  expect(job.link).toBeFalsy();
  await expect(page.locator('#jobLinkBody')).toContainText('Link to');
});

test('addNewJob/cancelEdit: opening a blank draft and cancelling without typing a name leaves no trace', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const countBefore = await page.evaluate(() => jobs.length);
  await page.evaluate(() => addNewJob());
  await expect(page.locator('#formArea')).toHaveClass(/open/);
  await page.evaluate(() => cancelEdit());
  await expect(page.locator('#formArea')).not.toHaveClass(/open/);

  const countAfter = await page.evaluate(() => jobs.length);
  expect(countAfter).toBe(countBefore);
});

test('refreshJobFormIfOpen: an external change to the open job\'s tasks (e.g. a Gantt bar drag) re-renders the grid in place', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const jobId = await page.evaluate(() => jobs.find((j) => !j.phases || !j.phases.length).id);
  await page.evaluate((id) => editJob(id), jobId);

  await page.evaluate((id) => {
    const job = findJob(id).job;
    job.tasks[0].start = '2027-09-01';
    job.tasks[0].finish = '2027-09-15';
    refreshJobFormIfOpen(id);
  }, jobId);

  const row = page.locator('#taskRows .task-fixed-row[data-index="0"]');
  await expect(row.locator('.task-fixed-start')).toHaveValue('2027-09-01');
  await expect(row.locator('.task-fixed-finish')).toHaveValue('2027-09-15');
});
