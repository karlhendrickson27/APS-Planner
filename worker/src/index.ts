// ==========================================
// TeamSync — Worker (Durable Objects backend) — entry point / router
// ==========================================
//
// Routes incoming requests to the appropriate handler and re-exports the
// ApsRoom Durable Object class (defined in room-do.ts) so it's included
// in this deployed script. Cloudflare requires a Durable Object's class
// to live in the same deployed script as the binding that references it
// — but that's a bundling requirement, not a source-file one: wrangler
// bundles a Worker's local ES module imports into one script
// automatically, so the implementation is split across the sibling files
// in this directory.
//
// Bindings this worker needs (configured in wrangler.jsonc/the dashboard):
//   APS_ROOM        Durable Object namespace, class name "ApsRoom",
//                    pointing at this same script.
//   ROOM_TOKEN_SECRET  Secret (Settings -> Variables and Secrets) — any
//                    long random string, used to sign/verify room
//                    connection tokens.
//   BACKUP_BUCKET, USERS_KV  R2 bucket and KV namespace used for backups
//                    and user accounts respectively.
//
// Attachments (card/job file uploads) live in R2 under an attachments/
// prefix in the same BACKUP_BUCKET, rather than inline base64 in the
// synced data — see attachments.ts.

import { getRoomStub } from './room-stub.ts';
import { jsonResponse } from './http.ts';
import { handleAuth, handleAuthMfa } from './auth.ts';
import { handleSsoConfig, handleGoogleStart, handleGoogleCallback, handleSsoRedeem, handleSsoSettings, handleSsoLinkTicket } from './sso.ts';
import { handleAccountMe, handleAccountEmail } from './account.ts';
import { handleMfaStatus, handleMfaSetup, handleMfaEnable, handleMfaDisable, handleMfaRecoveryCodes, handleUsersResetMfa, handleSecurityPolicy } from './mfa-handlers.ts';
import { runBackup, handleTriggerBackup, handleListBackups, handleDownloadBackup, handleRestoreBackup } from './backup.ts';
import {
  handleUsersList, handleUsersRoster, handleUsersAdd,
  handleUsersUpdate, handleUsersRemove, handleUsersResetPassword
} from './users-admin.ts';
import { handleAttachmentUpload, handleAttachmentDownload, handleAttachmentDelete } from './attachments.ts';
import { handleReportError, handleErrorsList } from './errors.ts';
import { handleAdminNotices, handleAdminNoticesSeen } from './admin-notices.ts';
import { handleMaintenanceStatus, handleSetMaintenanceStatus } from './maintenance.ts';
import { handleAuditExport, handleDataExport, handleDeletionStatus, handleDeletionSchedule, handleDeletionCancel, runDueDeletion } from './compliance.ts';
import { handleCalendarFeedLink, handleCalendarFeed } from './calendar-feed.ts';
import { handleNotificationState } from './notifications.ts';
export { ApsRoom } from './room-do.ts';

