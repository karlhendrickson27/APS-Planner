const { test, expect } = require('@playwright/test');
const { APP_URL, WORKER_ORIGIN, seedSession, mockRoomWebSocket, fakeSessionToken } = require('./helpers');

test('login: a valid seeded session bypasses the login overlay', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await page.goto(APP_URL);

  await expect(page.locator('#loginOverlay')).not.toHaveClass(/show/);
  await expect(page.locator('#jobList')).toBeAttached();
});

// The four tests below drive the REAL login flow (no seedSession bypass)
// — reauthenticate()'s POST to API_BASE_URL is intercepted directly, so
// these exercise the actual #loginOverlay form, the retry-on-failure
// loop, and the lockout path, none of which any other test in this file
// touches (every other test seeds a session specifically to skip this).
async function mockWorkerForLogin(page, loginResponse) {
  await page.route(WORKER_ORIGIN + '/**', (route) => {
    const req = route.request();
    const url = req.url();
    if (url.includes('/room')) return route.abort();
    if (req.method() === 'POST' && (url === WORKER_ORIGIN + '/' || url === WORKER_ORIGIN)) {
      return loginResponse(route);
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

test('login: the real form boots into the overlay and a correct submit logs in', async ({ page }) => {
  const token = fakeSessionToken({ username: 'realuser', displayName: 'Real User', role: 'admin' });
  await mockWorkerForLogin(page, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ token }),
  }));
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);

  await expect(page.locator('#loginOverlay')).toHaveClass(/show/);
  await page.fill('#loginUsername', 'realuser');
  await page.fill('#loginPassword', 'correct-password');
  await page.click('#loginSubmit');

  await expect(page.locator('#loginOverlay')).not.toHaveClass(/show/, { timeout: 5000 });
  const storedToken = await page.evaluate(() => localStorage.getItem('gantt_session_token_v1'));
  expect(storedToken).toBeTruthy();
});

test('login: a rejected login shows an error, keeps the typed username, clears the password, and lets a retry succeed', async ({ page }) => {
  const token = fakeSessionToken({ username: 'realuser', displayName: 'Real User', role: 'admin' });
  let attempt = 0;
  await mockWorkerForLogin(page, (route) => {
    attempt++;
    if (attempt === 1) {
      return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'bad creds' }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token }) });
  });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);

  await page.fill('#loginUsername', 'realuser');
  await page.fill('#loginPassword', 'wrong-password');
  await page.click('#loginSubmit');

  // Rejected: banner shows, password is cleared, but the username the user
  // just typed stays on screen — only the localStorage-cached username (what
  // a *future* page load would prefill) is cleared, per reauthenticate()'s
  // own comment, not the field they're currently looking at.
  await expect(page.locator('#loginBanner')).toHaveClass(/show/);
  await expect(page.locator('#loginBanner')).toHaveClass(/err/);
  await expect(page.locator('#loginBannerText')).toHaveText('Incorrect username or password.');
  await expect(page.locator('#loginUsername')).toHaveValue('realuser');
  await expect(page.locator('#loginPassword')).toHaveValue('');
  await expect(page.locator('#loginOverlay')).toHaveClass(/show/);
  const cachedUsername = await page.evaluate(() => localStorage.getItem('gantt_username_v1'));
  expect(cachedUsername).toBeNull();

  // Retry with just the (now-corrected) password succeeds.
  await page.fill('#loginPassword', 'correct-password');
  await page.click('#loginSubmit');
  await expect(page.locator('#loginOverlay')).not.toHaveClass(/show/, { timeout: 5000 });
});

test('login: a 429 lockout shows the lockout banner and preserves the typed username', async ({ page }) => {
  await mockWorkerForLogin(page, (route) => route.fulfill({
    status: 429,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Too many attempts — try again in 3 minutes.' }),
  }));
  await page.goto(APP_URL);

  await page.fill('#loginUsername', 'realuser');
  await page.fill('#loginPassword', 'whatever');
  await page.click('#loginSubmit');

  await expect(page.locator('#loginBanner')).toHaveClass(/show/);
  await expect(page.locator('#loginBanner')).toHaveClass(/lockout/);
  await expect(page.locator('#loginBannerText')).toHaveText('Too many attempts — try again in 3 minutes.');
  // Unlike a rejected (401) login, a lockout is not the account's fault —
  // the username must survive so the user doesn't have to retype it.
  await expect(page.locator('#loginUsername')).toHaveValue('realuser');
  await expect(page.locator('#loginOverlay')).toHaveClass(/show/);
});

test('job CRUD: creating a job via the UI lands in the underlying data model', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#loginOverlay')).not.toHaveClass(/show/);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const jobName = 'Playwright smoke test job ' + Date.now();
  // Driven via addNewJob() directly rather than clicking one of its two
  // trigger buttons (the always-visible rail one, or the dynamically
  // rendered one at the bottom of the job list) — which button is even
  // clickable depends on which tab/panel is active and how wide the job
  // rail is, none of which this test cares about; it's exercising the
  // draft-job -> autosave -> data-model path, same as either button does.
  await page.evaluate(() => addNewJob());
  await page.locator('#f_job').fill(jobName);
  // Force the debounced autosave to flush immediately rather than waiting
  // on its real-world debounce timer — deterministic, not timing-dependent.
  await page.evaluate(() => flushAutoSaveJobForm());

  // Verified against the actual data model, not the DOM — a save that
  // "looks right" on screen isn't proof it stuck.
  const savedJobExists = await page.evaluate((name) => {
    const proj = getActiveProject();
    return !!(proj && Object.values(proj.jobs || {}).some((j) => j.name === name));
  }, jobName);
  expect(savedJobExists).toBe(true);
});

test('model layer read-back: a job created through the real UI comes back from findJob() with the right shape', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#loginOverlay')).not.toHaveClass(/show/);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const jobName = 'Model read-back test job ' + Date.now();
  await page.evaluate(() => addNewJob());
  await page.locator('#f_job').fill(jobName);
  await page.evaluate(() => flushAutoSaveJobForm());

  // findJob() (src/core/models.ts) — this confirms it resolves a job that
  // was just created through the real save path, with the shape everything
  // else in the app expects back from it (job.id === the id it was found
  // by, idx pointing at its real position in the jobs array).
  const result = await page.evaluate((name) => {
    const idx = jobs.findIndex((j) => j.name === name);
    const job = jobs[idx];
    const found = findJob(job.id);
    return { idx, found };
  }, jobName);

  expect(result.found).not.toBeNull();
  expect(result.found.idx).toBe(result.idx);
  expect(result.found.job.name).toBe(jobName);
});

test('regression (Fix 3): isBusyEditing() now covers an in-progress Board drag', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await page.goto(APP_URL);
  await expect(page.locator('#loginOverlay')).not.toHaveClass(/show/);

  const cardDragBusy = await page.evaluate(() => {
    draggedCardId = 'test-card-id';
    const busy = isBusyEditing();
    draggedCardId = null;
    return busy;
  });
  expect(cardDragBusy).toBe(true);

  const colDragBusy = await page.evaluate(() => {
    draggedColId = 'test-col-id';
    const busy = isBusyEditing();
    draggedColId = null;
    return busy;
  });
  expect(colDragBusy).toBe(true);

  const idleBusy = await page.evaluate(() => isBusyEditing());
  expect(idleBusy).toBe(false);
});

test('isBusyEditing(): an open modal (e.g. the card detail modal) also counts as busy', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await page.goto(APP_URL);
  await expect(page.locator('#loginOverlay')).not.toHaveClass(/show/);

  // The Fix 3 test above covers the Board/Gantt/Calendar drag-state
  // branch of isBusyEditing() (src/sync/connection.ts) — this covers the
  // separate open-modal branch.
  const result = await page.evaluate(() => {
    const before = isBusyEditing();
    const modal = document.getElementById('cardModal');
    modal.classList.add('show');
    const whileOpen = isBusyEditing();
    modal.classList.remove('show');
    const afterClose = isBusyEditing();
    return { before, whileOpen, afterClose };
  });

  expect(result.before).toBe(false);
  expect(result.whileOpen).toBe(true);
  expect(result.afterClose).toBe(false);
});

test('regression (Fix 4): a first-connection failure escalates the sync indicator instead of hanging on "Connecting…"', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page); // real connection succeeds; the scenario below is simulated directly
  await page.clock.install();
  await page.goto(APP_URL);
  await expect(page.locator('#loginOverlay')).not.toHaveClass(/show/);

  // Simulating this via real WebSocket retry timing means fighting
  // ReconnectingWebSocket's own backoff schedule (unknown/unstable exact
  // values) rather than testing this app's code — same reasoning as the
  // Fix 3 test above calling isBusyEditing() directly instead of
  // simulating a real HTML5 drag. Fix 4 changed exactly one thing:
  // handleRoomClose() now calls scheduleOfflineEscalation() even when
  // roomEverConnected is still false (a first-connection failure) —
  // exercise that directly.
  await page.evaluate(() => {
    roomEverConnected = false;
    handleRoomClose({ code: 1006 });
  });

  // scheduleOfflineEscalation()'s timer is 8s; fast-forward well past it
  // deterministically rather than waiting on a real 8-second clock.
  await page.clock.fastForward(15000);

  const tooltip = await page.evaluate(() => document.getElementById('syncDot')?.title || '');
  expect(tooltip.toLowerCase()).toContain('offline');
});

test('sync: a successful reconnect clears the offline indicator and cancels the pending escalation', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.clock.install();
  await page.goto(APP_URL);
  await expect(page.locator('#loginOverlay')).not.toHaveClass(/show/);

  // Drive the same offline path as the Fix 4 regression test above, then
  // recover from it — handleRoomOpen() is what a real reconnect calls.
  await page.evaluate(() => {
    roomEverConnected = false;
    handleRoomClose({ code: 1006 });
  });
  await page.clock.fastForward(15000);
  const offlineTooltip = await page.evaluate(() => document.getElementById('syncDot')?.title || '');
  expect(offlineTooltip.toLowerCase()).toContain('offline');
  // The pill's visible label says it too (roadmap B3), not just the tooltip.
  await expect(page.locator('#syncDot .sync-pill-label')).toHaveText(/^Offline/);

  await page.evaluate(() => handleRoomOpen());
  await expect(page.locator('#syncDot .sync-pill-label')).toHaveText('Live');
  const recoveredTooltip = await page.evaluate(() => document.getElementById('syncDot')?.title || '');
  expect(recoveredTooltip.toLowerCase()).not.toContain('offline');

  // cancelOfflineEscalation() inside handleRoomOpen() must have cleared the
  // timer too — without that, the indicator would silently flip back to
  // "offline" on its own a few seconds later even though the connection is
  // fine, which a snapshot check right after handleRoomOpen() alone
  // wouldn't catch.
  await page.clock.fastForward(15000);
  const stillRecoveredTooltip = await page.evaluate(() => document.getElementById('syncDot')?.title || '');
  expect(stillRecoveredTooltip.toLowerCase()).not.toContain('offline');
});

test('board drag-and-drop: dropping a card on a new column updates its stored column', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const card = boardCards[0];
    if (!card) return null;
    const originalColumn = card.column;
    const targetColumnId = BOARD_COLUMNS.find((c) => c.id !== originalColumn).id;
    const body = document.getElementById('col-body-' + targetColumnId);
    const cardEl = document.querySelector('.board-card[data-id="' + card.id + '"]');
    if (!body || !cardEl) return null;

    // handleColumnDrop() finishes by calling syncBoardCardsFromDOM(), which
    // rebuilds every card's .column from where its element actually sits
    // in the DOM — a real drag's dragover handler (applyColumnDragOver())
    // is what moves the element there before drop fires. Since this test
    // drives handleColumnDrop() directly (see the reasoning below), it has
    // to do that DOM move itself first, or syncBoardCardsFromDOM() would
    // just read the card's unchanged original position right back.
    body.appendChild(cardEl);
    draggedCardId = card.id;
    // Drives the real drop handler directly rather than simulating native
    // HTML5 dragstart/dragover/drop events — same reasoning as the
    // isBusyEditing() drag-guard regression test: exercise the function
    // that owns the actual state change (setCardColumn via
    // handleColumnDrop), not the browser's own drag machinery.
    handleColumnDrop({ preventDefault() {}, stopPropagation() {}, currentTarget: body });

    return {
      originalColumn,
      targetColumnId,
      newColumn: boardCards.find((c) => c.id === card.id).column,
    };
  });

  expect(result).not.toBeNull();
  expect(result.newColumn).toBe(result.targetColumnId);
  expect(result.newColumn).not.toBe(result.originalColumn);
});

test('confirmChecklistBeforeMove: declining the confirmation leaves a card with open checklist items in its original column', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  // Explicit dialog handler, not Playwright's default auto-dismiss — same
  // "isolate the guard, don't rely on an unrelated default" lesson as the
  // Complete/Invoiced column-delete test above. Dismissing here is what a
  // real "Move it anyway?" -> Cancel click does.
  page.on('dialog', (d) => d.dismiss());

  const result = await page.evaluate(() => {
    const card = boardCards[0];
    const originalColumn = card.column;
    const targetColumnId = BOARD_COLUMNS.find((c) => c.id !== originalColumn).id;
    card.checklists = { [originalColumn]: [{ id: 'i1', text: 'Unfinished item', done: false }] };
    moveCardToColumn(card.id, targetColumnId);
    return { originalColumn, columnAfter: boardCards.find((c) => c.id === card.id).column };
  });

  expect(result.columnAfter).toBe(result.originalColumn);
});

test('confirmChecklistBeforeMove: accepting the confirmation moves the card despite open checklist items', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  page.on('dialog', (d) => d.accept());

  const result = await page.evaluate(() => {
    const card = boardCards[0];
    const originalColumn = card.column;
    const targetColumnId = BOARD_COLUMNS.find((c) => c.id !== originalColumn).id;
    card.checklists = { [originalColumn]: [{ id: 'i1', text: 'Unfinished item', done: false }] };
    moveCardToColumn(card.id, targetColumnId);
    return { targetColumnId, columnAfter: boardCards.find((c) => c.id === card.id).column };
  });

  expect(result.columnAfter).toBe(result.targetColumnId);
});

test('calendar CRUD: add, edit, and delete an event via the modal all land in the underlying data model', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const eventTitle = 'Playwright calendar event ' + Date.now();

  // Add — driven via the real modal open/fill/save path, then verified
  // against calendarEvents directly rather than the DOM (see the job CRUD
  // test above for why: a save that "looks right" on screen isn't proof
  // it stuck).
  await page.evaluate(() => openAddCalendarEvent('2026-09-15', '09:00'));
  await page.locator('#ce_title').fill(eventTitle);
  await page.evaluate(() => saveCalendarEventFromModal());

  const added = await page.evaluate((title) => {
    const evt = calendarEvents.find((e) => e.title === title);
    return evt ? { id: evt.id, start: evt.start } : null;
  }, eventTitle);
  expect(added).not.toBeNull();
  expect(added.start).toBe('2026-09-15');

  // Edit — reopen the same event through openEditCalendarEvent() (the real
  // entry point a click on the rendered bar uses) and change its date.
  const updatedTitle = eventTitle + ' (edited)';
  await page.evaluate((id) => openEditCalendarEvent(id), added.id);
  await page.locator('#ce_title').fill(updatedTitle);
  await page.locator('#ce_date').fill('2026-09-16');
  await page.evaluate(() => saveCalendarEventFromModal());

  const edited = await page.evaluate((id) => calendarEvents.find((e) => e.id === id), added.id);
  expect(edited.title).toBe(updatedTitle);
  expect(edited.start).toBe('2026-09-16');

  // Delete
  await page.evaluate((id) => openEditCalendarEvent(id), added.id);
  await page.evaluate(() => deleteCalendarEventFromModal());
  const stillExists = await page.evaluate((id) => calendarEvents.some((e) => e.id === id), added.id);
  expect(stillExists).toBe(false);
});

