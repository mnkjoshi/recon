import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useRevalidator, useSearchParams } from "react-router";
import { getActivity, getSession, getTurnsFull, sessionAction, type TurnWithDelta } from "../lib/api";
import { SessionConnection } from "../lib/connection";
import { applyTextEdit } from "../lib/textsync";
import { useCurrentUser } from "../lib/auth";
import { Header } from "../components/Header";
import { TimelineRail } from "../components/TimelineRail";
import { useToast } from "../components/Toasts";
import type {
  ActivityEntry,
  AgentStatus,
  ContentBlock,
  EngineEvent,
  Message,
  PresenceInfo,
} from "../lib/types";
import type { Route } from "./+types/session";

export async function clientLoader({ params, request }: Route.ClientLoaderArgs) {
  const url = new URL(request.url);
  const branch = url.searchParams.get("branch") ?? undefined;
  const [detail, turns, activity] = await Promise.all([
    getSession(params.session),
    getTurnsFull(params.session, branch),
    getActivity(params.session),
  ]);
  return { detail, turns, activity };
}

interface RunningTool {
  tool_use_id: string;
  name: string;
  input: unknown;
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
}

export default function SessionView({ loaderData, params }: Route.ComponentProps) {
  useCurrentUser();
  const { detail, turns, activity } = loaderData;
  const sessionId = params.session;
  const branch = turns.branch;
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [status, setStatus] = useState<AgentStatus>(detail.status);
  const [presence, setPresence] = useState<PresenceInfo[]>(detail.presence);
  const [streamText, setStreamText] = useState("");
  const [runningTools, setRunningTools] = useState<RunningTool[]>([]);
  const [liveActivity, setLiveActivity] = useState<ActivityEntry[]>([]);
  const [composer, setComposer] = useState("");
  const [connected, setConnected] = useState(false);

  const connectionRef = useRef<SessionConnection | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const canDrive = detail.you.can_drive;

  useEffect(() => {
    const conn = new SessionConnection(sessionId, {
      onStatus: setStatus,
      onPresence: setPresence,
      onComposerChange: setComposer,
      onOpenStateChange: setConnected,
      onEvent: (event: EngineEvent) => {
        switch (event.type) {
          case "token":
            setStreamText((t) => t + event.text);
            break;
          case "tool_call_started":
            setRunningTools((tools) => [
              ...tools,
              { tool_use_id: event.tool_use_id, name: event.name, input: event.input },
            ]);
            break;
          case "tool_call_finished":
            setRunningTools((tools) =>
              tools.map((t) =>
                t.tool_use_id === event.tool_use_id
                  ? { ...t, result: event.result, is_error: event.is_error, duration_ms: event.duration_ms }
                  : t,
              ),
            );
            break;
          case "turn_committed":
            setStreamText("");
            setRunningTools([]);
            revalidator.revalidate();
            break;
          case "branch_created":
            revalidator.revalidate();
            break;
          case "turn_aborted":
            setStreamText("");
            setRunningTools([]);
            toast(`Turn aborted: ${event.reason}`);
            break;
          case "error":
            toast(event.message, "error");
            break;
        }
      },
    });
    connectionRef.current = conn;
    void conn.connect();
    return () => {
      conn.close();
      connectionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight });
  }, [streamText, turns.turns.length]);

  async function act(fn: () => Promise<unknown>, okMessage?: string) {
    try {
      const result = (await fn()) as { warning?: string | null } | undefined;
      if (okMessage) toast(okMessage);
      if (result && result.warning) toast(result.warning);
      revalidator.revalidate();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Action failed. Try again.", "error");
    }
  }

  const onSend = () => {
    const text = composer.trim();
    if (!text) return;
    void act(() => sessionAction(sessionId, { action: "send", branch, text }));
  };

  const onFork = (turnId: string) => {
    const name = window.prompt("New branch name:", suggestBranchName(detail.branches.length));
    if (!name) return;
    void act(
      () => sessionAction(sessionId, { action: "fork", turnId, name }),
      `Forked to ${name}`,
    );
  };

  const onRevert = (turnId: string) => {
    const name = window.prompt(
      "Revert creates a branch from this checkpoint. Branch name:",
      suggestBranchName(detail.branches.length),
    );
    if (!name) return;
    void act(async () => {
      const result = await sessionAction(sessionId, { action: "revert", turnId, name });
      setSearchParams({}, { replace: true });
      return result;
    }, `Reverted to ${name}`);
  };

  const onComposerEdit = (next: string) => {
    const conn = connectionRef.current;
    if (!conn) return;
    applyTextEdit(conn.doc.getText("composer"), conn.composerText(), next);
    setComposer(next);
  };

  const allActivity = useMemo(
    () => [...liveActivity, ...activity.activity].slice(0, 40),
    [liveActivity, activity.activity],
  );
  void setLiveActivity; // activity currently refreshes via revalidation

  const viewingBranch = searchParams.get("branch") ?? detail.session.current_branch;

  return (
    <>
      <Header
        crumb={
          <span className="muted small">
            {detail.session.name} · <span className="mono">{viewingBranch}</span>
          </span>
        }
      />
      <div className="session-grid">
        <TimelineRail
          sessionId={sessionId}
          turns={turns.turns}
          branches={detail.branches}
          status={status}
          canDrive={canDrive}
          onFork={onFork}
          onRevert={onRevert}
        />

        <main className="panel session-stream" ref={streamRef} aria-label="Conversation">
          {turns.turns.length === 0 && !streamText ? (
            <div className="empty-state">
              <p>No turns on this branch yet.</p>
              <p className="small">Compose a prompt below and send it to the agent.</p>
            </div>
          ) : null}
          {turns.turns.map((turn) => (
            <TurnBlock key={turn.turn_id} turn={turn} sessionId={sessionId} />
          ))}
          {(streamText || runningTools.length > 0) && (
            <div className="turn-block">
              <div className="meta">
                <span style={{ color: "var(--cyan)" }}>streaming</span>
              </div>
              <div className="streaming-text streaming-caret bubble-assistant">{streamText}</div>
              {runningTools.map((tool) => (
                <div
                  key={tool.tool_use_id}
                  className={`tool-card ${tool.result === undefined ? "running" : ""}`}
                >
                  <details open>
                    <summary>
                      {tool.result === undefined ? <span className="tool-dot" /> : null}
                      <span>{tool.name}</span>
                      {tool.duration_ms !== undefined ? (
                        <span className="muted">{tool.duration_ms}ms</span>
                      ) : null}
                    </summary>
                    <pre>{JSON.stringify(tool.input, null, 2)}</pre>
                    {tool.result !== undefined ? <pre>{tool.result}</pre> : null}
                  </details>
                </div>
              ))}
            </div>
          )}
        </main>

        <aside className="session-side" aria-label="Session status">
          <div className="panel" style={{ marginBottom: 12 }}>
            <div className="status-line">
              <span
                className={`status-dot ${status === "running" || status === "pausing" ? "running" : status === "paused" ? "paused" : ""}`}
              />
              <strong style={{ textTransform: "capitalize" }}>{status}</strong>
              {!connected ? <span className="muted small">reconnecting…</span> : null}
            </div>
            <div style={{ display: "flex", gap: 6, padding: "0 12px 12px" }}>
              {status === "running" || status === "pausing" ? (
                <>
                  <button
                    className="amber small"
                    disabled={!canDrive || status === "pausing"}
                    onClick={() =>
                      void act(() => sessionAction(sessionId, { action: "pause", branch }), "Pause requested")
                    }
                  >
                    Pause
                  </button>
                  <button
                    className="small"
                    disabled={!canDrive}
                    onClick={() =>
                      void act(() => sessionAction(sessionId, { action: "hard_stop", branch }), "Hard stop")
                    }
                  >
                    Hard stop
                  </button>
                </>
              ) : status === "paused" ? (
                <button
                  className="cyan small"
                  disabled={!canDrive}
                  onClick={() =>
                    void act(() => sessionAction(sessionId, { action: "resume", branch }), "Resumed")
                  }
                >
                  Resume
                </button>
              ) : (
                <span className="muted small">Agent idle</span>
              )}
            </div>
          </div>

          <div className="panel" style={{ marginBottom: 12 }}>
            <div style={{ padding: "10px 12px", display: "flex", gap: 6, flexWrap: "wrap" }}>
              {presence.map((p) => (
                <span
                  key={p.userId}
                  className="avatar"
                  style={{ background: p.color }}
                  title={p.displayName}
                >
                  {p.displayName.slice(0, 1).toUpperCase()}
                </span>
              ))}
              {presence.length === 0 ? <span className="muted small">nobody online</span> : null}
            </div>
            <div style={{ padding: "0 12px 10px" }} className="small muted">
              <Link to={`/s/${sessionId}/branches`}>Branches ({detail.branches.length})</Link>
            </div>
          </div>

          <div className="panel">
            <h3 style={{ padding: "10px 12px", fontSize: "var(--fs-2)" }}>Activity</h3>
            <ul className="activity-list">
              {allActivity.map((a) => (
                <li key={a.id}>
                  <strong>{a.actor_name}</strong> {formatAction(a.action)}{" "}
                  <span className="muted">{a.detail.slice(0, 60)}</span>
                  <div className="muted small">{new Date(a.created_at).toLocaleTimeString()}</div>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        <section className="panel session-composer composer" aria-label="Shared prompt composer">
          <div className="editor">
            <textarea
              value={composer}
              placeholder="Compose the next prompt together…"
              onChange={(e) => onComposerEdit(e.target.value)}
              onSelect={(e) =>
                connectionRef.current?.sendPresence((e.target as HTMLTextAreaElement).selectionStart)
              }
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") onSend();
              }}
            />
          </div>
          <div className="footer">
            {presence
              .filter((p) => p.cursor !== null)
              .map((p) => (
                <span
                  key={p.userId}
                  className="remote-cursor"
                  style={{ background: p.color, color: "var(--ink)" }}
                  title={`cursor at ${p.cursor}`}
                >
                  {p.displayName}
                </span>
              ))}
            <span className="spacer" style={{ flex: 1 }} />
            <span className="muted small">⌘⏎</span>
            <button
              className="cyan"
              onClick={onSend}
              disabled={!canDrive || !composer.trim() || status === "running" || status === "pausing"}
            >
              Send to agent
            </button>
          </div>
        </section>
      </div>
    </>
  );
}

