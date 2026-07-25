import { getAccessToken, getAuthorizationHeader } from "./auth";
import type {
  ActivityEntry,
  BranchRef,
  CompareResult,
  Message,
  SessionDetail,
  SessionListItem,
  SessionMeta,
  TurnRecord,
  TurnSummary,
} from "./types";

const API_BASE =
  (import.meta.env as Record<string, string | undefined>).VITE_API_BASE ?? "http://localhost:8787";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const authHeader = await getAuthorizationHeader();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(authHeader ? { authorization: authHeader } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(String(body.error ?? `request failed (${res.status})`), res.status);
  }
  return body as T;
}

export const listSessions = () => api<{ sessions: SessionListItem[] }>("/api/sessions");

export const createSession = (input: { name: string; model_id?: string; system_prompt?: string }) =>
  api<{ session: SessionMeta }>("/api/sessions", { method: "POST", body: JSON.stringify(input) });

export const getSession = (id: string) => api<SessionDetail>(`/api/sessions/${id}`);

export const getTurns = (id: string, branch?: string) =>
  api<{ branch: string; turns: TurnSummary[] }>(
    `/api/sessions/${id}/turns${branch ? `?branch=${encodeURIComponent(branch)}` : ""}`,
  );

export type TurnWithDelta = TurnSummary & { delta: Message[] };

export const getTurnsFull = (id: string, branch?: string) =>
  api<{ branch: string; turns: TurnWithDelta[] }>(
    `/api/sessions/${id}/turns?full=1${branch ? `&branch=${encodeURIComponent(branch)}` : ""}`,
  );

export const getTurn = (id: string, turnId: string) =>
  api<{ turn: TurnRecord; delta: Message[] }>(`/api/sessions/${id}/turn/${turnId}`);

export const getActivity = (id: string) =>
  api<{ activity: ActivityEntry[] }>(`/api/sessions/${id}/activity`);

export const compareBranches = (id: string, a: string, b: string) =>
  api<CompareResult>(
    `/api/sessions/${id}/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`,
  );

export type SessionAction =
  | { action: "send"; branch?: string; text: string }
  | { action: "pause"; branch?: string }
  | { action: "resume"; branch?: string }
  | { action: "hard_stop"; branch?: string }
  | { action: "fork"; turnId: string; name: string }
  | { action: "checkout"; name: string }
  | { action: "revert"; turnId: string; name: string }
  | { action: "prune"; turnId: string; keep: string[]; name: string; note: string };

export const sessionAction = (id: string, body: SessionAction) =>
  api<{ branch?: BranchRef; warning?: string | null; status?: string; started?: boolean }>(
    `/api/sessions/${id}/actions`,
    { method: "POST", body: JSON.stringify(body) },
  );

export const getUsage = () =>
  api<{ domain_events: { event: string; count: number }[] }>("/api/usage");

export async function sessionWsUrl(sessionId: string): Promise<string> {
  const token = await getAccessToken();
  const base = API_BASE.replace(/^http/, "ws");
  return `${base}/ws?session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token ?? "")}`;
}
