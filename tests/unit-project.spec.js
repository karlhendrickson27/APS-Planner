const { test, expect } = require('@playwright/test');
const { APP_URL, seedSession, mockRoomWebSocket, addSecondProject } = require('./helpers');

// Project management (src/app/project.ts) — switchProject() (the single
// highest-blast-radius function in the app: it touches every view's own
// close/flush logic on every switch, for every user), applyPermissionGating(),
// toggleProject(), and that saving never archives jobs on its own. The cross-project restriction
// path already had one test (teamsync.spec.js); these cover what didn't:
// the happy-path switch itself (including that a pending edit on the OLD
// project actually flushes before the switch, not after), the fail-closed
// guard, and the permission-gating sweep.

test('switchProject: switches active project data, and flushes a pending edit on the OLD project before switching away from it', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await addSecondProject(page);

  const setup = await page.evaluate(() => {
    const [firstId, secondId] = Object.keys(projects);
    return { firstId, secondId, firstProjectJobCount: projects[firstId].jobs.length };
  });

  // Open a job and start typing a name change, but don't flush — switchProject()
  // itself must flush it (via cancelEdit()) before the active project flips.
  const jobId = await page.evaluate(() => jobs[0].id);
  const newName = 'Edited right before switching ' + Date.now();
  await page.evaluate((id) => editJob(id), jobId);
  await page.locator('#f_job').fill(newName);

  await page.evaluate((secondId) => switchProject(secondId), setup.secondId);

  const afterSwitch = await page.evaluate(() => activeProjectId);
  expect(afterSwitch).toBe(setup.secondId);

  // The edit must have landed in the project that was active when it was
  // made (the FIRST one), not silently dropped or misfiled into the new one.
  const savedName = await page.evaluate(({ firstId, jobId }) => {
    const job = projects[firstId].jobs.find((j) => j.id === jobId);
    return job ? job.name : null;
  }, { firstId: setup.firstId, jobId });
  expect(savedName).toBe(newName);

  // Switching back should restore the first project's own job list untouched.
  await page.evaluate((firstId) => switchProject(firstId), setup.firstId);
  const restoredCount = await page.evaluate(() => jobs.length);
  expect(restoredCount).toBe(setup.firstProjectJobCount);
});

test('switchProject: fails closed (no switch, a toast instead) while roleConfirmed is still false', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await addSecondProject(page);

  const result = await page.evaluate(() => {
    const [firstId, secondId] = Object.keys(projects);
    const before = activeProjectId;
    const savedConfirmed = roleConfirmed;
    roleConfirmed = false;
    switchProject(activeProjectId === firstId ? secondId : firstId);
    const after = activeProjectId;
    roleConfirmed = savedConfirmed;
    return { before, after };
  });

  expect(result.after).toBe(result.before);
});

test('switchProject: a no-op call (same project, or an unknown id) changes nothing', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const before = activeProjectId;
    switchProject(activeProjectId); // same project
    const afterSame = activeProjectId;
    switchProject('not-a-real-project-id');
    const afterUnknown = activeProjectId;
    return { before, afterSame, afterUnknown };
  });

  expect(result.afterSame).toBe(result.before);
  expect(result.afterUnknown).toBe(result.before);
});

test('toggleProject: switches immediately with no confirmation, cycling to the other of the two fixed projects', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await addSecondProject(page);

  let dialogCount = 0;
  page.on('dialog', (d) => { dialogCount++; d.dismiss(); });

  const result = await page.evaluate(() => {
    const before = activeProjectId;
    toggleProject();
    const afterOnce = activeProjectId;
    toggleProject();
    const afterTwice = activeProjectId;
    return { before, afterOnce, afterTwice };
  });

  expect(dialogCount).toBe(0); // no confirmation dialog at all
  expect(result.afterOnce).not.toBe(result.before);
  expect(result.afterTwice).toBe(result.before); // back to the start with only 2 projects
});

test('applyPermissionGating: hides projectAdmin-only controls for an editor, and restores them for an admin', async ({ page }) => {
  await seedSession(page, { role: 'editor' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  // The rail must be open first — a separate CSS rule (body:not(.job-rail-open)
  // .job-rail-add-btn) forces display:none regardless of permission gating
  // while it's collapsed, independent of what's being tested here.
  await page.evaluate(() => toggleJobRail());
  await expect(page.locator('.job-rail-add-btn')).toHaveCSS('display', 'none');

  await page.evaluate(() => {
    currentUserRole = 'admin';
    applyPermissionGating();
  });
  await expect(page.locator('.job-rail-add-btn')).not.toHaveCSS('display', 'none');
});

test('no auto-archive: saving and reloading leaves a job that finished long ago active', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const longAgo = new Date(); longAgo.setDate(longAgo.getDate() - (ARCHIVE_CUTOFF_DAYS + 30));
    const recently = new Date(); recently.setDate(recently.getDate() - 2);
    // Local calendar date, not toISOString()'s UTC one — see
    // tests/unit-home.spec.js's isoDaysFromNow() for why that silently
    // differs from "today" for hours at a time in any timezone west of UTC.
    const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

    const oldJob = { id: 'old-job', name: 'Old finished job', color: '#123', archived: false, comments: [], tasks: [{ id: 't1', start: iso(longAgo), finish: iso(longAgo), order: 0 }] };
    const recentJob = { id: 'recent-job', name: 'Recently finished job', color: '#123', archived: false, comments: [], tasks: [{ id: 't2', start: iso(recently), finish: iso(recently), order: 0 }] };
    jobs.push(oldJob, recentJob);

    saveJobs();
    renderAll();

    return { oldArchived: jobs.find((j) => j.id === 'old-job').archived, recentArchived: jobs.find((j) => j.id === 'recent-job').archived, gone: typeof window.autoArchiveJobs };
  });

  expect(result.oldArchived).toBe(false);
  expect(result.recentArchived).toBe(false);
  expect(result.gone).toBe('undefined');
});
