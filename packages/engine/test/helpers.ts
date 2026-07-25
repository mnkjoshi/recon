import { Store } from "../src/store.js";
import { SessionEngine } from "../src/session.js";
import { MockProvider, type MockScript } from "../src/provider.js";
import { ToolRegistry } from "../src/tools.js";
import { NullSnapshot, type WorkspaceSnapshotter } from "../src/snapshot.js";
import type { SessionMeta } from "../src/types.js";

export const userA = { id: "user-a", name: "Alice" };
export const userB = { id: "user-b", name: "Bree" };

export function makeSession(opts: {
  script?: MockScript;
  delayMs?: number;
  tools?: ToolRegistry;
  snapshotter?: WorkspaceSnapshotter;
  store?: Store;
} = {}): { store: Store; engine: SessionEngine; meta: SessionMeta; provider: MockProvider } {
  const store = opts.store ?? new Store(":memory:");
  const meta: SessionMeta = {
    id: "s_test",
    name: "test session",
    team_id: "team_test",
    created_by: userA.id,
    created_by_name: userA.name,
    created_at: Date.now(),
    model_id: "mock-model-20260101",
    system_prompt: "You are a test agent.",
    current_branch: "main",
  };
  store.createSession(meta);
  const provider = new MockProvider(opts.script, opts.delayMs ?? 0);
  const engine = new SessionEngine({
    store,
    sessionId: meta.id,
    provider,
    tools: opts.tools ?? new ToolRegistry(),
    snapshotter: opts.snapshotter ?? new NullSnapshot(),
  });
  return { store, engine, meta, provider };
}

/** Script: every user message triggers `toolTurns` tool_use turns, then a final text turn. */
export function toolLoopScript(toolTurns: number): MockScript {
  return (req) => {
    // Count how many tool_result messages follow the last real user text message.
    let sinceUser = 0;
    for (let i = req.messages.length - 1; i >= 0; i -= 1) {
      const m = req.messages[i]!;
      const isToolResult = m.role === "user" && m.content.every((b) => b.type === "tool_result");
      if (m.role === "user" && !isToolResult) break;
      if (isToolResult) sinceUser += 1;
    }
    if (sinceUser < toolTurns) {
      return {
        content: [
          { type: "text", text: `working (step ${sinceUser + 1})` },
          {
            type: "tool_use",
            id: `tool_${req.messages.length}_${sinceUser}`,
            name: "step",
            input: { n: sinceUser + 1 },
          },
        ],
        stop_reason: "tool_use",
      };
    }
    return { content: [{ type: "text", text: `done after ${toolTurns} tool turns` }] };
  };
}

export function stepToolRegistry(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    definition: {
      name: "step",
      description: "test step tool",
      input_schema: { type: "object", properties: { n: { type: "number" } } },
    },
    handler: (input) => `step ${(input as { n: number }).n} ok`,
  });
  return tools;
}