function TurnBlock({ turn, sessionId }: { turn: TurnWithDelta; sessionId: string }) {
  return (
    <div className="turn-block" data-testid={`turn-${turn.turn_id}`}>
      <div className="meta">
        <Link className="mono" to={`/s/${sessionId}/turn/${turn.turn_id}`}>
          {turn.turn_id.slice(1, 8)}
        </Link>
        <span>{turn.author_name}</span>
        <span>{new Date(turn.created_at).toLocaleTimeString()}</span>
        {turn.kind === "prune_base" ? <span className="badge pruned">pruned base</span> : null}
      </div>
      {turn.delta.map((message, i) => (
        <MessageView key={i} message={message} toolResults={collectToolResults(turn.delta)} />
      ))}
    </div>
  );
}

function collectToolResults(delta: Message[]): Map<string, ContentBlock> {
  const map = new Map<string, ContentBlock>();
  for (const m of delta) {
    for (const block of m.content) {
      if (block.type === "tool_result" && block.tool_use_id) map.set(block.tool_use_id, block);
    }
  }
  return map;
}

function MessageView({
  message,
  toolResults,
}: {
  message: Message;
  toolResults: Map<string, ContentBlock>;
}) {
  return (
    <div>
      {message.content.map((block, i) => {
        if (block.type === "text") {
          return (
            <div key={i} className={message.role === "user" ? "bubble-user" : "bubble-assistant"}>
              {message.role === "user" ? <span className="muted">› </span> : null}
              {block.text}
            </div>
          );
        }
        if (block.type === "tool_use") {
          const result = block.id ? toolResults.get(block.id) : undefined;
          const isFileEdit = block.name === "write_file";
          const input = block.input as { path?: string; content?: string; command?: string } | undefined;
          return (
            <div key={i} className="tool-card">
              <details>
                <summary>
                  <span>{block.name}</span>
                  {input?.path ? <span className="muted">{input.path}</span> : null}
                  {input?.command ? <span className="muted">{input.command.slice(0, 48)}</span> : null}
                  {result?.is_error ? <span style={{ color: "var(--danger)" }}>error</span> : null}
                </summary>
                {isFileEdit && input?.content ? (
                  <pre data-diff-preview>
                    {input.content
                      .split("\n")
                      .slice(0, 40)
                      .map((line) => `+ ${line}`)
                      .join("\n")}
                  </pre>
                ) : (
                  <pre>{JSON.stringify(block.input, null, 2)}</pre>
                )}
                {result ? <pre>{result.content}</pre> : null}
              </details>
            </div>
          );
        }
        // tool_result blocks render inline with their tool_use above
        return null;
      })}
    </div>
  );
}

function formatAction(action: string): string {
  const map: Record<string, string> = {
    send: "sent a prompt",
    pause: "paused the agent",
    resume: "resumed the agent",
    hard_stop: "hard-stopped the agent",
    fork: "forked",
    checkout: "checked out",
    prune: "pruned",
    session_created: "created the session",
  };
  return map[action] ?? action;
}

function suggestBranchName(count: number): string {
  return `branch-${count + 1}`;
}
