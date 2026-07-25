import { HexclaveClientApp, useUser, type StackClientApp } from "@hexclave/react";

/**
 * Hexclave supplies everything user-shaped: identity, session membership
 * (teams), roles (team-scoped RBAC) and product analytics. No parallel user
 * store exists anywhere in Recon.
 *
 * When the app runs under `npx @hexclave/cli dev`, HEXCLAVE_PROJECT_ID (and
 * the publishable client key) are injected and the real hosted-auth flow is
 * active. Without them we fall back to an explicit, clearly-labeled insecure
 * dev identity (matching the engine server's DevAuthenticator) so the
 * two-user demo can run offline.
 */

const env = import.meta.env as Record<string, string | undefined>;
const projectId = env.HEXCLAVE_PROJECT_ID ?? env.VITE_HEXCLAVE_PROJECT_ID;
const publishableClientKey =
  env.HEXCLAVE_PUBLISHABLE_CLIENT_KEY ?? env.VITE_HEXCLAVE_PUBLISHABLE_CLIENT_KEY;

export const hexclaveConfigured = Boolean(projectId);

export const hexclaveClientApp: StackClientApp<true, string> | null = hexclaveConfigured
  ? new HexclaveClientApp<"cookie", true, string>({
      projectId: projectId!,
      publishableClientKey,
      tokenStore: "cookie",
      urls: { default: { type: "hosted" } },
    })
  : null;

// ---------------------------------------------------------------- dev mode

export interface DevUser {
  id: string;
  name: string;
}

const DEV_KEY = "recon-dev-user";

export function getDevUser(): DevUser {
  if (typeof localStorage === "undefined") return { id: "dev", name: "Dev" };
  const raw = localStorage.getItem(DEV_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as DevUser;
    } catch {
      /* fallthrough */
    }
  }
  const user = { id: `u_${Math.random().toString(36).slice(2, 8)}`, name: "Anonymous" };
  localStorage.setItem(DEV_KEY, JSON.stringify(user));
  return user;
}

export function setDevUser(user: DevUser): void {
  localStorage.setItem(DEV_KEY, JSON.stringify(user));
}

// ------------------------------------------------------------------ tokens

/**
 * Access token for REST calls and the WebSocket handshake. In Hexclave mode
 * this is the current session's access token (verified server-side against
 * the project JWKS); in dev mode it's the `dev:` token the DevAuthenticator
 * accepts.
 */
export async function getAccessToken(): Promise<string | null> {
  if (!hexclaveConfigured) {
    const dev = getDevUser();
    return `dev:${dev.id}:${dev.name}`;
  }
  const user = await hexclaveClientApp!.getUser();
  if (!user) return null;
  const { accessToken } = await user.currentSession.getTokens();
  return accessToken;
}

export async function getAuthorizationHeader(): Promise<string | null> {
  const token = await getAccessToken();
  return token ? `Bearer ${token}` : null;
}

// ------------------------------------------------------------------- hooks

export interface CurrentUser {
  id: string;
  displayName: string;
}

/**
 * Current user for display purposes. In Hexclave mode this suspends and
 * redirects to the hosted sign-in page when unauthenticated (the route
 * guard); dev mode returns the local dev identity.
 */
export function useCurrentUser(): CurrentUser {
  if (hexclaveConfigured) {
    // Constant condition for the app's lifetime, so the hook order is stable.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const user = useUser({ or: "redirect" });
    return {
      id: user.id,
      displayName: user.displayName ?? user.primaryEmail ?? `user ${user.id.slice(0, 8)}`,
    };
  }
  const dev = getDevUser();
  return { id: dev.id, displayName: dev.name };
}
