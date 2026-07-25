import { createHash } from "node:crypto";

/**
 * Deterministic JSON serialization: object keys sorted recursively so the
 * same value always produces the same bytes. Arrays keep their order (order
 * is semantically meaningful for messages and content blocks).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Content-address an arbitrary JSON value. */
export function hashValue(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * Compute a turn id. Includes the parent turn id, so ids form a Merkle chain
 * (git-style): two logs with identical ids are byte-identical prefixes.
 */
export function computeTurnId(fields: {
  parent_turn_id: string | null;
  kind: string;
  rendered_request_hash: string;
  response_hash: string | null;
  tool_results_hash: string | null;
  env_snapshot_ref: string | null;
  author: string;
  created_at: number;
}): string {
  return "t" + sha256Hex(canonicalJson(fields));
}
