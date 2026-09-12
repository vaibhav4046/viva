/*
 * bridge.js — the only thing in this extension that talks to VIVA.
 *
 * It is injected into a VIVA tab, so every request it makes is same-origin:
 * the student's own `viva_did` cookie goes with it, exactly as if they had
 * clicked in the app. That is the whole identity story. The extension holds no
 * token, no key and no credential of any kind, and a page on another site
 * never sees a VIVA response — the service worker relays only what it asked
 * for.
 *
 * The MCP pairing flow (src/lib/mcp/auth.ts) solves the same problem for
 * assistants, and reaches the product the same way — as a client of these very
 * routes, adding a cookie rebuilt from a verified token. The extension cannot
 * use one of its keys yet because only the server can turn a key back into a
 * cookie and `resolveIdentity` has no bearer path. The day it grows one, this
 * file is what changes: the same two fetches move to the service worker with
 * an Authorization header and the tab stops being needed. Nothing else here
 * depends on the transport. See extension/README.md, "Converging with MCP
 * pairing".
 */

if (!window.__vivaBridge) {
  window.__vivaBridge = true;

  /*
   * Progress is written to storage, not held in a message channel: a subject
   * build outlives both the popup and the service worker.
   *
   * One writer, one in-memory copy, and never a read-modify-write. The first
   * version read the record back before each patch, and NDJSON lines arrive
   * faster than a storage round-trip, so concurrent get/set pairs clobbered
   * each other and the finished record carried an empty `lines` — the popup
   * sat silent through the whole build, which is the one thing the streaming
   * exists to prevent.
   */
  let rec = {};
  const write = (patch) => {
    rec = Object.assign({}, rec, patch, { at: Date.now() });
    return chrome.storage.local.set({ capture: rec });
  };

  /** Read an NDJSON body line by line, handing each parsed object to `onLine`. */
  async function readNdjson(res, onLine) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n");
      buf = parts.pop() || "";
      for (const part of parts) {
        if (!part.trim()) continue;
        try { onLine(JSON.parse(part)); } catch { /* a half-written line is not an error */ }
      }
    }
    if (buf.trim()) { try { onLine(JSON.parse(buf)); } catch { /* ditto */ } }
  }

  async function createSubject({ title, text, url, chars, shape, trimmed }) {
    const lines = [];
    await write({ status: "running", title, url, chars, shape, trimmed, lines, subject: null, error: null });
    const push = (line) => { lines.push(line); return write({ lines: lines.slice(-8) }); };
    try {
      const res = await fetch("/api/subjects/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "paste", title, text: url ? `Source: ${url}\n\n${text}` : text }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null);
        await write({ status: "error", error: body?.error || { code: String(res.status), message: "VIVA would not take that page." } });
        return;
      }
      let finished = false;
      await readNdjson(res, (msg) => {
        if (msg.line) void push(msg.line);
        else if (msg.error) { finished = true; void write({ status: "error", error: msg.error }); }
        else if (msg.subject) { finished = true; void write({ status: "done", subject: msg.subject, redirect: msg.redirect }); }
      });
      if (!finished) await write({ status: "error", error: { code: "NO_RESULT", message: "VIVA stopped part-way through building that subject." } });
    } catch (e) {
      await write({ status: "error", error: { code: "NETWORK", message: "VIVA did not answer. Is it still running?" } });
    }
  }

  async function studyTurn({ subjectId, text, origin }) {
    const res = await fetch("/api/study/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, subjectId: subjectId || undefined, origin: origin || "typed" }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: body?.error || { code: String(res.status), message: "VIVA could not take that." } };
    return {
      ok: true,
      reply: body?.tutor?.text || "",
      question: body?.tutor?.question || null,
      citations: (body?.tutor?.citations || []).map((c) => c.quote),
      band: body?.band || null,
    };
  }

  /** Base64 WAV from the panel -> the multipart form /api/voice/transcribe wants. */
  async function transcribe({ wav, subjectId }) {
    const bin = atob(wav);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const form = new FormData();
    form.append("audio", new Blob([bytes], { type: "audio/wav" }), "turn.wav");
    if (subjectId) form.append("subjectId", subjectId);
    form.append("mode", "study");
    const res = await fetch("/api/voice/transcribe", { method: "POST", body: form });
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: body?.error || { code: String(res.status), message: "VIVA could not hear that." } };
    return { ok: true, text: body.clean || body.verbatim || "", confidence: body.confidence ?? null };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "viva.ping") { sendResponse({ ok: true }); return false; }
    if (msg?.type === "viva.create") { void createSubject(msg); sendResponse({ ok: true, started: true }); return false; }
    if (msg?.type === "viva.turn") { studyTurn(msg).then(sendResponse); return true; }
    if (msg?.type === "viva.transcribe") { transcribe(msg).then(sendResponse); return true; }
    return false;
  });
}
