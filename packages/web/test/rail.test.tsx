// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

afterEach(cleanup);
import { createRoutesStub } from "react-router";
import { TimelineRail } from "../app/components/TimelineRail";
import type { BranchRef, TurnSummary } from "../app/lib/types";

const turn = (id: string, parent: string | null, depth: number, kind = "turn"): TurnSummary => ({
  turn_id: id,
  parent_turn_id: parent,
  kind,
  author: "user-a",
  author_name: "Alice",
  created_at: 1700000000000 + depth * 1000,
  depth,
  stop_reason: "end_turn",
  tool_count: 0,
  usage: { input_tokens: 10, output_tokens: 10 },
  env_snapshot_ref: null,
  user_preview: `prompt ${depth}`,
  assistant_preview: `answer ${depth}`,
  delta_chars: 100,
});

const branch = (name: string, head: string, forkedFrom: string | null, kind: BranchRef["kind"]): BranchRef => ({
  session_id: "s1",
  name,
  head_turn_id: head,
  kind,
  forked_from_turn_id: forkedFrom,
  prune_manifest: null,
  created_by: "user-a",
  created_by_name: "Alice",
  created_at: 1700000000000,
  ahead: 0,
  behind: 0,
});

/** Fixture log: t1 → t2 → t3 on main, with a fork branching off t2. */
const turns = [turn("tabc1111", null, 0), turn("tdef2222", "tabc1111", 1), turn("tghi3333", "tdef2222", 2)];
const branches = [
  branch("main", "tghi3333", null, "root"),
  branch("alt", "tdef2222", "tdef2222", "fork"),
];

function renderRail(status: "idle" | "running" | "paused" = "idle") {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <TimelineRail
          sessionId="s1"
          turns={turns}
          branches={branches}
          status={status}
          canDrive={true}
          onFork={() => {}}
          onRevert={() => {}}
        />
      ),
    },
  ]);
  return render(<Stub initialEntries={["/"]} />);
}

describe("Timeline Rail", () => {
  it("renders one node per turn with mono hash chips", () => {
    renderRail();
    expect(screen.getByTestId("rail-node-tabc1111")).toBeTruthy();
    expect(screen.getByTestId("rail-node-tdef2222")).toBeTruthy();
    expect(screen.getByTestId("rail-node-tghi3333")).toBeTruthy();
    // chips show the short hash
    expect(screen.getByText("abc1111")).toBeTruthy();
  });

  it("marks fork points from branch lineage", () => {
    renderRail();
    expect(screen.getByTestId("rail-node-tdef2222").className).toContain("fork-point");
    expect(screen.getByTestId("rail-node-tabc1111").className).not.toContain("fork-point");
  });

  it("marks the head, live while running and frozen amber when paused", () => {
    renderRail("running");
    let head = screen.getByTestId("rail-node-tghi3333");
    expect(head.className).toContain("head");
    expect(head.className).toContain("live");
    cleanup();

    renderRail("paused");
    head = screen.getByTestId("rail-node-tghi3333");
    expect(head.className).toContain("paused");
    expect(head.className).not.toContain("live");
  });
});
