# VIVA

**Study out loud. VIVA remembers.**

Talk through what you are learning. VIVA transcribes you with the AssemblyAI
Dictation API, works out what you got wrong, shows you the passage it came
from, and asks you again tomorrow.

Built for **AssemblyAI Voice Hackathon Week: Hack into Dictation**, 9–13
September 2026.

Live: https://viva-five-murex.vercel.app

---

## Try it in 60 seconds, no sign-in

1. Open the live URL and press **Start talking**.
2. Hold the mic (or hold <kbd>Space</kbd>) and say something you half-remember:
   *"I don't really understand why attention needs positional encoding."*
   Your words appear as you say them.
3. When you let go, VIVA cleans the transcript, finds the passage it relates
   to, and asks you the one question that moves you forward.
4. Answer aloud. It grades the answer against the source, not against a vibe.
5. Come back to **Today** and the thing you got wrong is the first question.

There is no account. Identity is an HttpOnly cookie, so two browsers are two
separate learners. Voice is the point, but every screen also takes typing.

---

## The Dictation API is the product, not a checkbox

Transcription runs on the hackathon's own beta endpoint, server-side:

```
POST https://dictation.assemblyai.com/v1/transcribe/live
Authorization: <key>          # raw, no Bearer
multipart/form-data           # `config` part FIRST, then `audio`
audio: 16 kHz mono s16le PCM  # compressed formats are rejected with 415
```

What that buys, and why each part is used:

- **`keyterms_prompt`** carries the concept names of the subject you are
  studying, so "positional encoding" comes back spelled correctly instead of
  "positional and coding".
- **`stt_prompt`** carries the last few turns of the conversation, so a
  follow-up like "explain it without the jargon" resolves to the right concept.
- **`llm_instruction`** does the cleanup: filler words and false starts are
  removed, but hedges are kept exactly. "I think, maybe, it's about which words
  are important" is the single most useful sentence a learner can say, and a
  tidier transcript that drops the *I think* throws the signal away. You can
  always flip to **Verbatim** to see what you actually said.
- The response gives both, so the UI shows **Clean** by default and
  **Verbatim** on a toggle, with the real `request_time_ms` next to it.

If the Dictation endpoint is unavailable the Sync API answers instead and the
response says which path served it. With no key at all the mic returns an
honest 503 and the typed box still works — nothing is ever faked.

### Words while you are still speaking

The clip above is what gets graded. While you hold the mic, the same audio
also goes to Universal-Streaming, so you can watch the sentence form:

```
mic → AudioWorklet (one capture) ─┬→ buffered clip → /api/voice/transcribe → Dictation
                                  └→ wss://streaming.assemblyai.com/v3/ws   → live words
```

One microphone feeds both. The browser opens the socket itself, because
relaying every 64 ms frame through a server hop is the exact latency streaming
exists to remove — it carries a short-lived token from `/api/voice/stream-token`
and never the API key. Measured in a real browser: the first word paints
**2.1 s** after you start speaking, then refines every 150-350 ms. Settled text
is solid, in-flight words are dim, and the buffered transcript is still the one
that gets marked. If the socket never opens you lose the animation and nothing
else.

Language is a picker, not a guess: 32 streaming codes plus automatic detection.
Auto-detect is confident and wrong on marginal audio (a degraded English clip
came back as German), which is why the picker stays.

## Reproduce the transcription yourself

```bash
curl -s -X POST https://viva-five-murex.vercel.app/api/voice/transcribe \
  -F "audio=@your-16khz-mono.wav;type=audio/wav" \
  -F "subjectId=course_transformers_w4" \
  -F "mode=study"
```

A real run against production, 12 September 2026:

```json
{ "mode": "dictation",
  "confidence": 0.988,
  "sessionId": "e36868b6-b49f-417f-b4a9-1d53a7c26a14",
  "requestTimeMs": 604,
  "verbatim": "Um, I don't really understand why attention needs positional encoding. I think, maybe, it's about which words are important?",
  "clean":    "I don't really understand why attention needs positional encoding; I think maybe it's about which words are important." }
```

That pair is the whole argument for using the Dictation API rather than a
plain transcript: `Um,` is gone and `I think` / `maybe` are still there.
Latency, measured against production on 13 September 2026 with the command
above, five runs from a UK machine: **median 1310 ms** end to end, of which
**571 ms** is AssemblyAI's own `request_time_ms`. The rest is our round trip.

(Two earlier drafts of this file were optimistic — 853 ms, then 1166 ms. Both
were real measurements that stopped reproducing as the app changed, and both
were caught by a reviewer re-running the command rather than by us. The
numbers above are the median of five consecutive runs; expect roughly
1300-1530 ms end to end and 545-580 ms of provider time.)

---

## Bring a source, or start from the shelf

Thirteen subjects ship with the app — algebra, anatomy, astronomy, biology,
chemistry, economics, government, physics, psychology, sociology, statistics,
and two hand-written labs. Eleven are built from OpenStax textbooks under
CC BY 4.0, each passage keeping the section it came from, and each subject
saying plainly that a language model read the book and drew the map.

