const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const FIXTURE_URL = pathToFileURL(path.resolve(__dirname, 'unit-fixture.html')).toString();

// Direct unit tests for the presence-avatar rendering (src/sync/presence.ts)
// — against the REAL built bundle (same approach as tests/unit-utils.spec.js).
// renderPresenceAvatars() only touches one specific element
// (#presenceAvatars), which this blank fixture doesn't have — created
// directly in each test rather than adding app markup the fixture would
// otherwise need to fake.

test('renderPresenceAvatars: excludes the current session, includes everyone else with correct initials/title', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    document.body.innerHTML = '<div id="presenceAvatars"></div>';
    myPresenceSessionId = 'me-session';
    projects = { 'proj-1': { name: 'Riverside Remodel' } };
    latestPresenceUsers = [
      { sessionId: 'me-session', displayName: 'Myself', username: 'myself' }, // excluded — this is me
      { sessionId: 'other-1', displayName: 'Jane Doe', username: 'jane', projectId: 'proj-1', view: 'board' },
      { sessionId: 'other-2', username: 'bob' }, // no displayName — falls back to username; no view/project
    ];
    renderPresenceAvatars();
    return Array.from(document.querySelectorAll('.presence-avatar')).map((el) => ({
      text: el.textContent,
      title: el.title,
    }));
  });

  expect(result).toEqual([
    { text: 'JD', title: 'Jane Doe — Board — Riverside Remodel' },
    { text: 'BO', title: 'bob' },
  ]);
});

test('renderPresenceAvatars: hides my other tabs and shows one bubble per person', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    document.body.innerHTML = '<div id="presenceAvatars"></div>';
    myPresenceSessionId = 'me-1';
    projects = { 'proj-1': { name: 'Riverside Remodel' } };
    latestPresenceUsers = [
      { sessionId: 'me-1', displayName: 'Karl A', username: 'karl' },
      { sessionId: 'me-2', displayName: 'Karl A', username: 'karl', view: 'gantt' }, // my other tab
      { sessionId: 'me-3', displayName: 'Karl A', username: 'karl', view: 'home' },  // my phone
      { sessionId: 'jane-1', displayName: 'Jane Doe', username: 'jane', projectId: 'proj-1', view: 'board' },
      { sessionId: 'jane-2', displayName: 'Jane Doe', username: 'jane', projectId: 'proj-1', view: 'gantt' },
      { sessionId: 'jane-3', displayName: 'Jane Doe', username: 'jane', projectId: 'proj-1', view: 'board' },
    ];
    renderPresenceAvatars();
    return Array.from(document.querySelectorAll('.presence-avatar')).map((el) => ({ text: el.textContent, title: el.title }));
  });
  expect(result).toEqual([
    { text: 'JD', title: 'Jane Doe — Board — Riverside Remodel, Gantt Chart — Riverside Remodel' },
  ]);
});

test('presenceInitials: single-word names use the first two letters, multi-word names use first+last initial', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => ({
    single: presenceInitials('bob'),
    multi: presenceInitials('Jane Doe'),
    threeWords: presenceInitials('Mary Jane Watson'),
    blank: presenceInitials(''),
  }));
  expect(result).toEqual({ single: 'BO', multi: 'JD', threeWords: 'MW', blank: '?' });
});

test('presenceAvatarColor/presenceAnimDelay: deterministic per key, not random per call', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => ({
    colorFirst: presenceAvatarColor('jane'),
    colorSecond: presenceAvatarColor('jane'),
    delayFirst: presenceAnimDelay('jane'),
    delaySecond: presenceAnimDelay('jane'),
  }));
  expect(result.colorFirst).toBe(result.colorSecond);
  expect(result.delayFirst).toBe(result.delaySecond);
});
