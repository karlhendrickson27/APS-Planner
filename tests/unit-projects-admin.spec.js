const path = require('path');
const fs = require('fs');
const os = require('os');
const { test, expect } = require('@playwright/test');
const { APP_URL, seedSession, mockRoomWebSocket, addSecondProject } = require('./helpers');

// The Projects window (src/app/projects-admin.ts, roadmap A1): any number of
// projects instead of two fixed ones. The server side (only admins add
// projects; header logo/archived checks) is tested in worker/src.

async function loadAsAdmin(page) {
  await seedSession(page, { role: 'admin' });
  const sent = [];
  await page.routeWebSocket(/\/room\?/, (ws) => {
    ws.send(JSON.stringify({ type: 'snapshot', projects: {} }));
    ws.onMessage((raw) => {
      try {
        const msg = JSON.parse(raw);
        sent.push(msg);
        if (msg.msgId) ws.send(JSON.stringify({ type: 'ack', msgId: msg.msgId }));
      } catch (e) { /* not JSON */ }
    });
  });
  await page.addInitScript(() => localStorage.setItem('gantt_tutorial_state_v1_testadmin', JSON.stringify({ neverShow: true })));
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  return sent;
}

async function openProjects(page) {
  await page.locator('#accountBtn').click();
  await expect(page.locator('#projectToggleLabel')).toHaveText('Projects');
  await page.locator('#projectToggleBtn').click();
  await expect(page.locator('#projectsModal')).toHaveClass(/show/);
}

test('projects: an admin adds a project (copying stages), renames it, archives and restores it', async ({ page }) => {
  const sent = await loadAsAdmin(page);
  const first = await page.evaluate(() => ({ id: activeProjectId, name: getActiveProject().name, columns: BOARD_COLUMNS.map((c) => c.id) }));
  await openProjects(page);
  await expect(page.locator('#projectsList .proj-row')).toHaveCount(1);

  await page.locator('#projectsAddBtn').click();
  await page.locator('#projectsAddName').fill('Cedar Homes');
  await page.locator('#projectsAddCreateBtn').click();
  await expect(page.locator('#projectsModal')).not.toHaveClass(/show/);

  const created = await page.evaluate(() => ({ id: activeProjectId, name: getActiveProject().name, jobs: jobs.length, columns: BOARD_COLUMNS.map((c) => c.id) }));
  expect(created.id).not.toBe(first.id);
  expect(created.name).toBe('Cedar Homes');
  expect(created.jobs).toBe(0);
  expect(created.columns).toEqual(first.columns);
  await expect.poll(() => sent.some((m) => m.type === 'upsertProjectBatch' && m.projectId === created.id && m.name === 'Cedar Homes')).toBe(true);
  expect(sent.some((m) => m.type === 'setBoardColumns' && m.projectId === created.id)).toBe(true);

  // Rename.
  await openProjects(page);
  await expect(page.locator('#projectsList .proj-row')).toHaveCount(2);
  const row = page.locator('#projectsList .proj-row', { hasText: 'Cedar Homes' });
  await row.locator('[data-act="rename"]').click();
  await page.locator('#projRenameInput').fill('Cedar Homes West');
  await page.locator('#projRenameInput').press('Enter');
  await expect(page.locator('#projectsList')).toContainText('Cedar Homes West');
  await expect.poll(() => sent.some((m) => m.type === 'upsertProjectBatch' && m.projectId === created.id && m.name === 'Cedar Homes West')).toBe(true);

  // Archive the open one: switches to the other, moves it under Archived.
  await page.locator('#projectsList .proj-row', { hasText: 'Cedar Homes West' }).locator('[data-act="archive"]').click();
  await expect(page.locator('#projectsList .proj-row')).toHaveCount(1);
  await expect(page.locator('#projectsArchived')).toBeVisible();
  await expect(page.locator('#projectsArchivedCount')).toHaveText('1');
  expect(await page.evaluate(() => activeProjectId)).toBe(first.id);
  await expect.poll(() => sent.some((m) => m.type === 'upsertProjectBatch' && m.projectId === created.id && m.header && m.header.archived === true)).toBe(true);

  // The last project can't be archived.
  await page.locator('#projectsList .proj-row').first().locator('[data-act="archive"]').click();
  await expect(page.locator('#projectsList .proj-row')).toHaveCount(1);

  await page.locator('#projectsArchived summary').click();
  await page.locator('#projectsArchivedList [data-act="restore"]').click();
  await expect(page.locator('#projectsList .proj-row')).toHaveCount(2);
  await expect(page.locator('#projectsArchived')).toBeHidden();
});

