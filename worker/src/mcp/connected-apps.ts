// --- CLAUDE CONNECTOR: Settings > Connected apps ---
//   POST /connected-apps {token}                               -> {available, apps: [...]}
//   POST /connected-apps {token, action: 'disconnect', grantId} -> {available, apps: [...]}
// Lists the signed-in person's own Claude connections and lets them end
// one. Ending it revokes the grant and its tokens (the OAuth library
// deletes them, and handler.ts refuses any call whose grant is gone), so
// Claude has to be connected again to use it.
import { jsonResponse } from '../http.ts';
import { resolveCaller, getUser } from '../users.ts';
import { recordAudit, clientIp } from '../audit.ts';
import { oauthHelpers, grantUserId, LAST_USED_PREFIX } from './policy.ts';
import type { GrantMetadata, OAuthHelpersLike } from './policy.ts';

export interface ConnectedApp {
  grantId: string;
  clientName: string;
  connectedAt: number;
  lastUsedAt: number | null;
}

// A connection made before the account's last password reset (or before it
// was re-created) no longer works (handler.ts refuses it); it is revoked
// here when found, so it doesn't linger in the list.
async function listApps(env: Env, helpers: OAuthHelpersLike, userId: string, validAfter: number): Promise<ConnectedApp[]> {
  const apps: ConnectedApp[] = [];
  let cursor: string | undefined;
  const now = Math.floor(Date.now() / 1000);
  for (let page = 0; page < 10; page++) {
    const res = await helpers.listUserGrants(userId, { limit: 100, cursor });
    for (const g of res.items || []) {
      if (g.expiresAt && g.expiresAt < now) continue;
      const meta = (g.metadata || {}) as Partial<GrantMetadata>;
      const connectedAt = typeof meta.connectedAt === 'number' ? meta.connectedAt : g.createdAt * 1000;
      if (connectedAt < validAfter) { await helpers.revokeGrant(g.id, userId); continue; }
      const lastUsed = Number(await env.USERS_KV.get(LAST_USED_PREFIX + g.id)) || null;
      apps.push({
        grantId: g.id,
        clientName: typeof meta.clientName === 'string' && meta.clientName ? meta.clientName.slice(0, 100) : 'Claude',
        connectedAt,
        lastUsedAt: lastUsed,
      });
    }
    cursor = res.cursor;
    if (!cursor) break;
  }
  apps.sort((a, b) => b.connectedAt - a.connectedAt);
  return apps;
}

export async function handleConnectedApps(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  let body: { token?: string; action?: string; grantId?: unknown };
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders); }
  const caller = await resolveCaller(env, body);
  if (!caller) return jsonResponse({ error: 'Invalid credentials' }, 401, corsHeaders);
  const helpers = oauthHelpers(env);
  if (!helpers) return jsonResponse({ available: false, apps: [] }, 200, corsHeaders);
  const userId = grantUserId(caller.username);
  const account = await getUser(env, caller.username);
  const validAfter = Math.max(account && typeof account.tokensValidAfter === 'number' ? account.tokensValidAfter : 0, account && typeof account.createdAt === 'number' ? account.createdAt : 0);

  if (body.action === 'disconnect') {
    const grantId = typeof body.grantId === 'string' ? body.grantId : '';
    const mine = grantId ? (await listApps(env, helpers, userId, validAfter)).find((a) => a.grantId === grantId) : undefined;
    if (!mine) return jsonResponse({ error: 'That connection is already gone.' }, 404, corsHeaders);
    await helpers.revokeGrant(grantId, userId);
    try { await env.USERS_KV.delete(LAST_USED_PREFIX + grantId); } catch (e) { console.error('Connector last-used cleanup failed:', e); }
    await recordAudit(env, { user: caller.username, role: caller.role, action: 'Disconnected Claude', ip: clientIp(request), details: mine.clientName });
  } else if (body.action !== undefined && body.action !== 'list') {
    return jsonResponse({ error: 'Unknown action' }, 400, corsHeaders);
  }
  return jsonResponse({ available: true, apps: await listApps(env, helpers, userId, validAfter) }, 200, corsHeaders);
}