test('calendar month view: a scheduled job task renders as a positioned bar on the correct day', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('calendar'));

  // Same reasoning as the gantt drag test above: a fresh demo job's tasks
  // start unscheduled, so schedule one directly through the data model,
  // then pin calendarViewDate to the same month so the grid it builds
  // actually contains that date, and re-render through the real
  // renderCalendar()/renderMonthCalendar()/buildCalBarHtml() pipeline.
  const info = await page.evaluate(() => {
    const job = jobs[0];
    const phase = getJobPhases(job)[0];
    const sub = getPhaseSubUnits(phase)[0];
    const t = (sub.tasks || [])[0];
    if (!t) return null;
    t.start = '2026-09-10';
    t.finish = '2026-09-12';
    calendarViewDate = new Date('2026-09-15T00:00:00');
    calendarViewMode = 'month';
    renderCalendar();
    return { jobId: job.id };
  });
  expect(info).not.toBeNull();

  await expect(page.locator('.cal-day[data-date="2026-09-10"]')).toBeAttached();
  const bar = page.locator('.cal-event-bar[data-cal-job-id="' + info.jobId + '"]');
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute('data-cal-task-start', '2026-09-10');
  // Position comes from real getCell()/offsetLeft measurements against the
  // rendered grid, not a hardcoded value — a non-empty "left: ...px" proves
  // the lane-packing pass actually ran against real layout, not just that
  // some bar element exists in the DOM somewhere. Optional space after the
  // colon: Preact serializes inline styles as "left: 672px" (space), not
  // the old hand-written "left:672px" (no space) the string-built version
  // produced — both are equally valid CSS, this just matches either.
  await expect(bar).toHaveAttribute('style', /left:\s*\d/);
});

test('calendar week view: a timed calendar event renders in the hourly grid', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('calendar'));

  await page.evaluate(() => {
    calendarViewDate = new Date('2026-09-15T00:00:00');
    calendarEvents.push({
      id: genId(), title: 'Site walkthrough', start: '2026-09-15', time: '10:30', duration: 1,
      repeat: 'none', repeatUntil: null, color: '#7e57c2', exceptions: {}, visibility: 'all', visibleMembers: [],
    });
    // setCalendarView() (not a direct renderWeekCalendar() call) so this
    // also exercises the real Prev/Next/view-toggle entry point, not just
    // the render function in isolation.
    setCalendarView('week');
  });

  const evtEl = page.locator('.week-timed-event', { hasText: 'Site walkthrough' });
  await expect(evtEl).toBeVisible();
  // Optional space after the colon: Preact serializes inline styles as
  // "top: 504px" (space), not the old hand-written "top:504px" (no
  // space) the string-built version produced — both are equally valid
  // CSS, this just matches either.
  await expect(evtEl).toHaveAttribute('style', /top:\s*\d/);

  // Day view reuses the same renderWeekHourGrid() renderer for a single
  // date — switching there should show the identical timed event without
  // losing it.
  await page.evaluate(() => setCalendarView('day'));
  await expect(page.locator('.week-timed-event', { hasText: 'Site walkthrough' })).toBeVisible();
});

test('calendar bar drag: dragging a calendar event bar reschedules it by the dragged number of days', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('calendar'));

  // A job task's own bar in month/week view is always a collapsed
  // "job-span" cluster (see buildCalendarJobRows()), which is deliberately
  // read-only/click-to-open, never drag-reschedulable — dragging is only
  // meaningful here for a standalone calendar event's own bar (or a job's
  // due-date marker, a separate code path), so that's what this test
  // drags.
  const before = await page.evaluate(() => {
    const evt = {
      id: genId(), title: 'Concrete pour', start: '2026-09-10', duration: 2,
      repeat: 'none', repeatUntil: null, color: '#7e57c2', exceptions: {}, visibility: 'all', visibleMembers: [],
    };
    calendarEvents.push(evt);
    calendarViewDate = new Date('2026-09-15T00:00:00');
    calendarViewMode = 'month';
    renderCalendar();
    return { eventId: evt.id, start: evt.start, duration: evt.duration };
  });
  expect(before).not.toBeNull();

  const shiftedDays = 3;
  const result = await page.evaluate(
    ({ eventId, shiftedDays }) => {
      const bar = document.querySelector('.cal-event-bar[data-cal-job-id="calevt-job-' + eventId + '"]');
      if (!bar) return null;
      const cellWidth = document.querySelector('.cal-day').offsetWidth;
      // Same reasoning as the gantt drag test below: exercise the
      // committed handlers directly, bypassing the rAF-coalesced
      // mousemove wrapper (handleCalBarMouseMove) — the exact per-event
      // clientX doesn't matter, only the final delta handleCalBarMouseUp
      // computes from it.
      handleCalBarMouseDown({ preventDefault() {}, target: bar, clientX: 0 });
      applyCalBarMouseMove({ clientX: shiftedDays * cellWidth, clientY: 0 });
      handleCalBarMouseUp({ clientX: shiftedDays * cellWidth });
      const evt = calendarEvents.find((e) => e.id === eventId);
      return evt ? { start: evt.start, duration: evt.duration } : null;
    },
    { eventId: before.eventId, shiftedDays }
  );

  const expectedStart = await page.evaluate(
    ({ start, shiftedDays }) => {
      const d = new Date(start + 'T00:00:00');
      d.setDate(d.getDate() + shiftedDays);
      return toIsoDate(d);
    },
    { start: before.start, shiftedDays }
  );

  expect(result).not.toBeNull();
  expect(result.start).toBe(expectedStart);
  expect(result.duration).toBe(before.duration);
});

test('calendar toolbar: "Jobs" shows one bar per job; job, person and stage filters narrow the bars and hide calendar-only events', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('calendar'));
  await page.waitForFunction(() => getActiveTab() === 'calendar');

  const stageIds = await page.evaluate(() => {
    const cols = BOARD_COLUMNS.map((c, i) => ({ c, i })).filter((x) => !x.c.hideFromSchedule).slice(0, 2);
    // Two stages with a one-day gap between them, so "Stages" draws two bars per job.
    const mk = (id, name, pm) => {
      const job = { id, name, color: '#1e88e5', archived: false, comments: [], order: 0, tasks: [
        { id: id + 'a', name: cols[0].c.label, columnId: cols[0].c.id, order: cols[0].i, start: '2026-09-08', finish: '2026-09-09' },
        { id: id + 'b', name: cols[1].c.label, columnId: cols[1].c.id, order: cols[1].i, start: '2026-09-11', finish: '2026-09-12' },
      ] };
      jobs.push(job);
      ensureJobHasCards(job);
      boardCards.find((c) => c.jobId === id).customFields = { pm };
    };
    mk('calF1', 'Filter Job One', 'alice');
    mk('calF2', 'Filter Job Two', 'bob');
    calendarEvents.push({ id: 'calFevt', title: 'Crew meeting', start: '2026-09-10', duration: 1, repeat: 'none', repeatUntil: null, color: '#7e57c2', exceptions: {}, visibility: 'all', visibleMembers: [] });
    calendarViewDate = new Date('2026-09-15T00:00:00');
    calendarViewMode = 'month';
    renderCalendar();
    return cols.map((x) => x.c.id);
  });

  const bars = (jobId) => page.locator('#calendarDays .cal-event-bar[data-cal-job-id="' + jobId + '"]');
  await expect(bars('calF1')).toHaveCount(2);

  await page.locator('#calFilterBar').getByRole('button', { name: 'Jobs', exact: true }).click();
  await expect(bars('calF1')).toHaveCount(1);
  await expect(bars('calF1')).toHaveAttribute('data-cal-task-start', '2026-09-08');
  await expect(bars('calF1')).toHaveAttribute('data-cal-task-finish', '2026-09-12');
  await page.locator('#calFilterBar').getByRole('button', { name: 'Stages', exact: true }).click();

  await page.locator('#calFilterBar .rep-filter-btn').click();
  await page.locator('#calFilterBar select').nth(1).selectOption('alice');
  await expect(bars('calF2')).toHaveCount(0);
  await expect(bars('calF1')).toHaveCount(2);
  await expect(page.locator('.cal-event-bar', { hasText: 'Crew meeting' })).toHaveCount(0);

  await page.locator('#calFilterBar select').nth(2).selectOption(stageIds[1]);
  await expect(bars('calF1')).toHaveCount(1);
  await expect(bars('calF1')).toHaveAttribute('data-cal-task-start', '2026-09-11');

  // Removing both chips brings everything back.
  await page.locator('#calFilterBar .rep-chip button').first().click();
  await page.locator('#calFilterBar .rep-chip button').first().click();
  await expect(bars('calF2')).toHaveCount(2);
  await expect(page.locator('.cal-event-bar', { hasText: 'Crew meeting' })).toHaveCount(1);
});

test('calendar wheel navigation: a horizontal trackpad scroll pages the month, a vertical one does not', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('calendar'));
  await page.waitForFunction(() => getActiveTab() === 'calendar');
  await page.waitForTimeout(500);

  const before = await page.evaluate(() => {
    calendarViewDate = new Date('2026-09-15T00:00:00');
    calendarViewMode = 'month';
    renderCalendar();
    return toIsoDate(calendarViewDate);
  });

  // A vertical-dominant wheel event (deltaY > deltaX) must be left alone
  // entirely — handleCalWheel()'s own discrimination check — so a normal
  // scroll/zoom wheel over the calendar never accidentally pages it.
  // deltaX (80) alone clears CAL_WHEEL_THRESHOLD (50), so this only stays
  // a no-op because of the deltaX-vs-deltaY discrimination check
  // specifically, not because the accumulated delta was too small.
  const afterVertical = await page.evaluate(() => {
    const el = document.getElementById('calendarDays');
    el.dispatchEvent(new WheelEvent('wheel', { deltaX: 80, deltaY: 200, bubbles: true, cancelable: true }));
    return toIsoDate(calendarViewDate);
  });
  expect(afterVertical).toBe(before);

  // A horizontal-dominant wheel event past CAL_WHEEL_THRESHOLD (50) pages
  // to the next month via animateCalendarWheelChange()/calendarNext().
  const afterHorizontal = await page.evaluate(() => {
    const el = document.getElementById('calendarDays');
    el.dispatchEvent(new WheelEvent('wheel', { deltaX: 80, deltaY: 5, bubbles: true, cancelable: true }));
    return toIsoDate(calendarViewDate);
  });
  expect(afterHorizontal).toBe('2026-10-15');
});

test('gantt drag: moving a task bar shifts its dates by the dragged number of days', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('gantt'));

  // A fresh demo job's tasks start unscheduled (empty start/finish, one per
  // board stage — see ensureJobHasCards()) until manually scheduled, so
  // there's nothing to drag yet. Schedule the first job's first task
  // directly through the data model, then re-render so a real .task-bar
  // exists for it, the same way saving dates in the Job Manager form would.
  const before = await page.evaluate(() => {
    const job = jobs[0];
    const phase = getJobPhases(job)[0];
    const sub = getPhaseSubUnits(phase)[0];
    const t = (sub.tasks || [])[0];
    if (!t) return null;
    t.start = '2026-09-01';
    t.finish = '2026-09-05';
    renderGantt();
    return { jobId: job.id, taskId: t.id, start: t.start, finish: t.finish };
  });
  expect(before).not.toBeNull();

  const shiftedDays = 3;
  const result = await page.evaluate(
    ({ jobId, taskId, shiftedDays }) => {
      const bar = document.querySelector('.task-bar:not(.due-marker-bar)');
      if (!bar) return null;
      // startBarMove() reads e.clientX only to compute a live delta on
      // mousemove — since the rAF-coalesced move pipeline is bypassed
      // below (same reasoning as the Fix 3/Fix 4 tests: exercise the
      // committed state change directly, not the timing-sensitive
      // machinery around it), the exact clientX here doesn't matter.
      startBarMove({ clientX: 0 }, jobId, taskId, bar);
      barMoveState.deltaDays = shiftedDays;
      barMoveState.moved = true;
      onBarMoveEnd({});
      const found = findTask(jobId, taskId);
      return found ? { start: found.task.start, finish: found.task.finish } : null;
    },
    { jobId: before.jobId, taskId: before.taskId, shiftedDays }
  );

  const expected = await page.evaluate(
    ({ start, finish, shiftedDays }) => {
      const shift = (iso) => {
        const d = new Date(iso + 'T00:00:00');
        d.setDate(d.getDate() + shiftedDays);
        return toIsoDate(d);
      };
      return { start: shift(start), finish: shift(finish) };
    },
    { start: before.start, finish: before.finish, shiftedDays }
  );

  expect(result).not.toBeNull();
  expect(result.start).toBe(expected.start);
  expect(result.finish).toBe(expected.finish);
});

test('gantt bar resize: dragging the right edge extends a task and cascades every later task in the sub-unit', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('gantt'));

  // Same setup reasoning as the plain bar-move test above, but scheduling
  // the first TWO tasks in the sub-unit (not just one) so extending the
  // first one's finish date has a later task to cascade onto.
  const before = await page.evaluate(() => {
    const job = jobs[0];
    const phase = getJobPhases(job)[0];
    const sub = getPhaseSubUnits(phase)[0];
    const tasks = (sub.tasks || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const t0 = tasks[0];
    const t1 = tasks[1];
    if (!t0 || !t1) return null;
    t0.start = '2026-09-01';
    t0.finish = '2026-09-05';
    t1.start = '2026-09-06';
    t1.finish = '2026-09-10';
    renderGantt();
    return { jobId: job.id, taskId: t0.id, laterTaskId: t1.id };
  });
  expect(before).not.toBeNull();

  const extendDays = 3;
  const result = await page.evaluate(
    ({ jobId, taskId, laterTaskId, extendDays }) => {
      const bar = document.querySelector('.task-bar:not(.due-marker-bar)');
      if (!bar) return null;
      // Same reasoning as the plain bar-move test above: drive the
      // committed state change directly, bypassing the rAF-coalesced
      // mousemove pipeline (applyBarResizeMove) entirely.
      startBarResizeRight({ preventDefault() {}, stopPropagation() {}, clientX: 0 }, jobId, taskId, bar);
      barResizeState.currentDuration = barResizeState.initialDuration + extendDays;
      onBarResizeEnd({});
      const found = findTask(jobId, taskId);
      const laterFound = findTask(jobId, laterTaskId);
      return {
        finish: found ? found.task.finish : null,
        laterStart: laterFound ? laterFound.task.start : null,
        laterFinish: laterFound ? laterFound.task.finish : null,
      };
    },
    { jobId: before.jobId, taskId: before.taskId, laterTaskId: before.laterTaskId, extendDays }
  );

  expect(result).not.toBeNull();
  expect(result.finish).toBe('2026-09-08'); // 09-05 extended by 3 days
  expect(result.laterStart).toBe('2026-09-09'); // 09-06 cascaded by the same 3 days
  expect(result.laterFinish).toBe('2026-09-13'); // 09-10 cascaded by the same 3 days
});

// Stage-order rules (see cascadeShiftLaterTasks()): later moves push the
// rest of the job along; earlier moves leave later stages alone; and a later
// stage never starts before an earlier one. Three overlapping stages, the way
// jobs are really scheduled.
async function setupThreeStages(page) {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('gantt'));
  const ids = await page.evaluate(() => {
    const job = jobs[0];
    const sub = getPhaseSubUnits(getJobPhases(job)[0])[0];
    const tasks = (sub.tasks || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    if (tasks.length < 3) return null;
    tasks.forEach((t) => { t.start = ''; t.finish = ''; });
    tasks[0].start = '2026-09-01'; tasks[0].finish = '2026-09-10';
    tasks[1].start = '2026-09-05'; tasks[1].finish = '2026-09-15';
    tasks[2].start = '2026-09-12'; tasks[2].finish = '2026-09-20';
    renderGantt();
    return { jobId: job.id, taskIds: tasks.slice(0, 3).map((t) => t.id) };
  });
  expect(ids).not.toBeNull();
  return ids;
}

