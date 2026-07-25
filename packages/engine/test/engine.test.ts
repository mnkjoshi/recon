import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/hash.js";
import { GitWorkspaceSnapshot } from "../src/snapshot.js";
import type { EngineEvent, TurnRecord } from "../src/types.js";
import { makeSession, stepToolRegistry, toolLoopScript, userA, userB } from "./helpers.js";

describe("fork pointer semantics", () => {
  it("forking duplicates nothing: same turn rows, same blobs, new ref only", async () => {
    const { store, engine } = makeSession();
    await engine.sendUserMessage("main", "one", userA);
    await engine.sendUserMessage("main", "two", userA);
    const log = engine.log("main");
    expect(log).toHaveLength(2);

    const turnsBefore = store.db.prepare("SELECT COUNT(*) c FROM turns").get() as { c: number };
    const blobsBefore = store.db.prepare("SELECT COUNT(*) c FROM blobs").get() as { c: number };

    const branch = engine.fork(log[0]!.turn_id, "alt", userB);
    expect(branch.head_turn_id).toBe(log[0]!.turn_id);
    expect(branch.kind).toBe("fork");
    expect(branch.forked_from_turn_id).toBe(log[0]!.turn_id);

    const turnsAfter = store.db.prepare("SELECT COUNT(*) c FROM turns").get() as { c: number };
    const blobsAfter = store.db.prepare("SELECT COUNT(*) c FROM blobs").get() as { c: number };
    expect(turnsAfter.c).toBe(turnsBefore.c); // O(1): a checkpoint is a pointer
    expect(blobsAfter.c).toBe(blobsBefore.c);

    // The fork's log is literally the same records.
    expect(engine.log("alt").map((t) => t.turn_id)).toEqual([log[0]!.turn_id]);
  });
});

describe("replay produces byte-identical rendered-request prefix", () => {
  it("a fork's replayed history is the exact bytes the model saw", async () => {
    const { engine } = makeSession();
    await engine.sendUserMessage("main", "first", userA);
    await engine.sendUserMessage("main", "second", userA);
    await engine.sendUserMessage("main", "third", userA);
    const mainLog = engine.log("main");

    engine.fork(mainLog[1]!.turn_id, "alt", userB);
    const altLog = engine.log("alt");

    // Byte-identical: the stored rendered_request blobs of the shared prefix
    // serialize identically (they are the same content-addressed records).
    for (let i = 0; i < altLog.length; i += 1) {
      expect(canonicalJson(altLog[i]!.rendered_request)).toBe(
        canonicalJson(mainLog[i]!.rendered_request),
      );
      expect(altLog[i]!.turn_id).toBe(mainLog[i]!.turn_id);
    }

    // Continuing the fork renders a request whose message prefix is exactly
    // the replayed context of the fork point.
    const expectedPrefix = engine.contextAfter(mainLog[1]!.turn_id);
    await engine.sendUserMessage("alt", "diverge", userB);
    const newTurn = engine.log("alt")[2]!;
    const sentMessages = newTurn.rendered_request.messages;
    expect(canonicalJson(sentMessages.slice(0, expectedPrefix.length))).toBe(
      canonicalJson(expectedPrefix),
    );
    // and main is untouched
    expect(engine.log("main").map((t) => t.turn_id)).toEqual(mainLog.map((t) => t.turn_id));
  });
});

describe("prune", () => {
  it("creates a new branch with provenance manifest and curated prefix", async () => {
    const { engine } = makeSession();
    await engine.sendUserMessage("main", "keep-alpha", userA);
    await engine.sendUserMessage("main", "cut-noise", userA);
    await engine.sendUserMessage("main", "keep-beta", userA);
    const log = engine.log("main");
    const [alpha, noise, beta] = log as [TurnRecord, TurnRecord, TurnRecord];

    const { branch, base_turn } = engine.prune(
      beta.turn_id,
      [alpha.turn_id, beta.turn_id],
      "lean",
      "drop the noise exchange",
      userB,
    );

    expect(branch.kind).toBe("pruned");
    expect(branch.forked_from_turn_id).toBe(beta.turn_id);
    expect(branch.prune_manifest).not.toBeNull();
    expect(branch.prune_manifest!.kept).toEqual([alpha.turn_id, beta.turn_id]);
    expect(branch.prune_manifest!.cut).toEqual([noise.turn_id]);
    expect(branch.prune_manifest!.note).toBe("drop the noise exchange");
    expect(branch.prune_manifest!.author).toBe(userB.id);

    // The curated context = concatenation of kept turns' deltas, and never
    // masquerades as history: it's a prune_base commit with no response.
    expect(base_turn.kind).toBe("prune_base");
    expect(base_turn.response).toBeNull();
    expect(base_turn.parent_turn_id).toBeNull();
    const expected = [...engine.turnDelta(alpha), ...engine.turnDelta(beta)];
    expect(canonicalJson(base_turn.rendered_request.messages)).toBe(canonicalJson(expected));
    // The cut exchange is absent.
    expect(JSON.stringify(base_turn.rendered_request.messages)).not.toContain("cut-noise");

    // The pruned branch continues from the curated context.
    await engine.sendUserMessage("lean", "continue", userB);
    const leanLog = engine.log("lean");
    expect(leanLog).toHaveLength(2);
    expect(
      canonicalJson(leanLog[1]!.rendered_request.messages.slice(0, expected.length)),
    ).toBe(canonicalJson(expected));
  });

  it("rejects keeping turns outside the chain and empty keep sets", async () => {
    const { engine } = makeSession();
    await engine.sendUserMessage("main", "a", userA);
    const [t1] = engine.log("main") as [TurnRecord];
    expect(() => engine.prune(t1.turn_id, [], "x", "", userA)).toThrow(/at least one/);
    expect(() => engine.prune(t1.turn_id, ["tbogus"], "x", "", userA)).toThrow(/not in chain/);
  });
});

