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
3. VIVA transcribes it, finds the passage it relates to, and asks you the one
   question that moves you forward.
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

## Reproduce the transcription yourself

```bash
curl -s -X POST https://viva-five-murex.vercel.app/api/voice/transcribe \
  -H "Content-Type: audio/wav" \
  --data-binary @your-16khz-mono.wav
```

Returns a real result: `mode`, `confidence`, a real `session_id`, and
`demoFixture: false`. Verified live on 12 September 2026 at 0.9895 and 0.9957
confidence on two spoken samples.

---

## How it works

```
mic → AudioWorklet (Int16 PCM 16 kHz) → /api/voice/transcribe
    → AssemblyAI Dictation  (Sync fallback)
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

---

## Known limits

Stated plainly, because a demo that hides its edges is not worth trusting.

- **Persistence.** Without `DATABASE_URL` the store is per-instance and does
  not survive a redeploy. `GET /api/health/ready` reports this as
  `durable: false` rather than pretending otherwise.
- **Screen readers.** Automated accessibility checks pass; a manual pass with a
  real screen reader has not been done.
