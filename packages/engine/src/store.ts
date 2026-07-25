import DatabaseConstructor, { type Database } from "better-sqlite3";
import { canonicalJson, computeTurnId, hashValue } from "./hash.js";
import type {
  ActivityEntry,
  BranchRef,
  ProviderResponse,
  PruneManifest,
  RenderedRequest,
  SessionMeta,
  ToolResultBlock,
  TurnRecord,
} from "./types.js";

/**
 * SQLite-backed store: append-only turn log + content-addressed blob store +
 * branch refs. Local-first; the server owns this store.
 *
 * Turns reference their large payloads (rendered request, response, tool
 * results) by content hash, so a fork is a single branch row pointing at an
 * existing turn — O(1) storage per checkpoint, no copy amplification.
 */
export class Store {
  readonly db: Database;

  constructor(path: string = ":memory:") {
    this.db = new DatabaseConstructor(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blobs (
        hash TEXT PRIMARY KEY,
        content TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        team_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_by_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        model_id TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        current_branch TEXT NOT NULL DEFAULT 'main'
      );
      CREATE TABLE IF NOT EXISTS turns (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        parent_turn_id TEXT,
        kind TEXT NOT NULL DEFAULT 'turn',
        rendered_request_hash TEXT NOT NULL REFERENCES blobs(hash),
        response_hash TEXT REFERENCES blobs(hash),
        tool_results_hash TEXT REFERENCES blobs(hash),
        env_snapshot_ref TEXT,
        author TEXT NOT NULL,
        author_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        depth INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
      CREATE TABLE IF NOT EXISTS branches (
        session_id TEXT NOT NULL REFERENCES sessions(id),
        name TEXT NOT NULL,
        head_turn_id TEXT,
        kind TEXT NOT NULL DEFAULT 'root',
        forked_from_turn_id TEXT,
        prune_manifest_hash TEXT REFERENCES blobs(hash),
        created_by TEXT NOT NULL,
        created_by_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, name)
      );
      CREATE TABLE IF NOT EXISTS activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS domain_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event TEXT NOT NULL,
        session_id TEXT,
        user_id TEXT,
        properties TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );
    `);
  }

  // -------------------------------------------------------------- blobs

  putBlob(value: unknown): string {
    const content = canonicalJson(value);
    const hash = hashValue(value);
    this.db
      .prepare("INSERT OR IGNORE INTO blobs (hash, content) VALUES (?, ?)")
      .run(hash, content);
    return hash;
  }

  getBlob<T>(hash: string): T {
    const row = this.db.prepare("SELECT content FROM blobs WHERE hash = ?").get(hash) as
      | { content: string }
      | undefined;
    if (!row) throw new Error(`blob not found: ${hash}`);
    return JSON.parse(row.content) as T;
  }

  // ----------------------------------------------------------- sessions

  createSession(meta: SessionMeta): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO sessions (id, name, team_id, created_by, created_by_name, created_at, model_id, system_prompt, current_branch)
           VALUES (@id, @name, @team_id, @created_by, @created_by_name, @created_at, @model_id, @system_prompt, @current_branch)`,
        )
        .run(meta);
      this.db
        .prepare(
          `INSERT INTO branches (session_id, name, head_turn_id, kind, forked_from_turn_id, prune_manifest_hash, created_by, created_by_name, created_at)
           VALUES (?, ?, NULL, 'root', NULL, NULL, ?, ?, ?)`,
        )
        .run(meta.id, meta.current_branch, meta.created_by, meta.created_by_name, meta.created_at);
    });
    tx();
  }

  getSession(id: string): SessionMeta | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      | SessionMeta
      | undefined;
    return row ?? null;
  }

  listSessions(): SessionMeta[] {
    return this.db
      .prepare("SELECT * FROM sessions ORDER BY created_at DESC")
      .all() as SessionMeta[];
  }

  setCurrentBranch(sessionId: string, branch: string): void {
    this.db
      .prepare("UPDATE sessions SET current_branch = ? WHERE id = ?")
      .run(branch, sessionId);
  }

  // -------------------------------------------------------------- turns

  /**
   * Commit a turn atomically: blobs + turn row + branch head advance in one
   * transaction. Returns the fully materialized record. The branch head must
   * still equal the expected parent (single-writer invariant enforced at the
   * storage layer too).
   */
  commitTurn(input: {
    session_id: string;
    branch: string;
    kind?: "turn" | "prune_base";
    parent_turn_id: string | null;
    rendered_request: RenderedRequest;
    response: ProviderResponse | null;
    tool_results: ToolResultBlock[] | null;
    env_snapshot_ref: string | null;
    author: string;
    author_name: string;
    created_at?: number;
  }): TurnRecord {
    const created_at = input.created_at ?? Date.now();
    const kind = input.kind ?? "turn";
    const tx = this.db.transaction((): TurnRecord => {
      const branch = this.getBranch(input.session_id, input.branch);
      if (!branch) throw new Error(`branch not found: ${input.branch}`);
      if (branch.head_turn_id !== input.parent_turn_id) {
        throw new Error(
          `stale commit: branch ${input.branch} head is ${branch.head_turn_id}, expected ${input.parent_turn_id}`,
        );
      }
      const rendered_request_hash = this.putBlob(input.rendered_request);
      const response_hash = input.response === null ? null : this.putBlob(input.response);
      const tool_results_hash =
        input.tool_results === null ? null : this.putBlob(input.tool_results);
      const parentDepth = input.parent_turn_id
        ? (this.getTurn(input.parent_turn_id)?.depth ?? -1)
        : -1;
      const turn_id = computeTurnId({
        parent_turn_id: input.parent_turn_id,
        kind,
        rendered_request_hash,
        response_hash,
        tool_results_hash,
        env_snapshot_ref: input.env_snapshot_ref,
        author: input.author,
        created_at,
      });
      this.db
        .prepare(
          `INSERT INTO turns (turn_id, session_id, parent_turn_id, kind, rendered_request_hash, response_hash, tool_results_hash,
             env_snapshot_ref, author, author_name, created_at, input_tokens, output_tokens, depth)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          turn_id,
          input.session_id,
          input.parent_turn_id,
          kind,
          rendered_request_hash,
          response_hash,
          tool_results_hash,
          input.env_snapshot_ref,
          input.author,
          input.author_name,
          created_at,
          input.response?.usage.input_tokens ?? 0,
          input.response?.usage.output_tokens ?? 0,
          parentDepth + 1,
        );
      this.db
        .prepare("UPDATE branches SET head_turn_id = ? WHERE session_id = ? AND name = ?")
        .run(turn_id, input.session_id, input.branch);
      const rec = this.getTurn(turn_id);
      if (!rec) throw new Error("commit failed to persist");
      return rec;
    });
    return tx();
  }

  getTurn(turnId: string): TurnRecord | null {
    const row = this.db.prepare("SELECT * FROM turns WHERE turn_id = ?").get(turnId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return this.rowToTurn(row);
  }

  private rowToTurn(row: Record<string, unknown>): TurnRecord {
    return {
      turn_id: row.turn_id as string,
      session_id: row.session_id as string,
      parent_turn_id: (row.parent_turn_id as string) ?? null,
      kind: row.kind as TurnRecord["kind"],
      rendered_request: this.getBlob<RenderedRequest>(row.rendered_request_hash as string),
      response: row.response_hash ? this.getBlob<ProviderResponse>(row.response_hash as string) : null,
      tool_results: row.tool_results_hash
        ? this.getBlob<ToolResultBlock[]>(row.tool_results_hash as string)
        : null,
      env_snapshot_ref: (row.env_snapshot_ref as string) ?? null,
      author: row.author as string,
      author_name: row.author_name as string,
      created_at: row.created_at as number,
      usage: {
        input_tokens: row.input_tokens as number,
        output_tokens: row.output_tokens as number,
      },
      depth: row.depth as number,
    };
  }

  /** Walk parent pointers from a turn back to its root. Returns root-first. */
  getChain(headTurnId: string | null): TurnRecord[] {
    const chain: TurnRecord[] = [];
    let cursor = headTurnId;
    while (cursor) {
      const turn = this.getTurn(cursor);
      if (!turn) throw new Error(`broken chain at ${cursor}`);
      chain.push(turn);
      cursor = turn.parent_turn_id;
    }
    chain.reverse();
    return chain;
  }

  /** Every turn in a session (all branches), for graph rendering. */
  listTurns(sessionId: string): TurnRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY created_at ASC, turn_id ASC")
      .all(sessionId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToTurn(r));
  }

  // ----------------------------------------------------------- branches

  createBranch(branch: {
    session_id: string;
    name: string;
    head_turn_id: string | null;
    kind: BranchRef["kind"];
    forked_from_turn_id: string | null;
    prune_manifest: PruneManifest | null;
    created_by: string;
    created_by_name: string;
    created_at?: number;
  }): BranchRef {
    if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(branch.name)) {
      throw new Error(`invalid branch name: ${branch.name}`);
    }
    if (this.getBranch(branch.session_id, branch.name)) {
      throw new Error(`branch already exists: ${branch.name}`);
    }
    const created_at = branch.created_at ?? Date.now();
    const manifestHash = branch.prune_manifest ? this.putBlob(branch.prune_manifest) : null;
    this.db
      .prepare(
        `INSERT INTO branches (session_id, name, head_turn_id, kind, forked_from_turn_id, prune_manifest_hash, created_by, created_by_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        branch.session_id,
        branch.name,
        branch.head_turn_id,
        branch.kind,
        branch.forked_from_turn_id,
        manifestHash,
        branch.created_by,
        branch.created_by_name,
        created_at,
      );
    const ref = this.getBranch(branch.session_id, branch.name);
    if (!ref) throw new Error("branch create failed");
    return ref;
  }

  getBranch(sessionId: string, name: string): BranchRef | null {
    const row = this.db
      .prepare("SELECT * FROM branches WHERE session_id = ? AND name = ?")
      .get(sessionId, name) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToBranch(row);
  }

  listBranches(sessionId: string): BranchRef[] {
    const rows = this.db
      .prepare("SELECT * FROM branches WHERE session_id = ? ORDER BY created_at ASC")
      .all(sessionId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToBranch(r));
  }

  private rowToBranch(row: Record<string, unknown>): BranchRef {
    return {
      session_id: row.session_id as string,
      name: row.name as string,
      head_turn_id: (row.head_turn_id as string) ?? null,
      kind: row.kind as BranchRef["kind"],
      forked_from_turn_id: (row.forked_from_turn_id as string) ?? null,
      prune_manifest: row.prune_manifest_hash
        ? this.getBlob<PruneManifest>(row.prune_manifest_hash as string)
        : null,
      created_by: row.created_by as string,
      created_by_name: row.created_by_name as string,
      created_at: row.created_at as number,
    };
  }

  // ----------------------------------------------------------- activity

  logActivity(entry: Omit<ActivityEntry, "id" | "created_at"> & { created_at?: number }): void {
    this.db
      .prepare(
        `INSERT INTO activity (session_id, actor_id, actor_name, action, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.session_id,
        entry.actor_id,
        entry.actor_name,
        entry.action,
        entry.detail,
        entry.created_at ?? Date.now(),
      );
  }

  listActivity(sessionId: string, limit = 100): ActivityEntry[] {
    return this.db
      .prepare("SELECT * FROM activity WHERE session_id = ? ORDER BY id DESC LIMIT ?")
      .all(sessionId, limit) as ActivityEntry[];
  }

  // -------------------------------------------------- domain analytics

  /**
   * Domain events (session_created, turn_committed, fork, revert, prune,
   * pause, resume). Hexclave auto-captures baseline product analytics
   * (page views, clicks, replays); it does not expose a custom-event ingest
   * API, so domain actions are recorded here and surfaced in the internal
   * usage view alongside Hexclave analytics queries.
   */
  recordDomainEvent(event: string, fields: { session_id?: string; user_id?: string; properties?: Record<string, unknown> }): void {
    this.db
      .prepare(
        "INSERT INTO domain_events (event, session_id, user_id, properties, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        event,
        fields.session_id ?? null,
        fields.user_id ?? null,
        JSON.stringify(fields.properties ?? {}),
        Date.now(),
      );
  }

  domainEventCounts(): { event: string; count: number }[] {
    return this.db
      .prepare("SELECT event, COUNT(*) as count FROM domain_events GROUP BY event ORDER BY count DESC")
      .all() as { event: string; count: number }[];
  }

  close(): void {
    this.db.close();
  }
}
