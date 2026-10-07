const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');

const FIXTURE_URL = pathToFileURL(path.resolve(__dirname, 'unit-fixture.html')).toString();

// Direct unit tests for the new-user tutorial/coachmark system
// (src/app/onboarding.ts). getStoredUsername() is a real import from
// src/auth/session.ts, so these tests seed localStorage's real backing
// key directly rather than stubbing the function — reassigning
// window.getStoredUsername wouldn't redirect what onboarding.ts calls.

test('tutorialStateKey: keyed per-username, falls back to "anon" with nothing stored', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    localStorage.removeItem('gantt_username_v1');
    const anonKey = tutorialStateKey();
    localStorage.setItem('gantt_username_v1', 'alice');
    const aliceKey = tutorialStateKey();
    return { anonKey, aliceKey };
  });
  expect(result.anonKey).toBe('gantt_tutorial_state_v1_anon');
  expect(result.aliceKey).toBe('gantt_tutorial_state_v1_alice');
});

test('getTutorialState/saveTutorialState: round-trips through localStorage, defaults to {} when nothing stored', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    localStorage.setItem('gantt_username_v1', 'bob');
    const before = getTutorialState();
    saveTutorialState({ loginsSeen: 2, neverShow: false });
    const after = getTutorialState();
    return { before, after };
  });
  expect(result.before).toEqual({});
  expect(result.after).toEqual({ loginsSeen: 2, neverShow: false });
});

test('maybeShowTutorialPrompt: increments loginsSeen each call and stops scheduling the notification past TUTORIAL_MAX_LOGINS', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    localStorage.setItem('gantt_username_v1', 'carol');
    // Real setTimeout would actually fire showTutorialNotification() 800ms
    // later — intercept it to observe whether a call was scheduled at all,
    // without waiting or touching the DOM it builds.
    let scheduledCount = 0;
    const realSetTimeout = window.setTimeout;
    window.setTimeout = function(fn, ms) { scheduledCount++; return realSetTimeout(() => {}, 0); };
    try {
      const seenAfterEachCall = [];
      for (let i = 0; i < 5; i++) {
        maybeShowTutorialPrompt();
        seenAfterEachCall.push(getTutorialState().loginsSeen);
      }
      return { seenAfterEachCall, scheduledCount };
    } finally {
      window.setTimeout = realSetTimeout;
    }
  });
  // TUTORIAL_MAX_LOGINS is 3 — logins 1-3 schedule the notification, 4-5 don't.
  expect(result.seenAfterEachCall).toEqual([1, 2, 3, 4, 5]);
  expect(result.scheduledCount).toBe(3);
});

test('maybeShowTutorialPrompt: neverShow stops it from scheduling or incrementing further', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    localStorage.setItem('gantt_username_v1', 'dave');
    saveTutorialState({ loginsSeen: 1, neverShow: true });
    let scheduledCount = 0;
    const realSetTimeout = window.setTimeout;
    window.setTimeout = function(fn, ms) { scheduledCount++; return realSetTimeout(() => {}, 0); };
    try {
      maybeShowTutorialPrompt();
      return { loginsSeen: getTutorialState().loginsSeen, scheduledCount };
    } finally {
      window.setTimeout = realSetTimeout;
    }
  });
  expect(result.loginsSeen).toBe(1); // unchanged — bailed out before incrementing
  expect(result.scheduledCount).toBe(0);
});

test('findNextCoachmarkIndex: skips a step whose target is missing/hidden, returns -1 past the last one', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    // findNextCoachmarkIndex() closes over the module's real
    // COACHMARK_STEPS (not injectable) — exercised here against a blank
    // fixture with none of those real target elements present, so every
    // real step is legitimately "not found" and must be skipped over
    // rather than short-circuiting on the first miss.
    const forwardFromStart = findNextCoachmarkIndex(-1, 1);
    const pastTheEnd = findNextCoachmarkIndex(999, 1);
    return { forwardFromStart, pastTheEnd };
  });
  // This blank fixture has none of COACHMARK_STEPS' real target elements —
  // every step should be skipped, landing on -1 either direction.
  expect(result.forwardFromStart).toBe(-1);
  expect(result.pastTheEnd).toBe(-1);
});

test('findNextCoachmarkIndex: finds the real next step once its target exists on the page', async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const result = await page.evaluate(() => {
    // #jobRailToggleBtn is COACHMARK_STEPS[4]'s real target selector (after Notifications, Help, Settings and Account).
    const btn = document.createElement('button');
    btn.id = 'jobRailToggleBtn';
    document.body.appendChild(btn);
    return findNextCoachmarkIndex(3, 1);
  });
  expect(result).toBe(4);
});
