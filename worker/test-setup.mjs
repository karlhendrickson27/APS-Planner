// Loaded before every worker test (`npm run test:worker`, via --import).
// @cloudflare/workers-oauth-provider (src/mcp/oauth.ts) imports the
// Workers-only module "cloudflare:workers" for its WorkerEntrypoint base
// class; plain Node has no such module, so tests get a minimal stand-in.
// Nothing in this app subclasses WorkerEntrypoint, so the stand-in only
// has to exist for the library's `instanceof` checks.
import { registerHooks } from 'node:module';

const STUB = 'export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }\n' +
  'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }\n';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') {
      return { url: 'data:text/javascript,' + encodeURIComponent(STUB), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
