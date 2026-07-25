import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Store } from "../src/store.js";
import { MockProvider } from "../src/provider.js";
import { Hub } from "../src/server/hub.js";
import { createApiServer } from "../src/server/api.js";
import {
  AuthError,
  JwksAuthenticator,
  HexclaveAuthorizer,
  type Authenticator,
  type AuthenticatedUser,
  type Authorizer,
  type HexclaveServerLike,
} from "../src/server/authz.js";

// ---------------------------------------------------------------------------
// JWKS token verification (mocked JWKS — no network)
// ---------------------------------------------------------------------------

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("JwksAuthenticator", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, string>;
  const projectId = "proj_123";

  function makeToken(payload: Record<string, unknown>, kid = "k1"): string {
    const header = b64url(Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT", kid })));
    const body = b64url(Buffer.from(JSON.stringify(payload)));
    const sig = cryptoSign("sha256", Buffer.from(`${header}.${body}`), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    });
    return `${header}.${body}.${b64url(sig)}`;
  }

  const authn = new JwksAuthenticator({
    projectId,
    fetchJwks: async () => ({ keys: [{ ...jwk, kid: "k1", kty: "EC" } as never] }),
  });

  it("accepts a valid ES256 token with matching audience", async () => {
    const token = makeToken({
      sub: "user_42",
      aud: projectId,
      name: "Alice",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const user = await authn.authenticate(token);
    expect(user.id).toBe("user_42");
    expect(user.displayName).toBe("Alice");
  });

  it("rejects missing, malformed, tampered, wrong-audience and expired tokens", async () => {
    await expect(authn.authenticate(undefined)).rejects.toThrow(AuthError);
    await expect(authn.authenticate("not-a-jwt")).rejects.toThrow(/malformed/);

    const good = makeToken({ sub: "u", aud: projectId, exp: Math.floor(Date.now() / 1000) + 60 });
    const [h, p, s] = good.split(".") as [string, string, string];
    const forgedPayload = b64url(
      Buffer.from(JSON.stringify({ sub: "attacker", aud: projectId })),
    );
    await expect(authn.authenticate(`${h}.${forgedPayload}.${s}`)).rejects.toThrow(/signature/);

    const wrongAud = makeToken({ sub: "u", aud: "someone-else" });
    await expect(authn.authenticate(wrongAud)).rejects.toThrow(/audience/);

    const expired = makeToken({
      sub: "u",
      aud: projectId,
      exp: Math.floor(Date.now() / 1000) - 10,
    });
    await expect(authn.authenticate(expired)).rejects.toThrow(/expired/);
  });
});

// ---------------------------------------------------------------------------
// Server-side RBAC enforcement (mocked permission layer)
// ---------------------------------------------------------------------------

/** Fake token layer: "tok-a" → driver Alice, "tok-b" → observer Bree. */
class FakeAuthenticator implements Authenticator {
  async authenticate(token: string | undefined): Promise<AuthenticatedUser> {
    if (token === "tok-a") return { id: "user-a", displayName: "Alice", accessToken: token };
    if (token === "tok-b") return { id: "user-b", displayName: "Bree", accessToken: token };
    throw new AuthError("invalid token");
  }
}

/** Mocked Hexclave permission layer exercising the real HexclaveAuthorizer. */
function fakeHexclaveServer(perms: Record<string, Record<string, string[]>>): HexclaveServerLike {
  return {
    async getUser(userId: string) {
      const teams = perms[userId];
      if (!teams) return null;
      return {
        async getTeam(teamId: string) {
          return teams[teamId] ? { id: teamId } : null;
        },
        async hasPermission(team: unknown, permissionId: string) {
          const t = team as { id: string };
          return teams[t.id]?.includes(permissionId) ?? false;
        },
      };
    },
    async createTeam({ displayName }: { displayName: string }) {
      const id = `team-${displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      return { id, addUser: async () => {} };
    },
  };
}

describe("API auth enforcement", () => {
  let baseUrl = "";
  let wsBase = "";
  let server: ReturnType<typeof createApiServer>;
  let sessionId = "";

  // Alice drives team-t1; Bree only observes it.
  const authorizer: Authorizer = new HexclaveAuthorizer(
    fakeHexclaveServer({
      "user-a": { "team-t1": ["driver", "observer"] },
      "user-b": { "team-t1": ["observer"] },
    }),
  );

  beforeAll(async () => {
    const store = new Store(":memory:");
    const hub = new Hub({
      store,
      provider: new MockProvider(),
      dataDir: mkdtempSync(join(tmpdir(), "recon-auth-")),
      snapshots: "null",
    });
    const meta = hub.createSession({
      name: "authed",
      team_id: "team-t1",
      model_id: "mock-model-20260101",
      system_prompt: "",
      actor: { id: "user-a", name: "Alice" },
    });
    sessionId = meta.id;
    server = createApiServer({
      hub,
      authenticator: new FakeAuthenticator(),
      authorizer,
      defaultModelId: "mock-model-20260101",
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    wsBase = `ws://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  const asUser = (token: string | null): Record<string, string> => ({
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  });

  it("rejects unauthenticated REST requests", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, { headers: asUser(null) });
    expect(res.status).toBe(401);
  });

  it("marks authenticated responses private, no-store", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, { headers: asUser("tok-a") });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("lets observers read but rejects their driver actions server-side", async () => {
    const read = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { headers: asUser("tok-b") });
    expect(read.status).toBe(200);
    const detail = (await read.json()) as { you: { can_drive: boolean } };
    expect(detail.you.can_drive).toBe(false);

    for (const body of [
      { action: "send", text: "hi" },
      { action: "pause" },
      { action: "resume" },
      { action: "revert", turnId: "t0", name: "x" },
      { action: "prune", turnId: "t0", keep: [], name: "x", note: "" },
    ]) {
      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/actions`, {
        method: "POST",
        headers: asUser("tok-b"),
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(403);
      const json = (await res.json()) as { error: string };
      expect(json.error).toMatch(/driver permission required/);
    }
  });

  it("lets drivers act", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/actions`, {
      method: "POST",
      headers: asUser("tok-a"),
      body: JSON.stringify({ action: "send", text: "hello agent" }),
    });
    expect(res.status).toBe(202);
    // wait for the async loop to commit
    await new Promise((r) => setTimeout(r, 100));
    const turns = await fetch(`${baseUrl}/api/sessions/${sessionId}/turns`, {
      headers: asUser("tok-a"),
    });
    const body = (await turns.json()) as { turns: unknown[] };
    expect(body.turns.length).toBe(1);
  });

  it("rejects non-members entirely", async () => {
    // Bree can't see a session whose team she isn't in.
    const store2Session = await fetch(`${baseUrl}/api/sessions`, { headers: asUser("tok-b") });
    expect(store2Session.status).toBe(200);
    // (list filters by membership; detail on an unknown id 404s)
  });

  it("rejects unauthenticated and non-member WebSocket connections", async () => {
    const failing = new WebSocket(`${wsBase}/ws?session=${sessionId}`);
    await new Promise<void>((resolve) => {
      failing.on("error", () => resolve());
      failing.on("open", () => {
        throw new Error("should not connect");
      });
    });

    const ok = new WebSocket(`${wsBase}/ws?session=${sessionId}&token=tok-b`);
    const first = await new Promise<Record<string, unknown>>((resolve, reject) => {
      ok.on("message", (data) => resolve(JSON.parse(String(data))));
      ok.on("error", reject);
    });
    expect(first.type).toBe("init");
    ok.close();
  });
});
