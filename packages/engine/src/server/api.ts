import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
import type { Hub } from "./hub.js";
import {
  AuthError,
  bearerToken,
  type AuthenticatedUser,
  type Authenticator,
  type Authorizer,
} from "./authz.js";
import type { Message, TurnRecord } from "../types.js";

export interface ApiOptions {
  hub: Hub;
  authenticator: Authenticator;
  authorizer: Authorizer;
  /** Model id used when a session doesn't specify one. Pin a dated snapshot. */
  defaultModelId: string;
  defaultSystemPrompt?: string;
  /** Hexclave analytics query passthrough; injectable for tests. */
  queryAnalytics?: (sql: string) => Promise<unknown>;
}

/** Compact turn shape for the timeline rail and log views. */
export interface TurnSummary {
  turn_id: string;
  parent_turn_id: string | null;
  kind: string;
  author: string;
  author_name: string;
  created_at: number;
  depth: number;
  stop_reason: string | null;
  tool_count: number;
  usage: { input_tokens: number; output_tokens: number };
  env_snapshot_ref: string | null;
  user_preview: string;
  assistant_preview: string;
  /** approximate token weight of this turn's delta, for the prune tally */
  delta_chars: number;
}

function preview(messages: Message[], role: "user" | "assistant"): string {
  for (const m of messages) {
    if (m.role !== role) continue;
    for (const block of m.content) {
      if (block.type === "text" && block.text.trim()) return block.text.slice(0, 160);
      if (block.type === "tool_result") return `[tool result] ${block.content.slice(0, 120)}`;
    }
  }
  return "";
}

export function summarizeTurn(turn: TurnRecord, delta: Message[]): TurnSummary {
  return {
    turn_id: turn.turn_id,
    parent_turn_id: turn.parent_turn_id,
    kind: turn.kind,
    author: turn.author,
    author_name: turn.author_name,
    created_at: turn.created_at,
    depth: turn.depth,
    stop_reason: turn.response?.stop_reason ?? null,
    tool_count: turn.response?.content.filter((b) => b.type === "tool_use").length ?? 0,
    usage: turn.usage,
    env_snapshot_ref: turn.env_snapshot_ref,
    user_preview: preview(delta, "user"),
    assistant_preview: preview(delta, "assistant"),
    delta_chars: JSON.stringify(delta).length,
  };
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error("invalid JSON body"), { status: 400 });
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    // Every authenticated response is private.
    "cache-control": "private, no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Creates the HTTP + WebSocket server hosting the engine. REST for CRUD
 * consumed by React Router loaders/actions; one WS channel per session for
 * live events, presence and Yjs sync. Every request is authenticated via
 * Hexclave; every mutation carries the verified user id as attribution, and
 * driver-gated actions are enforced server-side against team permissions.
 */
