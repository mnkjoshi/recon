import { Link, useNavigate, useRevalidator } from "react-router";
import { getSession, sessionAction } from "../lib/api";
import { useCurrentUser } from "../lib/auth";
import { Header } from "../components/Header";
import { useToast } from "../components/Toasts";
import type { Route } from "./+types/branches";

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  return getSession(params.session);
}

export default function Branches({ loaderData, params }: Route.ComponentProps) {
  useCurrentUser();
  const { session, branches, you } = loaderData;
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const toast = useToast();

  async function checkout(name: string) {
    try {
      const result = await sessionAction(params.session, { action: "checkout", name });
      toast(`Checked out ${name}`);
      if (result.warning) toast(result.warning);
      revalidator.revalidate();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Checkout failed. Try again.", "error");
    }
  }

  return (
    <>
      <Header
        crumb={
          <span className="muted small">
            <Link to={`/s/${session.id}`}>{session.name}</Link> · branches
          </span>
        }
      />
      <main className="page">
        <h2 style={{ marginBottom: 16 }}>Branches</h2>
        <div className="panel row-list">
          {branches.map((b) => {
            const current = b.name === session.current_branch;
            return (
              <div key={b.name}>
                <span className="mono" style={{ fontWeight: current ? 600 : 400 }}>
                  {b.name}
                </span>
                {current ? <span className="badge amber">current</span> : null}
                <span className={`badge ${b.kind === "pruned" ? "pruned" : b.kind === "fork" ? "amber" : ""}`}>
                  {b.kind === "root" ? "root" : b.kind === "fork" ? "forked" : "pruned"}
                </span>
                {b.head_turn_id ? (
                  <Link className="mono muted small" to={`/s/${session.id}/turn/${b.head_turn_id}`}>
                    head {b.head_turn_id.slice(1, 8)}
                  </Link>
                ) : (
                  <span className="muted small">no turns</span>
                )}
                <span className="muted small">
                  +{b.ahead} / −{b.behind} vs {session.current_branch}
                </span>
                {b.prune_manifest ? (
                  <span className="muted small" title={b.prune_manifest.note}>
                    kept {b.prune_manifest.kept.length}, cut {b.prune_manifest.cut.length}
                  </span>
                ) : null}
                <span className="spacer" style={{ flex: 1 }} />
                <button
                  className="small"
                  onClick={() =>
                    navigate(
                      `/s/${session.id}/compare/${encodeURIComponent(session.current_branch)}...${encodeURIComponent(b.name)}`,
                    )
                  }
                >
                  Compare
                </button>
                {!current ? (
                  <button
                    className="amber small"
                    disabled={!you.can_drive}
                    onClick={() => void checkout(b.name)}
                  >
                    Checkout
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </main>
    </>
  );
}
