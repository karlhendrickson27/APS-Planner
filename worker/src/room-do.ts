// --- THE DURABLE OBJECT — ApsRoom manages a single room's WebSocket
// connections, presence, and synced state (see room-state.ts for the
// reducer logic this delegates to). ---
import { resolveIdentityFromToken } from './users.ts';
import { tierAtLeast } from './tiers.ts';
import {
  emptyRoomState, MESSAGE_TIER_REQUIREMENTS,
  filterRoomStateForAttachment, filterUpsertProjectBatchByTier, applyMessage,
  computeRoomDelta, filterRoomDeltaForAttachment
} from './room-state.ts';
import { readItemizedRoom, writeFullRoom, writeRoomChange, migrateLegacyRoom, LEGACY_KEY } from './room-storage.ts';
import type { KvStorage } from './room-storage.ts';
import type { UpsertProjectBatchMessage } from './room-state.ts';
import type { RoomState, RoomMessage, Attachment } from './types.ts';
import { describeChange, auditKey, AUDIT_PREFIX, AUDIT_RETENTION_DAYS } from './audit.ts';
import type { AuditEntry } from './audit.ts';

// A presence entry is dropped from the broadcast if its connection hasn't
// sent a setPresence heartbeat in this long — well above the client's
// heartbeat interval so a couple of missed beats (backgrounded tab,
// brief network hiccup) don't cause a false prune.
const PRESENCE_STALE_MS = 90 * 1000;

// Connections that see the same data share a scope: every admin and every
// unrestricted account sees everything; a restricted account sees only its
// assigned project (see filterRoomStateForAttachment()).
function describeRoom(state: RoomState): string {
  const ps = Object.values(state.projects || {});
  const count = (k: 'jobs' | 'boardCards' | 'calendarEvents') => ps.reduce((n, p) => n + Object.keys(p[k] || {}).length, 0);
  return ps.length + ' projects, ' + count('jobs') + ' jobs, ' + count('boardCards') + ' cards, ' + count('calendarEvents') + ' events';
}

function scopeKey(a: Attachment | null): string {
  if (!a || a.role === 'admin' || !a.assignedProjectId) return '*';
  return 'p:' + a.assignedProjectId;
}

// What serializeAttachment()/deserializeAttachment() actually stores on
// each WebSocket — the connect-time identity plus presence fields that
// get updated on every setPresence heartbeat.
interface RoomAttachment extends Attachment {
  view: string | null;
  projectId: string | null;
  sessionId?: string | null;
  lastSeen?: number;
  // Sync protocol the client said it speaks (the "proto" query param on
  // the WebSocket URL). 2 = accepts {type:'delta'} messages after every
  // write; absent/1 = older client, still gets a full snapshot each time.
  proto?: number;
  // The client's address at connect time, for the audit trail.
  ip?: string;
}

// Durable Object storage accepts at most 128 keys per put/delete call.
const STORAGE_BATCH = 128;
const AUDIT_PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;
const AUDIT_LIST_MAX = 5000;

export class ApsRoom {
  state: DurableObjectState;
  env: Env;
  roomState: RoomState | null;
  auditSeq = 0;
  lastAuditPruneAt = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.roomState = null;

