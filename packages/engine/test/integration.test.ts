import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/hash.js";
import { makeSession, userA, userB } from "./helpers.js";

/**
 * Integration (mocked provider): two simulated users.
 * User A runs 5 turns; user B reverts to turn 3, forks, continues.
 * The shared prefix is identical, the futures diverge, and both branches
 * remain independently resumable. Plus one full prune flow.
 */
describe("two-user revert flow", () => {
  it("A runs 5 turns, B reverts to turn 3 and both branches keep working", async () => {
    const { engine, store } = makeSession();

    // --- User A drives five exchanges on main.
    for (let i = 1; i <= 5; i += 1) {
      await engine.sendUserMessage("main", `feature step ${i}`, userA);
    }
    const mainLog = engine.log("main");
    expect(mainLog).toHaveLength(5);
    expect(mainLog.every((t) => t.author === userA.id)).toBe(true);

    // --- User B reverts to turn 3: fork + checkout, context replayed verbatim.
    const turn3 = mainLog[2]!;
    const { branch } = engine.revertTo(turn3.turn_id, "bree/rethink", userB);
    expect(branch.head_turn_id).toBe(turn3.turn_id);
    expect(branch.created_by).toBe(userB.id);
    expect(store.getSession(engine.sessionId)!.current_branch).toBe("bree/rethink");

    // The fork's context is byte-identical to main's context at turn 3 —
    // as if turns 4 and 5 never happened.
    expect(canonicalJson(engine.contextAfter(branch.head_turn_id))).toBe(
      canonicalJson(engine.contextAfter(turn3.turn_id)),
    );
    const forkChain = engine.log("bree/rethink");
    expect(forkChain.map((t) => t.turn_id)).toEqual(mainLog.slice(0, 3).map((t) => t.turn_id));

    // --- B continues on the fork; futures diverge.
    await engine.sendUserMessage("bree/rethink", "take a different approach", userB);
    await engine.sendUserMessage("bree/rethink", "and refine it", userB);

    const diff = engine.diff("main", "bree/rethink");
    expect(diff.shared_prefix).toEqual(mainLog.slice(0, 3).map((t) => t.turn_id));
    expect(diff.only_a.map((t) => t.turn_id)).toEqual(mainLog.slice(3).map((t) => t.turn_id));
    expect(diff.only_b).toHaveLength(2);
    expect(diff.only_b.every((t) => t.author === userB.id)).toBe(true);

    // --- Both branches independently resumable.
    await engine.sendUserMessage("main", "meanwhile, main continues", userA);
    await engine.sendUserMessage("bree/rethink", "fork also continues", userB);
    expect(engine.log("main")).toHaveLength(6);
    expect(engine.log("bree/rethink")).toHaveLength(6);

    // The shared prefix stayed bit-identical through all of it.
    const finalMain = engine.log("main");
    const finalFork = engine.log("bree/rethink");
    for (let i = 0; i < 3; i += 1) {
      expect(finalMain[i]!.turn_id).toBe(finalFork[i]!.turn_id);
      expect(canonicalJson(finalMain[i]!.rendered_request)).toBe(
        canonicalJson(finalFork[i]!.rendered_request),
      );
    }
  });

  it("prune flow: B branches off a lean context and works in it", async () => {
    const { engine } = makeSession();
    await engine.sendUserMessage("main", "set up the project", userA);
    await engine.sendUserMessage("main", "long tangent about logging", userA);
    await engine.sendUserMessage("main", "back on track: build the API", userA);
    const log = engine.log("main");

    const { branch } = engine.prune(
      log[2]!.turn_id,
      [log[0]!.turn_id, log[2]!.turn_id],
      "bree/lean",
      "cut the logging tangent",
      userB,
    );
    expect(branch.kind).toBe("pruned");
    expect(branch.prune_manifest!.cut).toEqual([log[1]!.turn_id]);

    // The curated context is leaner and the tangent is gone.
    const leanBase = engine.log("bree/lean")[0]!;
    const curated = JSON.stringify(leanBase.rendered_request.messages);
    expect(curated).toContain("set up the project");
    expect(curated).toContain("build the API");
    expect(curated).not.toContain("logging");

    // Work continues in the pruned branch; main is untouched.
    await engine.sendUserMessage("bree/lean", "add the first endpoint", userB);
    expect(engine.log("bree/lean")).toHaveLength(2);
    expect(engine.log("main")).toHaveLength(3);
  });
});