describe("pause boundary safety", () => {
  it("pause lands between provider calls; no partial turn is ever committed", async () => {
    const { engine } = makeSession({
      script: toolLoopScript(3),
      tools: stepToolRegistry(),
      delayMs: 5,
    });
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));

    // Request pause as soon as the first turn commits.
    let paused = false;
    engine.subscribe((e) => {
      if (e.type === "turn_committed" && !paused) {
        paused = true;
        engine.pause("main", userB);
      }
    });

    const committed = await engine.sendUserMessage("main", "go", userA);
    expect(engine.status("main")).toBe("paused");
    // The in-flight turn finished (stream + all tool executions) and
    // committed whole; the loop then stopped at the boundary.
    expect(committed.length).toBeGreaterThanOrEqual(1);
    expect(committed.length).toBeLessThan(4); // did not run to completion
    for (const turn of committed) {
      expect(turn.response).not.toBeNull();
      const toolUses = turn.response!.content.filter((b) => b.type === "tool_use");
      const results = turn.tool_results ?? [];
      expect(results.length).toBe(toolUses.length); // complete, never partial
    }

    // Resume continues from the committed head to completion.
    const resumed = await engine.resume("main", userB);
    expect(engine.status("main")).toBe("idle");
    const log = engine.log("main");
    expect(log).toHaveLength(4); // 3 tool turns + final text turn
    expect(log[3]!.response!.stop_reason).toBe("end_turn");
    expect(committed.length + resumed.length).toBe(4);
  });

  it("hard stop aborts the in-flight turn without committing it", async () => {
    const { engine } = makeSession({ delayMs: 20 });
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));

    const loop = engine.sendUserMessage("main", "a slow streaming reply please", userA);
    await new Promise((r) => setTimeout(r, 30)); // mid-stream
    engine.hardStop("main", userB);
    await loop;

    expect(engine.log("main")).toHaveLength(0); // nothing committed
    expect(events.some((e) => e.type === "turn_aborted")).toBe(true);
    expect(engine.status("main")).toBe("idle");
    // The branch is fully usable afterwards.
    await engine.sendUserMessage("main", "again", userA);
    expect(engine.log("main")).toHaveLength(1);
  });

  it("rejects concurrent sends on the same branch (single writer)", async () => {
    const { engine } = makeSession({ delayMs: 10 });
    const first = engine.sendUserMessage("main", "first", userA);
    await new Promise((r) => setTimeout(r, 5));
    await expect(engine.sendUserMessage("main", "second", userB)).rejects.toThrow(/already running/);
    await first;
  });
});

describe("env snapshot round-trip", () => {
  it("git snapshotter captures and restores workspace state", () => {
    const base = mkdtempSync(join(tmpdir(), "recon-test-"));
    const workspace = join(base, "ws");
    const snap = new GitWorkspaceSnapshot(workspace, join(base, "shadow"));

    writeFileSync(join(workspace, "a.txt"), "version 1", "utf8");
    const ref1 = snap.snapshot("first");
    writeFileSync(join(workspace, "a.txt"), "version 2", "utf8");
    writeFileSync(join(workspace, "b.txt"), "new file", "utf8");
    const ref2 = snap.snapshot("second");
    expect(ref1).not.toBe(ref2);

    snap.restore(ref1);
    expect(readFileSync(join(workspace, "a.txt"), "utf8")).toBe("version 1");
    expect(existsSync(join(workspace, "b.txt"))).toBe(false);

    snap.restore(ref2);
    expect(readFileSync(join(workspace, "a.txt"), "utf8")).toBe("version 2");
    expect(readFileSync(join(workspace, "b.txt"), "utf8")).toBe("new file");
  });
});

describe("structural diff", () => {
  it("finds the shared prefix and divergent turns", async () => {
    const { engine } = makeSession();
    await engine.sendUserMessage("main", "one", userA);
    await engine.sendUserMessage("main", "two", userA);
    const log = engine.log("main");
    engine.fork(log[0]!.turn_id, "alt", userA);
    await engine.sendUserMessage("alt", "alt-two", userA);
    await engine.sendUserMessage("alt", "alt-three", userA);

    const diff = engine.diff("main", "alt");
    expect(diff.shared_prefix).toEqual([log[0]!.turn_id]);
    expect(diff.only_a.map((t) => t.turn_id)).toEqual([log[1]!.turn_id]);
    expect(diff.only_b).toHaveLength(2);
    expect(engine.aheadBehind("alt", "main")).toEqual({ ahead: 2, behind: 1 });
  });
});