// --- WORKER ENTRYPOINTS ---
export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // A due "delete all our data" request runs here, instead of that run's
    // backup (see runDueDeletion() in compliance.ts).
    if (await runDueDeletion(env)) return;
    await runBackup(env);
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      // X-Aps-Token — attachment upload sends the session token as a
      // header instead of a query param (its POST body is the raw file
      // bytes, not JSON, so there's no body field to put it in) — see
      // handleAttachmentUpload().
      "Access-Control-Allow-Headers": "Content-Type, X-Aps-Token",
      "Cache-Control": "no-store",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Realtime room connection — the client opens a WebSocket here with
    // ?token=... (minted by POST / below). Auth is checked by the
    // Durable Object itself on upgrade, not here; this just routes to
    // the one shared room instance.
    if (url.pathname === "/room" && request.headers.get("Upgrade") === "websocket") {
      return getRoomStub(env).fetch(request);
    }

    // Public health check for the status page (.github/workflows/status.yml).
    // "ok" means this Worker AND the room Durable Object answered; it
    // reveals nothing about the data.
    if (url.pathname === "/health" && request.method === "GET") {
      try {
        const res = await getRoomStub(env).fetch("https://internal/internal/ping");
        if (!res.ok) throw new Error("room " + res.status);
        return jsonResponse({ status: "ok", time: new Date().toISOString() }, 200, corsHeaders);
      } catch (e) {
        return jsonResponse({ status: "unavailable" }, 503, corsHeaders);
      }
    }
    // Sign in with Google — see sso.ts. start/callback are browser
    // navigations (GET + redirects), not fetches.
    if (url.pathname === "/sso/config" && request.method === "GET") {
      return handleSsoConfig(request, env, corsHeaders);
    }
    if (url.pathname === "/sso/google/start" && request.method === "GET") {
      return handleGoogleStart(request, env, url);
    }
    if (url.pathname === "/sso/google/callback" && request.method === "GET") {
      return handleGoogleCallback(request, env, url, ctx);
    }
    if (url.pathname === "/sso/redeem" && request.method === "POST") {
      return handleSsoRedeem(request, env, corsHeaders, ctx);
    }
    if (url.pathname === "/sso/settings" && request.method === "POST") {
      return handleSsoSettings(request, env, corsHeaders);
    }
    if (url.pathname === "/sso/link-ticket" && request.method === "POST") {
      return handleSsoLinkTicket(request, env, corsHeaders);
    }
    // Self-service account details — see account.ts.
    if (url.pathname === "/account/me" && request.method === "POST") {
      return handleAccountMe(request, env, corsHeaders);
    }
    if (url.pathname === "/account/email" && request.method === "POST") {
      return handleAccountEmail(request, env, corsHeaders);
    }
    // Two-step verification — see auth.ts and mfa-handlers.ts.
    if (url.pathname === "/auth/mfa" && request.method === "POST") {
      return handleAuthMfa(request, env, corsHeaders, ctx);
    }
    if (url.pathname === "/mfa/status" && request.method === "POST") {
      return handleMfaStatus(request, env, corsHeaders);
    }
    if (url.pathname === "/mfa/setup" && request.method === "POST") {
      return handleMfaSetup(request, env, corsHeaders);
    }
    if (url.pathname === "/mfa/enable" && request.method === "POST") {
      return handleMfaEnable(request, env, corsHeaders, ctx);
    }
    if (url.pathname === "/mfa/disable" && request.method === "POST") {
      return handleMfaDisable(request, env, corsHeaders);
    }
    if (url.pathname === "/mfa/recovery-codes" && request.method === "POST") {
      return handleMfaRecoveryCodes(request, env, corsHeaders);
    }
    if (url.pathname === "/users/reset-mfa" && request.method === "POST") {
      return handleUsersResetMfa(request, env, corsHeaders);
    }
    if (url.pathname === "/security/policy" && request.method === "POST") {
      return handleSecurityPolicy(request, env, corsHeaders);
    }
    if (url.pathname === "/" || url.pathname === "/auth") {
      return handleAuth(request, env, corsHeaders, ctx);
    }

    if (url.pathname === "/trigger-backup" && request.method === "POST") {
      return handleTriggerBackup(request, env, corsHeaders);
    }
    if (url.pathname === "/list-backups" && request.method === "POST") {
      return handleListBackups(request, env, corsHeaders);
    }
    // POST-only, credentials in the JSON body — was GET with
    // username/password/key as query params, which lands verbatim in
    // Worker access logs on every download. The client now fetch()es this
    // (instead of window.open(), which can't send a POST body) and turns
    // the response into a local download itself.
    if (url.pathname === "/download-backup" && request.method === "POST") {
      return handleDownloadBackup(request, env, corsHeaders);
    }
    // Same reasoning as /download-backup above — POST + JSON body instead
    // of the admin password sitting in a GET query string.
    if (url.pathname === "/restore-backup" && request.method === "POST") {
      return handleRestoreBackup(request, env, corsHeaders);
    }

    if (url.pathname === "/users/list" && request.method === "POST") {
      return handleUsersList(request, env, corsHeaders);
    }
    if (url.pathname === "/users/roster" && request.method === "POST") {
      return handleUsersRoster(request, env, corsHeaders);
    }
    if (url.pathname === "/users/add" && request.method === "POST") {
      return handleUsersAdd(request, env, corsHeaders);
    }
    if (url.pathname === "/users/update" && request.method === "POST") {
      return handleUsersUpdate(request, env, corsHeaders);
    }
    if (url.pathname === "/users/remove" && request.method === "POST") {
      return handleUsersRemove(request, env, corsHeaders);
    }
    if (url.pathname === "/users/reset-password" && request.method === "POST") {
      return handleUsersResetPassword(request, env, corsHeaders);
    }

    if (url.pathname === "/report-error" && request.method === "POST") {
      return handleReportError(request, env, corsHeaders);
    }
    if (url.pathname === "/errors/list" && request.method === "POST") {
      return handleErrorsList(request, env, corsHeaders);
    }
    if (url.pathname === "/admin/notices" && request.method === "POST") {
      return handleAdminNotices(request, env, corsHeaders);
    }
    if (url.pathname === "/admin/notices/seen" && request.method === "POST") {
      return handleAdminNoticesSeen(request, env, corsHeaders);
    }

    // Public, no auth — see maintenance.ts's own comment on why.
    if (url.pathname === "/maintenance-status" && request.method === "GET") {
      return handleMaintenanceStatus(request, env, corsHeaders);
    }
    if (url.pathname === "/maintenance-status/set" && request.method === "POST") {
      return handleSetMaintenanceStatus(request, env, corsHeaders);
    }

    if (url.pathname === "/audit/export" && request.method === "POST") {
      return handleAuditExport(request, env, corsHeaders);
    }
    if (url.pathname === "/data/delete/status" && request.method === "POST") {
      return handleDeletionStatus(request, env, corsHeaders);
    }
    if (url.pathname === "/data/delete/schedule" && request.method === "POST") {
      return handleDeletionSchedule(request, env, corsHeaders);
    }
    if (url.pathname === "/data/delete/cancel" && request.method === "POST") {
      return handleDeletionCancel(request, env, corsHeaders);
    }
    if (url.pathname === "/data/export" && request.method === "POST") {
      return handleDataExport(request, env, corsHeaders);
    }
    if (url.pathname === "/notifications/state" && request.method === "POST") {
      return handleNotificationState(request, env, corsHeaders);
    }
    if (url.pathname === "/calendar-feed/link" && request.method === "POST") {
      return handleCalendarFeedLink(request, env, corsHeaders);
    }
    // Live calendar feed (calendar-feed.ts): fetched by Outlook/Google
    // Calendar themselves, so a plain GET with the secret in the path.
    if (url.pathname.startsWith("/cal/") && request.method === "GET") {
      return handleCalendarFeed(env, corsHeaders, url);
    }
    if (url.pathname === "/attachments/upload" && request.method === "POST") {
      return handleAttachmentUpload(request, env, corsHeaders, url);
    }
    if (url.pathname === "/attachments/download") {
      return handleAttachmentDownload(request, env, corsHeaders, url);
    }
    if (url.pathname === "/attachments/delete" && request.method === "POST") {
      return handleAttachmentDelete(request, env, corsHeaders);
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  }
};
