# Architecture

How VIVA is put together, and the three guarantees the code actually enforces.

## The loop

```
mic ──► AudioWorklet ──► /api/voice/transcribe ──► AssemblyAI Dictation
        Int16 PCM 16k        (server-side)          (Sync = fallback)
                                   │
                                   ▼
                          /api/study/turn
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                          ▼
   intent + concept        retrieval over the           Socratic reply,
   (compiler first,        subject's own passages       every citation
    model confirms)        (top 3)                      resolved or stripped
                                   │
                                   ▼
                    append-only turn log ──► mastery reducer ──► /today
```

## Voice

`public/worklets/pcm16.js` resamples the microphone to 16 kHz mono Int16 in the
audio thread, carrying the fractional read position and the previous quantum's
tail across 128-sample boundaries.

One capture feeds two paths. Frames are buffered into a WAV that is POSTed
whole on release — that clip is what gets graded — and the same frames go, as
they are produced, to a Universal-Streaming socket the browser opens itself so
the learner can watch the sentence form. `startCapture`'s `onFrame` is the tee;
opening a second capture for the socket meant two `getUserMedia` calls and two
AudioWorklets on one device, which crashed the renderer outright.

`GET /api/voice/stream-token` mints a streaming-only token (expiry clamped
server-side to 60-600 s, same rate-limit bucket as transcription). The API key
stays on the server; `src/proxy.ts` allows exactly `wss://streaming.assemblyai.com`
in `connect-src` and no new fetch target. If the socket never opens, the
buffered path is unaffected.

`POST /api/voice/transcribe` (multipart: `audio`, `subjectId`, `mode`) builds
the Dictation request from the learner's actual subject:

| Field | Source |
|---|---|
| `keyterms_prompt` | concept names + aliases of the resolved subject |
| `stt_prompt` | last few turns, speaker labels stripped |
| `llm_instruction` | `study` keeps hedges and negations, removes filler; `verbatim` omits it |
| `language_codes` | the subject's languages; streaming accepts 32 codes plus automatic detection, and anything outside that set maps to auto rather than killing the session |

Speaker labels are stripped from `stt_prompt` because a prompt beginning
`Student:` once produced a transcript beginning `Student:`. The strip is pinned
by a test; the leak itself did not reproduce on re-probe (see API-FEEDBACK §9).

Any WAV is accepted: `toPcm16kMono` downmixes and resamples server-side before
declaring the format. Declaring 16 kHz over 48 kHz bytes made the endpoint read
the clip at one sixth speed and return an empty transcript with HTTP 200.

Dictation answers first. Sync is reached only through service faults
(401/404/429/503/504/5xx) or a missing dictation URL, never audio faults
(400/413/415), so a bad clip is not paid for twice. The response says which
path served it.

## The three guarantees

**No citation without a passage.** `groundReply` filters every citation against
the chunk ids actually retrieved for that turn and deletes the rest — the schema
only asks for a string, so that check is what enforces this. If nothing survives
and the intent needed one, VIVA says it cannot find that in your source.

**No model writes a score.** Mastery moves only through the reducer in
`src/lib/mastery.ts`. The model emits a direction (`up`/`down`/`flat`); the
arithmetic is ours and every change carries a reason.

**The key never reaches the browser.** Every call that carries the key is
server-side. `connect-src` is `'self'`, Vercel insights and
`wss://streaming.assemblyai.com`: the browser reaches AssemblyAI on one origin,
over a short-lived token `/api/voice/stream-token` mints, never with the key.

## Subjects

Starters are static records. Anything a learner adds goes through
`POST /api/subjects/create` (inline, `maxDuration = 60`, progress streamed as
NDJSON): text or PDF → 800-char chunks with 120 overlap and page numbers →
concepts, questions, explainers.

Two build paths. With a model, the full plan. Without one, `src/lib/intake/`
reads the student's own text — definition patterns, headings, term frequency
with an IDF ceiling — and every description and hint is a verbatim sentence
from their notes. Each subject records `builtBy`, and the UI says which. A
name-only topic with no model is refused rather than invented, and a PDF with
no extractable text says so.