test('projects: a logo upload is shrunk, saved on the project and shown behind the Board', async ({ page }) => {
  const sent = await loadAsAdmin(page);
  // A 1200x800 red PNG, made in the page.
  const pngPath = path.join(os.tmpdir(), 'ts-logo-' + Date.now() + '.png');
  const b64 = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 1200; c.height = 800; const x = c.getContext('2d'); x.fillStyle = '#c00'; x.fillRect(0, 0, 1200, 800); return c.toDataURL('image/png').split(',')[1]; });
  fs.writeFileSync(pngPath, Buffer.from(b64, 'base64'));
  const pid = await page.evaluate(() => activeProjectId);

  await openProjects(page);
  await page.locator('#projectsList .proj-row').first().locator('[data-act="logo"]').click();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('[data-act="logo-upload"]').click();
  await (await chooser).setFiles(pngPath);
  await expect(page.locator('.proj-logo-panel img')).toBeVisible();
  const logo = await page.evaluate(() => getActiveProject().header.logo);
  expect(logo).toMatch(/^data:image\/jpeg;base64,/);
  const size = await page.evaluate((src) => new Promise((r) => { const i = new Image(); i.onload = () => r([i.naturalWidth, i.naturalHeight]); i.src = src; }), logo);
  expect(size).toEqual([600, 400]);
  await expect.poll(() => sent.some((m) => m.type === 'upsertProjectBatch' && m.projectId === pid && m.header && String(m.header.logo).startsWith('data:image/jpeg'))).toBe(true);
  expect(await page.evaluate(() => document.getElementById('panel-board').style.background)).toContain('data:image/jpeg');

  await page.locator('[data-act="logo-remove"]').click();
  expect(await page.evaluate(() => getActiveProject().header.logo)).toBe('');
  expect(await page.evaluate(() => document.getElementById('panel-board').style.background)).not.toContain('data:image');
  fs.unlinkSync(pngPath);
});

test('projects: someone below admin sees the menu item only when there is more than one project, and only to switch', async ({ page }) => {
  await seedSession(page, { role: 'editor' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.locator('#accountBtn').click();
  await expect(page.locator('#projectToggleBtn')).toBeHidden();
  await page.keyboard.press('Escape');

  const other = await addSecondProject(page, 'Second Co');
  await page.locator('#accountBtn').click();
  await expect(page.locator('#projectToggleLabel')).toHaveText('Switch project');
  await page.locator('#projectToggleBtn').click();
  await expect(page.locator('#projectsTitle')).toHaveText('Switch project');
  await expect(page.locator('#projectsList [data-act="rename"]')).toHaveCount(0);
  await expect(page.locator('#projectsAddBtn')).toBeHidden();
  await page.locator('#projectsList .proj-row', { hasText: 'Second Co' }).locator('.proj-open').click();
  await expect(page.locator('#projectsModal')).not.toHaveClass(/show/);
  expect(await page.evaluate(() => activeProjectId)).toBe(other);
});

test('projects: a new browser adopts whatever projects the server has, with no leftover starter project', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  const proj = (name) => ({ name, jobs: {}, boardCards: {}, calendarEvents: {}, boardColumns: [], fieldOptions: {}, deletedIds: {}, header: { title: name, subtitle: '', theme: '#3949ab' }, activityLog: [], rev: 1, fieldRevisions: { boardColumns: 0, fieldOptions: 0, header: 0, workflowItems: 0 } });
  await page.routeWebSocket(/\/room\?/, (ws) => {
    ws.send(JSON.stringify({ type: 'snapshot', projects: { 'p-a': proj('Alpha Framing'), 'p-b': proj('Beta Trusses'), 'p-c': proj('Gamma Walls') } }));
  });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await expect.poll(() => page.evaluate(() => Object.keys(projects).sort())).toEqual(['p-a', 'p-b', 'p-c']);
  expect(['p-a', 'p-b', 'p-c']).toContain(await page.evaluate(() => activeProjectId));
});

test('linked jobs: with several other projects, the picker asks which project first', async ({ page }) => {
  await loadAsAdmin(page);
  await addSecondProject(page, 'Second Co');
  const third = await addSecondProject(page, 'Third Co');
  await page.evaluate((id) => { projects[id].jobs = [{ id: 'third-job', name: 'Third job', color: '#3949ab', archived: false, tasks: [] }]; }, third);
  await page.evaluate(() => editJob(jobs[0].id));
  await page.locator('#jobLinkBody .job-phase-strip-btn').click();
  await expect(page.locator('#jobLinkProjectSelect option')).toHaveCount(2);
  await page.locator('#jobLinkProjectSelect').selectOption(third);
  await expect(page.locator('#jobLinkPickerSelect')).toContainText('Third job');
  await page.locator('#jobLinkBody .btn-primary').click();
  expect(await page.evaluate(() => jobs[0].link)).toEqual({ jobId: 'third-job', projectId: third });
});
