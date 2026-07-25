import { describe, expect, it } from "vitest";
import { canonicalJson, computeTurnId, hashValue } from "../src/hash.js";
import { Store } from "../src/store.js";
import type { RenderedRequest } from "../src/types.js";

const req = (text: string): RenderedRequest => ({
  model_id: "mock-model-20260101",
  system_prompt: "sys",
  tools: [],
  messages: [{ role: "user", content: [{ type: "text", text }] }],
});

const resp = (text: string) => ({
  id: "m1",
  model: "mock-model-20260101",
  stop_reason: "end_turn",
  content: [{ type: "text" as const, text }],
  usage: { input_tokens: 1, output_tokens: 1 },
});

describe("hash chain", () => {
  it("canonical json is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(hashValue({ b: 1, a: 2 })).toBe(hashValue({ a: 2, b: 1 }));
  });

  it("turn ids include the parent hash (Merkle chain)", () => {
    const base = {
      kind: "turn",
      rendered_request_hash: "r",
      response_hash: "p",
      tool_results_hash: null,
      env_snapshot_ref: null,
      author: "a",
      created_at: 1,
    };
    const id1 = computeTurnId({ ...base, parent_turn_id: null });
    const id2 = computeTurnId({ ...base, parent_turn_id: id1 });
    const id2other = computeTurnId({ ...base, parent_turn_id: "tsomethingelse" });
    expect(id1).not.toBe(id2);
    expect(id2).not.toBe(id2other);
    // determinism
    expect(computeTurnId({ ...base, parent_turn_id: null })).toBe(id1);
  });

  it("committed turns verify against recomputed hashes; content is deduplicated", () => {
    const store = new Store(":memory:");
    store.createSession({
      id: "s1",
      name: "test",
      team_id: "t1",
      created_by: "u1",
      created_by_name: "User One",
      created_at: 1,
      model_id: "mock-model-20260101",
      system_prompt: "sys",
      current_branch: "main",
    });
    const t1 = store.commitTurn({
      session_id: "s1",
      branch: "main",
      parent_turn_id: null,
      rendered_request: req("hello"),
      response: resp("hi"),
      tool_results: null,
      env_snapshot_ref: null,
      author: "u1",
      author_name: "User One",
      created_at: 10,
    });
    const t2 = store.commitTurn({
      session_id: "s1",
      branch: "main",
      parent_turn_id: t1.turn_id,
      rendered_request: req("again"),
      response: resp("hi"),
      tool_results: null,
      env_snapshot_ref: null,
      author: "u1",
      author_name: "User One",
      created_at: 20,
    });

    // Recompute t2's id from its stored fields: chain verifies.
    const recomputed = computeTurnId({
      parent_turn_id: t1.turn_id,
      kind: "turn",
      rendered_request_hash: hashValue(t2.rendered_request),
      response_hash: hashValue(t2.response),
      tool_results_hash: null,
      env_snapshot_ref: null,
      author: "u1",
      created_at: 20,
    });
    expect(recomputed).toBe(t2.turn_id);

    // Identical response blobs are stored once (content-addressed).
    const blobCount = store.db.prepare("SELECT COUNT(*) c FROM blobs").get() as { c: number };
    // 2 distinct rendered requests + 1 shared response
    expect(blobCount.c).toBe(3);
    store.close();
  });
});
