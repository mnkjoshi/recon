import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import type { WebSocket } from "ws";
import { Store } from "../store.js";
import { SessionEngine, type Actor } from "../session.js";
import type { Provider } from "../provider.js";
import { ToolRegistry, workspaceTools } from "../tools.js";
import { GitWorkspaceSnapshot, NullSnapshot, type WorkspaceSnapshotter } from "../snapshot.js";
import type { EngineEvent, SessionMeta } from "../types.js";

export interface PresenceInfo {
  userId: string;
  displayName: string;
  /** composer cursor index, if the user has focus there */
  cursor: number | null;
  color: string;
}

interface Client {
  socket: WebSocket;
  user: { id: string; displayName: string };
  presence: PresenceInfo;
}

export interface HubOptions {
  store: Store;
  provider: Provider;
  dataDir: string;
  /** 'git' snapshots per-session workspaces; 'null' for chat-only sessions. */
  snapshots: "git" | "null";
}

const PRESENCE_COLORS = ["#E8A33D", "#4FC1CE", "#B48EAD", "#A3BE8C", "#D08770", "#5E81AC"];

/**
 * One SessionRoom per live session: owns the SessionEngine, the shared
 * composer CRDT (a Yjs doc), presence, and the WebSocket fanout of engine
 * events. Control actions serialize through the engine; the composer is the
 * only multi-writer surface, and it is a CRDT.
 */
export class SessionRoom {
  readonly engine: SessionEngine;
  readonly doc: Y.Doc;
  private clients = new Set<Client>();

  constructor(
    readonly meta: SessionMeta,
    private readonly store: Store,
    provider: Provider,
    snapshotter: WorkspaceSnapshotter,
    tools: ToolRegistry,
  ) {
    this.engine = new SessionEngine({
      store,
      sessionId: meta.id,
      provider,
      tools,
      snapshotter,
    });
    this.doc = new Y.Doc();
    this.doc.getText("composer");
    // Fan engine events out to every connected client.
    this.engine.subscribe((event) => this.broadcast({ type: "event", event }));
  }

  composerText(): string {
    return this.doc.getText("composer").toString();
  }

  clearComposer(): void {
    const text = this.doc.getText("composer");
    const update = () => text.delete(0, text.length);
    this.doc.transact(update, "server");
    this.broadcastYjsState();
  }

  applyYjsUpdate(update: Uint8Array, from: Client | null): void {
    Y.applyUpdate(this.doc, update, from ?? "server");
    const b64 = Buffer.from(update).toString("base64");
    this.broadcast({ type: "yjs", update: b64 }, from);
  }

  private broadcastYjsState(): void {
    const state = Buffer.from(Y.encodeStateAsUpdate(this.doc)).toString("base64");
    this.broadcast({ type: "yjs", update: state });
  }

  connect(socket: WebSocket, user: { id: string; displayName: string }): void {
    const client: Client = {
      socket,
      user,
      presence: {
        userId: user.id,
        displayName: user.displayName,
        cursor: null,
        color: PRESENCE_COLORS[this.clients.size % PRESENCE_COLORS.length]!,
      },
    };
    this.clients.add(client);

    socket.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { type: string; [k: string]: unknown };
        if (msg.type === "yjs" && typeof msg.update === "string") {
          this.applyYjsUpdate(new Uint8Array(Buffer.from(msg.update, "base64")), client);
        } else if (msg.type === "presence") {
          client.presence.cursor = typeof msg.cursor === "number" ? msg.cursor : null;
          this.broadcastPresence();
        }
      } catch {
        // ignore malformed frames
      }
    });
    socket.on("close", () => {
      this.clients.delete(client);
      this.broadcastPresence();
    });

    // Initial state: full Yjs doc + presence + current status.
    socket.send(
      JSON.stringify({
        type: "init",
        yjs: Buffer.from(Y.encodeStateAsUpdate(this.doc)).toString("base64"),
        presence: this.presenceList(),
        status: this.engine.status(this.meta.current_branch),
        currentBranch: this.store.getSession(this.meta.id)?.current_branch ?? "main",
      }),
    );
    this.broadcastPresence();
  }

  presenceList(): PresenceInfo[] {
    return [...this.clients].map((c) => c.presence);
  }

  private broadcastPresence(): void {
    this.broadcast({ type: "presence", users: this.presenceList() });
  }

  broadcast(message: unknown, except: Client | null = null): void {
    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      if (client === except) continue;
      if (client.socket.readyState === client.socket.OPEN) {
        client.socket.send(payload);
      }
    }
  }

  get connectionCount(): number {
    return this.clients.size;
  }
}

/** Lazily materializes SessionRooms; owns per-session workspaces. */
export class Hub {
  private rooms = new Map<string, SessionRoom>();

  constructor(private readonly opts: HubOptions) {
    mkdirSync(opts.dataDir, { recursive: true });
  }

  get store(): Store {
    return this.opts.store;
  }

  createSession(input: {
    name: string;
    team_id: string;
    model_id: string;
    system_prompt: string;
    actor: Actor;
  }): SessionMeta {
    const meta: SessionMeta = {
      id: `s_${randomUUID().slice(0, 12)}`,
      name: input.name,
      team_id: input.team_id,
      created_by: input.actor.id,
      created_by_name: input.actor.name,
      created_at: Date.now(),
      model_id: input.model_id,
      system_prompt: input.system_prompt,
      current_branch: "main",
    };
    this.opts.store.createSession(meta);
    this.opts.store.logActivity({
      session_id: meta.id,
      actor_id: input.actor.id,
      actor_name: input.actor.name,
      action: "session_created",
      detail: meta.name,
    });
    this.opts.store.recordDomainEvent("session_created", {
      session_id: meta.id,
      user_id: input.actor.id,
      properties: { name: meta.name },
    });
    return meta;
  }

  room(sessionId: string): SessionRoom {
    const existing = this.rooms.get(sessionId);
    if (existing) return existing;
    const meta = this.opts.store.getSession(sessionId);
    if (!meta) throw new Error(`session not found: ${sessionId}`);

    const workspaceDir = join(this.opts.dataDir, "workspaces", meta.id);
    const snapshotter: WorkspaceSnapshotter =
      this.opts.snapshots === "git"
        ? new GitWorkspaceSnapshot(workspaceDir, join(this.opts.dataDir, "shadows", meta.id))
        : new NullSnapshot();
    const tools = new ToolRegistry();
    if (this.opts.snapshots === "git") {
      for (const tool of workspaceTools(workspaceDir)) tools.register(tool);
    }
    const room = new SessionRoom(meta, this.opts.store, this.opts.provider, snapshotter, tools);
    this.rooms.set(sessionId, room);
    return room;
  }

  connectionCount(sessionId: string): number {
    return this.rooms.get(sessionId)?.connectionCount ?? 0;
  }
}

export type { EngineEvent };
