import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Per-turn environment snapshots: the rendered-request log captures what the
 * agent *knew*; these capture what the world *looked like*. Revert restores
 * both.
 */
export interface WorkspaceSnapshotter {
  /** Capture the current workspace state; returns a snapshot ref or null. */
  snapshot(label: string): string | null;
  /** Restore the workspace to a previously captured state. */
  restore(ref: string): void;
  /** Whether this snapshotter actually captures anything. */
  readonly enabled: boolean;
}

/** For chat-only sessions: no workspace, nothing to snapshot. */
export class NullSnapshot implements WorkspaceSnapshotter {
  readonly enabled = false;
  snapshot(): null {
    return null;
  }
  restore(): void {
    // nothing to restore
  }
}

/**
 * Shadow-git snapshotter: a bare git dir *outside* the workspace tracks the
 * workspace as its work-tree, so the user's own git repo (if any) is
 * untouched. snapshot() = add -A && commit → commit sha; restore() = checkout
 * that sha into the work-tree and remove untracked files.
 */
export class GitWorkspaceSnapshot implements WorkspaceSnapshotter {
  readonly enabled = true;
  private gitDir: string;

  constructor(
    private workspaceDir: string,
    shadowDir?: string,
  ) {
    this.gitDir = shadowDir ?? join(workspaceDir, "..", `.recon-shadow-${basenameSafe(workspaceDir)}`);
    mkdirSync(this.workspaceDir, { recursive: true });
    if (!existsSync(join(this.gitDir, "HEAD"))) {
      mkdirSync(this.gitDir, { recursive: true });
      this.git(["init", "--bare", "-b", "main", this.gitDir], { useDirs: false });
      // A bare repo refuses work-tree operations; we always pass --work-tree
      // explicitly, so flip the flag off.
      this.git(["config", "core.bare", "false"]);
      this.git(["config", "user.email", "engine@recon.local"]);
      this.git(["config", "user.name", "recon-engine"]);
      // Shadow commits are machine checkpoints; never inherit the user's
      // global signing setup (a missing signing key would break snapshots).
      this.git(["config", "commit.gpgsign", "false"]);
      // Keep the user's own .git out of the shadow history.
      this.git(["config", "core.excludesFile", "/dev/null"]);
    }
  }

  private git(args: string[], opts: { useDirs?: boolean; allowFail?: boolean } = {}): string {
    const useDirs = opts.useDirs ?? true;
    const full = useDirs
      ? ["--git-dir", this.gitDir, "--work-tree", this.workspaceDir, ...args]
      : args;
    const res = spawnSync("git", full, { encoding: "utf8" });
    if (res.status !== 0 && !opts.allowFail) {
      throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
    }
    return res.stdout.trim();
  }

  snapshot(label: string): string {
    this.git(["add", "-A"]);
    // --allow-empty so every turn gets a snapshot even with no file changes;
    // the ref must exist for revert to be meaningful.
    this.git(["commit", "--allow-empty", "-m", label]);
    return this.git(["rev-parse", "HEAD"]);
  }

  restore(ref: string): void {
    // Reset index + work-tree to the snapshot, then drop anything untracked
    // that appeared after it. HEAD moves too, so subsequent snapshots chain
    // from the restored state.
    this.git(["reset", "--hard", ref]);
    this.git(["clean", "-fd"], { allowFail: true });
  }
}

function basenameSafe(p: string): string {
  return p.replace(/[^A-Za-z0-9_-]+/g, "_").slice(-64);
}
