const path = require('path');
const { pathToFileURL } = require('url');

const APP_URL = pathToFileURL(path.resolve(__dirname, '..', 'index.html')).toString();
const WORKER_ORIGIN = 'https://aps-planner-staging.production-db3.workers.dev';

function base64Url(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Matches decodeSessionTokenPayload()/isSessionTokenUsable() in
// src/auth/session.ts — the client only ever checks `exp` locally, never
// the signature, so ".fakesig" is accepted as a locally-valid-looking
// token without needing the real ROOM_TOKEN_SECRET.
function fakeSessionToken({ username, displayName, role, assignedProjectId, ttlMs = 60 * 60 * 1000 }) {
  const payload = { username, displayName, role, assignedProjectId: assignedProjectId || null, exp: Date.now() + ttlMs };
  return base64Url(JSON.stringify(payload)) + '.fakesig';
}

// Seeds a locally-valid session BEFORE the page's own boot() runs, and
// mocks every Worker JSON endpoint with a generic 200 so boot doesn't 401
// itself back into the login overlay. Does NOT mock the /room WebSocket —
// callers that care about sync/offline behavior handle that themselves via
// page.routeWebSocket().
async function seedSession(page, { username = 'testadmin', displayName = 'Test Admin', role = 'admin', assignedProjectId = null } = {}) {
  const token = fakeSessionToken({ username, displayName, role, assignedProjectId });
  await page.addInitScript(([tok, user]) => {
    localStorage.setItem('gantt_session_token_v1', tok);
    localStorage.setItem('gantt_username_v1', user);
  }, [token, username]);

  await page.route(WORKER_ORIGIN + '/**', (route) => {
    const url = route.request().url();
    if (url.includes('/room')) return route.abort(); // WS upgrades aren't HTTP-routable this way; real WS tests use routeWebSocket()
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  return token;
}

// Simulates a successful room connection that immediately delivers an
// (empty) snapshot — enough to satisfy applyRoomSnapshot()'s
// isFirstSnapshot path (hides #freshLoadOverlay, sets roomEverConnected)
// without needing a real Worker/Durable Object round trip.
async function mockRoomWebSocket(page) {
  await page.routeWebSocket(/\/room\?/, (ws) => {
    ws.send(JSON.stringify({ type: 'snapshot', projects: {} }));
  });
}

// A brand-new (empty) room starts with ONE project; tests about switching
// or linking between projects add a second one here, the way the app
// used to fabricate two (same starter jobs). Returns its id; the active
// project doesn't change.
async function addSecondProject(page, name = 'Second Co') {
  return page.evaluate((projectName) => {
    const id = 'project-test-' + genId();
    projects[id] = {
      id, name: projectName,
      jobs: JSON.parse(JSON.stringify(projects[activeProjectId].jobs)),
      boardColumns: JSON.parse(JSON.stringify(DEFAULT_BOARD_COLUMNS)),
      boardCards: [], calendarEvents: [], deletedIds: {}, fieldOptions: {},
      header: { title: projectName, subtitle: '', theme: '#3949ab', bgPhoto: null, boardBgPhoto: null },
    };
    saveProjects();
    updateProjectToggle();
    return id;
  }, name);
}

module.exports = { APP_URL, WORKER_ORIGIN, fakeSessionToken, seedSession, mockRoomWebSocket, addSecondProject };
