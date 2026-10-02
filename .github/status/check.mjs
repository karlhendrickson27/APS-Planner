// Uptime check for the public status page (status/index.html). Run every
// ~5 minutes by .github/workflows/status.yml, which keeps the results in
// status.json on the status-data branch.
//   node .github/status/check.mjs <path to status.json>
//
// status.json:
//   components: [{ id, name }]
//   checks:     [[time ms, ms per component or -1 if down], ...]   last 7 days
//   days:       { "YYYY-MM-DD" (UTC): { <id>: [up, total] } }       last 90 days
import fs from 'node:fs';

export const COMPONENTS = [
  { id: 'app', name: 'TeamSync app', url: 'https://app.useteamsync.com/', ok: (res, body) => res.ok && body.includes('TeamSync') },
  { id: 'api', name: 'Sync server', url: 'https://aps-planner-staging.production-db3.workers.dev/health', ok: (res, body) => res.ok && body.includes('"status":"ok"') },
];
const KEEP_CHECKS_MS = 7 * 24 * 60 * 60 * 1000;
const KEEP_DAYS = 90;
const TIMEOUT_MS = 15000;
const RETRY_AFTER_MS = 10000;

async function probe(c) {
  const start = Date.now();
  try {
    const url = c.url + (c.url.includes('?') ? '&' : '?') + 'statuscheck=' + start;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': 'TeamSync status check', 'Cache-Control': 'no-cache' } });
    const body = await res.text();
    return c.ok(res, body) ? Date.now() - start : -1;
  } catch (e) {
    return -1;
  }
}

// One retry before calling something down, so a network blip on the
// checking machine isn't reported as an outage.
async function check(c) {
  const first = await probe(c);
  if (first >= 0) return first;
  await new Promise((r) => setTimeout(r, RETRY_AFTER_MS));
  return probe(c);
}

export function record(data, now, results) {
  const out = data && Array.isArray(data.checks) ? data : { checks: [], days: {} };
  out.version = 1;
  out.components = COMPONENTS.map((c) => ({ id: c.id, name: c.name }));
  out.checks = out.checks.filter((row) => now - row[0] <= KEEP_CHECKS_MS);
  out.checks.push([now].concat(COMPONENTS.map((c) => results[c.id])));
  const day = new Date(now).toISOString().slice(0, 10);
  out.days = out.days || {};
  const d = out.days[day] || (out.days[day] = {});
  COMPONENTS.forEach((c) => {
    const cur = d[c.id] || [0, 0];
    d[c.id] = [cur[0] + (results[c.id] >= 0 ? 1 : 0), cur[1] + 1];
  });
  Object.keys(out.days).sort().slice(0, -KEEP_DAYS).forEach((k) => { delete out.days[k]; });
  out.updated = new Date(now).toISOString();
  return out;
}

// Run directly (not imported by a test).
if (process.argv[1] && process.argv[1].endsWith('check.mjs')) {
  const file = process.argv[2];
  if (!file) { console.error('usage: check.mjs <status.json>'); process.exit(2); }
  let data = null;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* first run */ }
  const results = {};
  await Promise.all(COMPONENTS.map(async (c) => { results[c.id] = await check(c); }));
  fs.writeFileSync(file, JSON.stringify(record(data, Date.now(), results)));
  console.log(COMPONENTS.map((c) => c.id + ': ' + (results[c.id] >= 0 ? 'up (' + results[c.id] + ' ms)' : 'DOWN')).join(', '));
}
