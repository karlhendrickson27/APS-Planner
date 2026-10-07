const { test, expect } = require('@playwright/test');
const { APP_URL, seedSession, mockRoomWebSocket } = require('./helpers');

// In-app notifications (src/app/notifications.ts) and the @mention picker
// (src/app/mention-picker.ts). The server part has its own tests
// (worker/src/notifications.test.mjs); here the server is faked.

const JSON_HEADERS = { 'Access-Control-Allow-Origin': '*' };

async function setup(page) {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.addInitScript(() => localStorage.setItem('gantt_tutorial_state_v1_testadmin', JSON.stringify({ neverShow: true })));
  const patches = [];
  await page.route('**/notifications/state', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (body.patch) patches.push(body.patch);
    const state = { since: Date.now() - 3600 * 1000, seen: { _base: 0 }, read: {}, readUpTo: 0, off: [] };
    await route.fulfill({ status: 200, contentType: 'application/json', headers: JSON_HEADERS, body: JSON.stringify({ state }) });
  });
  await page.route('**/users/roster', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: JSON_HEADERS,
    body: JSON.stringify({ users: [{ username: 'testadmin', displayName: 'Test Admin', isLead: true }, { username: 'ana', displayName: 'Ana Smith', isLead: false }] }) }));
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  return patches;
}

test('notifications: mentions, being added to a job and due dates show under the bell; read marks and choices stick', async ({ page }) => {
  const patches = await setup(page);
  await expect(page.locator('#notifyBtn')).toBeVisible();
  await expect(page.locator('#notifyCount')).toBeHidden();

  // Someone else (as if it came from the server) mentions me, adds me to a
  // job that's due tomorrow, and assigns me a checklist item.
  const names = await page.evaluate(() => {
    const j0 = jobs[0], j1 = jobs[1];
    j0.comments = (j0.comments || []).concat([{ id: 'c-x', author: 'Ana Smith', by: 'ana', text: '@Test Admin can you check the truss count?', when: Date.now() - 60000 }]);
    const card = getPrimaryPhaseCard(j1);
    const t = new Date(); t.setDate(t.getDate() + 1);
    card.customFields = Object.assign({}, card.customFields, { pm: 'testadmin' });
    card.due = toIsoDate(t);
    card.column = BOARD_COLUMNS.find((c) => !['complete', 'invoiced'].includes(c.id)).id;
    card.checklists = Object.assign({}, card.checklists, { [card.column]: [{ id: 'ci-1', text: 'Order trusses', done: false, assignee: ['testadmin'] }] });
    return [j0.name, j1.name];
  });
  await page.locator('#notifyBtn').click();
  const panel = page.locator('#notifyPanel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.notify-item')).toHaveCount(4);
  await expect(panel).toContainText('Ana Smith mentioned you on ' + names[0]);
  await expect(panel).toContainText('You were added to ' + names[1]);
  await expect(panel).toContainText(names[1] + ' is due tomorrow');
  await expect(panel).toContainText('Order trusses');
  await expect(page.locator('#notifyCount')).toHaveText('4');

  // My own edit (adding myself to another job) isn't news to me.
  await page.evaluate(() => {
    const card = getPrimaryPhaseCard(jobs[2]);
    card.customFields = Object.assign({}, card.customFields, { members: ((card.customFields || {}).members || []).concat(['testadmin']) });
    saveJobs();
  });
  await page.locator('#notifyBtn').click();
  await page.locator('#notifyBtn').click();
  await expect(panel.locator('.notify-item')).toHaveCount(4);

  // Turning off @mentions hides that one; Mark all read clears the count.
  await panel.locator('#notifySettingsBtn').click();
  await panel.locator('input[data-kind="mention"]').uncheck();
  await expect(panel.locator('.notify-item')).toHaveCount(3);
  await expect(page.locator('#notifyCount')).toHaveText('3');
  await panel.locator('#notifyMarkAll').click();
  await expect(page.locator('#notifyCount')).toBeHidden();
  await expect(panel.locator('.notify-item.unread')).toHaveCount(0);
  await expect.poll(() => patches.some((p) => typeof p.readUpTo === 'number' && Array.isArray(p.off) && p.off.includes('mention'))).toBe(true);

  // Clicking one opens its job.
  await panel.locator('.notify-item', { hasText: 'is due tomorrow' }).click();
  await expect(panel).toBeHidden();
  await expect(page.locator('#formArea')).toHaveClass(/open/);
});

test('mention picker: typing @ in a comment lists teammates and fills in the name', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => editJob(jobs[0].id));
  const box = page.locator('#newJobCommentText');
  await box.click();
  await box.pressSequentially('Hey @an');
  const picker = page.locator('#mentionPicker');
  await expect(picker).toBeVisible();
  await expect(picker.locator('li')).toHaveCount(1);
  await expect(picker).toContainText('Ana Smith');
  await box.press('Enter');
  await expect(picker).toBeHidden();
  await expect(box).toHaveValue('Hey @Ana Smith ');
  await box.pressSequentially('@zz');
  await expect(picker).toBeHidden();
});
