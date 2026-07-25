import { useState } from "react";
import { Link, useNavigate, useRevalidator } from "react-router";
import { createSession, listSessions } from "../lib/api";
import { useCurrentUser } from "../lib/auth";
import { Header } from "../components/Header";
import { useToast } from "../components/Toasts";
import type { Route } from "./+types/home";

export async function clientLoader(_args: Route.ClientLoaderArgs) {
  return listSessions();
}

export default function Home({ loaderData }: Route.ComponentProps) {
  useCurrentUser(); // route guard: redirects to hosted sign-in when unauthenticated
  const { sessions } = loaderData;
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const toast = useToast();

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const { session } = await createSession({ name: name.trim() });
      toast(`Created session ${session.name}`);
      navigate(`/s/${session.id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not create the session. Try again.", "error");
      revalidator.revalidate();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Header />
      <main className="page">
        <div style={{ display: "flex", alignItems: "baseline", gap: 16, marginBottom: 20 }}>
          <h1>Sessions</h1>
          <span className="spacer" style={{ flex: 1 }} />
          <form onSubmit={onCreate} style={{ display: "flex", gap: 8 }}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="New session name"
              aria-label="New session name"
            />
            <button type="submit" className="amber" disabled={busy || !name.trim()}>
              Start a session
            </button>
          </form>
        </div>

        {sessions.length === 0 ? (
          <div className="panel empty-state">
            <h3>Start a session to begin.</h3>
            <p className="muted">
              A session is a shared agent with a versioned context — every turn is a checkpoint
              anyone can revert to.
            </p>
          </div>
        ) : (
          <div className="panel row-list">
            {sessions.map((s) => (
              <Link key={s.id} to={`/s/${s.id}`} style={{ textDecoration: "none" }}>
                <span
                  style={{
                    fontFamily: "var(--font-display)",
                    fontWeight: 600,
                    fontSize: "var(--fs-3)",
                  }}
                >
                  {s.name}
                </span>
                <span className="badge amber">
                  {s.branch_count} branch{s.branch_count === 1 ? "" : "es"}
                </span>
                {s.online > 0 ? <span className="badge">{s.online} online</span> : null}
                <span className="spacer" style={{ flex: 1 }} />
                <span className="muted small">
                  last activity {new Date(s.last_activity).toLocaleString()}
                </span>
              </Link>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
