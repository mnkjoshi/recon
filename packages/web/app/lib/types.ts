/** Wire types mirrored from @recon/engine's API surface. */

export interface SessionMeta {
  id: string;
  name: string;
  team_id: string;
  created_by: string;
  created_by_name: string;
  created_at: number;
  model_id: string;
  system_prompt: string;
  current_branch: string;
}

export interface SessionListItem extends SessionMeta {
  branch_count: number;
  online: number;
  last_activity: number;
}

export interface PruneManifest {
  base_turn_id: string;
  kept: string[];
  cut: string[];
  note: string;
  author: string;
  author_name: string;
  created_at: number;
}

export interface BranchRef {
  session_id: string;
  name: string;
  head_turn_id: string | null;
  kind: "root" | "fork" | "pruned";
  forked_from_turn_id: string | null;
  prune_manifest: PruneManifest | null;
  created_by: string;
  created_by_name: string;
  created_at: number;
  ahead: number;
  behind: number;
}

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
  delta_chars: number;
}

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

export interface Message {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface TurnRecord {
  turn_id: string;
  session_id: string;
  parent_turn_id: string | null;
  kind: string;
  rendered_request: {
    model_id: string;
    system_prompt: string;
    tools: { name: string; description: string; input_schema: unknown }[];
    messages: Message[];
  };
  response: {
    id: string;
    model: string;
    stop_reason: string;
    content: ContentBlock[];
    usage: { input_tokens: number; output_tokens: number };
  } | null;
  tool_results: ContentBlock[] | null;
  env_snapshot_ref: string | null;
  author: string;
  author_name: string;
  created_at: number;
  usage: { input_tokens: number; output_tokens: number };
  depth: number;
}

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

export interface PresenceInfo {
  userId: string;
  displayName: string;
  cursor: number | null;
  color: string;
}

export interface ActivityEntry {
  id: number;
  session_id: string;
  actor_id: string;
  actor_name: string;
  action: string;
  detail: string;
  created_at: number;
}

export interface SessionDetail {
  session: SessionMeta;
  branches: BranchRef[];
  status: AgentStatus;
  presence: PresenceInfo[];
  you: { id: string; displayName: string; can_drive: boolean };
}

export interface CompareResult {
  a: string;
  b: string;
  shared_prefix: TurnSummary[];
  only_a: TurnSummary[];
  only_b: TurnSummary[];
}
