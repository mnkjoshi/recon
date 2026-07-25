import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { getSession, getTurns, sessionAction } from "../lib/api";
import { useCurrentUser } from "../lib/auth";
import { Header } from "../components/Header";
import { useToast } from "../components/Toasts";
import type { Route } from "./+types/prune";

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  const detail = await getSession(params.session);
  // The prune chain is the ancestry of the prune point; find the branch whose
  // log contains it, preferring the current branch.
  const current = await getTurns(params.session, detail.session.current_branch);
  let turns = current.turns;
  if (!turns.some((t) => t.turn_id === params.turnId)) {
    for (const b of detail.branches) {
      const log = await getTurns(params.session, b.name);
      if (log.turns.some((t) => t.turn_id === params.turnId)) {
        turns = log.turns;
        break;
      }
    }
  }
  const idx = turns.findIndex((t) => t.turn_id === params.turnId);
  const chain = idx >= 0 ? turns.slice(0, idx + 1) : [];
  return { detail, chain };
}

/** ~4 chars per token: a live, honest-enough tally for curation decisions. */
const CHARS_PER_TOKEN = 4;

export default function PruneWorkbench({ loaderData, params }: Route.ComponentProps) {
  useCurrentUser();
  const { detail, chain } = loaderData;
  const [keep, setKeep] = useState<Set<string>>(() => new Set(chain.map((t) => t.turn_id)));
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();

  const tally = useMemo(() => {
    let keptChars = 0;
    let totalChars = 0;
    for (const t of chain) {
      totalChars += t.delta_chars;
      if (keep.has(t.turn_id)) keptChars += t.delta_chars;
    }
    return {
      kept: Math.round(keptChars / CHARS_PER_TOKEN),
      total: Math.round(totalChars / CHARS_PER_TOKEN),
    };
  }, [chain, keep]);

  if (chain.length === 0) {
    return (
      <>
        <Header />
        <main className="page empty-state">
          <p>Turn not found on any branch of this session.</p>
          <Link to={`/s/${params.session}`}>Back to session</Link>
        </main>
      </>
    );
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !note.trim() || busy) return;
    setBusy(true);
    try {
      const result = await sessionAction(params.session, {
        action: "prune",
        turnId: params.turnId,
        keep: [...keep],
        name: name.trim(),
        note: note.trim(),
      });
      toast(`Pruned to ${name.trim()}`);
      if (result.warning) toast(result.warning);
      navigate(`/s/${params.session}/branches`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Prune failed. Try again.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Header
        crumb={
          <span className="muted small">
            <Link to={`/s/${detail.session.id}`}>{detail.session.name}</Link> · prune workbench
          </span>
        }
      />
      <main className="page">
        <h2>Prune from {params.turnId.slice(1, 9)}</h2>
        <p className="muted" style={{ maxWidth: 640 }}>
          Uncheck turns that are irrelevant to the current line of development. The kept turns
          become the curated context of a new branch. The agent never saw this exact context
          before, so the pruned prefix won’t reuse the provider’s prompt cache.
        </p>

        <div className="panel row-list" style={{ margin: "16px 0" }}>
          {chain.map((t) => (
            <label key={t.turn_id} style={{ cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={keep.has(t.turn_id)}
                onChange={(e) => {
                  setKeep((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(t.turn_id);
                    else next.delete(t.turn_id);
                    return next;
                  });
                }}
              />
              <span className="mono small">{t.turn_id.slice(1, 8)}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                {t.user_preview ? <div className="small">“{t.user_preview.slice(0, 100)}”</div> : null}
                {t.assistant_preview ? (
                  <div className="small muted">{t.assistant_preview.slice(0, 100)}</div>
                ) : null}
              </div>
              <span className="muted small">~{Math.round(t.delta_chars / CHARS_PER_TOKEN)} tok</span>
            </label>
          ))}
        </div>

        <div className="panel" style={{ padding: 14, maxWidth: 640 }}>
          <p style={{ marginTop: 0 }}>
            Curated context: <strong style={{ color: "var(--amber)" }}>~{tally.kept} tokens</strong>{" "}
            <span className="muted">of ~{tally.total} original</span>
          </p>
          <form onSubmit={onCreate} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="New branch name (required)"
              aria-label="New branch name"
              required
            />
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why are these turns being cut? (required note, recorded in provenance)"
              aria-label="Prune note"
              required
              rows={2}
            />
            <div>
              <button
                className="amber"
                type="submit"
                disabled={busy || !name.trim() || !note.trim() || keep.size === 0 || !detail.you.can_drive}
              >
                Create pruned branch
              </button>
            </div>
          </form>
        </div>
      </main>
    </>
  );
}
