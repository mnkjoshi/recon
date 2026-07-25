import type { Store } from "./store.js";
import type { Provider } from "./provider.js";
import type { ToolRegistry } from "./tools.js";
import type { WorkspaceSnapshotter } from "./snapshot.js";
import type {
  AgentStatus,
  BranchDiff,
  BranchRef,
  EngineEvent,
  Message,
  RenderedRequest,
  ToolResultBlock,
  ToolUseBlock,
  TurnRecord,
} from "./types.js";

export interface Actor {
  id: string;
  name: string;
}

/**
 * Rendering hook: compaction / RAG injection / memory blocks run here, BEFORE
 * the request is sent and logged — so the logged rendered_request is exactly
 * what the model saw.
 */
export type RenderHook = (
  request: RenderedRequest,
  ctx: { sessionId: string; branch: string },
) => RenderedRequest;

export type EngineListener = (event: EngineEvent) => void;

/**
 * Single-writer agent loop per branch, plus the version-control operations:
 * fork / checkout / prune / log / diff. Humans collaborate on the *pending*
 * prompt and on control actions; only this engine writes turns to a branch.
 */
export class SessionEngine {
  private statuses = new Map<string, AgentStatus>();
  private pauseRequested = new Set<string>();
  private inflight = new Map<string, AbortController>();
  private listeners = new Set<EngineListener>();

  constructor(
    private readonly opts: {
      store: Store;
      sessionId: string;
      provider: Provider;
      tools: ToolRegistry;
      snapshotter: WorkspaceSnapshotter;
      renderHooks?: RenderHook[];
    },
  ) {}

  get sessionId(): string {
    return this.opts.sessionId;
  }

  subscribe(listener: EngineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: EngineEvent): void {
    for (const l of this.listeners) l(event);
  }

  status(branch: string): AgentStatus {
    return this.statuses.get(branch) ?? "idle";
  }

  private setStatus(branch: string, status: AgentStatus): void {
    this.statuses.set(branch, status);
    this.emit({ type: "status", branch, status });
  }

  // ------------------------------------------------------------------
  // Context materialization: replay, don't redo.
  // ------------------------------------------------------------------

  /**
   * The conversation context at a turn is derived purely from stored data:
   * the turn's own rendered_request.messages (the exact prefix the model was
   * sent) plus its stored response and tool results appended verbatim.
   */
  contextAfter(turnId: string | null): Message[] {
    if (!turnId) return [];
    const turn = this.opts.store.getTurn(turnId);
    if (!turn) throw new Error(`turn not found: ${turnId}`);
    const messages: Message[] = [...turn.rendered_request.messages];
    if (turn.response) {
      messages.push({ role: "assistant", content: turn.response.content });
      if (turn.tool_results) {
        messages.push({ role: "user", content: turn.tool_results });
      }
    }
    return messages;
  }

  /** Number of messages the context holds after this turn (for delta slicing). */
  private contextLenAfter(turn: TurnRecord): number {
    return (
      turn.rendered_request.messages.length +
      (turn.response ? 1 : 0) +
      (turn.tool_results ? 1 : 0)
    );
  }

  /**
   * A turn's *delta*: the messages it contributed beyond its parent's
   * context — the new user message (or curated base), the assistant response,
   * and any tool results. Used by prune to build curated contexts.
   */
  turnDelta(turn: TurnRecord): Message[] {
    const parentLen = turn.parent_turn_id
      ? (() => {
          const parent = this.opts.store.getTurn(turn.parent_turn_id!);
          if (!parent) throw new Error(`broken chain at ${turn.parent_turn_id}`);
          return this.contextLenAfter(parent);
        })()
      : 0;
    const delta: Message[] = turn.rendered_request.messages.slice(parentLen);
    if (turn.response) {
      delta.push({ role: "assistant", content: turn.response.content });
      if (turn.tool_results) delta.push({ role: "user", content: turn.tool_results });
    }
    return delta;
  }

  private renderRequest(branchName: string, extraMessages: Message[]): RenderedRequest {
    const { store, sessionId, tools } = this.opts;
    const session = store.getSession(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);
    const branch = store.getBranch(sessionId, branchName);
    if (!branch) throw new Error(`branch not found: ${branchName}`);
    let request: RenderedRequest = {
      model_id: session.model_id,
      system_prompt: session.system_prompt,
      tools: tools.definitions(),
      messages: [...this.contextAfter(branch.head_turn_id), ...extraMessages],
    };
    for (const hook of this.opts.renderHooks ?? []) {
      request = hook(request, { sessionId, branch: branchName });
    }
    return request;
  }

  // ------------------------------------------------------------------
  // The single-writer agent loop
  // ------------------------------------------------------------------

