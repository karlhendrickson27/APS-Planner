// --- COMPLIANCE ENDPOINTS ---
// Audit log export, the "export all our data" download, and the scheduled
// "delete all our data". Admin actions re-check the caller's admin role
// against the account itself (requireAdmin) and record themselves in the
// audit trail.
import { jsonResponse } from './http.ts';
import { getRoomStub } from './room-stub.ts';
import { resolveCaller, listAllUsers, verifyCredentials } from './users.ts';
import { requireAdmin } from './users-admin.ts';
import { roomStateToAppFormat } from './backup.ts';
import { recordAudit, clientIp } from './audit.ts';
import type { RoomState } from './types.ts';

// POST { token, from, to, after? } -> { entries, cursor }. from/to are ms
// timestamps (inclusive). Returns up to 5,000 entries, oldest first; pass
// the returned cursor back as `after` for the next page (null when done).
export async function handleAuditExport(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  let body: { token?: string; from?: number; to?: number; after?: string | null };
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }
  const admin = await requireAdmin(env, await resolveCaller(env, body), corsHeaders);
  if (admin.error) return admin.error;
  const from = typeof body.from === "number" ? body.from : 0;
  const to = typeof body.to === "number" ? body.to : Date.now();
  if (!(to >= from)) return jsonResponse({ error: "Invalid date range" }, 400, corsHeaders);

  const qs = new URLSearchParams({ from: String(from), to: String(to) });
  if (typeof body.after === "string" && body.after) qs.set("after", body.after);
  const res = await getRoomStub(env).fetch("https://internal/internal/audit-list?" + qs.toString());
  if (!res.ok) return jsonResponse({ error: "Could not read the audit log" }, 500, corsHeaders);
  const page = await res.json() as { entries: unknown[]; cursor: string | null };
  // One entry per download, not per page.
  if (!body.after) {
    await recordAudit(env, { user: admin.user!.username, role: "admin", action: "Downloaded audit log", ip: clientIp(request),
      details: new Date(from).toISOString().slice(0, 10) + " to " + new Date(to).toISOString().slice(0, 10) });
  }
  return jsonResponse(page, 200, corsHeaders);
}

export const DATA_EXPORT_FORMAT = "teamsync-export-v1";

// POST { token } -> one JSON document with everything the company has
// stored: every project (in the backup format, so it can also be restored
// from), the user list (never password hashes or salts) and a list of the
// attached files (downloadable individually; file contents aren't inlined).
export async function handleDataExport(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  let body: { token?: string };
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }
  const admin = await requireAdmin(env, await resolveCaller(env, body), corsHeaders);
  if (admin.error) return admin.error;

  const res = await getRoomStub(env).fetch("https://internal/internal/export");
  if (!res.ok) return jsonResponse({ error: "Could not read project data" }, 500, corsHeaders);
  const roomState = await res.json() as RoomState;

  const users = (await listAllUsers(env)).map(function (u) {
    return { username: u.username, displayName: u.displayName, role: u.role, assignedProjectId: u.assignedProjectId, isLead: u.isLead, createdAt: u.createdAt, twoStepEnabled: u.mfaEnabled, email: u.email || null, emailConfirmed: u.emailConfirmed };
  });

  const attachments: { key: string; size: number; uploaded: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.BACKUP_BUCKET.list({ prefix: "attachments/", cursor: cursor });
    page.objects.forEach(function (o) { attachments.push({ key: o.key, size: o.size, uploaded: new Date(o.uploaded).toISOString() }); });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const exportedAt = new Date().toISOString();
  await recordAudit(env, { user: admin.user!.username, role: "admin", action: "Exported all company data", ip: clientIp(request) });
  return new Response(JSON.stringify({
    format: DATA_EXPORT_FORMAT,
    exportedAt: exportedAt,
    exportedBy: admin.user!.username,
    notes: "projects uses the TeamSync backup format. users never includes password data. " +
      "attachments lists every uploaded file; download one with the attachment link in the app. " +
      "The audit log is exported separately (Settings > Security & data).",
    projects: roomStateToAppFormat(roomState),
    users: users,
    attachments: attachments,
  }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Content-Disposition": 'attachment; filename="teamsync-export-' + exportedAt.slice(0, 10) + '.json"' }
  });
}

// ===== "Delete all our data" =====
// Two steps, seven days apart, so a mistake or a compromised admin account
// can't destroy everything at once:
//   1. An admin schedules it (password re-entered + the typed phrase). The
//      deletion date is set here, server-side, DELETION_DELAY_MS ahead.
//      Every signed-in user sees a warning banner until then, and any admin
//      can cancel. Both steps are in the audit trail.
//   2. The 6-hourly scheduled job (index.ts) runs runDueDeletion(), which
//      deletes everything once that date has passed: all project data and
//      the audit trail (the room Durable Object's storage), every backup
//      and attachment (R2), and every account and setting (KV). It leaves
//      one audit entry recording that the deletion happened.
// Nothing else starts a deletion.
export const DELETION_KV_KEY = "data-deletion-scheduled";
export const DELETION_DELAY_MS = 7 * 24 * 60 * 60 * 1000;
export const DELETION_CONFIRM_PHRASE = "DELETE ALL DATA";