function readStages(page, ids) {
  return page.evaluate(({ jobId, taskIds }) =>
    taskIds.map((id) => { const t = findTask(jobId, id).task; return [t.start, t.finish]; }), ids);
}

function moveStage(page, ids, index, days) {
  return page.evaluate(({ jobId, taskIds, index, days }) => {
    const t = findTask(jobId, taskIds[index]).task;
    const s = new Date(t.start + 'T00:00:00'); s.setDate(s.getDate() + days);
    const f = new Date(t.finish + 'T00:00:00'); f.setDate(f.getDate() + days);
    t.start = toIsoDate(s); t.finish = toIsoDate(f);
    cascadeShiftLaterTasks(jobId, taskIds[index], days);
  }, { ...ids, index, days });
}

test('gantt stage order: moving a stage later pushes later stages by the same amount, keeping overlaps', async ({ page }) => {
  const ids = await setupThreeStages(page);
  await moveStage(page, ids, 0, 3);
  expect(await readStages(page, ids)).toEqual([
    ['2026-09-04', '2026-09-13'], ['2026-09-08', '2026-09-18'], ['2026-09-15', '2026-09-23'],
  ]);
});

test('gantt stage order: moving a stage earlier leaves later stages where they are', async ({ page }) => {
  const ids = await setupThreeStages(page);
  await moveStage(page, ids, 1, -2);
  expect(await readStages(page, ids)).toEqual([
    ['2026-09-01', '2026-09-10'], ['2026-09-03', '2026-09-13'], ['2026-09-12', '2026-09-20'],
  ]);
});

test('gantt stage order: dragging a stage back past an earlier stage pulls that stage back with it', async ({ page }) => {
  const ids = await setupThreeStages(page);
  await moveStage(page, ids, 2, -13); // stage 3 now starts 08-30, before both others
  expect(await readStages(page, ids)).toEqual([
    ['2026-08-30', '2026-09-08'], ['2026-08-30', '2026-09-09'], ['2026-08-30', '2026-09-07'],
  ]);
});

test('gantt stage order: resizing a stage start past the next stage pushes the next stage along', async ({ page }) => {
  const ids = await setupThreeStages(page);
  const result = await page.evaluate(({ jobId, taskIds }) => {
    const bar = document.querySelector('.task-bar:not(.due-marker-bar)');
    startBarResizeLeft({ preventDefault() {}, stopPropagation() {}, clientX: 0 }, jobId, taskIds[0], bar);
    barResizeState.currentDuration = 3; // start moves 09-01 -> 09-08, past stage 2's 09-05
    onBarResizeEnd({});
    return true;
  }, ids);
  expect(result).toBe(true);
  expect(await readStages(page, ids)).toEqual([
    ['2026-09-08', '2026-09-10'], ['2026-09-08', '2026-09-18'], ['2026-09-12', '2026-09-20'],
  ]);
});

// Same order rules one level up: a phase split into sub-phases. Sub-phase
// A runs 09-01..09-10, B 09-05..09-15 (overlapping), C 09-12..09-20.
// The phase starts collapsed in Tasks view (one bar for the whole phase).
async function setupThreeSubPhases(page, { realMouse = false } = {}) {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('gantt'));
  if (realMouse) {
    // See the real-mouse bar drag test below — the tab morph has to settle
    // before on-screen positions mean anything.
    await page.waitForFunction(() => getActiveTab() === 'gantt');
    await page.waitForTimeout(1500);
  }
  const ids = await page.evaluate(() => {
    const job = jobs[0];
    // A real (stored) phase — an unphased job's default phase is synthetic.
    job.phases = [{ id: 'ph-test', name: 'Install', order: 0, tasks: job.tasks || [], isDefault: false }];
    job.tasks = [];
    const phase = job.phases[0];
    splitPhaseIntoSubPhases(phase);
    addPhaseSubUnit(phase);
    addPhaseSubUnit(phase);
    const ranges = [['2026-09-01', '2026-09-10'], ['2026-09-05', '2026-09-15'], ['2026-09-12', '2026-09-20']];
    phase.subPhases.forEach((sub, i) => {
      (sub.tasks || []).forEach((t) => { t.start = ''; t.finish = ''; });
      const first = sub.tasks.slice().sort((a, b) => (a.order || 0) - (b.order || 0))[0];
      first.start = ranges[i][0]; first.finish = ranges[i][1];
    });
    renderGantt();
    return { jobId: job.id, phaseId: phase.id, subIds: phase.subPhases.map((sp) => sp.id) };
  });
  return ids;
}

function readSubPhases(page, ids) {
  return page.evaluate(({ jobId, phaseId }) => {
    const phase = getJobPhases(findJob(jobId).job).find((p) => p.id === phaseId);
    return phase.subPhases.map((sp) => {
      const t = sp.tasks.filter((x) => x.start).map((x) => [x.start, x.finish]);
      return t[0];
    });
  }, ids);
}

function dragSpan(page, ids, subId, days) {
  return page.evaluate(({ jobId, phaseId, subId, days }) => {
    const bar = document.querySelector('.task-bar');
    startBarMove({ clientX: 0 }, jobId, 'x', bar, true, phaseId, subId);
    barMoveState.moved = true;
    barMoveState.deltaDays = days;
    onBarMoveEnd({});
  }, { ...ids, subId, days });
}

test('gantt sub-phase order: moving a sub-phase later leaves the next one alone until its start passes it', async ({ page }) => {
  const ids = await setupThreeSubPhases(page);
  await dragSpan(page, ids, ids.subIds[0], 4); // A now starts 09-05 — same day as B, not past it
  expect(await readSubPhases(page, ids)).toEqual([
    ['2026-09-05', '2026-09-14'], ['2026-09-05', '2026-09-15'], ['2026-09-12', '2026-09-20'],
  ]);
});

test('gantt sub-phase order: dragging a sub-phase\'s start past the next one pushes it only as far as needed', async ({ page }) => {
  const ids = await setupThreeSubPhases(page);
  await dragSpan(page, ids, ids.subIds[0], 13); // A now starts 09-14, past B (09-05) and C (09-12)
  expect(await readSubPhases(page, ids)).toEqual([
    ['2026-09-14', '2026-09-23'], ['2026-09-14', '2026-09-24'], ['2026-09-14', '2026-09-22'],
  ]);
});

test('gantt sub-phase order: moving a sub-phase earlier leaves later ones; crossing an earlier one pulls it back', async ({ page }) => {
  const ids = await setupThreeSubPhases(page);
  await dragSpan(page, ids, ids.subIds[1], -2);
  expect(await readSubPhases(page, ids)).toEqual([
    ['2026-09-01', '2026-09-10'], ['2026-09-03', '2026-09-13'], ['2026-09-12', '2026-09-20'],
  ]);
  await dragSpan(page, ids, ids.subIds[2], -12); // C now starts 08-31, before A and B
  expect(await readSubPhases(page, ids)).toEqual([
    ['2026-08-31', '2026-09-09'], ['2026-08-31', '2026-09-10'], ['2026-08-31', '2026-09-08'],
  ]);
});

test('gantt sub-phase order: moving a stage past the start of the next sub-phase pushes that sub-phase along', async ({ page }) => {
  const ids = await setupThreeSubPhases(page);
  await page.evaluate(({ jobId, phaseId }) => {
    const phase = getJobPhases(findJob(jobId).job).find((p) => p.id === phaseId);
    const t = phase.subPhases[0].tasks.find((x) => x.start);
    t.start = '2026-09-08'; t.finish = '2026-09-17'; // A's only stage moved 7 days later
    cascadeShiftLaterTasks(jobId, t.id, 7);
  }, ids);
  // B started 09-05, now before A's 09-08 — pushed 3 days; C (09-12) still fine.
  expect(await readSubPhases(page, ids)).toEqual([
    ['2026-09-08', '2026-09-17'], ['2026-09-08', '2026-09-18'], ['2026-09-12', '2026-09-20'],
  ]);
});

// Same rules between a job's phases. Phase 1 is split into two
// sub-phases (09-01..09-05 and 09-04..09-08, shown collapsed); Phase 2 is
// unsplit, 09-10..09-15.
async function setupTwoPhases(page) {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('gantt'));
  return page.evaluate(() => {
    const job = jobs[0];
    const blank = () => (job.tasks || []).map((t) => ({ ...t, id: t.id + '-' + Math.random().toString(36).slice(2), start: '', finish: '' }));
    job.phases = [
      { id: 'ph-1', name: 'Phase 1', order: 0, tasks: blank(), isDefault: false },
      { id: 'ph-2', name: 'Phase 2', order: 1, tasks: blank(), isDefault: false },
    ];
    job.tasks = [];
    const [p1, p2] = job.phases;
    splitPhaseIntoSubPhases(p1);
    addPhaseSubUnit(p1);
    const first = (tasks) => tasks.slice().sort((a, b) => (a.order || 0) - (b.order || 0))[0];
    p1.subPhases.forEach((sp) => sp.tasks.forEach((t) => { t.start = ''; t.finish = ''; }));
    Object.assign(first(p1.subPhases[0].tasks), { start: '2026-09-01', finish: '2026-09-05' });
    Object.assign(first(p1.subPhases[1].tasks), { start: '2026-09-04', finish: '2026-09-08' });
    Object.assign(first(p2.tasks), { start: '2026-09-10', finish: '2026-09-15' });
    renderGantt();
    return { jobId: job.id };
  });
}

function readPhases(page, ids) {
  return page.evaluate(({ jobId }) => findJob(jobId).job.phases.map((ph) =>
    getPhaseSubUnits(ph).map((u) => { const t = u.tasks.find((x) => x.start); return t ? [t.start, t.finish] : null; })
  ), ids);
}

function dragPhase(page, ids, phaseId, days) {
  return page.evaluate(({ jobId, phaseId, days }) => {
    const bar = document.querySelector('.task-bar');
    startBarMove({ clientX: 0 }, jobId, 'x', bar, true, phaseId, null);
    barMoveState.moved = true;
    barMoveState.deltaDays = days;
    onBarMoveEnd({});
  }, { ...ids, phaseId, days });
}

test('gantt phase order: moving a phase later leaves the next phase alone until its start passes it', async ({ page }) => {
  const ids = await setupTwoPhases(page);
  await dragPhase(page, ids, 'ph-1', 5); // Phase 1 now starts 09-06, still before Phase 2's 09-10
  expect(await readPhases(page, ids)).toEqual([
    [['2026-09-06', '2026-09-10'], ['2026-09-09', '2026-09-13']],
    [['2026-09-10', '2026-09-15']],
  ]);
});

test('gantt phase order: dragging a phase\'s start past the next phase pushes that phase only as far as needed', async ({ page }) => {
  const ids = await setupTwoPhases(page);
  await dragPhase(page, ids, 'ph-1', 12); // Phase 1 now starts 09-13, past Phase 2's 09-10
  expect(await readPhases(page, ids)).toEqual([
    [['2026-09-13', '2026-09-17'], ['2026-09-16', '2026-09-20']],
    [['2026-09-13', '2026-09-18']],
  ]);
});

test('gantt phase order: dragging a phase back past an earlier phase pulls that phase back with it', async ({ page }) => {
  const ids = await setupTwoPhases(page);
  await dragPhase(page, ids, 'ph-2', -12); // Phase 2 now starts 08-29, before Phase 1's 09-01
  expect(await readPhases(page, ids)).toEqual([
    [['2026-08-29', '2026-09-02'], ['2026-09-01', '2026-09-05']],
    [['2026-08-29', '2026-09-03']],
  ]);
});

test('gantt phase order: moving a phase earlier without crossing leaves the other phase alone', async ({ page }) => {
  const ids = await setupTwoPhases(page);
  await dragPhase(page, ids, 'ph-2', -3);
  expect(await readPhases(page, ids)).toEqual([
    [['2026-09-01', '2026-09-05'], ['2026-09-04', '2026-09-08']],
    [['2026-09-07', '2026-09-12']],
  ]);
});

test('gantt collapsed phase: grabbing where sub-phases overlap drags the whole phase (real mouse)', async ({ page }) => {
  const ids = await setupThreeSubPhases(page, { realMouse: true });
  // The overlap hatch is click-through, so the grab lands on the phase's
  // own bar underneath — which used to find no sub-phase and do nothing.
  const hatch = page.locator('.job-span-task-hatch[data-phase-id="' + ids.phaseId + '"]').first();
  await hatch.scrollIntoViewIfNeeded();
  const box = await hatch.boundingBox();
  const x = box.x + box.width - 6, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 68, y, { steps: 6 }); // ~2 cells at dayWidth 34
  await page.mouse.up();
  const after = await readSubPhases(page, ids);
  // Every sub-phase moved by the same (positive) number of days.
  const shift = (a, b) => Math.round((new Date(a) - new Date(b)) / 86400000);
  const d = shift(after[0][0], '2026-09-01');
  expect(d).toBeGreaterThan(0);
  expect(shift(after[1][0], '2026-09-05')).toBe(d);
  expect(shift(after[2][0], '2026-09-12')).toBe(d);
});

test('gantt condensed bar: dragging one piece previews its whole length and dims the rest (no ghost left behind)', async ({ page }) => {
  const ids = await setupThreeSubPhases(page, { realMouse: true });
  const solid = page.locator('.job-span-task-solid[data-phase-id="' + ids.phaseId + '"][data-sub-phase-id="' + ids.subIds[0] + '"]');
  await solid.scrollIntoViewIfNeeded();
  const fullWidth = Number(await solid.getAttribute('data-full-width'));
  const box = await solid.boundingBox();
  expect(fullWidth).toBeGreaterThan(box.width); // part of A overlaps B
  await page.mouse.move(box.x + 4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 30, box.y + box.height / 2, { steps: 5 });
  const mid = await page.evaluate(() => ({
    width: parseFloat(document.querySelector('.job-span-task-solid.moving').style.width),
    dimmed: document.querySelectorAll('.gantt-drag-dim').length,
  }));
  expect(mid.width).toBe(fullWidth);
  expect(mid.dimmed).toBeGreaterThan(0);
  await page.mouse.up();
  expect(await page.locator('.gantt-drag-dim').count()).toBe(0);
});

test('gantt bar drag (real mouse events): dragging a bar body moves its dates, exercising renderTimelineBars()\'s own mousedown wiring', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('gantt'));
  // switchTabMorphed() finishes its morph transition asynchronously —
  // the panel isn't reliably laid out with real pixel dimensions until
  // it settles, which
  // this test's real page.mouse coordinates depend on (unlike the other
  // Gantt tests here, which drive handlers directly and never need real
  // on-screen positions). getActiveTab() flips before the CSS morph
  // transition actually finishes settling the panel's layout, and under
  // full-suite parallel load (6 workers contending for the CPU) that
  // transition's wall-clock time stretches well past its nominal CSS
  // duration — waiting on the tab-state condition alone still flaked, so
  // this also gives the transition itself real room to finish.
  await page.waitForFunction(() => getActiveTab() === 'gantt');
  await page.waitForTimeout(1500);

  // Every other Gantt drag test in this file drives startBarMove()/
  // onBarMoveEnd() directly, bypassing the browser's real mousedown/
  // mousemove/mouseup chain entirely — that's deliberate (see their own
  // comments) to isolate the committed-state logic from rAF/event timing.
  // This test instead exercises the actual DOM wiring renderTimelineBars()
  // creates (bar.addEventListener('mousedown', ...)) via Playwright's real
  // mouse API, the one thing none of those other tests can catch if it
  // broke. A wide (multi-week) bar is used deliberately — the bar's own
  // job-name tag (<span class="task-bar-job-tag collapsible">) is
  // pointer-events:auto and stopPropagation()s its own mousedown so
  // clicking THAT toggles job-focus instead of starting a drag (see its
  // own comment in gantt.ts); a wide bar leaves clear space near its right
  // end, past the tag, to grab the bar body itself instead.
  const before = await page.evaluate(() => {
    const job = jobs[0];
    const phase = getJobPhases(job)[0];
    const sub = getPhaseSubUnits(phase)[0];
    const t = (sub.tasks || [])[0];
    if (!t) return null;
    // Dates relative to today: the Gantt opens scrolled to today, so a
    // bar with fixed dates drifts off-screen as the calendar moves on.
    // The bar ends just after today so its right end is on-screen.
    const iso = (offset) => {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    };
    t.start = iso(-12);
    t.finish = iso(3);
    renderGantt();
    return { jobId: job.id, taskId: t.id, expectStart: iso(-14), expectFinish: iso(1) };
  });
  expect(before).not.toBeNull();

  const bar = page.locator('.task-bar:not(.due-marker-bar)').first();
  const box = await bar.boundingBox();
  await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 20 - 68, box.y + box.height / 2, { steps: 5 }); // ~2 cells left at dayWidth 34
  await page.mouse.up();

  const result = await page.evaluate(
    ({ jobId, taskId }) => {
      const found = findTask(jobId, taskId);
      return found ? { start: found.task.start, finish: found.task.finish } : null;
    },
    before
  );

  expect(result).not.toBeNull();
  expect(result.start).toBe(before.expectStart); // shifted 2 days earlier
  expect(result.finish).toBe(before.expectFinish); // shifted the same 2 days
});