  /**
   * Send a user message and run the agent loop to completion (or pause).
   * Each provider call commits as one turn; the loop continues while the
   * model requests tools. Safe pause boundaries are between provider calls —
   * a turn (stream + its tool executions) always commits whole or not at all.
   */
  async sendUserMessage(branchName: string, text: string, actor: Actor): Promise<TurnRecord[]> {
    return this.runLoop(branchName, { role: "user", content: [{ type: "text", text }] }, actor);
  }

  /** Pause at the next safe boundary. */
  pause(branchName: string, actor: Actor): void {
    const status = this.status(branchName);
    if (status === "running") {
      this.pauseRequested.add(branchName);
      this.setStatus(branchName, "pausing");
    } else if (status === "idle") {
      // Pausing an idle agent parks the branch so sends are rejected until resume.
      this.pauseRequested.add(branchName);
      this.setStatus(branchName, "paused");
    }
    this.opts.store.logActivity({
      session_id: this.sessionId,
      actor_id: actor.id,
      actor_name: actor.name,
      action: "pause",
      detail: branchName,
    });
  }

  /**
   * Resume from the committed head. If the branch paused mid tool-loop (the
   * head turn's response asked for tools and results are already committed),
   * the loop continues generating; otherwise the branch just goes idle.
   */
  async resume(branchName: string, actor: Actor): Promise<TurnRecord[]> {
    this.pauseRequested.delete(branchName);
    this.opts.store.logActivity({
      session_id: this.sessionId,
      actor_id: actor.id,
      actor_name: actor.name,
      action: "resume",
      detail: branchName,
    });
    const branch = this.opts.store.getBranch(this.sessionId, branchName);
    const head = branch?.head_turn_id ? this.opts.store.getTurn(branch.head_turn_id) : null;
    const midToolLoop =
      head?.response?.stop_reason === "tool_use" && head.tool_results !== null;
    if (this.status(branchName) === "paused" || this.status(branchName) === "idle") {
      if (midToolLoop) {
        return this.runLoop(branchName, null, actor);
      }
      this.setStatus(branchName, "idle");
    }
    return [];
  }

  /** Abort the in-flight turn without committing it. */
  hardStop(branchName: string, actor: Actor): void {
    this.inflight.get(branchName)?.abort();
    this.pauseRequested.delete(branchName);
    this.opts.store.logActivity({
      session_id: this.sessionId,
      actor_id: actor.id,
      actor_name: actor.name,
      action: "hard_stop",
      detail: branchName,
    });
  }

