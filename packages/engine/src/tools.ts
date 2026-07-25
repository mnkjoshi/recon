import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { ToolDefinition } from "./types.js";

export type ToolHandler = (input: unknown) => Promise<string> | string;

export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

/** Registered tool handlers executed by the session engine's agent loop. */
export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    this.tools.set(tool.definition.name, tool);
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  async execute(name: string, input: unknown): Promise<{ result: string; is_error: boolean }> {
    const tool = this.tools.get(name);
    if (!tool) return { result: `unknown tool: ${name}`, is_error: true };
    try {
      return { result: await tool.handler(input), is_error: false };
    } catch (err) {
      return { result: err instanceof Error ? err.message : String(err), is_error: true };
    }
  }
}

function insideWorkspace(workspaceDir: string, p: string): string {
  const abs = resolve(workspaceDir, p);
  const root = resolve(workspaceDir);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`path escapes workspace: ${p}`);
  }
  return abs;
}

/** Default coding tools scoped to a workspace directory. */
export function workspaceTools(workspaceDir: string): RegisteredTool[] {
  mkdirSync(workspaceDir, { recursive: true });
  return [
    {
      definition: {
        name: "write_file",
        description: "Write a file inside the workspace (creates parent directories).",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative path" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
      handler: (input) => {
        const { path, content } = input as { path: string; content: string };
        const abs = insideWorkspace(workspaceDir, path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, "utf8");
        return `wrote ${content.length} bytes to ${path}`;
      },
    },
    {
      definition: {
        name: "read_file",
        description: "Read a file inside the workspace.",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      handler: (input) => {
        const { path } = input as { path: string };
        return readFileSync(insideWorkspace(workspaceDir, path), "utf8");
      },
    },
    {
      definition: {
        name: "bash",
        description: "Run a shell command inside the workspace (30s timeout).",
        input_schema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
      handler: (input) => {
        const { command } = input as { command: string };
        const res = spawnSync("bash", ["-c", command], {
          cwd: workspaceDir,
          encoding: "utf8",
          timeout: 30_000,
        });
        const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.slice(0, 20_000);
        if (res.status !== 0) throw new Error(out || `exit code ${res.status}`);
        return out || "(no output)";
      },
    },
  ];
}
