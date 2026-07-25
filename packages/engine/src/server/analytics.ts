/**
 * Hexclave analytics passthrough.
 *
 * Enabling the analytics app auto-captures events, clickmaps and session
 * replays through the client SDK — no wiring here. This module only covers
 * the server-side *read* path: running read-only ClickHouse SQL against the
 * project's analytics dataset to power the internal usage view.
 *
 * Note: Hexclave does not expose a custom-event ingest API, so Recon's
 * domain actions (session_created / turn_committed / fork / revert / prune /
 * pause / resume) are recorded in the engine store's `domain_events` table
 * and surfaced alongside these queries.
 */
export function createHexclaveAnalyticsQuery(opts: {
  projectId: string;
  secretServerKey: string;
  apiBase?: string;
}): (sql: string) => Promise<unknown> {
  const base = opts.apiBase ?? "https://api.hexclave.com";
  return async (sql: string) => {
    const res = await fetch(`${base}/api/v1/analytics/query`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hexclave-access-type": "server",
        "x-hexclave-project-id": opts.projectId,
        "x-hexclave-secret-server-key": opts.secretServerKey,
      },
      body: JSON.stringify({ query: sql }),
    });
    if (!res.ok) {
      throw new Error(`analytics query failed (${res.status}): ${await res.text()}`);
    }
    return res.json();
  };
}