`resolveSubject(store, userId, id)` is the single resolution point. Passing
another learner's id resolves to your own default, never to their material.

## Identity and storage

Identity is the `viva_did` HttpOnly cookie, 128 bits, `SameSite=Lax`. There is
no sign-in and no user-switching parameter — every route derives the owner from
the cookie alone.

Storage is Postgres when `DATABASE_URL` is set, otherwise a per-instance file
store. `GET /api/health/ready` reports `durable` and `degraded` separately from
`ready`: the app can serve from the fallback, and says so, rather than claiming
health it does not have or taking a working demo offline.

## Degradation

| Missing | What happens |
|---|---|
| `LLM_API_KEY` | Heuristic tutor answers. No error, no blank card. |
| `DATABASE_URL` | Per-instance file store; `durable: false` on the health endpoint. |
| `ASSEMBLYAI_API_KEY` | Mic returns an honest 503; typing still works. |
| Dictation unavailable | Sync fallback, labelled in the response. |
| Any provider error | One plain sentence, never a status code or a stack trace. |

## Verifying it

```bash
npm run verify   # typecheck + copy lint + tests + build
```

`scripts/lint-copy.mjs` fails the build on internal vocabulary in
student-facing strings — it scans rendered text only (string literals, template
literals, JSX text), exempts identifiers and SQL, and ships a self-test so the
rules cannot silently stop firing.

## Subjects

`src/lib/corpus/library.json` ships 11 subjects built from CC BY 4.0 OpenStax
books, registered through `src/lib/corpus/index.ts` into the same course
registry the hand-written labs use, so retrieval, quizzing and teach-back need
no special case. Each carries a `SourceLicence` that the UI is required to
render — that is the condition on using the material, not a nicety.

A learner's own subject comes from pasted text, a `.txt`/`.md`/`.docx`/`.pdf`
(dispatched on magic bytes, not the filename), or a URL. URL fetching resolves
every redirect hop and refuses private, loopback, link-local and metadata
addresses, caps the body at 3 MB and the request at 12 s, and refuses a page
with too little prose rather than guessing. Up to four sources make one
subject and each keeps its own provenance.

## The record lives in the browser

Without `DATABASE_URL` the server store is per-instance, so the browser is the
authority: `src/components/mirror.ts` keeps events, mastery and whole subjects
in `localStorage` and `POST /api/learner/sync` replays them into whichever
instance answers. Replay is idempotent on `clientEventId`, and mastery is
never taken from the client — it is recomputed by folding the replayed events
through `src/lib/mastery.ts`, so a reload cannot move the map.

## Reasoning

`src/lib/ai/provider.ts` resolves an ordered chain: `LLM_*` first, then each
`LLM_FALLBACKS` entry. A credential that returns 429 is skipped for a minute
rather than retried every turn. This exists because it happened — one key hit
its daily token cap and every turn silently answered from the heuristic path
for hours. `/api/health/ready` now reports the failure class, never the
upstream message.

Every prompt that asks for a schema-shaped object names its keys. The one that
did not (`TUTOR_SYSTEM`) produced sensible content under invented key names,
failed validation, and fell back silently 100% of the time.

## Other surfaces

- `src/app/api/mcp/route.ts` — Model Context Protocol over Streamable HTTP.
  Eight tools, all calling VIVA's own routes, so an assistant's quiz is marked
  by the same code. Pairing is an HMAC-signed code (10 min) exchanged for an
  account key (30 days).
- `extension/` — Manifest V3, no build step, no credentials. It works inside
  the learner's own VIVA tab, so requests are same-origin; host permissions
  are the two VIVA origins only.
- `src/components/orb/` — one WebGL orb for the whole app, mounted in the root
  layout outside `template.tsx`. Pages render an empty `OrbSlot`; the host
  measures the active slot and springs its own transform. Phones get a drawn
  SVG and never download three.
