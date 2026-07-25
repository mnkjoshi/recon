import { useState } from "react";
import { useNavigate } from "react-router";
import type { AgentStatus, BranchRef, TurnSummary } from "../lib/types";

/**
 * The Timeline Rail — the version control UI. A vertical commit graph of the
 * current branch's turns: mono hash chips on a 1px graphite spine, fork
 * points blooming amber, the live head pulsing cyan while the agent runs and
 * freezing amber when paused. Hover previews a turn; every node exposes
 * `Fork from here`, `Revert here`, and `Prune from here`.
 */
export function TimelineRail(props: {
  sessionId: string;
  turns: TurnSummary[];
  branches: BranchRef[];
  status: AgentStatus;
  canDrive: boolean;
  onFork: (turnId: string) => void;
  onRevert: (turnId: string) => void;
}) {
  const { turns, branches, status, canDrive } = props;
  const navigate = useNavigate();
  const [open, setOpen] = useState<string | null>(null);

  const forkPoints = new Set(
    branches.map((b) => b.forked_from_turn_id).filter((id): id is string => Boolean(id)),
  );
  const headId = turns[turns.length - 1]?.turn_id ?? null;

  return (
    <nav className="panel session-rail" aria-label="Timeline rail">
      <div className="rail-track" data-testid="rail-track">
        {turns.length === 0 ? (
          <p className="muted small" style={{ paddingLeft: 4 }}>
            No turns yet. Send a prompt to create the first checkpoint.
          </p>
        ) : null}
        {turns.map((turn) => {
          const isHead = turn.turn_id === headId;
          const classes = [
            "rail-node",
            forkPoints.has(turn.turn_id) ? "fork-point" : "",
            isHead ? "head" : "",
            isHead && (status === "running" || status === "pausing") ? "live" : "",
            isHead && status === "paused" ? "paused" : "",
            turn.kind === "prune_base" ? "prune-base" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div
              key={turn.turn_id}
              className={classes}
              data-testid={`rail-node-${turn.turn_id}`}
              onMouseEnter={() => setOpen(turn.turn_id)}
              onMouseLeave={() => setOpen((cur) => (cur === turn.turn_id ? null : cur))}
            >
              <span className="dot" aria-hidden="true" />
              <button
                className="hash-chip"
                onClick={() => navigate(`/s/${props.sessionId}/turn/${turn.turn_id}`)}
                onFocus={() => setOpen(turn.turn_id)}
                aria-label={`Turn ${turn.turn_id.slice(0, 10)}`}
              >
                {turn.kind === "prune_base" ? "prune·" : ""}
                {turn.turn_id.slice(1, 8)}
              </button>
              {open === turn.turn_id ? (
                <div className="rail-popover" role="tooltip">
                  <div className="mono muted">{turn.turn_id.slice(0, 16)}…</div>
                  {turn.user_preview ? <div>“{turn.user_preview.slice(0, 80)}”</div> : null}
                  {turn.assistant_preview ? (
                    <div className="muted">{turn.assistant_preview.slice(0, 80)}</div>
                  ) : null}
                  <div className="muted small">
                    {turn.author_name} · {new Date(turn.created_at).toLocaleTimeString()}
                    {turn.tool_count > 0 ? ` · ${turn.tool_count} tool call${turn.tool_count > 1 ? "s" : ""}` : ""}
                  </div>
                  <div className="actions">
                    <button
                      className="amber small"
                      disabled={!canDrive}
                      onClick={() => props.onFork(turn.turn_id)}
                    >
                      Fork from here
                    </button>
                    <button
                      className="amber small"
                      disabled={!canDrive}
                      onClick={() => props.onRevert(turn.turn_id)}
                    >
                      Revert here
                    </button>
                    <button
                      className="amber small"
                      disabled={!canDrive}
                      onClick={() => navigate(`/s/${props.sessionId}/prune/${turn.turn_id}`)}
                    >
                      Prune from here
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
