import { createPublicKey, verify as cryptoVerify } from "node:crypto";

/**
 * Authentication + authorization boundary.
 *
 * Production: access tokens are verified against Hexclave's JWKS endpoint
 * (ES256, audience = project id, sub = user id) for the hot path; team
 * membership and the team-scoped driver/observer RBAC permissions are
 * checked through Hexclave's server API using the secret server key.
 *
 * Everything is behind interfaces so tests inject fakes and never touch the
 * network. There is no parallel user table anywhere — attribution uses
 * Hexclave user ids and display names throughout.
 */

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403 = 401,
  ) {
    super(message);
  }
}

export interface AuthenticatedUser {
  id: string;
  displayName: string;
  accessToken: string;
}

export interface Authenticator {
  /** Verify a raw access token; throws AuthError when invalid. */
  authenticate(token: string | undefined): Promise<AuthenticatedUser>;
}

export interface Authorizer {
  /** Read + compose access (observer). */
  canObserve(user: AuthenticatedUser, teamId: string): Promise<boolean>;
  /** Control actions: send / pause / resume / revert / prune (driver). */
  canDrive(user: AuthenticatedUser, teamId: string): Promise<boolean>;
  /** Create the Hexclave team backing a new session; returns team id. */
  createSessionTeam(user: AuthenticatedUser, displayName: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// JWKS-based token verification (ES256)
// ---------------------------------------------------------------------------

interface Jwk {
  kid?: string;
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  alg?: string;
}

function b64urlToBuffer(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export class JwksAuthenticator implements Authenticator {
  private keys: Jwk[] = [];
  private fetchedAt = 0;

  constructor(
    private readonly opts: {
      projectId: string;
      jwksUrl?: string;
      apiBase?: string;
      /** injectable for tests */
      fetchJwks?: () => Promise<{ keys: Jwk[] }>;
      cacheTtlMs?: number;
    },
  ) {}

  private jwksUrl(): string {
    return (
      this.opts.jwksUrl ??
      `${this.opts.apiBase ?? "https://api.hexclave.com"}/api/v1/projects/${this.opts.projectId}/.well-known/jwks.json`
    );
  }

  private async loadKeys(force = false): Promise<Jwk[]> {
    const ttl = this.opts.cacheTtlMs ?? 5 * 60_000;
    if (!force && this.keys.length > 0 && Date.now() - this.fetchedAt < ttl) return this.keys;
    const jwks = this.opts.fetchJwks
      ? await this.opts.fetchJwks()
      : ((await (await fetch(this.jwksUrl())).json()) as { keys: Jwk[] });
    this.keys = jwks.keys ?? [];
    this.fetchedAt = Date.now();
    return this.keys;
  }

  async authenticate(token: string | undefined): Promise<AuthenticatedUser> {
    if (!token) throw new AuthError("missing access token");
    const parts = token.split(".");
    if (parts.length !== 3) throw new AuthError("malformed token");
    const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

    let header: { alg?: string; kid?: string };
    let payload: Record<string, unknown>;
    try {
      header = JSON.parse(b64urlToBuffer(headerB64).toString("utf8"));
      payload = JSON.parse(b64urlToBuffer(payloadB64).toString("utf8"));
    } catch {
      throw new AuthError("malformed token");
    }
    if (header.alg !== "ES256") throw new AuthError(`unsupported alg: ${header.alg}`);

    let keys = await this.loadKeys();
    let jwk = keys.find((k) => !header.kid || k.kid === header.kid);
    if (!jwk) {
      keys = await this.loadKeys(true); // key rotation: refetch once
      jwk = keys.find((k) => !header.kid || k.kid === header.kid);
    }
    if (!jwk) throw new AuthError("no matching signing key");

    const publicKey = createPublicKey({ key: jwk as never, format: "jwk" });
    const ok = cryptoVerify(
      "sha256",
      Buffer.from(`${headerB64}.${payloadB64}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      b64urlToBuffer(sigB64),
    );
    if (!ok) throw new AuthError("invalid signature");

    const aud = payload.aud;
    const audOk = Array.isArray(aud)
      ? aud.includes(this.opts.projectId)
      : aud === this.opts.projectId;
    if (!audOk) throw new AuthError("token audience mismatch");
    if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) {
      throw new AuthError("token expired");
    }
    const sub = payload.sub;
    if (typeof sub !== "string" || !sub) throw new AuthError("token missing sub");

    const displayName =
      (typeof payload.name === "string" && payload.name) ||
      (typeof payload.display_name === "string" && payload.display_name) ||
      `user ${sub.slice(0, 8)}`;
    return { id: sub, displayName, accessToken: token };
  }
}

// ---------------------------------------------------------------------------
// Hexclave-backed authorizer (@hexclave/js server app)
// ---------------------------------------------------------------------------

/**
 * Narrow view of the @hexclave/js surface we use, so tests can fake it and a
 * minor SDK shape change stays contained here.
 */
export interface HexclaveServerLike {
  getUser(userId: string): Promise<HexclaveServerUserLike | null>;
  createTeam(opts: { displayName: string }): Promise<{ id: string; addUser(userId: string): Promise<void> }>;
}
export interface HexclaveServerUserLike {
  getTeam(teamId: string): Promise<unknown | null>;
  hasPermission(team: unknown, permissionId: string): Promise<boolean>;
  grantPermission?(team: unknown, permissionId: string): Promise<void>;
}

export class HexclaveAuthorizer implements Authorizer {
  constructor(private readonly server: HexclaveServerLike) {}

  private async permission(user: AuthenticatedUser, teamId: string, id: string): Promise<boolean> {
    const serverUser = await this.server.getUser(user.id);
    if (!serverUser) return false;
    const team = await serverUser.getTeam(teamId);
    if (!team) return false;
    return serverUser.hasPermission(team, id);
  }

  canObserve(user: AuthenticatedUser, teamId: string): Promise<boolean> {
    return this.permission(user, teamId, "observer");
  }

  canDrive(user: AuthenticatedUser, teamId: string): Promise<boolean> {
    return this.permission(user, teamId, "driver");
  }

  async createSessionTeam(user: AuthenticatedUser, displayName: string): Promise<string> {
    const team = await this.server.createTeam({ displayName });
    await team.addUser(user.id);
    // Session creator drives. Config also sets teamCreator → driver, but the
    // team was created server-side, so grant explicitly for belt & braces.
    const serverUser = await this.server.getUser(user.id);
    const teamObj = serverUser ? await serverUser.getTeam(team.id) : null;
    if (serverUser?.grantPermission && teamObj) {
      await serverUser.grantPermission(teamObj, "driver");
    }
    return team.id;
  }
}

/** Builds the production authorizer from @hexclave/js. Import is dynamic so
 * tests and dev mode never load the SDK. */
export async function createHexclaveAuthorizer(): Promise<Authorizer> {
  const mod = (await import("@hexclave/js")) as unknown as {
    HexclaveServerApp: new (opts: unknown) => HexclaveServerLike;
  };
  const server = new mod.HexclaveServerApp({
    tokenStore: null,
    urls: { default: { type: "hosted" } },
  });
  return new HexclaveAuthorizer(server);
}

// ---------------------------------------------------------------------------
// Insecure dev fallback (no Hexclave credentials present)
// ---------------------------------------------------------------------------

/**
 * Development-only: accepts tokens of the form `dev:<userId>:<displayName>`
 * and treats every user as driver of everything. Never used when
 * HEXCLAVE_PROJECT_ID / HEXCLAVE_SECRET_SERVER_KEY are configured.
 */
export class DevAuthenticator implements Authenticator {
  async authenticate(token: string | undefined): Promise<AuthenticatedUser> {
    if (!token || !token.startsWith("dev:")) {
      throw new AuthError("missing or invalid dev token (expected dev:<id>:<name>)");
    }
    const [, id, name] = token.split(":");
    if (!id) throw new AuthError("dev token missing user id");
    return { id, displayName: name || id, accessToken: token };
  }
}

export class DevAuthorizer implements Authorizer {
  private counter = 0;
  async canObserve(): Promise<boolean> {
    return true;
  }
  async canDrive(): Promise<boolean> {
    return true;
  }
  async createSessionTeam(): Promise<string> {
    this.counter += 1;
    return `dev-team-${this.counter}`;
  }
}

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1] : header;
}
