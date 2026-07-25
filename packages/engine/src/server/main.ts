import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../store.js";
import { AnthropicProvider, MockProvider } from "../provider.js";
import { Hub } from "./hub.js";
import { createApiServer } from "./api.js";
import {
  createHexclaveAuthorizer,
  DevAuthenticator,
  DevAuthorizer,
  JwksAuthenticator,
  type Authenticator,
  type Authorizer,
} from "./authz.js";
import { createHexclaveAnalyticsQuery } from "./analytics.js";

/**
 * Server bootstrap. Local-first single-server deployment: SQLite + blob store
 * + per-session workspaces under DATA_DIR; external services are limited to
 * the model API and Hexclave.
 *
 * Run under the Hexclave CLI so credentials are injected:
 *   npx @hexclave/cli dev --config-file ./hexclave.config.ts -- npm run dev:engine
 */
async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8787);
  const dataDir = process.env.DATA_DIR ?? join(process.cwd(), "data");
  mkdirSync(dataDir, { recursive: true });

  const store = new Store(join(dataDir, "recon.db"));

  // Determinism pinning: replayed history is stored verbatim, and fresh
  // generations should target a pinned model. Prefer a dated snapshot id
  // where the provider publishes one.
  const defaultModelId = process.env.RECON_MODEL_ID ?? "claude-opus-5";

  const provider = process.env.RECON_MOCK_PROVIDER
    ? new MockProvider()
    : new AnthropicProvider({ strictPinning: process.env.RECON_STRICT_PINNING === "1" });

  const projectId = process.env.HEXCLAVE_PROJECT_ID;
  const secretServerKey = process.env.HEXCLAVE_SECRET_SERVER_KEY;

  let authenticator: Authenticator;
  let authorizer: Authorizer;
  let queryAnalytics: ((sql: string) => Promise<unknown>) | undefined;
  if (projectId && secretServerKey) {
    authenticator = new JwksAuthenticator({ projectId });
    authorizer = await createHexclaveAuthorizer();
    queryAnalytics = createHexclaveAnalyticsQuery({ projectId, secretServerKey });
  } else {
    console.warn(
      "[recon] HEXCLAVE_PROJECT_ID / HEXCLAVE_SECRET_SERVER_KEY not set — " +
        "running with INSECURE dev auth (tokens: dev:<id>:<name>). " +
        "Start via `npx @hexclave/cli dev -- ...` for real auth.",
    );
    authenticator = new DevAuthenticator();
    authorizer = new DevAuthorizer();
  }

  const hub = new Hub({
    store,
    provider,
    dataDir,
    snapshots: process.env.RECON_SNAPSHOTS === "null" ? "null" : "git",
  });

  const server = createApiServer({
    hub,
    authenticator,
    authorizer,
    defaultModelId,
    defaultSystemPrompt:
      process.env.RECON_SYSTEM_PROMPT ??
      "You are a collaborative coding agent. Use the workspace tools to build what the team asks for.",
    queryAnalytics,
  });

  server.listen(port, () => {
    console.log(`[recon] engine server listening on http://localhost:${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
