import type { Api } from "@/lib/redteam/controller";
import { voiceMessage } from "@/lib/audio/messages";

/** The browser's side of the RedTeam API. Every call goes to our own origin. */

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => null)) as (T & { error?: { message?: string; code?: string } }) | null;
  if (!res.ok || !json) throw new Error(json?.error?.message ?? "That did not go through.");
  return json;
}

/** Mint a Voice Agent token from our own origin. The permanent key never comes with it. */
export async function mintToken(): Promise<string> {
  let res: Response;
  try {
    res = await fetch("/api/voice-agent/token", { cache: "no-store" });
  } catch {
    throw new Error(voiceMessage("NETWORK_DOWN"));
  }
  const body = (await res.json().catch(() => null)) as { token?: string; error?: { code?: string } } | null;
  if (!res.ok || typeof body?.token !== "string") throw new Error(voiceMessage(body?.error?.code ?? "NO_API_KEY"));
  return body.token;
}

export const httpApi: Api = {
  token: mintToken,
  tool: (sessionId, name, args, callId) => post("/api/redteam/tool", { sessionId, name, callId, arguments: args }),
  turn: (sessionId, event, text) => post("/api/redteam/turn", { sessionId, event, ...(text ? { text } : {}) }),
  typed: (sessionId, body) => post("/api/redteam/typed", { sessionId, ...body }),
  end: (sessionId) => post("/api/redteam/end", { sessionId }),
};

export async function createReview(input: { mode: string; sample: boolean; title?: string; text?: string }) {
  return post<{ session: import("@/lib/redteam/controller").SessionView; voice: import("@/lib/redteam/controller").VoiceConfig }>("/api/redteam/session", input);
}

export async function loadReview(id: string) {
  const res = await fetch(`/api/redteam/session/${encodeURIComponent(id)}`, { cache: "no-store" });
  if (!res.ok) return null;
  return (await res.json()) as { session: import("@/lib/redteam/controller").SessionView; voice: import("@/lib/redteam/controller").VoiceConfig };
}