  private async runLoop(
    branchName: string,
    initialUserMessage: Message | null,
    actor: Actor,
  ): Promise<TurnRecord[]> {
    const { store, provider, tools, snapshotter } = this.opts;
    const current = this.status(branchName);
    if (current === "running" || current === "pausing") {
      throw new Error(`agent is already running on branch ${branchName}`);
    }
    if (current === "paused" && initialUserMessage) {
      throw new Error(`branch ${branchName} is paused; resume before sending`);
    }
    this.setStatus(branchName, "running");
    const committed: TurnRecord[] = [];
    let pendingUser: Message | null = initialUserMessage;

    try {
      // Each iteration = one provider call = one committed turn.
      for (;;) {
        // Safe boundary: honor pause between provider calls.
        if (this.pauseRequested.has(branchName)) {
          this.setStatus(branchName, "paused");
          return committed;
        }
        const branch = store.getBranch(this.sessionId, branchName);
        if (!branch) throw new Error(`branch not found: ${branchName}`);
        const rendered = this.renderRequest(branchName, pendingUser ? [pendingUser] : []);

        const abort = new AbortController();
        this.inflight.set(branchName, abort);
        let response;
        try {
          response = await provider.stream(rendered, {
            signal: abort.signal,
            onText: (delta) => this.emit({ type: "token", branch: branchName, text: delta }),
          });
        } catch (err) {
          if (abort.signal.aborted) {
            this.emit({ type: "turn_aborted", branch: branchName, reason: "hard stop" });
            this.setStatus(branchName, "idle");
            return committed;
          }
          throw err;
        } finally {
          this.inflight.delete(branchName);
        }

        // Execute tools requested by this response. The whole set belongs to
        // this turn; a hard stop between tools abandons the turn uncommitted.
        const toolUses = response.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
        let toolResults: ToolResultBlock[] | null = null;
        if (response.stop_reason === "tool_use" && toolUses.length > 0) {
          toolResults = [];
          for (const use of toolUses) {
            if (abort.signal.aborted) {
              this.emit({ type: "turn_aborted", branch: branchName, reason: "hard stop" });
              this.setStatus(branchName, "idle");
              return committed;
            }
            this.emit({
              type: "tool_call_started",
              branch: branchName,
              tool_use_id: use.id,
              name: use.name,
              input: use.input,
            });
            const started = Date.now();
            const { result, is_error } = await tools.execute(use.name, use.input);
            this.emit({
              type: "tool_call_finished",
              branch: branchName,
              tool_use_id: use.id,
              name: use.name,
              result,
              is_error,
              duration_ms: Date.now() - started,
            });
            toolResults.push({ type: "tool_result", tool_use_id: use.id, content: result, is_error });
          }
        }

        const snapshotRef = snapshotter.snapshot(
          `session ${this.sessionId} branch ${branchName} turn after ${branch.head_turn_id ?? "root"}`,
        );

        const turn = store.commitTurn({
          session_id: this.sessionId,
          branch: branchName,
          parent_turn_id: branch.head_turn_id,
          rendered_request: rendered,
          response,
          tool_results: toolResults,
          env_snapshot_ref: snapshotRef,
          author: actor.id,
          author_name: actor.name,
        });
        committed.push(turn);
        this.emit({ type: "turn_committed", branch: branchName, turn });
        store.recordDomainEvent("turn_committed", {
          session_id: this.sessionId,
          user_id: actor.id,
          properties: { branch: branchName, turn_id: turn.turn_id },
        });
        pendingUser = null;

        if (response.stop_reason !== "tool_use") break;
      }
      this.setStatus(branchName, "idle");
      return committed;
    } catch (err) {
      this.setStatus(branchName, "idle");
      this.emit({
        type: "error",
        branch: branchName,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      this.pauseRequested.delete(branchName);
    }
  }

  // ------------------------------------------------------------------
  // Version control: fork / checkout / prune / log / diff
  // ------------------------------------------------------------------

  /**
   * Create a branch pointing at an existing turn. No data is copied — the
   * checkpoint is the pointer; history is materialized lazily on read.
   */
  fork(turnId: string, branchName: string, actor: Actor): BranchRef {
    const { store } = this.opts;
    const turn = store.getTurn(turnId);
    if (!turn || turn.session_id !== this.sessionId) {
      throw new Error(`turn not found in session: ${turnId}`);
    }
    const branch = store.createBranch({
      session_id: this.sessionId,
      name: branchName,
      head_turn_id: turnId,
      kind: "fork",
      forked_from_turn_id: turnId,
      prune_manifest: null,
      created_by: actor.id,
      created_by_name: actor.name,
    });
    this.emit({ type: "branch_created", branch });
    store.logActivity({
      session_id: this.sessionId,
      actor_id: actor.id,
      actor_name: actor.name,
      action: "fork",
      detail: `${branchName} from ${turnId.slice(0, 10)}`,
    });
    store.recordDomainEvent("fork", {
      session_id: this.sessionId,
      user_id: actor.id,
      properties: { branch: branchName, from_turn: turnId },
    });
    return branch;
  }

  /**
   * Switch the session's active branch. Session context = the replayed
   * prefix, verbatim. Also restores the branch head's workspace snapshot;
   * returns a warning when no snapshot is available to restore.
   */
  checkout(branchName: string, actor: Actor): { branch: BranchRef; warning: string | null } {
    const { store, snapshotter } = this.opts;
    const status = this.status(branchName);
    const branch = store.getBranch(this.sessionId, branchName);
    if (!branch) throw new Error(`branch not found: ${branchName}`);
    if (status === "running" || status === "pausing") {
      throw new Error(`cannot checkout while agent is running on ${branchName}`);
    }
    store.setCurrentBranch(this.sessionId, branchName);

    let warning: string | null = null;
    const snapshotRef = this.nearestSnapshotRef(branch.head_turn_id);
    if (snapshotRef && snapshotter.enabled) {
      snapshotter.restore(snapshotRef);
    } else if (snapshotter.enabled) {
      warning = "no workspace snapshot found for this branch head; workspace left as-is";
    }

    this.emit({ type: "branch_checked_out", branch: branchName, actor: actor.name });
    store.logActivity({
      session_id: this.sessionId,
      actor_id: actor.id,
      actor_name: actor.name,
      action: "checkout",
      detail: branchName,
    });
    store.recordDomainEvent("revert", {
      session_id: this.sessionId,
      user_id: actor.id,
      properties: { branch: branchName },
    });
    return { branch, warning };
  }

  /** Convenience: revert = fork at a turn + checkout the new branch. */
  revertTo(turnId: string, branchName: string, actor: Actor): { branch: BranchRef; warning: string | null } {
    this.fork(turnId, branchName, actor);
    return this.checkout(branchName, actor);
  }

  private nearestSnapshotRef(turnId: string | null): string | null {
    let cursor = turnId;
    while (cursor) {
      const turn = this.opts.store.getTurn(cursor);
      if (!turn) return null;
      if (turn.env_snapshot_ref) return turn.env_snapshot_ref;
      cursor = turn.parent_turn_id;
    }
    return null;
  }

  /**
   * Prune: branch off a turn while cutting irrelevant turns. The curated
   * context is something the agent never actually saw, so it never
   * masquerades as history — it becomes the first commit (a `prune_base`
   * turn) of a new branch whose metadata records full provenance.
   *
   * Note for callers: a pruned prefix breaks provider prompt-cache reuse for
   * the shared prefix (surface this in the UI).
   */
  prune(
    baseTurnId: string,
    keepTurnIds: string[],
    branchName: string,
    note: string,
    actor: Actor,
  ): { branch: BranchRef; base_turn: TurnRecord } {
    const { store } = this.opts;
    const base = store.getTurn(baseTurnId);
    if (!base || base.session_id !== this.sessionId) {
      throw new Error(`turn not found in session: ${baseTurnId}`);
    }
    const chain = store.getChain(baseTurnId);
    const chainIds = chain.map((t) => t.turn_id);
    const keepSet = new Set(keepTurnIds);
    for (const id of keepSet) {
      if (!chainIds.includes(id)) throw new Error(`kept turn not in chain: ${id}`);
    }
    const kept = chainIds.filter((id) => keepSet.has(id));
    const cut = chainIds.filter((id) => !keepSet.has(id));
    if (kept.length === 0) throw new Error("prune must keep at least one turn");

    // Curated context: concatenation of kept turns' deltas, in chain order.
    const curated: Message[] = [];
    for (const turn of chain) {
      if (keepSet.has(turn.turn_id)) curated.push(...this.turnDelta(turn));
    }

    const manifest = {
      base_turn_id: baseTurnId,
      kept,
      cut,
      note,
      author: actor.id,
      author_name: actor.name,
      created_at: Date.now(),
    };
    const branch = store.createBranch({
      session_id: this.sessionId,
      name: branchName,
      head_turn_id: null,
      kind: "pruned",
      forked_from_turn_id: baseTurnId,
      prune_manifest: manifest,
      created_by: actor.id,
      created_by_name: actor.name,
    });

    // The curated prefix is recorded as the branch's first commit. model,
    // system prompt and tools are carried over from the base turn's rendered
    // request so future requests keep a stable prefix shape.
    const baseTurn = store.commitTurn({
      session_id: this.sessionId,
      branch: branchName,
      kind: "prune_base",
      parent_turn_id: null,
      rendered_request: {
        model_id: base.rendered_request.model_id,
        system_prompt: base.rendered_request.system_prompt,
        tools: base.rendered_request.tools,
        messages: curated,
      },
      response: null,
      tool_results: null,
      env_snapshot_ref: this.nearestSnapshotRef(baseTurnId),
      author: actor.id,
      author_name: actor.name,
    });

    const updated = store.getBranch(this.sessionId, branchName);
    if (!updated) throw new Error("prune branch vanished");
    this.emit({ type: "branch_created", branch: updated });
    store.logActivity({
      session_id: this.sessionId,
      actor_id: actor.id,
      actor_name: actor.name,
      action: "prune",
      detail: `${branchName}: kept ${kept.length}, cut ${cut.length} — ${note}`,
    });
    store.recordDomainEvent("prune", {
      session_id: this.sessionId,
      user_id: actor.id,
      properties: { branch: branchName, kept: kept.length, cut: cut.length },
    });
    return { branch: updated, base_turn: baseTurn };
  }

  /** The turn log of a branch, root-first. */
  log(branchName: string): TurnRecord[] {
    const branch = this.opts.store.getBranch(this.sessionId, branchName);
    if (!branch) throw new Error(`branch not found: ${branchName}`);
    return this.opts.store.getChain(branch.head_turn_id);
  }

  /** Structural diff between two branches' turn sequences. */
  diff(a: string, b: string): BranchDiff {
    const chainA = this.log(a);
    const chainB = this.log(b);
    let i = 0;
    while (i < chainA.length && i < chainB.length && chainA[i]!.turn_id === chainB[i]!.turn_id) {
      i += 1;
    }
    return {
      shared_prefix: chainA.slice(0, i).map((t) => t.turn_id),
      only_a: chainA.slice(i),
      only_b: chainB.slice(i),
    };
  }

  /** Ahead/behind counts of a branch relative to another (default branch). */
  aheadBehind(branchName: string, relativeTo: string): { ahead: number; behind: number } {
    const d = this.diff(branchName, relativeTo);
    return { ahead: d.only_a.length, behind: d.only_b.length };
  }
}