    if (typeof WebSocketRequestResponsePair !== 'undefined' && this.state.setWebSocketAutoResponse) {
      this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    }
  }

  // Storage layout — see room-storage.ts. `legacyLayout` is true only if
  // this room is still on the old single-value layout because migrating
  // it failed verification; it then keeps working exactly as before.
  legacyLayout = false;

  // One shared load per instance: two sockets connecting at the same
  // moment must not both run the migration.
  private loading: Promise<RoomState> | null = null;

  async loadRoomState(): Promise<RoomState> {
    if (this.roomState) return this.roomState;
    if (!this.loading) {
      this.loading = this.loadRoomStateOnce().finally(() => { this.loading = null; });
    }
    return this.loading;
  }

  private async loadRoomStateOnce(): Promise<RoomState> {
    if (this.roomState) return this.roomState;
    const storage = this.state.storage as unknown as KvStorage;
    const itemized = await readItemizedRoom(storage);
    if (itemized) {
      this.roomState = itemized;
      // One line per room load (Durable Objects restart on deploys and
      // after going idle) — confirms which layout is live and how big.
      console.log('Room loaded (per-item layout): ' + describeRoom(itemized));
      return this.roomState;
    }
    const legacy = await storage.get<RoomState>(LEGACY_KEY);
    if (!legacy) {
      this.roomState = emptyRoomState();
      await writeFullRoom(storage, this.roomState);
      return this.roomState;
    }
    const result = await migrateLegacyRoom(storage, legacy);
    if (result.ok) {
      console.log('Room storage migrated to per-item layout:', JSON.stringify(result));
      this.roomState = (await readItemizedRoom(storage)) as RoomState;
    } else {
      console.error('Room storage migration failed — staying on the single-value layout:', JSON.stringify(result));
      this.legacyLayout = true;
      this.roomState = legacy;
    }
    return this.roomState;
  }

  // Saves the change from `prev` to the current roomState. Per-item layout:
  // only the entries that write touched. Legacy layout: the whole value,
  // as before.
  async persist(prev: RoomState | null): Promise<void> {
    const storage = this.state.storage as unknown as KvStorage;
    if (this.legacyLayout) {
      await storage.put({ [LEGACY_KEY]: this.roomState });
      return;
    }
    const next = this.roomState as RoomState;
    const delta = prev ? computeRoomDelta(prev, next) : null;
    if (prev && !delta) return;
    if (delta) await writeRoomChange(storage, next, delta);
    else await writeFullRoom(storage, next);
  }

  // ---- Audit trail (see audit.ts) ----
  async appendAudit(entries: AuditEntry[]): Promise<void> {
    if (!entries.length) return;
    const keys = Object.create(null) as Record<string, AuditEntry>;
    entries.forEach((e) => {
      keys[auditKey(e.at, (++this.auditSeq).toString(36) + '-' + Math.random().toString(36).slice(2, 6))] = e;
    });
    const all = Object.keys(keys);
    for (let i = 0; i < all.length; i += STORAGE_BATCH) {
      const chunk: Record<string, AuditEntry> = {};
      all.slice(i, i + STORAGE_BATCH).forEach((k) => { chunk[k] = keys[k]; });
      await this.state.storage.put(chunk);
    }
    await this.pruneAudit();
  }

  async pruneAudit(): Promise<void> {
    const now = Date.now();
    if (now - this.lastAuditPruneAt < AUDIT_PRUNE_EVERY_MS) return;
    this.lastAuditPruneAt = now;
    const cutoff = now - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const old = await this.state.storage.list({ prefix: AUDIT_PREFIX, end: auditKey(cutoff, ''), limit: 1000 });
    const keys = Array.from(old.keys());
    for (let i = 0; i < keys.length; i += STORAGE_BATCH) await this.state.storage.delete(keys.slice(i, i + STORAGE_BATCH));
  }

  // Entries with from <= at <= to, oldest first, a page at a time: pass
  // the returned cursor back as `after` for the next page (null when done).
  async listAudit(from: number, to: number, after: string | null, limit: number): Promise<{ entries: AuditEntry[]; cursor: string | null }> {
    const n = Math.max(1, Math.min(AUDIT_LIST_MAX, limit || AUDIT_LIST_MAX));
    const opts: DurableObjectListOptions = { prefix: AUDIT_PREFIX, end: auditKey(to + 1, ''), limit: n };
    if (after) opts.startAfter = after; else opts.start = auditKey(from, '');
    const rows = await this.state.storage.list<AuditEntry>(opts);
    const keys = Array.from(rows.keys());
    return { entries: Array.from(rows.values()), cursor: keys.length === n ? keys[keys.length - 1] : null };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Only ever called by runDueDeletion() (compliance.ts) once a scheduled
    // deletion's date has passed: removes all project data and the audit
    // trail, and disconnects everyone.
    if (url.pathname === '/internal/wipe' && request.method === 'POST') {
      for (const ws of this.state.getWebSockets()) { try { ws.close(4002, 'Company data deleted'); } catch (e) {} }
      await this.state.storage.deleteAll();
      this.roomState = null;
      this.legacyLayout = false;
      return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/internal/ping') {
      return new Response('ok');
    }

    if (url.pathname === '/internal/audit' && request.method === 'POST') {
      let body: { entries?: AuditEntry[] };
      try { body = await request.json(); } catch (e) { return new Response('bad json', { status: 400 }); }
      const entries = (Array.isArray(body.entries) ? body.entries : []).filter((e) => e && typeof e.action === 'string');
      await this.appendAudit(entries.map((e) => Object.assign({}, e, { at: typeof e.at === 'number' ? e.at : Date.now() })));
      return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/internal/audit-list') {
      const from = Number(url.searchParams.get('from')) || 0;
      const to = Number(url.searchParams.get('to')) || Date.now();
      const page = await this.listAudit(from, to, url.searchParams.get('after'), Number(url.searchParams.get('limit')) || AUDIT_LIST_MAX);
      return new Response(JSON.stringify(page), { headers: { 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/internal/export') {
      const roomState = await this.loadRoomState();
      return new Response(JSON.stringify(roomState), { headers: { 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/internal/import' && request.method === 'POST') {
      let imported: RoomState;
      try {
        imported = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ error: 'invalid JSON body' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      if (!imported || typeof imported !== 'object' || typeof imported.projects !== 'object') {
        return new Response(JSON.stringify({ error: 'expected { projects: {...} }' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      const previousState = await this.loadRoomState();
      this.roomState = imported;
      try {
        await this.persist(previousState);
      } catch (e) {
        this.roomState = previousState;
        console.error('Failed to persist imported room state:', e);
        return new Response(JSON.stringify({ error: 'Failed to save imported state' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
      this.broadcastSnapshot();
      return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Called by handleUsersUpdate()/handleUsersRemove() (plain HTTP
    // handlers with no access to this DO's live sockets otherwise) right
    // after a role/project/removal change actually lands in KV — force-
    // closes that user's connection(s) so a stale role can't just keep
    // working until the token's own 24h expiry. Closing alone isn't
    // enough to fix stale permissions on its own (a plain reconnect would
    // just resend the same still-valid, now-stale token) — the client's
    // handleRoomClose() is what turns this specific close code into a
    // forced re-login instead of a silent reconnect.
    if (url.pathname === '/internal/kick-user' && request.method === 'POST') {
      const targetUsername = url.searchParams.get('username') || '';
      let kicked = 0;
      for (const ws of this.state.getWebSockets()) {
        const a = ws.deserializeAttachment() as RoomAttachment | null;
        if (a && a.username === targetUsername) {
          try { ws.close(4001, 'Permissions changed — please sign in again'); } catch (e) {}
          kicked++;
        }
      }
      return new Response(JSON.stringify({ success: true, kicked }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocketUpgrade(request);
    }

    return new Response('Not found', { status: 404 });
  }

  async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    const identity = await resolveIdentityFromToken(this.env, token);
    if (!identity) {
      return new Response('Unauthorized', { status: 401 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.state.acceptWebSocket(server);
    // view/projectId start null (see handlePresenceMessage below) and
    // live in this SAME attachment as identity specifically so they
    // survive hibernation too — a plain instance field would not.
    const attachment: RoomAttachment = {
      username: identity.username as string,
      displayName: identity.displayName as string,
      role: identity.role as string,
      assignedProjectId: (identity.assignedProjectId as string) || null,
      view: null,
      projectId: null,
      proto: url.searchParams.get('proto') === '2' ? 2 : 1,
      ip: request.headers.get('CF-Connecting-IP') || ''
    };
    server.serializeAttachment(attachment);

    const roomState = await this.loadRoomState();
    const scoped = filterRoomStateForAttachment(roomState, attachment);
    server.send(JSON.stringify(Object.assign({ type: 'snapshot' }, scoped)));
    this.broadcastPresence();

    return new Response(null, { status: 101, webSocket: client });
  }

  // Presence (who's currently looking at which tab/project) is
  // deliberately kept completely separate from applyMessage()/room
  // state: ephemeral connection metadata, never touches state.storage,
  // never persisted, never staleness/revision-checked. A bug here can
  // show a wrong avatar; it cannot lose or corrupt any actual data — this
  // returns before ever reaching applyMessage, and never calls persist().
  // sessionId is a random id the CLIENT generates once per page load and
  // includes on every setPresence call — the only reliable way to
  // recognize its own entry afterward. username doesn't work: anyone
  // connected via the shared team password gets username: null
  // server-side regardless of what they typed into the login prompt, so
  // comparing against the locally-typed username never matches — the
  // "seeing my own presence bubble as a phantom second user" bug
  // reported live.
  //
  // lastSeen + PRESENCE_STALE_MS below is a second, independent layer on
  // top of that: webSocketClose() is the fast path for a clean disconnect,
  // but a tab that's closed without one (crash, network drop) leaves a
  // hibernated connection in state.getWebSockets() that Cloudflare's
  // ping/pong heartbeat can take a while to notice is dead — in the
  // meantime it shows up as a ghost bubble nobody can dismiss (reported
  // live twice: once as a stray "TM" bubble, once as a duplicate "Josh"
  // bubble on someone else's screen). Since the client re-sends setPresence
  // periodically (see the client's src/sync/presence.ts setInterval), a live connection's
  // lastSeen never goes stale; one that stops updating gets quietly
  // dropped from the broadcast list on the next presence event, without
  // needing to actually close the underlying socket.
  handlePresenceMessage(ws: WebSocket, msg: { view?: unknown; projectId?: unknown; sessionId?: unknown }): void {
    const attachment = (ws.deserializeAttachment() || {}) as RoomAttachment;
    ws.serializeAttachment(Object.assign({}, attachment, {
      view: typeof msg.view === 'string' ? msg.view : null,
      projectId: typeof msg.projectId === 'string' ? msg.projectId : null,
      sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : null,
      lastSeen: Date.now()
    }));
    this.broadcastPresence();
  }

  broadcastPresence(): void {
    const now = Date.now();
    const users: { username: string; displayName: string; view: string | null; projectId: string | null; sessionId: string | null }[] = [];
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as RoomAttachment | null;
      if (!a) continue;
      if (a.lastSeen && (now - a.lastSeen) > PRESENCE_STALE_MS) continue;
      users.push({ username: a.username, displayName: a.displayName, view: a.view || null, projectId: a.projectId || null, sessionId: a.sessionId || null });
    }
    const payload = JSON.stringify({ type: 'presence', users: users });
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(payload); } catch (e) { /* dead socket — webSocketClose() cleans up */ }
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let msg: RoomMessage;
    try {
      const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
      msg = JSON.parse(text);
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: 'invalid JSON' }));
      return;
    }

    if (msg && msg.type === 'setPresence') {
      this.handlePresenceMessage(ws, msg);
      return;
    }

    const roomState = await this.loadRoomState();

    // Content-write authorization: the token was already verified at
    // connect time (handleWebSocketUpgrade()) and its role/assignedProjectId
    // captured in the WebSocket's own attachment, so no per-message KV
    // round-trip is needed — resolveCaller() (users.ts) already accepts
    // up-to-token-TTL staleness for the same reason. A message with no
    // matching attachment (shouldn't happen post-upgrade, but don't trust it
    // blindly) is treated as unauthorized.
    const attachment = ws.deserializeAttachment() as RoomAttachment | null;
    const requiredTier = msg && MESSAGE_TIER_REQUIREMENTS[msg.type];
    if (requiredTier && (!attachment || !tierAtLeast(attachment.role, requiredTier))) {
      ws.send(JSON.stringify({ type: 'error', msgId: msg && msg.msgId, message: 'Forbidden: requires ' + requiredTier + ' or higher' }));
      return;
    }
    // 'admin' always bypasses project scoping, same as every other project-
    // restriction check in this app (see the client's switchProject()/
    // enforceProjectScopeForRole() in src/app/project.ts) — an admin account
    // can have a stored assignedProjectId left over from before being
    // promoted (the client already ignores it for role==='admin'), and this
    // check was missing that same exemption, incorrectly blocking an
    // unrestricted admin's own cross-project writes (e.g. linking a job to
    // the other project — see the client's linkJobs(), also in
    // src/app/project.ts, which deliberately writes to BOTH fixed projects
    // for exactly this feature).
    // Only an admin can start a new project (any message naming a project
    // the room doesn't have yet would otherwise create it).
    if (msg && typeof msg.projectId === 'string' && msg.type !== 'removeProject' && attachment && attachment.role !== 'admin' && roomState.projects && Object.keys(roomState.projects).length && !roomState.projects[msg.projectId]) {
      ws.send(JSON.stringify({ type: 'error', msgId: msg.msgId, message: 'Forbidden: only an admin can add a project' }));
      return;
    }
    if (msg && msg.projectId && attachment && attachment.role !== 'admin' && attachment.assignedProjectId && msg.projectId !== attachment.assignedProjectId) {
      ws.send(JSON.stringify({ type: 'error', msgId: msg.msgId, message: 'Forbidden: outside your assigned project' }));
      return;
    }
    if (msg && msg.type === 'upsertProjectBatch' && attachment) {
      msg = Object.assign({ type: msg.type }, filterUpsertProjectBatchByTier(msg as unknown as UpsertProjectBatchMessage, roomState.projects[msg.projectId as string], attachment.role)) as RoomMessage;
    }

    const result = applyMessage(roomState, msg, attachment);

    if (result.error) {
      ws.send(JSON.stringify({ type: 'error', msgId: msg.msgId, message: result.error }));
      return;
    }
    if (result.rejected) {
      // The rejecting client applied its edit optimistically (this app has
      // always worked that way) before finding out the server already had
      // something newer — send fresh data immediately rather than leaving
      // their local view wrong until the next unrelated broadcast.
      ws.send(JSON.stringify(Object.assign({ type: 'rejected', msgId: msg.msgId }, result.rejected)));
      ws.send(JSON.stringify(Object.assign({ type: 'snapshot' }, filterRoomStateForAttachment(this.roomState as RoomState, attachment))));
      return;
    }
    if (result.changed) {
      // Persist BEFORE acking: the client's pendingWrites/
      // armStuckWriteWatch() (src/sync/outbound.ts) treats an ack as "the
      // server has safely stored this" and clears its own retry tracking
      // the moment one arrives. Acking first and persisting after made
      // that promise false — a persist() failure between the two left the
      // client believing a write succeeded that was never actually
      // durable. this.roomState is rolled back on failure so this DO's
      // own in-memory state doesn't drift from what's actually on disk,
      // and the client gets an error (not silence) so its own retry path
      // — the actual safety net — has something to act on.
      const previousState = this.roomState;
      this.roomState = result.state;
      try {
        await this.persist(previousState);
      } catch (e) {
        this.roomState = previousState;
        console.error('Failed to persist room state:', e);
        ws.send(JSON.stringify({ type: 'error', msgId: msg.msgId, message: 'Failed to save — please retry' }));
        return;
      }
      // Audit rows for what this write actually changed. Not awaited: the
      // runtime holds outgoing messages until storage writes started here
      // have completed, and an audit failure must not fail the edit.
      const saved = computeRoomDelta(previousState as RoomState, this.roomState as RoomState);
      if (saved && attachment) {
        this.appendAudit(describeChange(previousState as RoomState, this.roomState as RoomState, saved, { user: attachment.username, role: attachment.role, ip: attachment.ip }, Date.now()))
          .catch((e) => console.error('Audit write failed:', e));
      }
      if (result.ack) ws.send(JSON.stringify(result.ack));
      this.broadcastChange(previousState as RoomState, this.roomState as RoomState);
    } else if (result.ack) {
      ws.send(JSON.stringify(result.ack));
    }
  }

  // Two connections can have different assignedProjectId scoping (see
  // filterRoomStateForAttachment()), so what each may receive can differ —
  // but every connection with the SAME scope gets the same bytes, so the
  // payload is serialized once per scope rather than once per socket.
  broadcastSnapshot(): void {
    const cache = new Map<string, string>();
    for (const ws of this.state.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as RoomAttachment | null;
      const key = scopeKey(attachment);
      let payload = cache.get(key);
      if (payload === undefined) {
        payload = JSON.stringify(Object.assign({ type: 'snapshot' }, filterRoomStateForAttachment(this.roomState as RoomState, attachment)));
        cache.set(key, payload);
      }
      try { ws.send(payload); } catch (e) { /* dead socket, webSocketClose() cleans up */ }
    }
  }

  // After an accepted write: clients that speak protocol 2 get only what
  // changed ({type:'delta'}, typically a few KB); older clients still get
  // the full snapshot they expect. The sender gets the delta too — it's
  // how its own edit is confirmed back into its view, same as the old
  // snapshot echo. A connection that can see none of the change (a
  // project-restricted user, edit in another project) gets nothing.
  broadcastChange(prev: RoomState, next: RoomState): void {
    const delta = computeRoomDelta(prev, next);
    if (!delta) return;
    const snapshotCache = new Map<string, string>();
    const deltaCache = new Map<string, string | null>();
    for (const ws of this.state.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as RoomAttachment | null;
      const key = scopeKey(attachment);
      let payload: string | null | undefined;
      if (attachment && attachment.proto === 2) {
        payload = deltaCache.get(key);
        if (payload === undefined) {
          const scoped = filterRoomDeltaForAttachment(delta, attachment);
          payload = scoped ? JSON.stringify(Object.assign({ type: 'delta' }, scoped)) : null;
          deltaCache.set(key, payload);
        }
      } else {
        payload = snapshotCache.get(key);
        if (payload === undefined) {
          payload = JSON.stringify(Object.assign({ type: 'snapshot' }, filterRoomStateForAttachment(next, attachment)));
          snapshotCache.set(key, payload);
        }
      }
      if (!payload) continue;
      try { ws.send(payload); } catch (e) { /* dead socket, webSocketClose() cleans up */ }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    try { ws.close(code, reason); } catch (e) {}
    // So everyone else's presence list drops this person promptly
    // instead of waiting for the next unrelated broadcast.
    this.broadcastPresence();
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('APS room websocket error:', error);
  }
}
