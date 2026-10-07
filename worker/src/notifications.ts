// --- IN-APP NOTIFICATIONS: per-person state (roadmap A4) ---
//   POST /notifications/state  {token, patch?} -> {state}
// The notifications themselves are worked out in the app from the shared
// schedule (src/app/notifications.ts): comments, @mentions, checklist items
// assigned to you, due dates. What the server keeps is only each person's
// own bookkeeping, so it follows them from phone to desktop:
//   - since:    when they first had notifications; older things never show
//   - seen:     key -> first time the app saw that fact (e.g. "assigned to
//               you"), for facts the schedule doesn't timestamp itself
//   - read:     key -> when they read it
//   - readUpTo: "Mark all read" time
//   - off:      the alert kinds they turned off
// Stored under its own key, notify:<username>, not on the user record (that
// record is read on every request and shouldn't grow).
import { jsonResponse } from './http.ts';
import { resolveCaller, getUser } from './users.ts';

const KEY_PREFIX = 'notify:';
export const NOTIFY_KINDS = ['assigned', 'due', 'overdue', 'mention', 'comment'];
const KEEP_MS = 60 * 24 * 60 * 60 * 1000;   // forget read marks after 60 days
const MAX_READ = 3000;
const MAX_SEEN = 5000;
const MAX_KEY_LEN = 200;

export interface NotifyState {
  since: number;
  seen: Record<string, number>;
  read: Record<string, number>;
  readUpTo: number;
  off: string[];
}

interface NotifyPatch {
  seen?: Record<string, number>;
  read?: Record<string, number>;
  readUpTo?: number;
  off?: string[];
}

function cleanMap(m: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!m || typeof m !== 'object' || Array.isArray(m)) return out;
  for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
    if (typeof k === 'string' && k.length <= MAX_KEY_LEN && typeof v === 'number' && isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
}

// Read marks are only needed while a notification can still show (30 days
// in the app), so old ones are dropped. "Seen" times are never dropped by
// age: a fact that's still true (you're still on that job) would otherwise
// look new again. 0 means "was already there before notifications started".
// Both are capped, keeping the newest.
function prune(m: Record<string, number>, now: number, maxAge: number | null, max: number): Record<string, number> {
  const entries = Object.entries(m).filter(([, t]) => maxAge === null || t === 0 || now - t < maxAge);
  if (entries.length > max) {
    entries.sort((a, b) => b[1] - a[1]);
    entries.length = max;
  }
  return Object.fromEntries(entries);
}

export function mergeNotifyState(state: NotifyState, patch: NotifyPatch, now: number): NotifyState {
  const seen = { ...state.seen };
  for (const [k, t] of Object.entries(cleanMap(patch.seen))) {
    // The first device to see something sets its time.
    if (!(k in seen) || t < seen[k]) seen[k] = t;
  }
  const read = { ...state.read, ...cleanMap(patch.read) };
  const readUpTo = typeof patch.readUpTo === 'number' && isFinite(patch.readUpTo) ? Math.max(state.readUpTo, Math.min(patch.readUpTo, now)) : state.readUpTo;
  const off = Array.isArray(patch.off) ? patch.off.filter((k) => NOTIFY_KINDS.includes(k)) : state.off;
  return { since: state.since, seen: prune(seen, now, null, MAX_SEEN), read: prune(read, now, KEEP_MS, MAX_READ), readUpTo, off };
}

export async function handleNotificationState(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  let body: { token?: string; patch?: NotifyPatch };
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders); }
  const caller = await resolveCaller(env, body);
  const user = caller ? await getUser(env, caller.username) : null;
  if (!user) return jsonResponse({ error: 'Invalid credentials' }, 401, corsHeaders);
  const key = KEY_PREFIX + user.username;
  const now = Date.now();
  let state: NotifyState | null = null;
  const raw = await env.USERS_KV.get(key);
  if (raw) { try { state = JSON.parse(raw); } catch (e) { state = null; } }
  const isNew = !state;
  if (!state) state = { since: now, seen: {}, read: {}, readUpTo: 0, off: [] };
  if (body.patch && typeof body.patch === 'object') {
    state = mergeNotifyState(state, body.patch, now);
    await env.USERS_KV.put(key, JSON.stringify(state));
  } else if (isNew) {
    await env.USERS_KV.put(key, JSON.stringify(state));
  }
  return jsonResponse({ state }, 200, corsHeaders);
}