test('regression: hovering two different Gantt date headers shows each one\'s own date, not always the last', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('gantt'));
  await page.waitForFunction(() => getActiveTab() === 'gantt');
  await page.waitForTimeout(1500);

  // Real bug in buildDateHeader() (src/views/gantt.ts): the loop's
  // `current` Date is one object mutated in place across every
  // iteration, so every day-header's click/mouseenter
  // closure captured the SAME object — by the time a user actually
  // hovered one, `current` already held the loop's final date, so every
  // header showed the same (wrong, last-in-range) popover date. Fixed by
  // snapshotting a fresh Date per iteration before wiring the listeners.
  const todayHeader = page.locator('.day-header.today-header');
  const todayDate = await todayHeader.getAttribute('data-date');
  await todayHeader.hover();
  const popoverToday = await page.locator('#datePopover h5').textContent();

  // Three cells over — still a header rendered by the SAME loop, so this
  // is exactly the scenario the shared-mutable-object bug broke.
  const laterHeader = todayHeader.locator('xpath=following-sibling::div[@class="day-header"][3]');
  const laterDate = await laterHeader.getAttribute('data-date');
  await laterHeader.hover();
  const popoverLater = await page.locator('#datePopover h5').textContent();

  expect(todayDate).not.toBe(laterDate);
  const expectedToday = await page.evaluate((iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }), todayDate);
  const expectedLater = await page.evaluate((iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }), laterDate);
  expect(popoverToday).toBe(expectedToday);
  expect(popoverLater).toBe(expectedLater);
});

test('gantt zoom: zoomIn/zoomOut/resetZoom step dayWidth and clamp to [14, 80]', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('gantt'));
  await page.waitForFunction(() => getActiveTab() === 'gantt');
  await page.waitForTimeout(1500);

  const result = await page.evaluate(() => {
    dayWidth = 34;
    zoomIn();
    const afterIn = dayWidth;
    zoomOut();
    zoomOut();
    const afterOut = dayWidth;
    resetZoom();
    const afterReset = dayWidth;
    // Clamping: pushing zoomOut far past the floor should settle at
    // GANTT_ZOOM_MIN (14), not keep going negative or hit 0.
    for (let i = 0; i < 15; i++) zoomOut();
    const clampedLow = dayWidth;
    for (let i = 0; i < 20; i++) zoomIn();
    const clampedHigh = dayWidth;
    return { afterIn, afterOut, afterReset, clampedLow, clampedHigh };
  });

  expect(result.afterIn).toBe(40); // 34 + 6
  expect(result.afterOut).toBe(28); // 40 - 6 - 6
  expect(result.afterReset).toBe(34);
  expect(result.clampedLow).toBe(14);
  expect(result.clampedHigh).toBe(80);
});

test('help: the ? button opens Help on the current page\'s section, the Gantt section holds the key, and Escape or an outside click closes it', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('gantt'));
  await page.waitForFunction(() => getActiveTab() === 'gantt');

  // One stage with its own color, the rest without — the key lists the
  // colored one as a swatch and names the others as using the job's color.
  const { coloredLabel, otherLabel } = await page.evaluate(() => {
    BOARD_COLUMNS.forEach((c, i) => { c.color = i === 0 ? '#4dd0e1' : undefined; });
    return { coloredLabel: BOARD_COLUMNS[0].label, otherLabel: BOARD_COLUMNS[1].label };
  });

  const btn = page.locator('#helpBtn');
  const panel = page.locator('#helpPanel');
  // The key is in the Gantt section of Help now (no ⓘ on the pill).
  await expect(page.locator('#ganttKeyBtn')).toHaveCount(0);
  await page.waitForTimeout(600);
  await expect(panel).toBeHidden();
  await btn.click();
  await expect(panel).toBeVisible();
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  // Opened on the page you're on: only the Gantt section is unfolded.
  await expect(panel.locator('.help-section[open]')).toHaveCount(1);
  const gantt = panel.locator('.help-section[data-section="gantt"]');
  await expect(gantt).toHaveAttribute('open', '');
  await expect(gantt.locator('.gantt-key-stages li')).toHaveText([coloredLabel]);
  await expect(gantt.locator('.gantt-key-note').last()).toContainText(otherLabel);
  await expect(gantt).toContainText('Stripes');
  await expect(gantt).not.toContainText(/turn (the )?stripes off/i);
  // The tour starts from Help now, not Settings.
  await expect(panel.locator('#helpTourBtn')).toBeVisible();
  await expect(page.locator('#replayTourBtn')).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  await expect(btn).toBeFocused();

  await btn.click();
  await expect(panel).toBeVisible();
  await page.mouse.click(300, 400);
  await expect(panel).toBeHidden();
});

test('gantt zoom: fitToView computes a dayWidth that fits the whole visible date range in the container', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('gantt'));
  await page.waitForFunction(() => getActiveTab() === 'gantt');
  await page.waitForTimeout(1500);

  const result = await page.evaluate(() => {
    const job = jobs[0];
    const phase = getJobPhases(job)[0];
    const sub = getPhaseSubUnits(phase)[0];
    const t = (sub.tasks || [])[0];
    t.start = '2026-09-01';
    t.finish = '2026-09-10';
    renderGantt();
    fitToView();
    computeDateRange();
    const totalDays = getDaysDiff(startDate, endDate) + 1;
    const containerWidth = document.getElementById('timelineBody').clientWidth - 20;
    const expectedFitted = Math.max(Math.floor(containerWidth / totalDays), 14);
    return { dayWidth, expectedFitted };
  });

  expect(result.dayWidth).toBe(result.expectedFitted);
});

test('board column CRUD: add, rename, and delete a column via the real modal/prompt flow', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  // Add
  const columnLabel = 'Playwright Test Board ' + Date.now();
  const addedId = await page.evaluate((label) => {
    addBoardColumn(label);
    return BOARD_COLUMNS.find((c) => c.label === label).id;
  }, columnLabel);
  expect(addedId).toBeTruthy();

  // Rename — deleteBoardColumn()/renameBoardColumn() use the native
  // confirm()/prompt() dialogs; Playwright auto-dismisses dialogs unless
  // a handler accepts them first.
  const renamedLabel = columnLabel + ' (renamed)';
  page.once('dialog', (d) => d.accept(renamedLabel));
  await page.evaluate((id) => renameBoardColumn(id), addedId);
  const afterRename = await page.evaluate((id) => BOARD_COLUMNS.find((c) => c.id === id).label, addedId);
  expect(afterRename).toBe(renamedLabel);

  // Delete — accepting the confirm() dialog
  page.once('dialog', (d) => d.accept());
  await page.evaluate((id) => deleteBoardColumn(id), addedId);
  const stillExists = await page.evaluate((id) => BOARD_COLUMNS.some((c) => c.id === id), addedId);
  expect(stillExists).toBe(false);
});

test('board column CRUD: the Complete and Invoiced columns cannot be deleted', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const before = await page.evaluate(() => BOARD_COLUMNS.length);
  // Accept the confirm() dialog so this test actually isolates the
  // complete/invoiced special-case guard — without this, Playwright's
  // default dialog auto-dismiss (confirm() returning false) would make
  // the assertion below pass for the WRONG reason even if that guard
  // were removed, since the later confirm() check would still block the
  // delete on its own. Confirmed this the hard way: the guard was
  // temporarily removed and this test still passed until this handler
  // was added.
  page.on('dialog', (d) => d.accept());
  await page.evaluate(() => deleteBoardColumn('complete'));
  const after = await page.evaluate(() => BOARD_COLUMNS.length);
  expect(after).toBe(before);
});

test('column settings dropdown: isDarkColor classifies known light/dark hex colors correctly', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await page.goto(APP_URL);
  await expect(page.locator('#loginOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => ({
    black: isDarkColor('#000000'),
    white: isDarkColor('#ffffff'),
    indigo: isDarkColor('#3949ab'), // this app's own default accent — dark enough for white text
  }));
  expect(result).toEqual({ black: true, white: false, indigo: true });
});

test('column settings dropdown: changing a column\'s color propagates to every job task in that column, and resetting clears it', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const col = BOARD_COLUMNS[0];
    const fakeEvent = { stopPropagation() {} };
    changeColumnColor(col.id, '#ff5722', fakeEvent);
    const afterSet = col.color;
    changeColumnColor(col.id, '', fakeEvent);
    return { afterSet, afterReset: col.color };
  });

  expect(result.afterSet).toBe('#ff5722');
  expect(result.afterReset).toBeUndefined();
});

test('column settings dropdown: schedule visibility, schedule sync, and finished-trigger toggles flip their own column flags independently', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const col = BOARD_COLUMNS[0];
    const before = { hideFromSchedule: !!col.hideFromSchedule, scheduleDisconnected: !!col.scheduleDisconnected, isFinished: isFinishedColumn(col) };
    toggleColumnScheduleVisibility(col.id);
    toggleColumnScheduleSync(col.id);
    toggleColumnFinishedTrigger(col.id);
    const after = { hideFromSchedule: !!col.hideFromSchedule, scheduleDisconnected: !!col.scheduleDisconnected, isFinished: isFinishedColumn(col) };
    return { before, after };
  });

  expect(result.after.hideFromSchedule).toBe(!result.before.hideFromSchedule);
  expect(result.after.scheduleDisconnected).toBe(!result.before.scheduleDisconnected);
  expect(result.after.isFinished).toBe(!result.before.isFinished);
});

test('column settings dropdown: workflow item, checklist auto-assign/assignee, and default-duration/stalled-threshold settings all persist onto the column', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const col = BOARD_COLUMNS[0];
    const item = WORKFLOW_ITEMS[0] || { id: 'wf-test', label: 'Test Item' };
    if (!WORKFLOW_ITEMS.length) WORKFLOW_ITEMS.push(item);

    setColumnWorkflowItem(col.id, item.id);
    const beforeAutoAssign = !!col.autoAssignChecklist;
    toggleColumnAutoAssignChecklist(col.id);
    setColumnChecklistAssignee(col.id, 'testadmin');
    // Invalid values fall back to the app-wide defaults, not NaN/0.
    setColumnDefaultDuration(col.id, 'not-a-number');
    setColumnStalledThreshold(col.id, '9');

    return {
      workflowItemId: col.workflowItemId,
      autoAssignChecklist: { before: beforeAutoAssign, after: !!col.autoAssignChecklist },
      checklistAssigneeOverride: col.checklistAssigneeOverride,
      defaultDuration: col.defaultDuration,
      expectedDefaultDuration: DEFAULT_TASK_DURATION_DAYS,
      stalledAfterDays: col.stalledAfterDays,
    };
  });

  expect(result.workflowItemId).toBeTruthy();
  expect(result.autoAssignChecklist.after).toBe(!result.autoAssignChecklist.before);
  expect(result.checklistAssigneeOverride).toBe('testadmin');
  expect(result.defaultDuration).toBe(result.expectedDefaultDuration);
  expect(result.stalledAfterDays).toBe(9);
});

test('reconnectCard: clears a card\'s manual-column pin', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const card = boardCards[0];
    card.manualColumn = 'active';
    card.manualColumnUntil = Date.now() + 86400000;
    reconnectCard(card.id);
    return { manualColumn: card.manualColumn, manualColumnUntil: card.manualColumnUntil };
  });

  expect(result.manualColumn).toBeNull();
  expect(result.manualColumnUntil).toBeNull();
});

test('column settings dropdown: opening one column\'s dropdown closes any other that was already open', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('board'));

  const result = await page.evaluate(() => {
    const [colA, colB] = BOARD_COLUMNS;
    const fakeEvent = { stopPropagation() {} };
    toggleColSettings(colA.id, fakeEvent);
    const aOpenFirst = document.getElementById('col-settings-' + colA.id).classList.contains('show');
    toggleColSettings(colB.id, fakeEvent);
    return {
      aOpenFirst,
      aOpenAfterB: document.getElementById('col-settings-' + colA.id).classList.contains('show'),
      bOpen: document.getElementById('col-settings-' + colB.id).classList.contains('show'),
    };
  });

  expect(result.aOpenFirst).toBe(true);
  expect(result.aOpenAfterB).toBe(false);
  expect(result.bOpen).toBe(true);
});

test('column color swatches: arrow keys move roving tabindex/focus without selecting; Enter commits the focused swatch', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('board'));
  await page.waitForTimeout(500); // switchTabMorphed's transition is async — see its own note elsewhere in this suite

  const colId = await page.evaluate(() => {
    const col = BOARD_COLUMNS[0];
    delete col.color; // start from the "no color" (first) swatch, deterministic
    renderBoard();
    toggleColSettings(col.id, { stopPropagation() {} });
    return col.id;
  });
  await page.locator('#col-settings-' + colId + ' .board-col-color-toggle').click();

  const grid = page.locator('#col-colors-' + colId);
  const swatches = grid.locator('.board-col-color-option');
  const swatchCount = await swatches.count();
  expect(swatchCount).toBeGreaterThan(1);

  // Only the selected ("no color") swatch should be a tab stop initially.
  await expect(swatches.nth(0)).toHaveAttribute('tabindex', '0');
  await expect(swatches.nth(1)).toHaveAttribute('tabindex', '-1');

  await swatches.nth(0).focus();
  await page.keyboard.press('ArrowRight');

  // Focus and the roving tab stop move to the second swatch — but the
  // underlying data must NOT have changed yet. Arrow keys deliberately
  // don't auto-select here: changeColumnColor() closes the whole settings
  // panel as its last step, so selecting on every arrow press would close
  // the picker after the very first key press.
  const afterArrowRight = await page.evaluate((cid) => ({
    activeIsSecondSwatch: document.activeElement === document.querySelectorAll('#col-colors-' + cid + ' .board-col-color-option')[1],
    columnColor: BOARD_COLUMNS.find((c) => c.id === cid).color,
  }), colId);
  expect(afterArrowRight.activeIsSecondSwatch).toBe(true);
  expect(afterArrowRight.columnColor).toBeUndefined();
  await expect(swatches.nth(0)).toHaveAttribute('tabindex', '-1');
  await expect(swatches.nth(1)).toHaveAttribute('tabindex', '0');

  // ArrowDown moves by the grid's real column count, not just +1 —
  // confirms the computed grid-template-columns count, not a hardcoded
  // guess, drives navigation. Still no selection change.
  await page.keyboard.press('ArrowDown');
  const columnCount = await grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  const afterArrowDown = await page.evaluate((cid) => {
    const els = document.querySelectorAll('#col-colors-' + cid + ' .board-col-color-option');
    return { activeIndex: Array.from(els).indexOf(document.activeElement), columnColor: BOARD_COLUMNS.find((c) => c.id === cid).color };
  }, colId);
  expect(afterArrowDown.activeIndex).toBe(1 + columnCount);
  expect(afterArrowDown.columnColor).toBeUndefined();

  // Enter commits whatever swatch is currently focused — the same
  // pre-existing activation this widget already had, now reachable after
  // arrowing to any swatch in the grid, not just the one that started
  // with a tab stop.
  await page.keyboard.press('Enter');
  const afterEnter = await page.evaluate(({ cid, idx }) => ({
    color: BOARD_COLUMNS.find((c) => c.id === cid).color,
    expectedColor: BOARD_COLOR_PRESETS[idx],
  }), { cid: colId, idx: columnCount });
  expect(afterEnter.color).toBe(afterEnter.expectedColor);
});