Your own material goes in the same way: paste notes, drop a `.txt`, `.md`,
`.docx` or `.pdf`, or give a URL. Up to four sources become one subject and
each keeps its own provenance, so a citation names the document it is in. URL
fetching resolves every redirect hop and refuses private, loopback, link-local
and metadata addresses.

## Read your chat history back into your subject

`extension/` is a Manifest V3 browser extension. On a ChatGPT, Claude, Gemini
or NotebookLM tab — or any article — one click turns what you were reading into
a VIVA subject, and a small panel lets you answer out loud without leaving the
page. It holds no credentials: it works inside your own VIVA tab, so every
request is same-origin and carries the session you already have. Host
permissions are the two VIVA origins and nothing else, so it is structurally
unable to read a page you did not act on. Load it unpacked; see
[extension/README.md](extension/README.md).

## Use VIVA from Claude, Cursor or any assistant

VIVA speaks the Model Context Protocol, so it does not have to be another tab.
Connect it once and say "quiz me on histology", "keep this", "what am I weak
on" from wherever you already work. The microphone stays in VIVA; the thinking
can happen anywhere.

Add it — one line:

```bash
claude mcp add --transport http viva https://viva-five-murex.vercel.app/api/mcp
```

Or one entry in Claude Desktop / Cursor's config:

```json
{
  "mcpServers": {
    "viva": {
      "type": "http",
      "url": "https://viva-five-murex.vercel.app/api/mcp"
    }
  }
}
```

Pair it — open [/connect](https://viva-five-murex.vercel.app/connect) in the
browser you study in, press **Get a connection code**, and paste the code into
your assistant. The code lasts ten minutes; what comes back is a key for that
one account. Put it in the connection's `Authorization: Bearer …` header and
you never paste again.

The code is signed rather than stored, which is what lets a pairing survive a
redeploy — and means it can be redeemed more than once inside its ten minutes,
because there is no database in which to mark it spent. Treat it like a
one-time password you are reading aloud.

Eight tools: list your subjects, build one from pasted notes, say something and
get VIVA's reply with the line it quoted, start a quiz, answer one, today's ten
minutes, and what you are mixed up about.

Every tool calls VIVA's own routes — the quiz an assistant asks is the quiz the
app asks, marked by the same code, and mastery is still written in exactly one
place. No tool can delete anything, and the marking key never leaves the server.
VIVA has no sign-in, so pairing is the whole account model: one signed key, one
study account, and no argument that can point it at anyone else's subjects.

## How it works

```
mic → AudioWorklet (Int16 PCM 16 kHz) → /api/voice/transcribe
    → AssemblyAI Dictation  (Sync fallback)   ‖  live socket, same frames
    → intent + concept  → retrieval over your subject's passages
    → Socratic reply, every citation resolved to a stored passage
    → append-only turn log → mastery reducer → tomorrow's plan
```

Three rules the code actually enforces:

- **No citation without a passage.** The tutor's reply schema requires a
  `chunkId` that exists in the retrieved set; anything else is stripped. If
  nothing survives, VIVA says it cannot find that in your source rather than
  inventing one.
- **No model writes a score.** Mastery moves only through the reducer in
  `src/lib/mastery.ts`. The model emits a signal; the arithmetic is ours and
  every change carries a reason.
- **The key never reaches the browser.** All AssemblyAI calls are server-side.

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Running it

```bash
npm install
cp .env.example .env.local     # add ASSEMBLYAI_API_KEY
npm run dev
```

```bash
npm run verify                 # typecheck + tests + build
npm run lint:copy              # fails on internal jargon in student-facing copy
```

Environment:

| Variable | Required | Notes |
|---|---|---|
| `ASSEMBLYAI_API_KEY` | yes | Server-side only |
| `ASSEMBLYAI_DICTATION_URL` | no | Defaults to the v1 live endpoint |
| `ASSEMBLYAI_TRANSCRIPTION_MODE` | no | `dictation` (default) or `sync` |
| `DATABASE_URL` | no | Postgres. Without it, a per-instance file store |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | no | Without them the heuristic tutor answers |
| `LLM_FALLBACKS` | no | Spare credentials, `baseUrl\|key\|model` separated by commas. Tried in order when the first is rate limited, and skipped for a minute after |
| `MCP_TOKEN_SECRET` | no | Signs assistant pairing keys. Unset, pairings break on redeploy |

---

## Known limits

Stated plainly, because a demo that hides its edges is not worth trusting.

- **Persistence.** Without `DATABASE_URL` the server store is per-instance and
  does not survive a redeploy, so the browser holds the record and replays it
  on every load: your map, your plan and your subjects come back, on that
  device. `GET /api/health/ready` reports `durable: false` rather than
  pretending otherwise, and the app says so on screen.
- **Non-English accuracy is untested.** Streaming accepts 32 languages and the
  transcript is real, but every clip measured here was English. Nobody has
  checked a Hindi or Mandarin transcript word by word, so no accuracy claim is
  made for them.
- **Screen readers.** Automated accessibility checks pass; a manual pass with a
  real screen reader has not been done.
