// --- CLAUDE CONNECTOR: OAuth 2.1 (what claude.ai custom connectors use) ---
// @cloudflare/workers-oauth-provider wraps the Worker's fetch. It serves
// only its own protocol routes and passes everything else straight to the
// existing router, untouched:
//   /.well-known/oauth-authorization-server   metadata
//   /.well-known/oauth-protected-resource/mcp  metadata for /mcp
//   /register    dynamic client registration (Claude registers itself)
//   /token       code + PKCE -> access token (1 hour) + refresh (30 days)
//   /mcp         needs a valid access token, then mcpApiHandler (handler.ts)
// /authorize is ours (authorize.ts), reached through the router.
// Grants and tokens live in the OAUTH_KV namespace, encrypted by the
// library. This is the only file that imports the library (it needs the
// Workers runtime), so everything else stays testable in plain Node.
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { mcpApiHandler } from './handler.ts';
import { isAllowedRedirectUri, allowLocalhost, OAUTH_SCOPE, ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS } from './policy.ts';

type Router = { fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> };

// The resource is named by the address it's reached at (today the
// workers.dev one, later api.useteamsync.com), so one provider per origin.
// A token is only good at the address it was issued for; moving the
// server means connecting Claude again with the new address.
const providers = new Map<string, OAuthProvider<Env>>();

function buildProvider(origin: string, localhostOk: boolean, router: Router): OAuthProvider<Env> {
  return new OAuthProvider<Env>({
    apiHandlers: { '/mcp': mcpApiHandler as never },
    defaultHandler: router,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
    accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
    scopesSupported: [OAUTH_SCOPE],
    resourceMetadata: { resource: origin + '/mcp', authorization_servers: [origin], resource_name: 'TeamSync' },
    // Only Claude may register, judged by where it wants codes sent.
    clientRegistrationCallback({ clientMetadata }) {
      const uris = clientMetadata.redirect_uris;
      if (!Array.isArray(uris) || !uris.length || !uris.every((u) => isAllowedRedirectUri(u, localhostOk))) {
        return { code: 'invalid_redirect_uri', description: 'TeamSync only accepts connections from Claude.' };
      }
      return undefined;
    },
  });
}

export function providerFor(origin: string, env: Env, router: Router): OAuthProvider<Env> {
  const localhostOk = allowLocalhost(env);
  const key = origin + '|' + (localhostOk ? 'dev' : '');
  let p = providers.get(key);
  if (!p) { p = buildProvider(origin, localhostOk, router); providers.set(key, p); }
  return p;
}

const CONNECTOR_PATHS = ['/mcp', '/authorize', '/token', '/register'];

// The Worker's fetch: the OAuth provider in front of the existing router.
// Until OAUTH_KV is bound, or for an address the library won't accept as
// a resource (it needs https, or http on localhost), requests go to the
// router exactly as before and the connector's own paths answer 503.
export async function fetchWithConnector(request: Request, env: Env, ctx: ExecutionContext, router: Router): Promise<Response> {
  const url = new URL(request.url);
  let provider: OAuthProvider<Env> | null = null;
  if ((env as unknown as { OAUTH_KV?: unknown }).OAUTH_KV) {
    try { provider = providerFor(url.origin, env, router); } catch (e) { provider = null; }
  }
  // A fresh env object per request: the library caches its helpers on
  // env.OAUTH_PROVIDER, and those are tied to the provider (so to the
  // origin) that made them.
  if (provider) return provider.fetch(request, { ...env }, ctx);
  if (CONNECTOR_PATHS.indexOf(url.pathname) !== -1 || url.pathname.startsWith('/.well-known/oauth-')) {
    return new Response(JSON.stringify({ error: 'The Claude connector is not set up on this server.' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
  return router.fetch(request, env, ctx);
}