test('Manage Column Checklist modal: adding and removing a default item persists onto the column and renders in the real modal body', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('board'));

  const result = await page.evaluate(() => {
    const col = BOARD_COLUMNS[0];
    openManageColumnChecklist(col.id);
    const input = document.getElementById('mcc_new_item');
    input.value = 'Confirm rebar delivery';
    addColumnChecklistDefaultItem();
    const afterAdd = {
      columnHasItem: (col.defaultChecklist || []).some((i) => i.text === 'Confirm rebar delivery'),
      bodyHtmlHasItem: document.getElementById('manageColumnChecklistBody').innerHTML.includes('Confirm rebar delivery'),
    };
    const addedItem = col.defaultChecklist.find((i) => i.text === 'Confirm rebar delivery');
    removeColumnChecklistDefaultItem(addedItem.id);
    const afterRemove = (col.defaultChecklist || []).some((i) => i.id === addedItem.id);
    closeManageColumnChecklist();
    return { afterAdd, afterRemove };
  });

  expect(result.afterAdd.columnHasItem).toBe(true);
  expect(result.afterAdd.bodyHtmlHasItem).toBe(true);
  expect(result.afterRemove).toBe(false);
});

test('My Checklist: adding a manual item, marking it done, and deleting it all persist onto the card — a manually-added item is spliced out entirely, not soft-deleted', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const card = boardCards[0];
    document.body.insertAdjacentHTML('beforeend', '<input id="test_mci_input" value="Order rebar">');
    addMyChecklistItem(activeProjectId, card.id, card.column, 'test_mci_input');
    const added = card.checklists[card.column].find((i) => i.text === 'Order rebar');
    const afterAdd = { found: !!added, done: added && added.done };

    toggleMyChecklistItemDone(activeProjectId, card.id, card.column, added.id);
    const afterToggle = card.checklists[card.column].find((i) => i.id === added.id).done;

    // deleteMyChecklistItem() REASSIGNS card.checklists[columnId] to a new
    // filtered array rather than mutating the existing one in place — must
    // re-read it fresh here rather than reuse an earlier array reference,
    // or a stale reference would make a real splice look like a no-op.
    deleteMyChecklistItem(activeProjectId, card.id, card.column, added.id);
    const afterDelete = card.checklists[card.column].some((i) => i.id === added.id);

    return { afterAdd, afterToggle, afterDelete };
  });

  expect(result.afterAdd).toEqual({ found: true, done: false });
  expect(result.afterToggle).toBe(true);
  expect(result.afterDelete).toBe(false); // spliced out, not left behind with removed:true
});

test('My Checklist: deleting a template-sourced item soft-deletes it (flags removed) instead of splicing it out, so it can\'t be resurrected', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const card = boardCards[0];
    const col = BOARD_COLUMNS.find((c) => c.id === card.column);
    col.defaultChecklist = [{ id: 'tmpl-inspect', text: 'Inspect forms' }];
    ensureCardChecklists(card);
    // Simulates a template item that's already been materialized onto this
    // card (the real path is getChecklistForStageInProject(), already
    // covered by its own unit tests) — this test is specifically about
    // deleteMyChecklistItem()'s template-vs-manual branch.
    card.checklists[card.column] = [{ id: 'tmpl-inspect', text: 'Inspect forms', done: false, assignee: '' }];

    deleteMyChecklistItem(activeProjectId, card.id, card.column, 'tmpl-inspect');
    const item = card.checklists[card.column].find((i) => i.id === 'tmpl-inspect');
    return { stillPresent: !!item, removedFlag: item && item.removed };
  });

  expect(result.stillPresent).toBe(true);
  expect(result.removedFlag).toBe(true);
});

test('My Checklist: sub-items can be added, toggled done, and deleted independently of their parent item', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const card = boardCards[0];
    ensureCardChecklists(card);
    card.checklists[card.column] = [{ id: 'item-1', text: 'Frame walls', done: false, assignee: '' }];

    document.body.insertAdjacentHTML('beforeend', '<input id="test_sub_input" value="Order lumber">');
    addMyChecklistSubItem(activeProjectId, card.id, card.column, 'item-1', 'test_sub_input');
    const item = card.checklists[card.column][0];
    const afterAdd = { count: (item.subItems || []).length, done: item.subItems[0].done };

    const subId = item.subItems[0].id;
    toggleMyChecklistSubItemDone(activeProjectId, card.id, card.column, 'item-1', subId);
    const afterToggle = item.subItems[0].done;

    deleteMyChecklistSubItem(activeProjectId, card.id, card.column, 'item-1', subId);
    const afterDelete = item.subItems.length;

    return { afterAdd, afterToggle, afterDelete };
  });

  expect(result.afterAdd).toEqual({ count: 1, done: false });
  expect(result.afterToggle).toBe(true);
  expect(result.afterDelete).toBe(0);
});

test('My Checklist: setMyChecklistItemAssignee adds and removes a username from an item\'s assignee list', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const card = boardCards[0];
    ensureCardChecklists(card);
    card.checklists[card.column] = [{ id: 'item-1', text: 'Frame walls', done: false, assignee: [] }];

    setMyChecklistItemAssignee(activeProjectId, card.id, card.column, 'item-1', 'testadmin', true);
    const afterAssign = card.checklists[card.column][0].assignee.slice();

    setMyChecklistItemAssignee(activeProjectId, card.id, card.column, 'item-1', 'testadmin', false);
    const afterUnassign = card.checklists[card.column][0].assignee.slice();

    return { afterAssign, afterUnassign };
  });

  expect(result.afterAssign).toEqual(['testadmin']);
  expect(result.afterUnassign).toEqual([]);
});

test('My Checklist: setMyChecklistStageAssignee is blocked below Project Admin, and works for a Project Admin', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const card = boardCards[0];
    ensureCardChecklists(card);

    currentUserRole = 'editor'; // below projectAdmin — canAssignChecklistStages() must reject
    setMyChecklistStageAssignee(activeProjectId, card.id, card.column, 'alice', true);
    const afterEditorAttempt = card.checklistAssignees && card.checklistAssignees[card.column];

    currentUserRole = 'admin';
    setMyChecklistStageAssignee(activeProjectId, card.id, card.column, 'alice', true);
    const afterAdmin = card.checklistAssignees[card.column].slice();

    return { afterEditorAttempt, afterAdmin };
  });

  expect(result.afterEditorAttempt).toBeUndefined();
  expect(result.afterAdmin).toEqual(['alice']);
});

test('My Checklist: buildMyChecklistRows only surfaces open items actually assigned to the current user', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const card = boardCards[0];
    ensureCardChecklists(card);
    card.checklists[card.column] = [
      { id: 'mine-open', text: 'Assigned to me, still open', done: false, assignee: ['testadmin'] },
      { id: 'mine-done', text: 'Assigned to me, already done', done: true, assignee: ['testadmin'] },
      { id: 'someone-else', text: 'Assigned to someone else', done: false, assignee: ['bob'] },
    ];
    const rows = buildMyChecklistRows();
    return rows.filter((r) => r.card.id === card.id).map((r) => r.item.text);
  });

  expect(result).toEqual(['Assigned to me, still open']);
});

test('My Checklist: the real tab renders an assigned item and updates the rail badge count', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('checklist'));

  const result = await page.evaluate(() => {
    const card = boardCards[0];
    ensureCardChecklists(card);
    card.checklists[card.column] = [{ id: 'render-check', text: 'Confirm rebar delivery', done: false, assignee: ['testadmin'] }];
    renderMyChecklist();
    return {
      bodyHtml: document.getElementById('myChecklistListBody').innerHTML,
      badgeText: document.getElementById('myChecklistCount').textContent,
    };
  });

  expect(result.bodyHtml).toContain('Confirm rebar delivery');
  expect(Number(result.badgeText)).toBeGreaterThan(0);
});

test('persistMyChecklistChange: a change to a non-active project\'s checklist is pushed to the server (pushProjectToShared) instead of taking the active project\'s saveJobs() path', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  let ws;
  await page.routeWebSocket(/\/room\?/, (socket) => {
    ws = socket;
    ws.send(JSON.stringify({ type: 'snapshot', projects: {} }));
    socket.onMessage(() => {}); // just needs to not error; acks aren't required for this check
  });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const setup = await page.evaluate(() => {
    // The freshly-seeded "other" project starts with an empty boardCards
    // array (see enforceFixedProjectSet()'s makeProject() in index.html) —
    // a minimal synthetic card is enough for resolveMyChecklistCard()'s
    // own needs (just .id and .column), so this doesn't depend on the app
    // having organically created one there.
    const [, otherId] = Object.keys(projects);
    const otherCard = { id: 'test-card-' + genId(), column: 'bid', checklists: { bid: [{ id: 'i1', text: 'Non-active project item', done: false, assignee: [] }] } };
    projects[otherId].boardCards.push(otherCard);
    return { otherId, cardId: otherCard.id, columnId: otherCard.column };
  });

  // pushProjectToShared() (real import from src/sync/outbound.ts) sends an
  // 'upsertProjectBatch' over the actual WebSocket — capturing that message
  // is a more reliable signal than trying to intercept the module-local
  // import binding persistMyChecklistChange() calls directly.
  const messages = [];
  ws.onMessage((raw) => { try { messages.push(JSON.parse(raw)); } catch (e) {} });

  const itemDoneAfter = await page.evaluate(
    ({ otherId, cardId, columnId }) => {
      toggleMyChecklistItemDone(otherId, cardId, columnId, 'i1');
      return projects[otherId].boardCards.find((c) => c.id === cardId).checklists[columnId][0].done;
    },
    setup
  );
  await new Promise((r) => setTimeout(r, 200));

  const pushedOther = messages.some((m) => m.type === 'upsertProjectBatch' && m.projectId === setup.otherId);
  expect(itemDoneAfter).toBe(true);
  expect(pushedOther).toBe(true);
});

test('board card visibility: isCardFromArchivedJob/isCardVisibleToMe reflect the linked job\'s real state', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const job = jobs[0];
    const originalArchived = job.archived;
    job.archived = true;
    const archivedResult = isCardFromArchivedJob({ jobId: job.id });
    job.archived = originalArchived;
    const restoredResult = isCardFromArchivedJob({ jobId: job.id });
    // A card with no jobId at all (not linked to any job) fails open —
    // stays visible/not-archived rather than erroring.
    const noJobId = { jobId: null };
    return {
      archivedResult,
      restoredResult,
      noJobIdArchived: isCardFromArchivedJob(noJobId),
      noJobIdVisible: isCardVisibleToMe(noJobId),
    };
  });
  expect(result.archivedResult).toBe(true);
  expect(result.restoredResult).toBe(false);
  expect(result.noJobIdArchived).toBe(false);
  expect(result.noJobIdVisible).toBe(true);
});

test('workflow items: add, recolor, and remove via the real modal', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  await page.evaluate(() => openWorkflowItemsModal());
  await expect(page.locator('#workflowItemsModal')).toHaveClass(/show/);

  const itemLabel = 'Playwright Workflow Item ' + Date.now();
  await page.locator('#wfi_new_item').fill(itemLabel);
  await page.locator('#workflowItemsBody button', { hasText: 'Add' }).click();

  const added = await page.evaluate((label) => WORKFLOW_ITEMS.find((i) => i.label === label), itemLabel);
  expect(added).toBeTruthy();
  expect(added.color).toBeTruthy();

  // Recolor — picking a swatch that isn't already selected, so the test
  // doesn't accidentally "pass" by picking the color it already had.
  const newColor = await page.evaluate((id) => {
    const item = WORKFLOW_ITEMS.find((i) => i.id === id);
    const target = COLOR_PRESETS.find((c) => c !== item.color);
    changeWorkflowItemColor(id, target, { stopPropagation() {} });
    return target;
  }, added.id);
  const afterRecolor = await page.evaluate((id) => WORKFLOW_ITEMS.find((i) => i.id === id).color, added.id);
  expect(afterRecolor).toBe(newColor);

  // Remove, and confirm a board that was grouped under it falls back to
  // showing no workflowItemId rather than a dangling reference.
  await page.evaluate((id) => {
    BOARD_COLUMNS[0].workflowItemId = id;
    removeWorkflowItem(id);
  }, added.id);
  const result = await page.evaluate((id) => ({
    stillExists: WORKFLOW_ITEMS.some((i) => i.id === id),
    columnStillLinked: BOARD_COLUMNS[0].workflowItemId === id,
  }), added.id);
  expect(result.stillExists).toBe(false);
  expect(result.columnStillLinked).toBe(false);
});

test('card modal: editing the title of a job-linked card renames the job, not just the card', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const jobLinkedCardId = await page.evaluate(() => boardCards.find((c) => c.jobId)?.id);
  expect(jobLinkedCardId).toBeTruthy();

  const newTitle = 'Renamed via card modal ' + Date.now();
  await page.evaluate((id) => openEditCard(id), jobLinkedCardId);
  await expect(page.locator('#cardModal')).toHaveClass(/show/);
  await page.locator('#c_title').fill(newTitle);
  await page.evaluate(() => flushCardAutosave());

  const result = await page.evaluate((id) => {
    const card = boardCards.find((c) => c.id === id);
    const job = findJob(card.jobId).job;
    return { jobName: job.name, cardTitle: card.title };
  }, jobLinkedCardId);
  // The rename writes through to the job; the card's own .title is
  // re-derived from that (ensureJobHasCards()), not set directly here.
  expect(result.jobName).toBe(newTitle);
  expect(result.cardTitle).toBe(newTitle);
});

test('card modal: editing the due date and custom fields saves through autosave, and delete removes the card', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const cardId = await page.evaluate(() => boardCards[0].id);
  await page.evaluate((id) => openEditCard(id), cardId);
  await expect(page.locator('#cardModal')).toHaveClass(/show/);

  await page.locator('#c_due').fill('2026-12-25');
  await page.evaluate(() => flushCardAutosave());
  const dueAfterSave = await page.evaluate((id) => boardCards.find((c) => c.id === id).due, cardId);
  expect(dueAfterSave).toBe('2026-12-25');

  await page.evaluate(() => closeCardModal());
  await expect(page.locator('#cardModal')).not.toHaveClass(/show/);

  // Re-open and delete
  await page.evaluate((id) => openEditCard(id), cardId);
  await page.evaluate(() => deleteCardFromModal());
  const stillExists = await page.evaluate((id) => boardCards.some((c) => c.id === id), cardId);
  expect(stillExists).toBe(false);
});

test('buildCardEl: an overdue card gets the overdue badge, a finished-column card does not', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const overdueCard = { id: 'test-1', column: 'bid', due: '2020-01-01' };
    const finishedColCard = { id: 'test-2', column: 'complete', due: '2020-01-01' };
    const notDueYetCard = { id: 'test-3', column: 'bid', due: '2099-01-01' };
    return {
      overdue: buildCardEl(overdueCard).querySelector('.board-card-due.overdue') !== null,
      finishedColNotOverdue: buildCardEl(finishedColCard).querySelector('.board-card-due.overdue') === null,
      notYetDue: buildCardEl(notDueYetCard).querySelector('.board-card-due.overdue') === null,
    };
  });
  expect(result.overdue).toBe(true);
  expect(result.finishedColNotOverdue).toBe(true);
  expect(result.notYetDue).toBe(true);
});

