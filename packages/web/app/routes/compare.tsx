import { useState } from "react";
import { Link } from "react-router";
import { compareBranches, getSession } from "../lib/api";
import { useCurrentUser } from "../lib/auth";
import { Header } from "../components/Header";
import type { TurnSummary } from "../lib/types";
import type { Route } from "./+types/compare";

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  const splat = params["*"] ?? "";
  const [a, b] = splat.split("...").map(decodeURIComponent);
  if (!a || !b) {
    throw new Response("Compare path must look like /compare/branch-a...branch-b", { status: 400 });
  }
  const [detail, diff] = await Promise.all([
    getSession(params.session),
    compareBranches(params.session, a, b),
  ]);
  return { detail, diff };
}

export default function Compare({ loaderData, params }: Route.ComponentProps) {
  useCurrentUser();
  const { detail, diff } = loaderData;
  const [prefixOpen, setPrefixOpen] = useState(false);

  return (
    <>
      <Header
        crumb={
          <span className="muted small">
            <Link to={`/s/${detail.session.id}`}>{detail.session.name}</Link> · compare
          </span>
        }
      />
      <main className="page">
        <h2 style={{ marginBottom: 4 }}>
          <span className="mono">{diff.a}</span>
          <span className="muted"> … </span>
          <span className="mono">{diff.b}</span>
        </h2>
        <p className="muted small">
          {diff.shared_prefix.length} shared turn{diff.shared_prefix.length === 1 ? "" : "s"} ·{" "}
          {diff.only_a.length} only on {diff.a} · {diff.only_b.length} only on {diff.b}
        </p>

        <div className="panel" style={{ margin: "16px 0" }}>
          <button
            style={{ width: "100%", textAlign: "left", border: "none", background: "transparent", padding: "10px 14px" }}
            onClick={() => setPrefixOpen((v) => !v)}
            aria-expanded={prefixOpen}
          >
            {prefixOpen ? "▾" : "▸"} Shared prefix ({diff.shared_prefix.length} turns)
          </button>
          {prefixOpen ? (
            <div className="row-list">
              {diff.shared_prefix.map((t) => (
                <TurnRow key={t.turn_id} turn={t} sessionId={params.session} />
              ))}
            </div>
          ) : null}
        </div>

        <div className="compare-cols">
          <DivergentColumn
            title={diff.a}
            turns={diff.only_a}
            sessionId={params.session}
            empty={`No turns unique to ${diff.a}.`}
          />
          <DivergentColumn
            title={diff.b}
            turns={diff.only_b}
            sessionId={params.session}
            empty={`No turns unique to ${diff.b}.`}
          />
        </div>
      </main>
    </>
  );
}

function DivergentColumn({
  title,
  turns,
  sessionId,
  empty,
}: {
  title: string;
  turns: TurnSummary[];
  sessionId: string;
  empty: string;
}) {
  return (
    <div className="panel">
      <h3 className="mono" style={{ padding: "10px 14px", fontSize: "var(--fs-2)", color: "var(--amber)" }}>
        {title}
      </h3>
      <div className="row-list">
        {turns.length === 0 ? <div className="muted small">{empty}</div> : null}
        {turns.map((t) => (
          <TurnRow key={t.turn_id} turn={t} sessionId={sessionId} />
        ))}
      </div>
    </div>
  );
}

function TurnRow({ turn, sessionId }: { turn: TurnSummary; sessionId: string }) {
  return (
    <div>
      <Link className="mono small" to={`/s/${sessionId}/turn/${turn.turn_id}`}>
        {turn.turn_id.slice(1, 8)}
      </Link>
      <div style={{ minWidth: 0, flex: 1 }}>
        {turn.user_preview ? <div className="small">“{turn.user_preview.slice(0, 90)}”</div> : null}
        {turn.assistant_preview ? (
          <div className="small muted">{turn.assistant_preview.slice(0, 90)}</div>
        ) : null}
      </div>
      <span className="muted small">{turn.author_name}</span>
    </div>
  );
}
