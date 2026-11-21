// Account > Connected apps (src/app/connected-apps.ts). The server side has
// its own tests (worker/src/mcp-connector.test.mjs); this checks the window.
const { test, expect } = require('@playwright/test');
const { APP_URL, seedSession, mockRoomWebSocket } = require('./helpers');

const DAY = 24 * 60 * 60 * 1000;

async function open(page, apps) {
  await seedSession(page, { role: 'editor' });
  await mockRoomWebSocket(page);
  const calls = [];
  let current = apps.slice();
  await page.route('**/connected-apps', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    calls.push(body);
    if (body.action === 'disconnect') current = current.filter((a) => a.grantId !== body.grantId);
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ available: true, apps: current }) });
  });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => toggleAccountMenu());
  await page.locator('#connectedAppsBtn').click();
  await expect(page.locator('#connectedAppsModal')).toHaveClass(/show/);
  return calls;
}

test('connected apps: lists Claude connections and Disconnect removes one after confirming', async ({ page }) => {
  const now = Date.now();
  const calls = await open(page, [
    { grantId: 'g1', clientName: 'Claude', connectedAt: now - 3 * DAY, lastUsedAt: now - 2 * 60 * 60 * 1000 },
    { grantId: 'g2', clientName: 'Claude', connectedAt: now - 10 * DAY, lastUsedAt: null },
  ]);
  const rows = page.locator('#connectedAppsList li');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('Claude');
  await expect(rows.first()).toContainText('last used');
  await expect(rows.nth(1)).toContainText('not used yet');
  await expect(page.locator('#connectedAppsEmpty')).toBeHidden();

  // Cancelling the confirm leaves it connected.
  page.once('dialog', (d) => d.dismiss());
  await rows.first().getByRole('button', { name: /Disconnect Claude/ }).click();
  await expect(rows).toHaveCount(2);

  page.once('dialog', (d) => d.accept());
  await rows.first().getByRole('button', { name: /Disconnect Claude/ }).click();
  await expect(rows).toHaveCount(1);
  expect(calls.filter((c) => c.action === 'disconnect').map((c) => c.grantId)).toEqual(['g1']);
  expect(calls.every((c) => typeof c.token === 'string' && c.token.length > 0)).toBe(true);

  page.once('dialog', (d) => d.accept());
  await rows.first().getByRole('button', { name: /Disconnect Claude/ }).click();
  await expect(page.locator('#connectedAppsEmpty')).toBeVisible();
  await expect(page.locator('#connectedAppsList')).toBeHidden();
  await expect(page.locator('#connectedAppsCloseBtn')).toBeFocused();

  await page.locator('#connectedAppsCloseBtn').click();
  await expect(page.locator('#connectedAppsModal')).not.toHaveClass(/show/);
});

test('connected apps: empty state points to Help, and Escape closes the window', async ({ page }) => {
  await open(page, []);
  await expect(page.locator('#connectedAppsEmpty')).toBeVisible();
  await expect(page.locator('#connectedAppsEmpty')).toContainText('Using TeamSync with Claude');
  await page.keyboard.press('Escape');
  await expect(page.locator('#connectedAppsModal')).not.toHaveClass(/show/);
});

test('"via Claude" names show as the name plus a small tag in the activity log', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => {
    const p = getActiveProject();
    p.activityLog = [{ who: 'Karl Hendrickson (via Claude)', what: 'moved Highland › Ext › Deliver to Nov 25–Nov 25', when: Date.now() }];
    toggleActivitySidebar();
  });
  const item = page.locator('.activity-log-item').first();
  await expect(item.locator('.activity-log-who')).toHaveText(/^Karl Hendrickson\s*via Claude$/);
  await expect(item.locator('.via-claude-tag')).toHaveText('via Claude');
});