test('buildCardEl: checklist progress badge reflects done/total counts, including sub-items', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const badgeText = await page.evaluate(() => {
    const card = {
      id: 'test-checklist', column: 'bid',
      checklists: { bid: [{ id: 'i1', text: 'Item 1', done: true }, { id: 'i2', text: 'Item 2', done: false, subItems: [{ done: true }, { done: false }] }] },
    };
    const badge = buildCardEl(card).querySelector('.mini-badge');
    return badge ? badge.textContent.trim() : null;
  });
  // 2 of 4 flags done: item1 (done), item2 (not done), sub1 (done), sub2 (not done)
  expect(badgeText).toContain('2/4');
});

test('buildCardEl: the attachment count badge only appears when attachments exist', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const withAttachments = { id: 'a1', column: 'bid', attachments: [{ name: 'a.pdf' }, { name: 'b.pdf' }] };
    const withoutAttachments = { id: 'a2', column: 'bid' };
    const badges = [...buildCardEl(withAttachments).querySelectorAll('.mini-badge')].map((b) => b.textContent.trim());
    return {
      withCount: badges.some((t) => t.includes('2')),
      withoutBadge: buildCardEl(withoutAttachments).querySelector('.board-card-badges') === null,
    };
  });
  expect(result.withCount).toBe(true);
  expect(result.withoutBadge).toBe(true);
});

test('error reporting: an uncaught error and an unhandled rejection both POST a report to the Worker', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);

  const reported = [];
  await page.route(WORKER_ORIGIN + '/report-error', async (route) => {
    reported.push(JSON.parse(route.request().postData()));
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
  });

  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  await page.evaluate(() => {
    setTimeout(() => { throw new Error('Playwright synthetic uncaught error'); }, 0);
  });
  await page.waitForTimeout(100);

  await page.evaluate(() => {
    Promise.reject(new Error('Playwright synthetic unhandled rejection'));
  });
  await page.waitForTimeout(100);

  expect(reported.length).toBe(2);
  const errorReport = reported.find((r) => r.kind === 'error');
  const rejectionReport = reported.find((r) => r.kind === 'unhandledrejection');
  expect(errorReport.message).toContain('Playwright synthetic uncaught error');
  expect(rejectionReport.message).toContain('Playwright synthetic unhandled rejection');
  // A verified identity should ride along on the report — this session
  // was seeded as an admin — rather than trusting a client-claimed name.
  expect(errorReport.token).toBeTruthy();
});

test('error reporting: a tight error loop is capped rather than flooding the Worker', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);

  let reportCount = 0;
  await page.route(WORKER_ORIGIN + '/report-error', async (route) => {
    reportCount++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
  });

  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  await page.evaluate(() => {
    for (let i = 0; i < 30; i++) reportClientError('error', 'loop ' + i, {});
  });
  await page.waitForTimeout(100);

  expect(reportCount).toBe(20); // MAX_CLIENT_ERROR_REPORTS_PER_LOAD
});

test('cross-project isolation: a project-restricted account cannot switch to the other project', async ({ page }) => {
  // A single admin load to get the two real (locally-fabricated, see
  // enforceFixedProjectSet()) project ids — these are generated at
  // runtime, not fixed strings, and a second page.goto() would just talk
  // to the same always-empty mocked room again and fabricate a fresh,
  // different pair instead of reloading the first pair. Simulating the
  // restricted account by mutating currentUserRole/currentAssignedProjectId
  // and calling enforceProjectScopeForRole()/switchProject() directly
  // avoids that entirely, and matches how a real role/assignment change
  // actually reaches this app: over the existing session, not a reload
  // (see applyIdentityFromTokenPayload()).
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  const projectIds = await page.evaluate(() => Object.keys(projects));
  expect(projectIds.length).toBe(2);
  const [assignedId, otherId] = projectIds;

  const result = await page.evaluate(
    ({ assignedId, otherId }) => {
      currentUserRole = 'projectAdmin';
      currentAssignedProjectId = assignedId;
      enforceProjectScopeForRole();
      const afterEnforce = activeProjectId;

      switchProject(otherId);
      return { afterEnforce, afterSwitchAttempt: activeProjectId };
    },
    { assignedId, otherId }
  );

  expect(result.afterEnforce).toBe(assignedId);
  expect(result.afterSwitchAttempt).toBe(assignedId);
});

test('applyRoomSnapshot: a snapshot from a teammate is merged into local data', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  let ws;
  await page.routeWebSocket(/\/room\?/, (socket) => {
    ws = socket;
    ws.send(JSON.stringify({ type: 'snapshot', projects: {} }));
    // Ack every write this client sends, same as a real server would —
    // enforceFixedProjectSet()'s first-snapshot bootstrap pushes both
    // seeded projects, and without acking those, hasPendingWriteForProject()
    // would stay true forever and mask the merge this test is checking.
    socket.onMessage((raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.msgId) socket.send(JSON.stringify({ type: 'ack', msgId: msg.msgId }));
      } catch (e) {}
    });
  });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const before = await page.evaluate(() => {
    const proj = getActiveProject();
    return { projectId: proj.id, jobCountBefore: proj.jobs.length };
  });
  await expect.poll(() => page.evaluate(({ projectId }) => !hasPendingWriteForProject(projectId), before)).toBe(true);

  // Build a snapshot that looks like what the server actually sends: every
  // existing project (skipping one would make applyRoomSnapshot's
  // pruneRemovedProjects() treat it as deleted — not what this test is
  // about), each keyed by id with a jobs MAP (not array, matching the
  // real wire shape Object.values() unwraps). The target project gets one
  // extra job a "teammate" added; the untouched project is echoed back
  // as-is so its own local jobs survive unaffected.
  const remoteProjects = await page.evaluate(
    ({ projectId }) => {
      const jid = 'teammate-job-' + genId();
      const out = {};
      Object.keys(projects).forEach((id) => {
        const p = projects[id];
        const jobsMap = {};
        (id === projectId ? p.jobs.concat([{ id: jid, name: 'Added by a teammate', tasks: [] }]) : p.jobs)
          .forEach((j) => { jobsMap[j.id] = j; });
        out[id] = { name: p.name, jobs: jobsMap };
      });
      return out;
    },
    before
  );
  ws.send(JSON.stringify({ type: 'snapshot', projects: remoteProjects }));

  await page.waitForTimeout(200);

  const after = await page.evaluate(() => {
    const proj = getActiveProject();
    return { jobCountAfter: proj.jobs.length, hasTeammateJob: proj.jobs.some((j) => j.name === 'Added by a teammate') };
  });

  expect(after.jobCountAfter).toBe(before.jobCountBefore + 1);
  expect(after.hasTeammateJob).toBe(true);
});

test('applyRoomSnapshot: a snapshot arriving while this project has an unacked local write does not clobber the optimistic local change', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  let ws;
  await page.routeWebSocket(/\/room\?/, (socket) => {
    ws = socket;
    ws.send(JSON.stringify({ type: 'snapshot', projects: {} }));
  });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const jobName = 'Optimistic local job ' + Date.now();
  await page.evaluate(() => addNewJob());
  await page.locator('#f_job').fill(jobName);
  await page.evaluate(() => flushAutoSaveJobForm());
  // Force the debounced push to fire NOW rather than waiting 300ms, so the
  // write is sitting in pendingWrites (sent, not yet acked) by the time
  // the snapshot below arrives — exactly the race window
  // hasPendingWriteForProject() exists to guard (see its own comment in
  // src/sync/outbound.ts and applyRoomSnapshot()'s in src/sync/inbound.ts).
  await page.evaluate(() => flushPendingRoomPush());

  const state = await page.evaluate(() => {
    const proj = getActiveProject();
    return {
      projectId: proj.id,
      hasPendingWrite: hasPendingWriteForProject(proj.id),
      otherProjectIds: Object.keys(projects).filter((id) => id !== proj.id),
    };
  });
  expect(state.hasPendingWrite).toBe(true);

  // Simulate the server broadcasting a fresh snapshot in the same window —
  // triggered by anything else in the room, not necessarily related to
  // this write — that does NOT yet reflect the job just added locally
  // (the real server always includes it once this write is acked, but
  // this snapshot is deliberately stale, modeling the race described in
  // hasPendingWriteForProject()'s own comment). Every project must be
  // present (see the merge test above) or pruneRemovedProjects() would
  // delete the untouched one.
  const remoteProjects = await page.evaluate(
    ({ projectId, otherProjectIds }) => {
      const out = {};
      out[projectId] = { name: projects[projectId].name }; // no `jobs` at all — the stale state
      otherProjectIds.forEach((id) => { out[id] = { name: projects[id].name }; });
      return out;
    },
    state
  );
  ws.send(JSON.stringify({ type: 'snapshot', projects: remoteProjects }));

  await page.waitForTimeout(200);

  const survived = await page.evaluate((name) => {
    const proj = getActiveProject();
    return proj.jobs.some((j) => j.name === name);
  }, jobName);

  expect(survived).toBe(true);
});

test('getActiveTab: reports the currently active panel, and defaults to home when nothing is active', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await page.goto(APP_URL);
  await expect(page.locator('#loginOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    switchTab('board');
    const onBoard = getActiveTab();
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    const withNoneActive = getActiveTab();
    return { onBoard, withNoneActive };
  });

  expect(result.onBoard).toBe('board');
  expect(result.withNoneActive).toBe('home');
});

test('switchTabMorphed: clicking the tab you\'re already on navigates to Home instead of no-op\'ing ("turn off the tab you\'re in")', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  // switchTabMorphed() is asynchronous (it runs the real switch inside a
  // View Transitions API callback) — getActiveTab() read in the same
  // synchronous tick still reports the OLD tab. Each step here is its
  // own evaluate() + waitForFunction() instead of
  // one combined evaluate(), so the transition genuinely settles between
  // the two switchTabMorphed() calls.
  await page.evaluate(() => switchTabMorphed('gantt'));
  await page.waitForFunction(() => getActiveTab() === 'gantt');
  const onGantt = await page.evaluate(() => getActiveTab());

  await page.evaluate(() => switchTabMorphed('gantt')); // already there — should bounce to home, not no-op
  await page.waitForFunction(() => getActiveTab() === 'home');
  const afterSecondClick = await page.evaluate(() => getActiveTab());

  expect(onGantt).toBe('gantt');
  expect(afterSecondClick).toBe('home');
});

test('switchTab: activates exactly one panel/rail-tab pair and deactivates every other one', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    switchTab('calendar');
    const activePanels = Array.from(document.querySelectorAll('.tab-panel.active')).map((p) => p.id);
    const activeRailTabs = Array.from(document.querySelectorAll('#appNavNotch .nav-tab.active')).map((b) => b.id);
    return { activePanels, activeRailTabs };
  });

  expect(result.activePanels).toEqual(['panel-calendar']);
  expect(result.activeRailTabs).toEqual(['tab-calendar']);
});

test('toggleJobRail: toggles the job-rail-open body class and the toggle button\'s active state/title together', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await page.goto(APP_URL);
  await expect(page.locator('#loginOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const before = document.body.classList.contains('job-rail-open');
    toggleJobRail();
    const afterOpen = {
      bodyOpen: document.body.classList.contains('job-rail-open'),
      btnActive: document.getElementById('jobRailToggleBtn').classList.contains('active'),
    };
    toggleJobRail();
    const afterClose = document.body.classList.contains('job-rail-open');
    return { before, afterOpen, afterClose };
  });

  expect(result.before).toBe(false);
  expect(result.afterOpen).toEqual({ bodyOpen: true, btnActive: true });
  expect(result.afterClose).toBe(false);
});

test('setMobileView: tapping the already-active view goes to Home, and switching to Calendar while in week mode clamps to month', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    setMobileView('board');
    const firstTap = document.body.dataset.mobileView;
    setMobileView('board'); // already active — should bounce to home
    const secondTap = document.body.dataset.mobileView;

    calendarViewMode = 'week';
    setMobileView('calendar');
    return { firstTap, secondTap, viewModeAfter: calendarViewMode, mobileViewAfter: document.body.dataset.mobileView };
  });

  expect(result.firstTap).toBe('board');
  expect(result.secondTap).toBe('home');
  expect(result.viewModeAfter).toBe('month');
  expect(result.mobileViewAfter).toBe('calendar');
});

test('toggleHomeWidgetExpand: expanding a widget marks it (and only it) as expanded, and toggling it again collapses back to idle', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    toggleHomeWidgetExpand('board');
    const afterExpand = {
      expandedId: homeExpandedWidgetId,
      boardHasClass: document.getElementById('homeWidgetWorkflow').classList.contains('is-expanded'),
      checklistHasClass: document.getElementById('homeWidgetChecklist').classList.contains('is-expanded'),
      stageBodyExpandedView: document.getElementById('homeStageBody').classList.contains('is-expanded-view'),
    };
    toggleHomeWidgetExpand('board'); // same key again — collapses back to idle
    const afterCollapse = {
      expandedId: homeExpandedWidgetId,
      boardHasClass: document.getElementById('homeWidgetWorkflow').classList.contains('is-expanded'),
    };
    return { afterExpand, afterCollapse };
  });

  expect(result.afterExpand).toEqual({ expandedId: 'board', boardHasClass: true, checklistHasClass: false, stageBodyExpandedView: true });
  expect(result.afterCollapse).toEqual({ expandedId: null, boardHasClass: false });
});

test('toggleHomeWidgetExpand: is a no-op below the 900px desktop breakpoint', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.setViewportSize({ width: 700, height: 800 });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const expandedId = await page.evaluate(() => {
    toggleHomeWidgetExpand('board');
    return homeExpandedWidgetId;
  });

  expect(expandedId).toBeNull();
});

test('applyHomeReflowTracks: computes real pixel grid tracks, and collapses Job Chat to a thin strip when a corner widget is expanded', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('home'));
  await page.waitForFunction(() => getActiveTab() === 'home');

  const result = await page.evaluate(() => {
    applyHomeReflowTracks();
    const idleColumns = getComputedStyle(document.querySelector('#panel-home .home-grid')).gridTemplateColumns;

    toggleHomeWidgetExpand('gantt'); // a corner widget, not Job Chat's own center column
    const jobChatCollapsed = document.getElementById('homeWidgetJobChat').classList.contains('is-collapsed-thin');
    const expandedColumns = getComputedStyle(document.querySelector('#panel-home .home-grid')).gridTemplateColumns;

    return {
      idleColumnCount: idleColumns.split(' ').length,
      idleIsPixels: /^[\d.]+px( [\d.]+px)*$/.test(idleColumns),
      jobChatCollapsed,
      expandedColumnCount: expandedColumns.split(' ').length,
    };
  });

  expect(result.idleColumnCount).toBe(3);
  expect(result.idleIsPixels).toBe(true);
  expect(result.jobChatCollapsed).toBe(true);
  expect(result.expandedColumnCount).toBe(3);
});

test('window resize: auto-collapses an expanded widget once the window narrows past the mobile breakpoint', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  await page.evaluate(() => toggleHomeWidgetExpand('board'));
  const expandedBefore = await page.evaluate(() => homeExpandedWidgetId);

  await page.setViewportSize({ width: 700, height: 800 });
  await page.waitForTimeout(300); // the resize listener's own debounce/settle work

  const result = await page.evaluate(() => ({
    expandedAfter: homeExpandedWidgetId,
    stageBodyExpandedView: document.getElementById('homeStageBody').classList.contains('is-expanded-view'),
  }));

  expect(expandedBefore).toBe('board');
  expect(result.expandedAfter).toBeNull();
  expect(result.stageBodyExpandedView).toBe(false);
});

