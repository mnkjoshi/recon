import * as Y from "yjs";
import type { AgentStatus, EngineEvent, PresenceInfo } from "./types";
import { sessionWsUrl } from "./api";

export interface ConnectionHandlers {
  onEvent?: (event: EngineEvent) => void;
  onPresence?: (users: PresenceInfo[]) => void;
  onStatus?: (status: AgentStatus) => void;
  onComposerChange?: (text: string) => void;
  onOpenStateChange?: (open: boolean) => void;
}

/**
 * Live session channel: engine event stream + presence + Yjs sync for the
 * shared composer, multiplexed over one WebSocket. Yjs updates travel as
 * base64 JSON frames; the server holds the authoritative doc and rebroadcasts.
 */
export class SessionConnection {
  readonly doc = new Y.Doc();
  private socket: WebSocket | null = null;
  private closed = false;

  constructor(
    private readonly sessionId: string,
    private readonly handlers: ConnectionHandlers,
  ) {
    // Forward local doc edits to the server; ignore remote-applied updates.
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "remote") return;
      this.send({ type: "yjs", update: toBase64(update) });
    });
    this.doc.getText("composer").observe(() => {
      this.handlers.onComposerChange?.(this.composerText());
    });
  }

  composerText(): string {
    return this.doc.getText("composer").toString();
  }

  async connect(): Promise<void> {
    const url = await sessionWsUrl(this.sessionId);
    if (this.closed) return;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => this.handlers.onOpenStateChange?.(true);
    socket.onclose = () => {
      this.handlers.onOpenStateChange?.(false);
      if (!this.closed) setTimeout(() => void this.connect(), 1500);
    };
    socket.onmessage = (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      switch (msg.type) {
        case "init": {
          if (typeof msg.yjs === "string") {
            Y.applyUpdate(this.doc, fromBase64(msg.yjs), "remote");
          }
          if (Array.isArray(msg.presence)) {
            this.handlers.onPresence?.(msg.presence as PresenceInfo[]);
          }
          if (typeof msg.status === "string") {
            this.handlers.onStatus?.(msg.status as AgentStatus);
          }
          break;
        }
        case "yjs":
          if (typeof msg.update === "string") {
            Y.applyUpdate(this.doc, fromBase64(msg.update), "remote");
          }
          break;
        case "presence":
          this.handlers.onPresence?.(msg.users as PresenceInfo[]);
          break;
        case "event": {
          const event = msg.event as EngineEvent;
          if (event.type === "status") this.handlers.onStatus?.(event.status);
          this.handlers.onEvent?.(event);
          break;
        }
      }
    };
  }

  sendPresence(cursor: number | null): void {
    this.send({ type: "presence", cursor });
  }

  private send(message: unknown): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
    this.doc.destroy();
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
