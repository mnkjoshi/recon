/**
 * Core data model for the Recon context version control engine.
 *
 * The unit of versioning is the *rendered request* — the literal
 * (model_id, system_prompt, tools, messages) tuple sent to the provider on
 * each API call — plus the exact response and the tool results fed back.
 * Every committed turn is a checkpoint by construction: a checkpoint is a
 * pointer to a prefix of the append-only turn log.
 */

// ---------------------------------------------------------------------------
// Message / provider wire types (provider-agnostic, Anthropic-shaped)
// ---------------------------------------------------------------------------

export type Role = "user" | "assistant";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: Role;
  content: ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * The exact tuple sent to the model API. This — not a semantic message log —
 * is what gets hashed and stored, so the "context preserved EXACTLY" guarantee
 * is airtight by construction: any harness-side transformation (compaction,
 * injection, memory) runs *before* this object is created.
 */
export interface RenderedRequest {
  model_id: string;
  system_prompt: string;
  tools: ToolDefinition[];
  messages: Message[];
}

/** The exact provider response, all content blocks included. */
export interface ProviderResponse {
  id: string;
  model: string;
  stop_reason: string;
  content: (TextBlock | ToolUseBlock)[];
  usage: { input_tokens: number; output_tokens: number };
}

// ---------------------------------------------------------------------------
// Turn log
// ---------------------------------------------------------------------------

export type TurnKind = "turn" | "prune_base";

export interface TurnRecord {
  /** Content-addressed hash including parent hash (Merkle chain). */
  turn_id: string;
  session_id: string;
  parent_turn_id: string | null;
  kind: TurnKind;
  rendered_request: RenderedRequest;
  /** null only for prune_base records (a curated context the model never answered). */
  response: ProviderResponse | null;
  /** Tool outputs fed back after this response, if the response requested tools. */
  tool_results: ToolResultBlock[] | null;
  /** Pointer to the workspace snapshot taken when this turn committed. */
  env_snapshot_ref: string | null;
  /** Hexclave user id of whoever triggered the turn. */
  author: string;
  author_name: string;
  created_at: number;
  usage: { input_tokens: number; output_tokens: number };
  /** Distance from the root of its chain; cheap ahead/behind computation. */
  depth: number;
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

export type BranchKind = "root" | "fork" | "pruned";

export interface PruneManifest {
  /** The turn the prune branched off from. */
  base_turn_id: string;
  /** Turn ids whose deltas were kept, in chain order. */
  kept: string[];
  /** Turn ids whose deltas were cut. */
  cut: string[];
  note: string;
  author: string;
  author_name: string;
  created_at: number;
}

export interface BranchRef {
  session_id: string;
  name: string;
  /** Pointer to a prefix of the turn log. Null only for a root branch with no turns yet. */
  head_turn_id: string | null;
  kind: BranchKind;
  /** For fork/pruned branches: the turn they diverged from. */
  forked_from_turn_id: string | null;
  prune_manifest: PruneManifest | null;
  created_by: string;
  created_by_name: string;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface SessionMeta {
  id: string;
  name: string;
  /** Hexclave team id — the session's collaborator roster and RBAC scope. */
  team_id: string;
  created_by: string;
  created_by_name: string;
  created_at: number;
  model_id: string;
  system_prompt: string;
  current_branch: string;
}

// ---------------------------------------------------------------------------
// Engine status / events
// ---------------------------------------------------------------------------

export type AgentStatus = "idle" | "running" | "pausing" | "paused";

export type EngineEvent =
  | { type: "status"; branch: string; status: AgentStatus }
  | { type: "token"; branch: string; text: string }
  | { type: "tool_call_started"; branch: string; tool_use_id: string; name: string; input: unknown }
  | {
      type: "tool_call_finished";
      branch: string;
      tool_use_id: string;
      name: string;
      result: string;
      is_error: boolean;
      duration_ms: number;
    }
  | { type: "turn_committed"; branch: string; turn: TurnRecord }
  | { type: "turn_aborted"; branch: string; reason: string }
  | { type: "branch_created"; branch: BranchRef }
  | { type: "branch_checked_out"; branch: string; actor: string }
  | { type: "error"; branch: string; message: string };

export interface ActivityEntry {
  id: number;
  session_id: string;
  actor_id: string;
  actor_name: string;
  action: string;
  detail: string;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Structural diff
// ---------------------------------------------------------------------------

export interface BranchDiff {
  /** Turn ids shared by both branches, root-first. */
  shared_prefix: string[];
  /** Turns only on branch A, oldest-first. */
  only_a: TurnRecord[];
  /** Turns only on branch B, oldest-first. */
  only_b: TurnRecord[];
}
