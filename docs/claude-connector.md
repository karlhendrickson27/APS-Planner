# Claude connector

TeamSync can be added to Claude (claude.ai) as a **custom connector**. Once
connected, Claude can read the schedule and, within the person's own role,
change it: move task dates, write task notes, comment on jobs and create
jobs. Every change goes through the same save path as an edit in the app,
so anyone with TeamSync open sees it at once, and it's audited and labeled
"via Claude".

Code: `worker/src/mcp/`. Tests: `worker/src/mcp-connector.test.mjs`,
`tests/unit-connected-apps.spec.js`.

## How it works

```
claude.ai ──OAuth 2.1──▶ /register, /authorize, /token     (sign in once)
claude.ai ──Bearer────▶ /mcp  (MCP over Streamable HTTP, stateless JSON)
                          │  account reloaded from USERS_KV on every call
                          ▼
              ApsRoom /internal/mcp-read   ── the person's scoped view
              ApsRoom /internal/mcp-apply  ── applyAsUser(): same commit
                                              path as the app's WebSocket
```

- **OAuth** is `@cloudflare/workers-oauth-provider` (`mcp/oauth.ts`). It
  sits in front of the existing router and answers only its own paths:
  `/.well-known/oauth-authorization-server`,
  `/.well-known/oauth-protected-resource/mcp`, `/register`, `/token` and
  `/mcp`. Every other route reaches the router unchanged. Clients, grants
  and tokens are stored encrypted in the `OAUTH_KV` namespace. Access
  tokens last 1 hour and refresh tokens 30 days.
- **Sign-in** (`mcp/authorize.ts`) is a small page styled like the app's
  login: username/email and password, or Google, then the two-step code if
  the account has one, then **Allow / Cancel**. It reuses the app's lockout
  counters, audit entries, two-step check and Google sign-in. If the
  company requires two-step and the person hasn't set it up, they're asked
  to do that in the app first.
- **MCP** (`mcp/protocol.ts`) is a small hand-written JSON-RPC handler:
  `initialize`, `ping`, `tools/list`, `tools/call`. There are no sessions,
  and GET `/mcp` answers 405.
- **Writes** (`mcp/tools.ts`) read the job, change only the targeted
  task(s) or field on a copy, and send it with the `updatedAt` it was read
  at. If someone changed the job in between, the room refuses it as stale;
  the tool re-reads and retries once, then gives up with a clear message.
  So it never overwrites someone else's edit. An activity-log line goes
  with each change, e.g. *"Karl Hendrickson (via Claude) moved Highland
  (3 F2) › Ext › Deliver to Nov 25–Nov 25"*.
- **All or nothing:** each tool call's messages (the edit plus its
  activity line; for `create_job` the job, its card and the line) are
  saved together in one commit (`ApsRoom.commitAsUser`) and reach open
  apps as one update. If any part is refused, nothing is saved.
- If the connection drops after a write was sent, the tool tells Claude
  it *may* have saved and to check with `get_job` before retrying, so a
  shift or a new job isn't done twice.

## Permission model

Claude acts **as the person who connected it, with exactly their role**,
re-read from their account on every call:

| Role | Can do through Claude |
|---|---|
| Viewer | read (list projects, schedule, search, job details) |
| Commenter | + comment on jobs |
| Editor | + change task dates, shift tasks, set task notes |
| Project Admin / Admin | + create jobs (same as the app's Add New Job button) |

- Same visibility as the app: a project-restricted account sees only its
  project; below Project Admin, only jobs that list you as a member.
- Disconnecting, removing an account, resetting its password, or removing
  and re-adding it ends the connection on the next call, and a role or
  project change applies on the next call (as soon as Cloudflare KV has
  the change everywhere: usually at once, at most about a minute). A
  connection ended by a password reset is revoked and dropped from
  Connected apps the next time the person opens it.
- Signing in with Google skips the two-step code, the same as Google
  sign-in in the app.
- The room enforces the role and assigned project again on every write
  (`applyAsUser`), so a tool bug can't get past it.
- There are **no** tools for deleting, archiving, users, roles, backups,
  sign-in settings, project admin, maintenance mode or exports.
- Writes are refused while maintenance mode is on.
- Limit: 120 saved writes per person per hour (counted in the room's own
  storage; refused writes and previews don't count). Edits in archived
  jobs or projects are refused.
- Claude is told that job names, notes and comments come from teammates
  and are information, not instructions. Text in a job could still try to
  steer it, so keep claude.ai's "ask before using a tool" on for the
  write tools if you want to approve each change.
- Audit trail: every saved change is recorded under the person's username
  with IP `claude-connector` and "via Claude" in the details. "Connected
  Claude" and "Disconnected Claude" are recorded too, and show as admin
  notices.
- Only Claude's callback (`https://claude.ai/api/mcp/auth_callback`,
  `https://claude.com/api/mcp/auth_callback`) is accepted, both when a
  client registers and when it asks to sign in. For local testing with an
  MCP inspector, set `MCP_ALLOW_LOCALHOST=true` (for example in
  `worker/.dev.vars`) to also allow `http://localhost:*`. Never set it in
  production.

## Tools

All write tools take `dryRun` (default `false`), which returns the exact
before/after without saving. All except `add_job_comment` also take a short
`reason`, which is added to the activity-log line.

| Tool | Role | What it does |
|---|---|---|
| `list_projects` | viewer | Projects you can see, with ids |
| `get_schedule` | viewer | Tasks overlapping `from`..`to` (optionally one project, optional `query`), sorted by start; up to 500 rows, says if cut off |
| `search_jobs` | viewer | Jobs by name, customer, P.O. number or location; id, customer, archived, date span |
| `get_job` | viewer | One job: phases/sub-phases/tasks, custom fields, Board stage, attachment names, latest 20 comments |
| `update_task_dates` | editor | Set one task's start and finish (real dates, finish ≥ start) |
| `shift_tasks` | editor | Move up to 50 tasks of one job by ±N days together |
| `set_task_notes` | editor | Replace one task's notes |
| `add_job_comment` | commenter | Comment as you; shown as "Name (via Claude)" |
| `create_job` | projectAdmin | New job built like the job form: one task per Board stage, plus its Board card; optional existing customer, color and stage dates |

## Setup (one time)

1. Create the storage for sign-ins and paste its id into
   `worker/wrangler.jsonc` in place of `REPLACE_WITH_OAUTH_KV_ID`:
   ```
   cd worker
   npx wrangler kv namespace create OAUTH_KV
   ```
2. Deploy the Worker: `cd worker && npx wrangler deploy`.
3. Merge to `main` and push, so the app's Connected apps window and Help
   entry go live.
4. In claude.ai: **Settings › Connectors › Add custom connector**, URL
   `https://aps-planner-staging.production-db3.workers.dev/mcp`, then
   sign in with your TeamSync login and click **Allow**.

The connector is named by the address it's reached at. When the server
moves to `api.useteamsync.com`, connect again using
`https://api.useteamsync.com/mcp`. Old connections stop working at the new
address, but nothing else is affected.

## Disconnecting and undoing

- **One person:** in TeamSync, your initials › **Connected apps** ›
  **Disconnect**. That revokes the grant and its tokens; Claude's next call
  is refused (within about a minute at most). You can also remove the
  connector in claude.ai.
- **Everyone, right away:** roll back the Worker
  (`npx wrangler rollback` from `worker/`, or pick the previous version in
  the Cloudflare dashboard). The app itself is unaffected either way.
- **Turn the connector off but keep the code:** remove the `OAUTH_KV`
  binding from `wrangler.jsonc` and deploy. The connector's paths then
  answer 503 and every other route works as before.

## Differences from the app worth knowing

- `create_job` starts the card in the first Board column and moves it
  only where the app's own rule (`deriveColumnForTasks`) would, so a job
  with only future dates stays in a holding column like Bid. It runs each
  column's checklist automation, as the app does. "Today" is the server's
  date in UTC, so a job created around midnight may land one column
  earlier or later. The server's copy of that rule
  (`worker/src/mcp/schedule.ts`) must be kept in step with
  `src/core/jobs.ts`.
- Saving is last-write-wins per job, the same as between two people in
  the app: Claude never overwrites an edit it hasn't seen, but someone
  with an unsent edit to the same job open in the app can overwrite
  Claude's change when their app saves.
- "Delete all company data" also clears the connector's sign-in storage
  (`OAUTH_KV`).
- Changing dates through Claude doesn't clear a card's manual Board
  column override. The app's job form does, and the override expires by
  itself after 24 hours.