export function createApiServer(opts: ApiOptions): Server {
  const { hub, authenticator, authorizer } = opts;

  const server = createServer(async (req, res) => {
    // Dev CORS: the web app runs on a different port locally.
    res.setHeader("access-control-allow-origin", req.headers.origin ?? "*");
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (!url.pathname.startsWith("/api/")) {
        send(res, 404, { error: "not found" });
        return;
      }
      const user = await authenticator.authenticate(bearerToken(req.headers.authorization));
      await route(req, res, url, user);
    } catch (err) {
      if (err instanceof AuthError) {
        send(res, err.status, { error: err.message });
      } else {
        const status = (err as { status?: number }).status ?? 500;
        send(res, status, { error: err instanceof Error ? err.message : "internal error" });
      }
    }
  });

  async function requireObserver(user: AuthenticatedUser, sessionId: string): Promise<void> {
    const meta = hub.store.getSession(sessionId);
    if (!meta) throw Object.assign(new Error("session not found"), { status: 404 });
    if (!(await authorizer.canObserve(user, meta.team_id))) {
      throw new AuthError("not a member of this session", 403);
    }
  }

  async function requireDriver(user: AuthenticatedUser, sessionId: string): Promise<void> {
    const meta = hub.store.getSession(sessionId);
    if (!meta) throw Object.assign(new Error("session not found"), { status: 404 });
    if (!(await authorizer.canDrive(user, meta.team_id))) {
      throw new AuthError("driver permission required for this action", 403);
    }
  }

  async function route(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    user: AuthenticatedUser,
  ): Promise<void> {
    const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
    const method = req.method ?? "GET";

    // GET /api/me
    if (parts[1] === "me" && method === "GET") {
      send(res, 200, { id: user.id, displayName: user.displayName });
      return;
    }

    // GET /api/usage — internal usage view (domain events + Hexclave passthrough)
    if (parts[1] === "usage" && parts.length === 2 && method === "GET") {
      send(res, 200, { domain_events: hub.store.domainEventCounts() });
      return;
    }
    if (parts[1] === "usage" && parts[2] === "query" && method === "POST") {
      const body = await readBody(req);
      if (!opts.queryAnalytics) {
        send(res, 501, { error: "Hexclave analytics not configured" });
        return;
      }
      send(res, 200, { result: await opts.queryAnalytics(String(body.sql ?? "")) });
      return;
    }

    if (parts[1] !== "sessions") {
      send(res, 404, { error: "not found" });
      return;
    }

    // /api/sessions
    if (parts.length === 2) {
      if (method === "GET") {
        const sessions = [];
        for (const meta of hub.store.listSessions()) {
          if (await authorizer.canObserve(user, meta.team_id)) {
            sessions.push({
              ...meta,
              branch_count: hub.store.listBranches(meta.id).length,
              online: hub.connectionCount(meta.id),
              last_activity: hub.store.listActivity(meta.id, 1)[0]?.created_at ?? meta.created_at,
            });
          }
        }
        send(res, 200, { sessions });
        return;
      }
      if (method === "POST") {
        const body = await readBody(req);
        const name = String(body.name ?? "").trim();
        if (!name) throw Object.assign(new Error("name is required"), { status: 400 });
        const teamId = await authorizer.createSessionTeam(user, `Recon: ${name}`);
        const meta = hub.createSession({
          name,
          team_id: teamId,
          model_id: String(body.model_id ?? opts.defaultModelId),
          system_prompt: String(body.system_prompt ?? opts.defaultSystemPrompt ?? ""),
          actor: { id: user.id, name: user.displayName },
        });
        send(res, 201, { session: meta });
        return;
      }
    }

    const sessionId = parts[2];
    if (!sessionId) {
      send(res, 404, { error: "not found" });
      return;
    }
    await requireObserver(user, sessionId);
    const room = hub.room(sessionId);
    const engine = room.engine;
    const store = hub.store;
    const actor = { id: user.id, name: user.displayName };

    // GET /api/sessions/:id
    if (parts.length === 3 && method === "GET") {
      const meta = store.getSession(sessionId)!;
      const branches = store.listBranches(sessionId).map((b) => ({
        ...b,
        ...safeAheadBehind(engine, b.name, meta.current_branch),
      }));
      send(res, 200, {
        session: meta,
        branches,
        status: engine.status(meta.current_branch),
        presence: room.presenceList(),
        // UI affordance only — every control action is re-checked server-side.
        you: {
          id: user.id,
          displayName: user.displayName,
          can_drive: await authorizer.canDrive(user, meta.team_id),
        },
      });
      return;
    }

    // GET /api/sessions/:id/turns?branch=
    if (parts[3] === "turns" && parts.length === 4 && method === "GET") {
      const meta = store.getSession(sessionId)!;
      const branch = url.searchParams.get("branch") ?? meta.current_branch;
      const full = url.searchParams.get("full") === "1";
      const log = engine.log(branch);
      send(res, 200, {
        branch,
        turns: log.map((t) => {
          const delta = engine.turnDelta(t);
          const summary = summarizeTurn(t, delta);
          return full ? { ...summary, delta } : summary;
        }),
      });
      return;
    }

    // GET /api/sessions/:id/turn/:turnId
    if (parts[3] === "turn" && parts[4] && method === "GET") {
      const turn = store.getTurn(parts[4]);
      if (!turn || turn.session_id !== sessionId) {
        send(res, 404, { error: "turn not found" });
        return;
      }
      send(res, 200, { turn, delta: engine.turnDelta(turn) });
      return;
    }

    // GET /api/sessions/:id/activity
    if (parts[3] === "activity" && method === "GET") {
      send(res, 200, { activity: store.listActivity(sessionId) });
      return;
    }

    // GET /api/sessions/:id/compare?a=&b=
    if (parts[3] === "compare" && method === "GET") {
      const a = url.searchParams.get("a");
      const b = url.searchParams.get("b");
      if (!a || !b) throw Object.assign(new Error("a and b are required"), { status: 400 });
      const diff = engine.diff(a, b);
      send(res, 200, {
        a,
        b,
        shared_prefix: diff.shared_prefix.map((id) => {
          const t = store.getTurn(id)!;
          return summarizeTurn(t, engine.turnDelta(t));
        }),
        only_a: diff.only_a.map((t) => summarizeTurn(t, engine.turnDelta(t))),
        only_b: diff.only_b.map((t) => summarizeTurn(t, engine.turnDelta(t))),
      });
      return;
    }

    // POST /api/sessions/:id/actions — serialized, attributed control actions.
    if (parts[3] === "actions" && method === "POST") {
      const body = await readBody(req);
      const action = String(body.action ?? "");
      const meta = store.getSession(sessionId)!;
      const branch = String(body.branch ?? meta.current_branch);

      // Every control action is driver-gated, enforced server-side.
      await requireDriver(user, sessionId);

      switch (action) {
        case "send": {
          const text = String(body.text ?? "").trim();
          if (!text) throw Object.assign(new Error("text is required"), { status: 400 });
          store.logActivity({
            session_id: sessionId,
            actor_id: user.id,
            actor_name: user.displayName,
            action: "send",
            detail: text.slice(0, 120),
          });
          room.clearComposer();
          // The loop streams over WS; don't block the HTTP response on it.
          engine.sendUserMessage(branch, text, actor).catch(() => {
            /* error already emitted as engine event */
          });
          send(res, 202, { started: true });
          return;
        }
        case "pause":
          engine.pause(branch, actor);
          send(res, 200, { status: engine.status(branch) });
          return;
        case "resume":
          engine.resume(branch, actor).catch(() => {});
          send(res, 200, { status: engine.status(branch) });
          return;
        case "hard_stop":
          engine.hardStop(branch, actor);
          send(res, 200, { status: engine.status(branch) });
          return;
        case "fork": {
          const created = engine.fork(String(body.turnId), String(body.name), actor);
          send(res, 201, { branch: created });
          return;
        }
        case "checkout": {
          const result = engine.checkout(String(body.name), actor);
          send(res, 200, result);
          return;
        }
        case "revert": {
          const result = engine.revertTo(String(body.turnId), String(body.name), actor);
          send(res, 201, result);
          return;
        }
        case "prune": {
          const keep = Array.isArray(body.keep) ? body.keep.map(String) : [];
          const result = engine.prune(
            String(body.turnId),
            keep,
            String(body.name),
            String(body.note ?? ""),
            actor,
          );
          send(res, 201, {
            ...result,
            warning:
              "Pruned prefixes break provider prompt-cache reuse for the shared prefix.",
          });
          return;
        }
        default:
          throw Object.assign(new Error(`unknown action: ${action}`), { status: 400 });
      }
    }

    send(res, 404, { error: "not found" });
  }

  // ------------------------------------------------------------- WebSocket

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/ws") {
        socket.destroy();
        return;
      }
      try {
        // The handshake carries the access token as a connection param.
        const user = await authenticator.authenticate(url.searchParams.get("token") ?? undefined);
        const sessionId = url.searchParams.get("session") ?? "";
        const meta = hub.store.getSession(sessionId);
        if (!meta || !(await authorizer.canObserve(user, meta.team_id))) {
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          hub.room(sessionId).connect(ws, { id: user.id, displayName: user.displayName });
        });
      } catch {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
      }
    })();
  });

  return server;
}

function safeAheadBehind(
  engine: { aheadBehind(a: string, b: string): { ahead: number; behind: number } },
  branch: string,
  relativeTo: string,
): { ahead: number; behind: number } {
  try {
    return engine.aheadBehind(branch, relativeTo);
  } catch {
    return { ahead: 0, behind: 0 };
  }
}
