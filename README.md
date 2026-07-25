# Recon

A collaborative vibecoding platform with **context version control**. Multiple people drive a
shared coding agent together — editing the pending prompt as a CRDT, watching the live stream
and tool calls, pausing/resuming — while underneath, every turn of the conversation is a
checkpoint anyone can revert to, fork from, or prune.

The core guarantee: **at every point in the conversation, a checkpoint exists that mirrors the
conversation exactly up to that point.** Because LLM APIs are stateless, the agent's entire
epistemic state at turn N is the token sequence it was fed at turn N — so checkpoints are
pointers into an append-only log of *rendered requests* (the literal
`(model_id, system_prompt, tools, messages)` tuple sent to the API), materialized lazily on
revert by replaying stored history verbatim. Exact context, O(1) storage per checkpoint.

## Layout

```
hexclave.config.ts     declarative user infra: auth + teams + RBAC + analytics
packages/engine        the context engine + Node server (SQLite, blob store, agent loop,
                       REST + WebSocket + Yjs sync, Hexclave JWKS/RBAC enforcement)
packages/web           React Router v7 app (timeline rail, conversation stream,
                       shared composer, branch/turn/compare/prune views)
```

## Quickstart

```sh
npm install

# Full stack with real auth (Hexclave CLI injects project id + secret key):
npm run dev

# Offline demo (mock provider + insecure dev identities):
RECON_MOCK_PROVIDER=1 npm run dev:engine     # engine server on :8787
npm run dev:web                              # web app on :5173
```

Environment knobs (engine): `PORT`, `DATA_DIR`, `RECON_MODEL_ID` (pin a dated snapshot id),
`RECON_MOCK_PROVIDER=1`, `RECON_SNAPSHOTS=null` (chat-only, no git workspace snapshots),
`RECON_STRICT_PINNING=1` (reject floating model aliases), `ANTHROPIC_API_KEY`.

Tests: `npm test` (30 tests across both packages). Typecheck: `npm run typecheck`.

## Deploying

The web SPA deploys through **Hexclave deployments (alpha)** — the `web` service is
declared under `deployments-alpha.services` in `hexclave.config.ts` (uploaded from
`packages/web`, built on Vercel, `build/client` served statically):

```sh
npx @hexclave/cli login                     # one-time browser login
# or CI: export HEXCLAVE_SECRET_SERVER_KEY=... 
export HEXCLAVE_PROJECT_ID=<your project id>

# fill in VITE_API_BASE + the two VITE_HEXCLAVE_* values in hexclave.config.ts, then:
npx @hexclave/cli deploy web
```

