import { useState } from "react";
import { Link } from "react-router";
import { getSession, getTurn } from "../lib/api";
import { useCurrentUser } from "../lib/auth";
import { Header } from "../components/Header";
import type { Route } from "./+types/turn";

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  const [detail, turn] = await Promise.all([
    getSession(params.session),
    getTurn(params.session, params.turnId),
  ]);
  return { detail, ...turn };
}

const TABS = ["Rendered request", "Response", "Tool results", "Workspace snapshot"] as const;

export default function TurnDetail({ loaderData, params }: Route.ComponentProps) {
  useCurrentUser();
  const { detail, turn } = loaderData;
  const [tab, setTab] = useState<(typeof TABS)[number]>("Rendered request");

  return (
    <>
      <Header
        crumb={
          <span className="muted small">
            <Link to={`/s/${detail.session.id}`}>{detail.session.name}</Link> · turn{" "}
            <span className="mono">{turn.turn_id.slice(1, 11)}</span>
          </span>
        }
      />
      <main className="page">
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <h2 className="mono" style={{ fontSize: "var(--fs-4)" }}>
            {turn.turn_id.slice(0, 18)}…
          </h2>
          {turn.kind === "prune_base" ? <span className="badge pruned">pruned base</span> : null}
          <span className="muted small">
            by {turn.author_name} · {new Date(turn.created_at).toLocaleString()} ·{" "}
            {turn.usage.input_tokens} in / {turn.usage.output_tokens} out tokens
          </span>
        </div>
        {turn.parent_turn_id ? (
          <p className="muted small">
            parent{" "}
            <Link className="mono" to={`/s/${params.session}/turn/${turn.parent_turn_id}`}>
              {turn.parent_turn_id.slice(1, 11)}
            </Link>
          </p>
        ) : (
          <p className="muted small">root of its chain</p>
        )}

        <div style={{ display: "flex", gap: 6, margin: "16px 0" }} role="tablist">
          {TABS.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? "amber small" : "small"}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="panel" style={{ padding: 12, overflowX: "auto" }}>
          {tab === "Rendered request" ? (
            <JsonView
              value={turn.rendered_request}
              caption="The exact (model_id, system_prompt, tools, messages) tuple sent to the API."
            />
          ) : null}
          {tab === "Response" ? (
            turn.response ? (
              <JsonView value={turn.response} caption="The exact API response, all content blocks." />
            ) : (
              <p className="muted">
                No response — this is a prune base: a curated context the model never answered.
              </p>
            )
          ) : null}
          {tab === "Tool results" ? (
            turn.tool_results ? (
              <JsonView value={turn.tool_results} caption="Tool outputs fed back after this response." />
            ) : (
              <p className="muted">No tool calls in this turn.</p>
            )
          ) : null}
          {tab === "Workspace snapshot" ? (
            turn.env_snapshot_ref ? (
              <div>
                <p className="small muted">Shadow-git commit capturing the workspace at commit time:</p>
                <pre className="mono">{turn.env_snapshot_ref}</pre>
                <p className="small muted">
                  Reverting to this turn restores the workspace to this snapshot.
                </p>
              </div>
            ) : (
              <p className="muted">No workspace snapshot (chat-only session).</p>
            )
          ) : null}
        </div>
      </main>
    </>
  );
}

/** Lightweight syntax highlighting: color JSON keys/strings via regex spans. */
function JsonView({ value, caption }: { value: unknown; caption: string }) {
  const json = JSON.stringify(value, null, 2);
  const html = json
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/("(?:[^"\\]|\\.)*")(\s*:)?/g, (_m, str: string, colon?: string) =>
      colon
        ? `<span style="color:var(--cyan)">${str}</span>${colon}`
        : `<span style="color:var(--amber)">${str}</span>`,
    )
    .replace(/\b(true|false|null|\d+)\b/g, '<span style="color:var(--slate)">$1</span>');
  return (
    <div>
      <p className="small muted">{caption}</p>
      <pre
        className="mono"
        style={{ margin: 0, maxHeight: "60vh", overflow: "auto" }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
