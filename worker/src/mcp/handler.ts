// --- CLAUDE CONNECTOR: the /mcp endpoint ---
// Reached only with a valid access token: the OAuth library (oauth.ts)
// checks it and hands over the grant's props in ctx.props. On every call
// the account is loaded fresh, so removing someone, resetting their
// password, or changing their role or project applies at once.
import { getUser } from '../users.ts';
import { getRoomStub } from '../room-stub.ts';
import { getMaintenanceStatus } from '../maintenance.ts';
import { handleMcpHttp } from './protocol.ts';
import { resourceMetadataUrl, LAST_USED_PREFIX, LAST_USED_EVERY_MS } from './policy.ts';
import type { GrantProps } from './policy.ts';
import type { McpUser } from './schedule.ts';
import type { ToolContext, RoomGateway } from './tools.ts';
import type { McpMessage } from '../room-do.ts';

type ConnectorCtx = ExecutionContext & { props?: unknown; auth?: { token?: string } };

// The account a grant acts for, as it is now, or null if the grant no
// longer counts: the account was removed (or removed and re-added), or its
// password was reset after the grant was made.
export async function currentConnectorUser(env: Env, props: unknown): Promise<McpUser | null> {
  const p = props as Partial<GrantProps> | null | undefined;
  if (!p || typeof p.username !== 'string' || !p.username) return null;
  const user = await getUser(env, p.username);
  if (!user) return null;
  const grantedAt = typeof p.grantedAt === 'number' ? p.grantedAt : 0;
  if (typeof user.tokensValidAfter === 'number' && grantedAt < user.tokensValidAfter) return null;
  if (typeof user.createdAt === 'number' && grantedAt < user.createdAt) return null;
  return { username: user.username, displayName: user.displayName, role: user.role, assignedProjectId: user.assignedProjectId || null };
}

// The identity connector writes carry into the room (see applyAsUser()):
// the person, plus "(via Claude)" on the name everyone sees and in the audit.
export function connectorAttachment(user: McpUser) {
  return {
    username: user.username,
    displayName: user.displayName + ' (via Claude)',
    role: user.role,
    assignedProjectId: user.assignedProjectId,
    ip: 'claude-connector',
    via: 'Claude',
    view: null,
    projectId: null,
  };
}

export function roomGateway(env: Env, user: McpUser): RoomGateway {
  const attachment = connectorAttachment(user);
  const call = async (path: string, body: unknown) => {
    const res = await getRoomStub(env).fetch('https://internal/internal/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('room ' + path + ' answered ' + res.status);
    return res.json();
  };
  return {
    read: () => call('mcp-read', { attachment }) as ReturnType<RoomGateway['read']>,
    apply: (messages: McpMessage[]) => call('mcp-apply', { attachment, messages }) as ReturnType<RoomGateway['apply']>,
  };
}

export function toolContext(env: Env, user: McpUser): ToolContext {
  return {
    user,
    room: roomGateway(env, user),
    maintenance: () => getMaintenanceStatus(env),
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
  };
}

function invalidToken(origin: string, description: string): Response {
  return new Response(JSON.stringify({ error: 'invalid_token', error_description: description }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer error="invalid_token", error_description="' + description + '", resource_metadata="' + resourceMetadataUrl(origin) + '"',
    },
  });
}

// Access tokens look like "<userId>:<grantId>:<secret>".
export function grantIdFromToken(token: unknown): string {
  const parts = typeof token === 'string' ? token.split(':') : [];
  return parts.length === 3 ? parts[1] : '';
}

async function noteLastUsed(env: Env, grantId: string, now: number): Promise<void> {
  if (!grantId) return;
  try {
    const prev = Number(await env.USERS_KV.get(LAST_USED_PREFIX + grantId)) || 0;
    if (now - prev < LAST_USED_EVERY_MS) return;
    await env.USERS_KV.put(LAST_USED_PREFIX + grantId, String(now), { expirationTtl: 40 * 24 * 60 * 60 });
  } catch (e) {
    console.error('Connector last-used write failed:', e);
  }
}

export const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ConnectorCtx): Promise<Response> {
    const origin = new URL(request.url).origin;
    const user = await currentConnectorUser(env, ctx.props);
    if (!user) return invalidToken(origin, 'This TeamSync connection is no longer valid. Connect again.');
    const used = noteLastUsed(env, grantIdFromToken(ctx.auth && ctx.auth.token), Date.now());
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(used); else await used;
    return handleMcpHttp(request, async () => toolContext(env, user));
  },
};
