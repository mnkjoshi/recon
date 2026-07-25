/**
 * Hexclave declarative configuration for Recon.
 *
 * Run development with:
 *   npx @hexclave/cli dev --config-file ./hexclave.config.ts -- npm run dev:all
 *
 * The CLI injects HEXCLAVE_PROJECT_ID and HEXCLAVE_SECRET_SERVER_KEY into the
 * wrapped process, so neither the engine server nor the web app needs manual
 * credential setup in development.
 *
 * Model: one Recon session == one Hexclave team. Collaborators are team
 * members. `driver` and `observer` are team-scoped RBAC permissions; `driver`
 * contains `observer`, the session creator gets `driver`, and anyone added to
 * the team gets `observer`. Every control action (send / pause / resume /
 * revert / prune) is enforced server-side against these permissions.
 */
export const config = {
  apps: {
    installed: {
      authentication: { enabled: true },
      teams: { enabled: true },
      analytics: {
        enabled: true,
        replays: {
          enabled: true,
          maskAllInputs: true,
        },
      },
      "deployments-alpha": { enabled: true },
    },
  },
  /**
   * Hexclave deployments (alpha): `npx @hexclave/cli deploy web` uploads the
   * service's source directory and builds it on Vercel.
   *
   * Only the web SPA deploys this way. The engine server is a long-lived
   * process (WebSockets, SQLite, per-session workspaces) and needs a
   * persistent host — run it wherever a Node daemon can live and point
   * VITE_API_BASE below at it.
   */
  "deployments-alpha": {
    services: {
      web: {
        type: "vercel",
        rootDirectory: "packages/web",
        installCommand: "npm install",
        buildCommand: "npm run build",
        // SPA mode: react-router build emits the static site here.
        outputDirectory: "build/client",
        env: {
          // Public engine-server URL (REST + WebSocket host). The engine is a
          // long-lived Node process; update this once it has a public home.
          VITE_API_BASE: { value: "https://recon-engine.example.com" },
          // Auto-injected from the Hexclave project at deploy time
          // (client-safe; baked into the SPA bundle).
          VITE_HEXCLAVE_PROJECT_ID: { type: "connection", value: "hexclave.projectId" },
        },
      },
    },
  },
  auth: {
    allowSignUp: true,
    otp: { allowSignIn: true },
    password: { allowSignIn: false },
    oauth: {
      providers: {
        google: { type: "google", allowSignIn: true },
      },
    },
  },
  teams: {
    // A platform session is a team; the client creates it when a user
    // creates a session.
    allowClientTeamCreation: true,
    createPersonalTeamOnSignUp: false,
  },
  rbac: {
    permissions: {
      observer: { scope: "team" },
      driver: {
        scope: "team",
        containedPermissionIds: { observer: true },
      },
    },
    defaultPermissions: {
      teamCreator: { driver: true },
      teamMember: { observer: true },
    },
  },
};

export default config;