test('renderHomeOverdueWidget: overdue/today/soon cards produce three separately-tiered dismissible alerts', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  // Two separate single-card scenarios (rather than one job of each tier
  // together) so a bucket that's off by one card still shows up as a
  // present/absent alert instead of an unchanged count — e.g. a
  // today<->soon classification swap wouldn't change either tier's count
  // when exactly one card sits in each, but it would flip which alert
  // exists when only one non-overdue card is seeded at a time.
  const todayOnly = await page.evaluate(() => {
    const cards = boardCards.filter(function (c) { return !isFinishedColumnId(c.column); });
    const today = new Date(new Date().toDateString());
    cards[0].due = toIsoDate(new Date(today.getTime() - 2 * 86400000)); // overdue
    cards[1].due = toIsoDate(today); // due today, nothing due "soon"
    renderHomeDashboard();
    const container = document.getElementById('homeOverdueBody');
    const todayEl = container.querySelector('#homeAlert-calendar-today');
    return {
      overdueText: container.querySelector('#homeAlert-calendar-overdue .home-widget-alert-text').textContent,
      todayText: todayEl ? todayEl.querySelector('.home-widget-alert-text').textContent : null,
      todayTierClass: todayEl ? todayEl.className : null,
      soonAbsent: !container.querySelector('#homeAlert-calendar-soon'),
    };
  });

  expect(todayOnly.overdueText).toBe('1 job overdue');
  expect(todayOnly.todayText).toBe('1 job due today');
  expect(todayOnly.todayTierClass).toContain('tier-today');
  expect(todayOnly.soonAbsent).toBe(true);

  const soonOnly = await page.evaluate(() => {
    const cards = boardCards.filter(function (c) { return !isFinishedColumnId(c.column); });
    const today = new Date(new Date().toDateString());
    cards.forEach(function (c) { c.due = ''; }); // clear the previous test's dates
    cards[0].due = toIsoDate(new Date(today.getTime() + 2 * 86400000)); // due soon, nothing overdue/today
    renderHomeDashboard();
    const container = document.getElementById('homeOverdueBody');
    const soonEl = container.querySelector('#homeAlert-calendar-soon');
    return {
      todayAbsent: !container.querySelector('#homeAlert-calendar-today'),
      soonText: soonEl ? soonEl.querySelector('.home-widget-alert-text').textContent : null,
      soonTierClass: soonEl ? soonEl.className : null,
    };
  });

  expect(soonOnly.todayAbsent).toBe(true);
  expect(soonOnly.soonText).toBe('1 job due soon');
  expect(soonOnly.soonTierClass).toContain('tier-soon');
});

test('dismissHomeWidgetAlert: dismissing an alert hides it and persists across re-render, but a changed underlying set brings a new alert back', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const card = boardCards.find(function (c) { return !isFinishedColumnId(c.column); });
    const today = new Date(new Date().toDateString());
    card.due = toIsoDate(new Date(today.getTime() - 2 * 86400000));
    renderHomeDashboard();
    const beforeDismiss = !!document.querySelector('#homeOverdueBody #homeAlert-calendar-overdue');

    // dismissHomeWidgetAlert() itself only removes a live DOM element and
    // writes localStorage — it doesn't re-render, so simulate the render
    // pipeline's own next call afterward via isHomeWidgetAlertDismissed().
    const rows1 = buildHomeOverdueRows();
    const signature1 = rows1.filter(function (r) { return r.isOverdue; }).map(function (r) { return r.card.id; }).slice().sort().join(',');
    dismissHomeWidgetAlert({ stopPropagation: function () {} }, 'calendar-overdue', signature1);
    renderHomeDashboard();
    const afterDismissSameData = !!document.querySelector('#homeOverdueBody #homeAlert-calendar-overdue');

    // Now a second card also becomes overdue — the alert's ids (and so its
    // signature) changed, so the old dismissal shouldn't suppress it.
    const secondCard = boardCards.find(function (c) { return !isFinishedColumnId(c.column) && c.id !== card.id; });
    secondCard.due = toIsoDate(new Date(today.getTime() - 1 * 86400000));
    renderHomeDashboard();
    const afterSetChanged = !!document.querySelector('#homeOverdueBody #homeAlert-calendar-overdue');

    return { beforeDismiss, afterDismissSameData, afterSetChanged };
  });

  expect(result.beforeDismiss).toBe(true);
  expect(result.afterDismissSameData).toBe(false);
  expect(result.afterSetChanged).toBe(true);
});

test('renderHomeWorkflowMiniBoard: renders one bar per board column with counts matching real card placement', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('home'));
  await page.waitForFunction(() => getActiveTab() === 'home');

  const result = await page.evaluate(() => {
    const firstColId = BOARD_COLUMNS[0].id;
    const expectedCount = boardCards.filter(function (c) { return c.column === firstColId; }).length;
    renderHomeWorkflowMiniBoard();
    const bar = document.querySelector('.wsm-bar-col[data-column="' + firstColId + '"] .wsm-bar-count');
    return { expectedCount: expectedCount, renderedCount: bar ? Number(bar.textContent) : null };
  });

  expect(result.expectedCount).toBeGreaterThan(0);
  expect(result.renderedCount).toBe(result.expectedCount);
});

test('renderHomeTodayScheduleWidget: flags a job whose schedule is fully done but still sitting in a non-finished column via the gantt-unclosed alert', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const job = jobs.find(function (j) { return !j.archived && j.tasks && j.tasks.length; });
    const yesterday = toIsoDate(new Date(Date.now() - 86400000));
    job.tasks.forEach(function (t) { t.start = yesterday; t.finish = yesterday; });
    renderHomeDashboard();
    const alertText = document.querySelector('#homeTodayBody #homeAlert-gantt-unclosed .home-widget-alert-text');
    return { alertText: alertText ? alertText.textContent : null };
  });

  expect(result.alertText).toMatch(/finished, not closed out/);
});

test('buildHomeJobChatFeed: aggregates comments across visible non-archived jobs, newest first, excluding an archived job\'s comments', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const result = await page.evaluate(() => {
    const [jobA, jobB, jobC] = jobs;
    // Demo/fixture jobs may already carry their own seeded comments — clear
    // every other job's so this feed is deterministic and only reflects
    // the three rows this test actually sets up.
    jobs.forEach(function (j) { if (j !== jobA && j !== jobB && j !== jobC) j.comments = []; });
    jobA.comments = [{ id: 'c-old', author: 'Alice', text: 'older comment', when: 1000 }];
    jobB.comments = [{ id: 'c-new', author: 'Bob', text: 'newer comment', when: 2000 }];
    jobC.comments = [{ id: 'c-archived', author: 'Carl', text: 'should not appear', when: 3000 }];
    const originalArchived = jobC.archived;
    jobC.archived = true;
    const rows = buildHomeJobChatFeed();
    jobC.archived = originalArchived; // restore for any later assertions in this test
    return rows.map(function (r) { return r.comment.id; });
  });

  expect(result).toEqual(['c-new', 'c-old']);
});

test('postHomeJobChatComment: posting via the real Home Job Chat UI adds a comment to the picked job and renders it in the feed', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('home'));
  await page.waitForFunction(() => getActiveTab() === 'home');
  await page.evaluate(() => localStorage.setItem('gantt_display_name_v1', 'Test Admin'));

  // The select now comes up on a blank "Select a job…" placeholder (see
  // renderHomeJobChatComposeOptions()'s own comment — it used to default
  // to whichever job sorted first, an easy way to post to the wrong job's
  // chat without noticing), and Post stays disabled until a real job is
  // actually chosen. Exercise that real flow rather than relying on an
  // implicit default the way this test used to.
  const targetJobId = await page.evaluate(() => {
    renderHomeJobChat();
    const select = document.getElementById('homeJobChatJobPicker');
    return select.options[1].value; // first real job, after the placeholder
  });
  await page.selectOption('#homeJobChatJobPicker', targetJobId);
  await expect(page.locator('#homeJobChatPostBtn')).toBeEnabled();

  await page.fill('#homeJobChatInput', 'A brand new job chat message');
  await page.click('#homeJobChatPostBtn');

  const result = await page.evaluate((jobId) => {
    const found = findJob(jobId);
    const comments = found.job.comments || [];
    return {
      lastComment: comments[comments.length - 1],
      inputCleared: document.getElementById('homeJobChatInput').value === '',
      listHtml: document.getElementById('homeJobChatList').textContent,
    };
  }, targetJobId);

  expect(result.lastComment.text).toBe('A brand new job chat message');
  expect(result.lastComment.author).toBe('Test Admin');
  expect(result.inputCleared).toBe(true);
  expect(result.listHtml).toContain('A brand new job chat message');
});

test('toggleHomeReplyBox/addHomeJobReply: replying to a comment via the real UI persists the reply onto the comment', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTabMorphed('home'));
  await page.waitForFunction(() => getActiveTab() === 'home');
  await page.evaluate(() => localStorage.setItem('gantt_display_name_v1', 'Test Admin'));

  const jobId = await page.evaluate(() => {
    jobs[0].comments = [{ id: 'reply-target', author: 'Alice', text: 'original comment', when: Date.now() }];
    renderHomeJobChat();
    return jobs[0].id;
  });

  await page.click('#homeJobChatList .job-comment-reply-btn');
  const rowVisible = await page.evaluate(() => document.getElementById('home-reply-row-reply-target').style.display === 'flex');
  await page.fill('#home-reply-ta-reply-target', 'a real reply');
  await page.evaluate(() => addHomeJobReply(jobs[0].id, 'reply-target'));

  const result = await page.evaluate((jid) => {
    const found = findJob(jid);
    const comment = found.job.comments.find(function (c) { return c.id === 'reply-target'; });
    return {
      replies: comment.replies,
      taCleared: document.getElementById('home-reply-ta-reply-target').value === '',
    };
  }, jobId);

  expect(rowVisible).toBe(true);
  expect(result.replies).toHaveLength(1);
  expect(result.replies[0].text).toBe('a real reply');
  expect(result.replies[0].author).toBe('Test Admin');
  expect(result.taCleared).toBe(true);
});

test('renderHomeDashboard: dispatches the Calendar widget to its real expanded month grid when expanded, and back to the compact mini-month when collapsed', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const compactBefore = await page.evaluate(() => {
    // renderHomeOverdueWidget() shows its empty state (no .home-mini-cal-grid
    // at all) when nothing is overdue/due-soon — seed one so the compact
    // path actually renders the mini-month grid this test is checking for.
    const card = boardCards.find(function (c) { return !isFinishedColumnId(c.column); });
    card.due = toIsoDate(new Date());
    renderHomeDashboard();
    return !!document.querySelector('#homeOverdueBody .home-mini-cal-grid');
  });

  const expandedState = await page.evaluate(() => {
    toggleHomeWidgetExpand('calendar');
    renderHomeDashboard();
    return {
      hasCompactGrid: !!document.querySelector('#homeOverdueBody .home-mini-cal-grid'),
      hasRealMonthGrid: !!document.querySelector('#homeOverdueBody .calendar-days'),
    };
  });

  const compactAfter = await page.evaluate(() => {
    toggleHomeWidgetExpand('calendar'); // collapse back
    renderHomeDashboard();
    return !!document.querySelector('#homeOverdueBody .home-mini-cal-grid');
  });

  expect(compactBefore).toBe(true);
  expect(expandedState.hasCompactGrid).toBe(false);
  expect(expandedState.hasRealMonthGrid).toBe(true);
  expect(compactAfter).toBe(true);
});

test('maintenance mode: a non-admin sees the full-screen overlay when it is active', async ({ page }) => {
  await seedSession(page, { role: 'viewer' });
  await mockRoomWebSocket(page);
  await page.route(WORKER_ORIGIN + '/maintenance-status*', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ active: true, message: 'Testing a maintenance window.' }) });
  });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  await expect(page.locator('#maintenanceOverlay')).toHaveClass(/show/);
  await expect(page.locator('#maintenanceOverlayMessage')).toHaveText('Testing a maintenance window.');
});

test('maintenance mode: an admin does not see the overlay even while it is active', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.route(WORKER_ORIGIN + '/maintenance-status*', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ active: true, message: 'Testing a maintenance window.' }) });
  });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  // Give the poll a moment to land, then confirm it deliberately did NOT block.
  await page.waitForTimeout(300);
  await expect(page.locator('#maintenanceOverlay')).not.toHaveClass(/show/);
});

test('maintenance mode admin toggle: turning it on sends the right request and updates the panel', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.route(WORKER_ORIGIN + '/maintenance-status*', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ active: false, message: '' }) });
  });
  let capturedBody = null;
  await page.route(WORKER_ORIGIN + '/maintenance-status/set', (route) => {
    capturedBody = route.request().postDataJSON();
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, status: { active: true, message: capturedBody.message } }) });
  });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  await page.evaluate(() => { toggleSettingsMenu(); showSettingsTab('admin'); toggleMaintenancePanel(); });
  await page.locator('#maintenanceMessageInput').fill('Back in 15 minutes for a data migration.');
  await expect(page.locator('#maintenanceEnableBtn')).toHaveText('Turn On Maintenance Mode');
  // Turning maintenance mode ON now confirms first (it immediately blocks
  // every non-admin user) — same window.confirm() convention as Log Out
  // and Switch Project. Accept it to exercise the actual request below.
  page.once('dialog', (d) => d.accept());
  await page.locator('#maintenanceEnableBtn').click();

  expect(capturedBody.active).toBe(true);
  expect(capturedBody.message).toBe('Back in 15 minutes for a data migration.');
  await expect(page.locator('#maintenanceToggle')).toHaveClass(/active/);
  await expect(page.locator('#maintenanceEnableBtn')).toHaveText('Turn Off Maintenance Mode');
});

test('job form on a phone: Job Name is always open, while optional sections still start collapsed (H4)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => editJob(jobs[0].id));
  await expect(page.locator('#f_job')).toBeVisible();
  await expect(page.locator('#f_job')).toHaveValue(await page.evaluate(() => jobs[0].name));
  await expect(page.locator('#f_due')).toBeHidden();
});

test('job form on a laptop-width window: Comments stacks below the job details (H1)', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 800 });
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => editJob(jobs[0].id));
  await expect(page.locator('#jobCommentsPanel')).toBeVisible();
  const [formTop, commentsTop] = await page.evaluate(() => [
    document.querySelector('.form-container').getBoundingClientRect().top,
    document.getElementById('jobCommentsPanel').getBoundingClientRect().top,
  ]);
  expect(commentsTop).toBeGreaterThan(formTop);
});

test('board: dragging empty space scrolls the board sideways; buttons and cards do not pan', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => { document.querySelectorAll('.onb-notif').forEach((e) => e.remove()); switchTab('board'); });
  await page.waitForFunction(() => getActiveTab() === 'board');

  const wrapper = page.locator('#boardWrapper');
  const overflow = await wrapper.evaluate((w) => w.scrollWidth - w.clientWidth);
  expect(overflow).toBeGreaterThan(100);

  // The empty board area below the columns, scrolled all the way right first.
  await wrapper.evaluate((w) => { w.scrollLeft = w.scrollWidth; });
  const box = await wrapper.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height - 40;
  const startScroll = await wrapper.evaluate((w) => w.scrollLeft);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 150, y, { steps: 5 });
  await page.mouse.up();
  const afterPan = await wrapper.evaluate((w) => w.scrollLeft);
  expect(startScroll - afterPan).toBeGreaterThan(100);

  // Pressing on a button (a column's settings ⋮) and dragging does not pan.
  const btn = page.locator('#boardWrapper .board-col-settings-btn').first();
  const bb = await btn.boundingBox();
  await page.mouse.move(bb.x + 5, bb.y + 5);
  await page.mouse.down();
  await page.mouse.move(bb.x + 155, bb.y + 5, { steps: 5 });
  await page.mouse.up();
  expect(await wrapper.evaluate((w) => w.scrollLeft)).toBe(afterPan);
  await expect(wrapper).not.toHaveClass(/board-panning/);
});

test('home: open Jobs rail, expand and close a widget, close the rail — the dashboard grid fills its width again', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.waitForFunction(() => getActiveTab() === 'home');

  // Sum of the grid's pinned column widths (+ two 16px gaps) vs the grid's real width.
  const slack = () => page.evaluate(() => {
    const g = document.querySelector('#panel-home .home-grid');
    const cols = getComputedStyle(g).gridTemplateColumns.split(' ').map(parseFloat);
    return Math.round(g.getBoundingClientRect().width - (cols[0] + cols[1] + cols[2] + 32));
  });

  const expandBtn = page.locator('#panel-home .home-widget-expand-btn').first();
  await page.locator('#jobRailToggleBtn').click();
  await page.waitForTimeout(500);
  expect(Math.abs(await slack())).toBeLessThanOrEqual(2); // fits while the rail is open too
  await expandBtn.click();
  await page.waitForTimeout(600);
  await expandBtn.click();
  await page.waitForTimeout(600);
  await page.locator('#jobRailToggleBtn').click();
  await page.waitForTimeout(500);
  expect(Math.abs(await slack())).toBeLessThanOrEqual(2);
});