The **engine server is not Vercel-deployable** (long-lived WebSockets, SQLite, per-session
git workspaces — it's local-first by design). Run it on any persistent Node host:

```sh
npm run build --workspace @recon/engine
HEXCLAVE_PROJECT_ID=... HEXCLAVE_SECRET_SERVER_KEY=... ANTHROPIC_API_KEY=... \
  DATA_DIR=/var/lib/recon PORT=8787 node packages/engine/dist/server/main.js
```

Then point the SPA's `VITE_API_BASE` at that host.

---

## Result

### Final architecture notes

**The unit of versioning is one provider call.** A `TurnRecord` stores the exact
`rendered_request` tuple, the exact API `response` (all content blocks including `tool_use`),
the `tool_results` fed back, an `env_snapshot_ref`, the author (Hexclave user id + display
name), timestamp, and token usage. One user message that triggers a tool loop commits several
turns — one per API call — which is precisely what makes pause boundaries and checkpoints
well-defined.

**Merkle chain over content-addressed blobs.** `turn_id = sha256(parent_turn_id, kind,
rendered_request_hash, response_hash, tool_results_hash, env_snapshot_ref, author, created_at)`.
Payloads live in a content-addressed blob table (deduplicated; identical responses store once);
turn rows reference them by hash. Two branches with the same turn id therefore share a
byte-identical prefix by construction — the replay-exactness test is an equality check on
canonical JSON of the stored blobs.

**Context materialization is O(1) reads, not reconstruction.** Each turn's `rendered_request`
already embeds the full message prefix the model saw. The context after turn N is
`N.rendered_request.messages + [assistant response] + [tool results]` — three appends to a
stored value, never a re-derivation. A turn's *delta* (what it contributed beyond its parent)
is computed by slicing off the parent's context length; deltas power the prune workbench,
conversation rendering, and previews.

**Fork = one branch row.** `fork(turn_id, name)` inserts a branch ref pointing at an existing
turn; the test suite asserts zero new turn rows and zero new blobs. `revert = fork + checkout`;
checkout flips the session's current branch and restores the nearest workspace snapshot on the
new head (or returns an explicit warning if none exists).

**Prune is a new root, never a rewrite.** `prune(base, keep_set, name, note)` concatenates the
kept turns' deltas into a curated message list and commits it as a `prune_base` turn — a turn
with `response: null`, parent `null` — at the root of a new branch whose metadata carries the
full provenance manifest (base turn, kept ids, cut ids, note, author). The curated context is
something the agent never saw, so it never masquerades as history; the API response and the
prune workbench both surface the prompt-cache warning.

**Single writer per branch, CRDT only on the pending prompt.** The engine rejects a second
concurrent send on a branch (enforced both in the loop and at the storage layer via a
head-must-match-parent check inside the commit transaction). Humans collaborate on the
composer (a Yjs `Y.Text`, server-authoritative doc, updates relayed over the session
WebSocket) and on serialized control actions, each attributed in the activity feed.

**Pause semantics.** A "safe boundary" is between provider calls in the agentic loop: the
in-flight turn (stream + all of its tool executions) always commits whole, then the loop parks
with status `paused`. Resume inspects the committed head — if it ended mid tool-loop
(`stop_reason: tool_use` with tool results committed), generation continues from exactly there;
otherwise the branch goes idle. `hard_stop` aborts the in-flight stream via `AbortController`
and commits nothing (test-verified: zero partial turns).

**Environment snapshots.** `GitWorkspaceSnapshot` keeps a shadow git dir *outside* the
workspace (`--git-dir`/`--work-tree`), commits `add -A` per turn, and restores with
`reset --hard + clean -fd`. Commit signing is explicitly disabled in the shadow repo so user
global git config can't break snapshots. `NullSnapshot` covers chat-only sessions.

**Hexclave supplies all user infrastructure.** One session = one Hexclave team; `driver` and
`observer` are team-scoped RBAC permissions declared in `hexclave.config.ts` (driver contains
observer; team creator → driver; team member → observer). The server verifies access tokens
against the project JWKS (ES256, audience = project id, `sub` = user id — implemented on
`node:crypto`, no extra dependency, with key-rotation refetch) and checks permissions through
`@hexclave/js` for every control action, server-side, per request. All authenticated responses
carry `Cache-Control: private, no-store`. The WebSocket handshake carries the token as a
connection param and enforces observer membership before upgrade. Attribution everywhere
(turn author, activity, presence) is Hexclave user id + display name; there is no parallel
user table.

### Deviations from spec (and why)

1. **Hexclave has no custom-analytics ingest API.** The live docs are explicit that the SDK
   exposes no `captureEvent`/`trackEvent`; only built-in events are auto-captured, and
   `queryAnalytics` exists as a REST endpoint (`POST /api/v1/analytics/query`), not a
   documented SDK method. Adaptation: baseline product analytics (events, clickmaps, session
   replays) come from enabling the analytics app, exactly as specced — no custom pipeline.
   Domain actions (session_created, turn_committed, fork, revert, prune, pause/resume) are
   recorded in a `domain_events` table in the engine store and surfaced at `GET /api/usage`;
   `POST /api/usage/query` forwards ClickHouse SQL to Hexclave's analytics query endpoint via
   a thin wrapper (`createHexclaveAnalyticsQuery`). If/when Hexclave ships custom-event
   ingest, the recording call sites are all in one place (`Store.recordDomainEvent`).

2. **`getAuthorizationHeader()` / `getAuthJson()` don't exist on the installed SDK.** The
   client SDK exposes tokens via `user.currentSession.getTokens()`. The web app wraps this in
   its own `getAuthorizationHeader()` helper with identical call sites to the spec's intent
   (every REST call sends it; the WS handshake sends the raw token).

3. **Anthropic no longer publishes dated snapshot ids for current models** (current ids like
   `claude-opus-5` are fixed but undated; appending dates 404s). Determinism pinning is
   honored as far as the provider allows: the model id is per-session configuration
   (`RECON_MODEL_ID`), the engine replays stored responses rather than ever re-running
   prompts (so history is exact regardless), and `RECON_STRICT_PINNING=1` enforces
   dated-snapshot ids for providers that have them.

4. **"Pause between tool calls"** is implemented as *between provider calls in the tool loop*
   (each of which is a committed turn), not between individual tool executions inside one
   response — pausing mid-response would either commit a partial turn (violating the
   "no partial turn ever committed" invariant) or discard completed work. The boundary chosen
   is the finest one compatible with the invariant.

5. **Server lives inside `packages/engine`** (`src/server/`) rather than a third package —
   the spec's "Node server hosting the engine" and the two-package monorepo requirement are
   both satisfied; the server is exported as `@recon/engine/server`.

6. **Yjs sync uses JSON-framed base64 updates over the session WebSocket** rather than the
   y-websocket binary subprotocol — one fewer dependency (y-websocket isn't in the allowed
   list), same convergence semantics (full-state update on connect, incremental updates
   after), verified by the CRDT convergence tests.

7. **Offline dev fallback.** Without Hexclave credentials the server refuses nothing silently
   — it logs a loud warning and switches to `dev:<id>:<name>` tokens with an allow-all
   authorizer, and the web app shows a labeled dev identity switcher instead of `<UserButton />`.
   With `HEXCLAVE_PROJECT_ID`/`HEXCLAVE_SECRET_SERVER_KEY` present (i.e. under
   `npx @hexclave/cli dev`), the real JWKS verification + RBAC path is active. Tests exercise
   the real `JwksAuthenticator` (with generated ES256 keys) and the real `HexclaveAuthorizer`
   (with a mocked permission layer), per the spec's testing instructions.

### Test results

`npm test` — **30/30 passing** (typecheck clean, both packages build).

Engine (22):
- hash chain: canonical-JSON stability, Merkle parent linkage, recomputed-id verification,
  blob deduplication
- fork pointer semantics: zero copied rows/blobs, shared records
- replay: byte-identical rendered-request prefix on forks; forked continuation renders the
  replayed prefix verbatim; original branch untouched
- prune: manifest kept/cut/note/author correctness, curated prefix = concat of kept deltas,
  cut content absent, pruned branch continues; rejects empty/foreign keep sets
- pause boundary: pause lands between provider calls, every committed turn has a complete
  response + full tool results, resume finishes the tool loop; hard stop commits nothing and
  leaves the branch usable; concurrent sends rejected (single writer)
- env snapshots: git shadow-repo round trip (restore old state, files created later removed,
  re-restore forward)
- structural diff + ahead/behind
- auth: ES256 JWKS verification (valid, missing, malformed, tampered signature, wrong
  audience, expired); unauthenticated REST → 401; `private, no-store` on authenticated
  responses; observer read OK but all five driver actions → 403 via the Hexclave permission
  check; driver actions succeed; unauthenticated/non-member WebSocket rejected
- integration (mocked provider): user A runs 5 turns → user B reverts to turn 3, forks,
  continues → shared prefix bit-identical, futures diverge, both branches independently
  resumable; full prune flow

Web (8):
- composer CRDT: two connected clients converge on interleaved edits; concurrent offline
  edits merge without loss; textarea diffing produces minimal ops
- timeline rail from a fixture log: node per turn, fork points marked from branch lineage,
  head live (cyan) while running / frozen (amber) when paused
- route smoke: session browser renders repo-style rows; empty state shows
  "Start a session to begin."

Also verified live (mock provider + real HTTP server): the full walkthrough below ran
end-to-end against `src/server/main.ts`.

### Usage walkthrough — two-user revert/prune demo

Start the engine with the mock provider (`RECON_MOCK_PROVIDER=1 npm run dev:engine`) and the
web app (`npm run dev:web`), open two browser windows, and use the dev identity switcher to be
Alice in one and Bree in the other (or run under `npx @hexclave/cli dev` and sign in as two
real users invited to the session's team).

1. **Alice** creates session *walkthrough* on the home screen and sends five prompts. Each
   exchange appears in the conversation stream as it streams (cyan caret), and the Timeline
   Rail grows a node per committed turn — each node is a checkpoint.
2. **Bree** (in the second window) watches the same stream live, hovers turn 3 on the rail to
   preview it, and clicks **Revert here**, naming the branch `bree/rethink`. The engine forks
   at turn 3 and checks the branch out: her context is now byte-for-byte the conversation as
   of turn 3 — turns 4 and 5 never happened on this branch — and the workspace is restored to
   turn 3's snapshot.
3. Both type into the **shared composer** simultaneously (multiplayer cursors, CRDT merge)
   and Bree hits *Send to agent*. The turn commits attributed to Bree on `bree/rethink`.
4. `/s/:id/compare/main...bree/rethink` shows the GitHub-style structural diff: 3 shared
   turns collapsed, main's turns 4–5 on the left, Bree's new turn on the right.
   (Live run: `shared=3 only_main=2 only_fork=1`.)
5. Bree opens **Prune from here** on turn 3, unchecks the noisy turn 2 (the live token tally
   drops), names the branch `bree/lean` with a required note. A `pruned`-badged branch
   appears whose first commit is the curated context, with kept/cut provenance on the branch
   list and a toast warning that the pruned prefix breaks provider prompt-cache reuse.
6. Alice keeps working on `main` while Bree works on `bree/lean` — both branches advance
   independently (live run ended `main: 6 turns, bree/rethink: 4, bree/lean: 2`). The
   activity feed shows every attributed action; `GET /api/usage` shows the domain-event
   funnel (`turn_committed`, `revert`, `prune`, `fork`, `session_created`).

Pause/resume: while the agent runs a tool loop, **Pause** (amber) parks it at the next turn
boundary — the rail's head node freezes amber — and **Resume** continues from the committed
head; **Hard stop** aborts the in-flight turn without committing it.
