const http = require('http');
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { seedSession, mockRoomWebSocket } = require('./helpers');

// Installed app / offline (roadmap I3): sw.js keeps the app itself on the
// device. Service workers only run on http(s), not the file:// page the
// rest of the suite uses, so this serves the repo over a tiny local server.

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.txt': 'text/plain', '.svg': 'image/svg+xml' };
let server;
let base;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port + '/';
});
test.afterAll(() => new Promise((r) => server.close(r)));

test('offline: the manifest names the app and its icons exist', async ({ request }) => {
  const manifest = await (await request.get(base + 'manifest.webmanifest')).json();
  expect(manifest.name).toBe('TeamSync');
  expect(manifest.display).toBe('standalone');
  for (const icon of manifest.icons) {
    const res = await request.get(base + icon.src);
    expect(res.status(), icon.src).toBe(200);
  }
});

test('offline: after one visit the app opens with no connection and shows the saved schedule', async ({ page, context }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.addInitScript(() => localStorage.setItem('gantt_tutorial_state_v1_testadmin', JSON.stringify({ neverShow: true })));

  await page.goto(base);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => navigator.serviceWorker.ready);
  // A second load runs through the worker, which saves the page and the
  // app bundle; the local data copy is written by the app itself.
  await page.reload();
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const jobCount = await page.evaluate(() => jobs.length);
  expect(jobCount).toBeGreaterThan(0);
  await page.evaluate(() => flushProjectsToLocalCache && flushProjectsToLocalCache());

  // (The pill still says Live here only because the test's fake server
  // connection ignores offline mode; a real phone shows Offline.)
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#loginOverlay')).not.toHaveClass(/show/);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/, { timeout: 15000 });
  expect(await page.evaluate(() => jobs.length)).toBe(jobCount);
  await expect(page.locator('.app-nav-brand')).toBeVisible();
  if (process.env.OFFLINE_SHOT) await page.screenshot({ path: process.env.OFFLINE_SHOT });
  await context.setOffline(false);
});
