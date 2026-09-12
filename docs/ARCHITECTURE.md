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
tail across 128-sample boundaries. The clip is assembled into a WAV on release
and POSTed whole — it is **not** streamed while recording, despite the endpoint
supporting it.

`POST /api/voice/transcribe` (multipart: `audio`, `subjectId`, `mode`) builds
the Dictation request from the learner's actual subject:

| Field | Source |
|---|---|
| `keyterms_prompt` | concept names + aliases of the resolved subject |
| `stt_prompt` | last few turns, speaker labels stripped |
| `llm_instruction` | `study` keeps hedges and negations, removes filler; `verbatim` omits it |
| `language_codes` | the subject's languages, 19 supported |

Speaker labels are stripped from `stt_prompt` because a prompt beginning
`Student:` produced a transcript beginning `Student:` — probed live, pinned by
a test.

Any WAV is accepted: `toPcm16kMono` downmixes and resamples server-side before
declaring the format. Declaring 16 kHz over 48 kHz bytes made the endpoint read
the clip at one sixth speed and return an empty transcript with HTTP 200.

Dictation answers first. Sync is reached only through service faults
(401/404/429/503/504/5xx), never audio faults (400/413/415), so a bad clip is
not paid for twice. The response says which path served it.

## The three guarantees

**No citation without a passage.** The reply schema requires a `chunkId` that
exists in the retrieved set; anything else is stripped. If nothing survives and
the intent needed one, VIVA says it cannot find that in your source.

**No model writes a score.** Mastery moves only through the reducer in
`src/lib/mastery.ts`. The model emits a direction (`up`/`down`/`flat`); the
arithmetic is ours and every change carries a reason.

**The key never reaches the browser.** All provider calls are server-side.
`connect-src` is `'self'` plus Vercel insights — the browser has no provider
origin to talk to, and `/api/voice/warm` exists so it never needs one.

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