export interface ScheduledDeletion { requestedBy: string; requestedAt: number; executeAt: number }

export async function getScheduledDeletion(env: Env): Promise<ScheduledDeletion | null> {
  const raw = await env.USERS_KV.get(DELETION_KV_KEY);
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    return d && typeof d.executeAt === "number" ? d : null;
  } catch (e) {
    return null;
  }
}

// POST { token } -> { scheduled: ScheduledDeletion | null }. Any signed-in
// user: everyone should be able to see that deletion is pending.
export async function handleDeletionStatus(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  let body: { token?: string };
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }
  if (!(await resolveCaller(env, body))) return jsonResponse({ error: "Invalid credentials" }, 401, corsHeaders);
  return jsonResponse({ scheduled: await getScheduledDeletion(env) }, 200, corsHeaders);
}

// POST { token, password, confirm } -> { scheduled }.
export async function handleDeletionSchedule(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  let body: { token?: string; password?: string; confirm?: string };
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }
  const admin = await requireAdmin(env, await resolveCaller(env, body), corsHeaders);
  if (admin.error) return admin.error;
  if (body.confirm !== DELETION_CONFIRM_PHRASE) {
    return jsonResponse({ error: 'Type "' + DELETION_CONFIRM_PHRASE + '" exactly to confirm' }, 400, corsHeaders);
  }
  if (!(await verifyCredentials(env, admin.user!.username, body.password))) {
    return jsonResponse({ error: "Password is incorrect" }, 403, corsHeaders);
  }
  const existing = await getScheduledDeletion(env);
  if (existing) return jsonResponse({ scheduled: existing }, 200, corsHeaders);
  const now = Date.now();
  const scheduled: ScheduledDeletion = { requestedBy: admin.user!.username, requestedAt: now, executeAt: now + DELETION_DELAY_MS };
  await env.USERS_KV.put(DELETION_KV_KEY, JSON.stringify(scheduled));
  await recordAudit(env, { user: admin.user!.username, role: "admin", action: "Scheduled deletion of all company data", ip: clientIp(request),
    details: "deletes on " + new Date(scheduled.executeAt).toISOString() });
  return jsonResponse({ scheduled: scheduled }, 200, corsHeaders);
}

// POST { token } -> { scheduled: null }. Any admin can cancel.
export async function handleDeletionCancel(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  let body: { token?: string };
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }
  const admin = await requireAdmin(env, await resolveCaller(env, body), corsHeaders);
  if (admin.error) return admin.error;
  const existing = await getScheduledDeletion(env);
  await env.USERS_KV.delete(DELETION_KV_KEY);
  if (existing) {
    await recordAudit(env, { user: admin.user!.username, role: "admin", action: "Cancelled deletion of all company data", ip: clientIp(request),
      details: "had been requested by " + existing.requestedBy });
  }
  return jsonResponse({ scheduled: null }, 200, corsHeaders);
}

async function deleteR2Prefix(env: Env, prefix: string): Promise<number> {
  let n = 0;
  for (;;) {
    const page = await env.BACKUP_BUCKET.list({ prefix: prefix, limit: 1000 });
    if (!page.objects.length) return n;
    await env.BACKUP_BUCKET.delete(page.objects.map(function (o) { return o.key; }));
    n += page.objects.length;
  }
}

// Lists every key first, then deletes: deleting while paging through a
// listing can shift the pages and skip keys.
async function deleteAllKv(kv: KVNamespace): Promise<number> {
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ cursor: cursor });
    page.keys.forEach(function (k) { names.push(k.name); });
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  for (const name of names) await kv.delete(name);
  return names.length;
}

// Called by the scheduled job. Returns true if it deleted (the caller then
// skips that run's backup).
export async function runDueDeletion(env: Env, now?: number): Promise<boolean> {
  const scheduled = await getScheduledDeletion(env);
  if (!scheduled || scheduled.executeAt > (now === undefined ? Date.now() : now)) return false;
  console.warn("Running scheduled deletion of all company data:", JSON.stringify(scheduled));
  const res = await getRoomStub(env).fetch("https://internal/internal/wipe", { method: "POST" });
  if (!res.ok) throw new Error("Room wipe failed: " + res.status);
  const backups = await deleteR2Prefix(env, "backups/");
  const attachments = await deleteR2Prefix(env, "attachments/");
  // Accounts and settings, plus the Claude connector's sign-ins (its keys
  // name the username), when that namespace is bound.
  const oauthKv = (env as unknown as { OAUTH_KV?: KVNamespace }).OAUTH_KV;
  const kvKeys = await deleteAllKv(env.USERS_KV) + (oauthKv ? await deleteAllKv(oauthKv) : 0);
  await recordAudit(env, { user: scheduled.requestedBy, action: "Deleted all company data",
    details: "requested " + new Date(scheduled.requestedAt).toISOString() + "; removed " + backups + " backups, " + attachments + " attachments, " + kvKeys + " account/setting entries" });
  console.warn("Scheduled deletion complete:", backups, "backups,", attachments, "attachments,", kvKeys, "KV keys");
  return true;
}