test('calendar: going Day -> Month or Day -> Week leaves no day-view items behind in the grid', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => {
    const job = jobs[0];
    job.tasks[0].start = '2026-09-14'; job.tasks[0].finish = '2026-09-18';
    switchTab('calendar');
    calendarViewDate = new Date('2026-09-15T00:00:00'); calendarViewMode = 'month'; renderCalendar();
  });
  const days = page.locator('#calendarDays');
  const firstCellDate = () => page.evaluate(() => document.querySelector('#calendarDays').firstElementChild.dataset.date || '');

  for (const exit of ['#calViewMonth', '#calBackBtn', '#calViewWeek']) {
    await page.evaluate(() => { calendarViewDate = new Date('2026-09-15T00:00:00'); calendarViewMode = 'month'; renderCalendar(); openDayView('2026-09-16'); });
    await expect(days.locator('.day-view-item')).toHaveCount(1);
    await page.locator(exit).click();
    await expect(days.locator('.day-view-item, .day-view-empty')).toHaveCount(0);
    // The grid's first child is a real day cell again (Aug 30 for September 2026's month grid, the week's Sunday for week view).
    expect(await firstCellDate()).toBe(exit === '#calViewWeek' ? '2026-09-13' : '2026-08-30');
  }
});

test('card editor: Archive archives the card\'s job, closes the editor, and Undo brings it back', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  const { jobId, cardId } = await page.evaluate(() => {
    switchTab('board');
    const card = boardCards.find((c) => c.jobId && !findJob(c.jobId).job.archived);
    openEditCard(card.id);
    return { jobId: card.jobId, cardId: card.id };
  });
  await expect(page.locator('#cardArchiveBtn')).toBeVisible();
  await page.locator('#cardArchiveBtn').click();
  await expect(page.locator('#cardModal')).not.toHaveClass(/show/);
  expect(await page.evaluate((id) => findJob(id).job.archived, jobId)).toBe(true);
  await expect(page.locator('#boardWrapper .board-card[data-id="' + cardId + '"]')).toHaveCount(0);
  await page.locator('.undo-toast button, .toast button', { hasText: 'Undo' }).first().click();
  await expect.poll(() => page.evaluate((id) => findJob(id).job.archived, jobId)).toBe(false);
});

test('finished trigger: a job whose card sits in a finished board drops off the Gantt, Calendar and Home schedule, and comes back when moved out', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const today = await page.evaluate(() => toIsoDate(new Date()));
  const ids = await page.evaluate((today) => {
    // Two plain (unphased) jobs scheduled across today; one gets moved to a finished board.
    const pick = jobs.filter((j) => !j.archived && !(j.phases && j.phases.length > 1)).slice(0, 2);
    const finishedCol = BOARD_COLUMNS.find((c) => isFinishedColumn(c));
    const activeCol = BOARD_COLUMNS.find((c) => !isFinishedColumn(c) && !c.hideFromSchedule);
    // Only the active stage is dated (today), and both cards are pinned there,
    // so date-driven stage moves can't carry either card onto a finished board.
    pick.forEach((j) => {
      j.tasks.forEach((t) => { if (t.columnId === activeCol.id) { t.start = today; t.finish = today; } else { t.start = ''; t.finish = ''; } });
      const card = boardCards.find((c) => c.jobId === j.id);
      card.column = activeCol.id; card.manualColumn = activeCol.id; card.manualColumnUntil = Date.now() + 86400000;
    });
    return { done: pick[0].id, open: pick[1].id, finishedCol: finishedCol.id, activeCol: activeCol.id };
  }, today);

  const counts = () => page.evaluate((ids) => {
    const inRows = (rows) => ({ done: rows.some((r) => r.job.id === ids.done), open: rows.some((r) => r.job.id === ids.open) });
    return {
      calendar: inRows(buildCalendarJobRows(getVisibleJobs())),
      flat: inRows(flattenJobs(getVisibleJobs())),
      homeToday: inRows(buildHomeTodayScheduleRows()),
      ganttBars: { done: document.querySelectorAll('#panel-gantt [data-job-id="' + ids.done + '"]').length > 0, open: document.querySelectorAll('#panel-gantt [data-job-id="' + ids.open + '"]').length > 0 },
    };
  }, ids);
  const place = (colId) => page.evaluate(({ id, colId }) => {
    const card = boardCards.find((c) => c.jobId === id);
    card.column = colId; card.manualColumn = colId; card.manualColumnUntil = Date.now() + 86400000;
    switchTab('gantt');
  }, { id: ids.done, colId });

  await place(ids.finishedCol);
  await page.waitForTimeout(400);
  let c = await counts();
  expect(c.calendar).toEqual({ done: false, open: true });
  expect(c.flat).toEqual({ done: false, open: true });
  expect(c.homeToday).toEqual({ done: false, open: true });
  expect(c.ganttBars).toEqual({ done: false, open: true });

  await place(ids.activeCol);
  await page.waitForTimeout(400);
  c = await counts();
  expect(c.calendar).toEqual({ done: true, open: true });
  expect(c.homeToday).toEqual({ done: true, open: true });
  expect(c.ganttBars).toEqual({ done: true, open: true });
});

test('gantt: zoom pill buttons zoom and reset; the red Today marker appears only while today is off-screen and jumps back', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => {
    document.querySelectorAll('.onb-notif').forEach((e) => e.remove());
    const iso = (o) => { const d = new Date(); d.setDate(d.getDate() + o); return toIsoDate(d); };
    jobs.slice(0, 4).forEach((j, n) => j.tasks.forEach((t, k) => { t.start = iso(-10 + n * 6 + k * 4); t.finish = iso(-6 + n * 6 + k * 4); }));
    saveJobs();
    switchTab('gantt');
  });
  await page.waitForFunction(() => getActiveTab() === 'gantt');
  await page.waitForTimeout(1500);

  // The old toolbar buttons are gone; zoom lives in the pill.
  await expect(page.locator('#ganttToolbar, #ganttFitToViewBtn, #ganttScrollTodayBtn')).toHaveCount(0);
  const dw = () => page.evaluate(() => dayWidth);
  await page.evaluate(() => { dayWidth = 34; renderGantt(); });
  await page.locator('.gantt-zoom-pill #ganttZoomInBtn').click();
  expect(await dw()).toBe(40);
  await page.locator('.gantt-zoom-pill #ganttResetZoomBtn').click();
  expect(await dw()).toBe(34);

  const mark = page.locator('#ganttTodayMark');
  await page.evaluate(() => scrollToToday());
  await expect(mark).toBeHidden();
  await page.evaluate(() => { const b = document.getElementById('timelineBody'); b.scrollLeft += 2500; });
  await expect(mark).toBeVisible();
  await expect(mark).toHaveClass(/left/);
  await expect(mark).toContainText('Today');
  await mark.click();
  await expect(mark).toBeHidden();
  await page.evaluate(() => { document.getElementById('timelineBody').scrollLeft = 0; });
  await expect(mark).toBeVisible();
  await expect(mark).toHaveClass(/right/);
});

test('gantt: the Job header arrow shows closed / mixed / open and folds everything; Alt-click on a row arrow does the same', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => {
    document.querySelectorAll('.onb-notif').forEach((e) => e.remove());
    const iso = (o) => { const d = new Date(); d.setDate(d.getDate() + o); return toIsoDate(d); };
    jobs.slice(0, 5).forEach((j, n) => j.tasks.forEach((t, k) => { t.start = iso(-10 + n * 6 + k * 4); t.finish = iso(-6 + n * 6 + k * 4); }));
    saveJobs();
    collapseAllGantt();
    switchTab('gantt');
  });
  await page.waitForFunction(() => getActiveTab() === 'gantt');
  await page.waitForTimeout(1200);

  const toggle = page.locator('#ganttBulkToggle');
  const folds = page.locator('#leftBody .task-row-pill:has(.task-row-pill-chev)');
  await expect(page.locator('#ganttExpandAllBtn, #ganttCollapseAllBtn')).toHaveCount(0);
  await expect(toggle).toHaveAttribute('data-state', 'closed');

  await folds.nth(1).click();                       // open one row by hand -> mixed
  await expect(toggle).toHaveAttribute('data-state', 'mixed');
  await toggle.click();                             // mixed -> collapse everything
  await expect(toggle).toHaveAttribute('data-state', 'closed');
  await toggle.click();                             // closed -> expand everything
  await expect(toggle).toHaveAttribute('data-state', 'open');

  await folds.first().click({ modifiers: ['Alt'] }); // Alt-click an open row's arrow -> collapse all
  await expect(toggle).toHaveAttribute('data-state', 'closed');
  await folds.first().click({ modifiers: ['Alt'] }); // Alt-click a closed one -> expand all
  await expect(toggle).toHaveAttribute('data-state', 'open');
});

test('gantt: the phone-only bulk toggle is hidden on desktop and shown on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);
  await page.evaluate(() => switchTab('gantt'));
  await expect(page.locator('#ganttBulkTogglePhone')).toBeHidden();
  await expect(page.locator('#ganttBulkToggle')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 800 });
  await page.evaluate(() => setMobileView('gantt'));
  await expect(page.locator('#ganttBulkTogglePhone')).toBeVisible();
  await expect(page.locator('#ganttBulkTogglePhone')).toContainText(/Expand all|Collapse all/);
});

test('Navbar: Home is active at load, pages are icons in the left column, and the Jobs rail closes all the way on desktop', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.setViewportSize({ width: 1366, height: 800 });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  await expect(page.locator('#tab-home')).toHaveClass(/active/);
  // Gmail-style column: icons only, the name is the tooltip.
  await expect(page.locator('#tab-home .nav-tab-label')).toBeHidden();
  await expect(page.locator('#tab-gantt')).toHaveAttribute('title', 'Gantt Chart');
  const col = await page.locator('#appNavNotch').boundingBox();
  const menu = await page.locator('#jobRailToggleBtn').boundingBox();
  expect(col.x).toBeLessThan(2);
  expect(col.y).toBeGreaterThan(menu.y + menu.height);
  // Desktop shows the job list with the ☰ at the top of the column; the column has no Jobs button here.
  await expect(page.locator('#tab-jobs')).toBeHidden();
  await expect(page.locator('#appNav #jobRailToggleBtn')).toBeVisible();
  // Closed, the rail is gone entirely, + New job included.
  await expect(page.locator('#jobRailAddBtn')).toBeHidden();
  await page.locator('#jobRailToggleBtn').click();
  await expect(page.locator('.job-rail-header-label')).toBeVisible();
  await expect(page.locator('#jobRailAddBtn .job-rail-add-label')).toBeVisible();
  await expect(page.locator('#jobRailToggleBtn')).toHaveAttribute('aria-expanded', 'true');
  await page.locator('#jobRailToggleBtn').click();

  // The top bar names the current page.
  await expect(page.locator('#appNavPage')).toHaveText('Home');
  await page.locator('#tab-gantt').click();
  await expect(page.locator('#panel-gantt')).toHaveClass(/active/);
  await expect(page.locator('#appNavPage')).toHaveText('Gantt Chart');
  await expect(page.locator('#tab-gantt')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#tab-home')).not.toHaveClass(/active/);

  await page.locator('#tab-home').click();
  await expect(page.locator('#panel-home')).toHaveClass(/active/);
  await expect(page.locator('#tab-home')).toHaveClass(/active/);
});

test('Navbar: the Account avatar shows your initials and opens the Account menu under it; the cog opens Settings', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.setViewportSize({ width: 1366, height: 800 });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  await expect(page.locator('#accountAvatar')).toHaveText('TA');
  await expect(page.locator('#accountBtn')).toHaveAttribute('title', /Test Admin/);
  await page.locator('#accountBtn').click();
  await expect(page.locator('#accountDropdown')).toBeVisible();
  await expect(page.locator('#settingsDropdown')).toBeHidden();
  await expect(page.locator('#accountWhoName')).toHaveText('Test Admin');
  await expect(page.locator('#accountWhoRole')).toHaveText('Admin');
  await expect(page.locator('#logoutBtn')).toBeVisible();
  await expect(page.locator('#changePasswordBtn')).toBeVisible();
  const btn = await page.locator('#accountBtn').boundingBox();
  const menu = await page.locator('#accountDropdown').boundingBox();
  expect(Math.abs((menu.x + menu.width) - (btn.x + btn.width))).toBeLessThan(2);
  expect(menu.y).toBeGreaterThan(btn.y + btn.height);

  // The cog sits just left of the avatar and opens Settings (closing Account).
  const cog = await page.locator('#settingsBtn').boundingBox();
  expect(cog.x + cog.width).toBeLessThanOrEqual(btn.x + 1);
  await page.locator('#settingsBtn').click();
  await expect(page.locator('#settingsDropdown')).toBeVisible();
  await expect(page.locator('#accountDropdown')).toBeHidden();
  await expect(page.locator('#darkModeBtn')).toBeVisible();
  await expect(page.locator('#settingsDropdown #logoutBtn')).toHaveCount(0);
});

test('Navbar on a phone: the island sits under the title, starts on Jobs, and switches full-screen views', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  const island = await page.locator('#appNavNotch').boundingBox();
  const brand = await page.locator('.app-nav-brand').boundingBox();
  expect(island.y).toBeGreaterThan(brand.y + brand.height);
  await expect(page.locator('#tab-jobs')).toBeVisible();
  await expect(page.locator('#tab-jobs')).toHaveClass(/active/);

  await page.locator('#tab-board').click();
  await expect(page.locator('body')).toHaveAttribute('data-mobile-view', 'board');
  await expect(page.locator('#tab-board')).toHaveClass(/active/);
  await expect(page.locator('#tab-jobs')).not.toHaveClass(/active/);
  await page.locator('#tab-board').click();
  await expect(page.locator('body')).toHaveAttribute('data-mobile-view', 'home');
  await expect(page.locator('#tab-home')).toHaveClass(/active/);
});

test('Navbar: Calendar and Reports controls sit in the top bar on wide screens and move back onto the page when narrow', async ({ page }) => {
  await seedSession(page, { role: 'admin' });
  await mockRoomWebSocket(page);
  await page.setViewportSize({ width: 1366, height: 800 });
  await page.goto(APP_URL);
  await expect(page.locator('#freshLoadOverlay')).not.toHaveClass(/show/);

  await page.locator('#tab-calendar').click();
  await expect(page.locator('#appNavCtlCalendar #calTodayBtn')).toBeVisible();
  await expect(page.locator('#appNavCtlReports')).toBeHidden();
  // The period sits left of the view toggles, which sit left of Settings.
  const today = await page.locator('#calTodayBtn').boundingBox();
  const month = await page.locator('#calViewMonth').boundingBox();
  const cog = await page.locator('#settingsBtn').boundingBox();
  expect(today.x).toBeLessThan(month.x);
  expect(month.x).toBeLessThan(cog.x);
  await page.locator('#calNextBtn').click();
  await expect(page.locator('#calendarLabel')).not.toHaveText('');

  await page.locator('#tab-reports').click();
  await expect(page.locator('#appNavCtlReports .rep-filter-btn')).toBeVisible();
  await expect(page.locator('#appNavCtlCalendar')).toBeHidden();

  // Too narrow for the top bar: both toolbars go back onto their pages.
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(page.locator('#panel-reports .rep-filter-btn')).toBeVisible();
  await page.locator('#tab-calendar').click();
  await expect(page.locator('#panel-calendar #calTodayBtn')).toBeVisible();
});
