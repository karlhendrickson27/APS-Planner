// --- CLAUDE CONNECTOR: shared rules and types ---
// Kept free of the OAuth library so every other connector file (and its
// tests) can use these without loading it.
import { normalizeUsername } from '../users.ts';

// Where an authorization may send its code: Claude only. A localhost
// address is accepted only while the MCP_ALLOW_LOCALHOST secret/var is
// "true" (for testing with a local MCP client during development).
export const CLAUDE_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];

declare global {
  interface Env {
    MCP_ALLOW_LOCALHOST?: string;
  }
}

export function allowLocalhost(env: Env): boolean {
  return env.MCP_ALLOW_LOCALHOST === 'true';
}

export function isAllowedRedirectUri(uri: unknown, localhostOk: boolean): boolean {
  if (typeof uri !== 'string') return false;
  if (CLAUDE_REDIRECT_URIS.indexOf(uri) !== -1) return true;
  if (!localhostOk) return false;
  let u: URL;
  try { u = new URL(uri); } catch (e) { return false; }
  return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && !u.username && !u.password;
}

export const OAUTH_SCOPE = 'teamsync';
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

// What a grant remembers. Just who it's for and when it was made: the
// role and project are re-read from the account on every call (handler.ts),
// and grantedAt lets a password reset or a removed-and-re-added account
// end the connection, the same as it signs out the app.
export interface GrantProps {
  username: string;
  grantedAt: number;
}

// Grant metadata, shown in Settings > Connected apps.
export interface GrantMetadata {
  clientName: string;
  connectedAt: number;
}

// The OAuth library keys grants by a user id that can't contain ':'.
export function grantUserId(username: string): string {
  return encodeURIComponent(normalizeUsername(username));
}

// The parts of the library's helpers (env.OAUTH_PROVIDER) this app uses,
// typed here so the files using them don't import the library.
export interface AuthRequestLike {
  responseType: string;
  clientId: string;
  redirectUri: string;
  scope: string[];
  state: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  resource?: string;
  issuer?: string;
}
export interface GrantSummaryLike {
  id: string;
  clientId: string;
  userId: string;
  scope: string[];
  metadata: unknown;
  createdAt: number;
  expiresAt?: number;
}
export interface OAuthHelpersLike {
  parseAuthRequest(request: Request): Promise<AuthRequestLike>;
  lookupClient(clientId: string): Promise<{ clientId: string; clientName?: string; redirectUris: string[] } | null>;
  completeAuthorization(options: { request: AuthRequestLike; userId: string; metadata: unknown; scope: string[]; props: unknown }): Promise<{ redirectTo: string }>;
  listUserGrants(userId: string, options?: { limit?: number; cursor?: string }): Promise<{ items: GrantSummaryLike[]; cursor?: string }>;
  revokeGrant(grantId: string, userId: string): Promise<void>;
}
export function oauthHelpers(env: Env): OAuthHelpersLike | null {
  return ((env as unknown as { OAUTH_PROVIDER?: OAuthHelpersLike }).OAUTH_PROVIDER) || null;
}

// RFC 9728's address for a resource's metadata (the same one the library
// serves): https://host/.well-known/oauth-protected-resource/mcp
export function resourceMetadataUrl(origin: string): string {
  return origin + '/.well-known/oauth-protected-resource/mcp';
}

// Last time each connection was used, for Settings > Connected apps.
// Written at most every LAST_USED_EVERY_MS per connection.
export const LAST_USED_PREFIX = 'mcp-used:';
export const LAST_USED_EVERY_MS = 10 * 60 * 1000;
