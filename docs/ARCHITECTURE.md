# Architecture (synced to code — 2026-09-10)

> Every claim below names its file. Numbers are budgets read from code, not
> measurements. No pgvector, no Redis — each is marked where it would plug in
> as a documented upgrade. Privy credentials ARE configured (2026-09-10):
> Google + email login live on /learn, server verification via
> @privy-io/server-auth, fail-closed to demo identity. Durable Blob store
> `viva-data` (iad1, private) is LIVE and active: production reports
> `backend: "blob"`, and a written event survived a full redeploy under the
> same demo identity (2026-09-10). Postgres stays the optional FTS/vector
> upgrade — see "Backend" below.

```
Browser (demo identity cookie · Audio capture → WAV encode · Source reader · VIVA UI)
   │  POST audio/wav or audio/pcm (16-bit, 80ms–120s, ≤40MB)
   ▼
Next.js server/API (stateless; per-instance memory only)
│
├─ Identity (src/lib/auth/identity.ts — Privy verify when configured,
│            else isolated HttpOnly demo-identity cookie `viva_did`)
├─ Rate limiter (src/lib/limits.ts — token bucket per IP: transcribe 12/min,
│            compile 60/min, exam 30/min, upload 10/min, default 120)
├─ Circuit breaker (src/lib/circuit.ts — 5 consecutive failures → open 60s,
│            half-open probe; per-process)
├─ WAV validation (src/lib/audio/wav.ts — RIFF/PCM/rate checks BEFORE credits)
├─ TranscriptionProvider (src/lib/assemblyai.ts — Sync primary,
│            event-dictation override, async for long audio; fixture banned in prod)
├─ HARNESS A — Semantic Compiler (src/lib/compiler.ts — deterministic, LLM-free)
├─ HARNESS B — Evidence Grounding (src/lib/retrieval.ts verifyEvidence;
│            chunks are DATA, injection-inert)
├─ Retrieval (pg.ts: Postgres FTS ts_rank + GIN │ file.ts: lexical scoreChunks)
├─ HARNESS C — Mastery Reducer (src/lib/mastery.ts — pure fold, bounded deltas)
├─ HARNESS D — Socratic Tutor + assessment (src/lib/tutor.ts —
│            tutorRespond, assessAnswer, scoreTeachback)
├─ HARNESS E — Response Verifier (src/lib/tutor.ts verifyResponse — 1 repair max)
├─ Event Store (src/lib/store/: pg.ts │ file.ts behind repo.ts; factory index.ts)
├─ ReasoningProvider seam (src/lib/ai/provider.ts — heuristic default, $0 LLM)
├─ Upload pipeline (src/app/api/sources/upload/route.ts — %PDF magic, pdf-parse,
│            ~800-char chunks, ≤10MB / ≤200 chunks, caller-scoped)
├─ Observability (src/lib/observe.ts — request ids, stage timings, safe JSON logs)
├─ Health (src/app/api/health/route.ts liveness; health/ready/route.ts readiness)
└─ Analytics (counts + latencies only; never keys, audio, transcripts, cookies)
   │
   ├─ Postgres (migrations/001_init.sql — 12 tables, per-row user_id ownership,
   │     FTS tsvector+GIN, idempotency UNIQUE(user_id, idempotency_key))
   │     Active ONLY when DATABASE_URL is set (src/lib/db/db.ts — pool max 10,
   │     statement 8s, connect 5s, SSL in prod)
   ├─ File fallback (src/lib/store/file.ts — DATA_DIR JSONL per user, atomic
   │     tmp+rename, per-user mutex; durable on disk, EPHEMERAL on serverless)
   └─ Bundled course (src/lib/course.ts — 12 citable chunks, 6 concepts,
         5 exam questions; original text, every citation resolves)
```

## Why this shape

One deployable. No microservices for a hackathon product. The event log is
the source of truth; mastery is derived and rebuildable (`reduceMastery` is a
pure fold — `src/lib/mastery.ts:29-104`). An LLM may rephrase tutor wording,
but it never writes mastery, never picks evidence, never invents citations,
never executes tools from voice input.

`POST /api/events/compile` runs harnesses A→(retrieval)→persist→D→E in one
bounded call (`src/app/api/events/compile/route.ts:48-111`).

## Backend-for-frontend contracts (every /api route)

All identity-scoped routes resolve the caller via `resolveIdentity`
(Privy bearer verified server-side when configured; else isolated demo
cookie; any Privy error fails closed to demo — `identity.ts:27-71`) and echo
a freshly minted cookie only when one was created. Limits are the per-IP,
per-instance token buckets from `limits.ts:22-28`. "None" auth = the route
does not touch user data (`/api/dictation/transcribe` is audio-in/text-out;
`/api/health*` are dependency probes).

| Route | Method | Auth | Limit | Coded failures (status) |
|---|---|---|---|---|
| `/api/demo/identity` | GET | resolves (mints) | — | — (200 always) |
| `/api/dictation/transcribe` | POST | none (no user data) | transcribe 12/min | 429 `RATE_LIMITED`; 503 `PROVIDER_BUSY` (breaker); 415 `EMPTY_AUDIO`/`BAD_AUDIO`/`UNSUPPORTED_FORMAT`/`AUDIO_TOO_SHORT`; 413 `AUDIO_TOO_LONG`/`AUDIO_TOO_LARGE`; 503 `NO_DICTATION_URL`/`NO_API_KEY`; 429 upstream `RATE_LIMITED` (+`Retry-After`); 400 upstream `BAD_AUDIO`; 502 `AUTH_FAILED`/`TRANSCRIPTION_FAILED`/upstream 5xx mapped (`transcribe/route.ts:29-104`) |
| `/api/events` | GET | identity | — | — (scoped list) |
| `/api/events/compile` | POST | identity | compile 60/min | 429 `RATE_LIMITED`; 400 `BAD_REQUEST` (`compile/route.ts:34-45`) |
| `/api/exam/start` | POST | identity | default 120/min | 429 `RATE_LIMITED` (`exam/start/route.ts:13-19`) |
| `/api/exam/answer` | POST | identity | exam 30/min | 429 `RATE_LIMITED`; 400 `BAD_REQUEST`/`UNKNOWN_QUESTION` (`exam/answer/route.ts:25-39`) |
| `/api/teachback/start` | POST | identity | default 120/min | 429 `RATE_LIMITED`; 400 `BAD_REQUEST` (`teachback/start/route.ts:18-42`) |
| `/api/teachback/answer` | POST | identity | exam 30/min | 429 `RATE_LIMITED`; 400 `BAD_REQUEST` (`teachback/answer/route.ts:37-54`) |
| `/api/tutor/respond` | POST | identity | compile 60/min | 429 `RATE_LIMITED`; 400 `BAD_REQUEST` (`tutor/respond/route.ts:21-32`) |
| `/api/learner` | GET | identity | — (destructive `?reset=1` scoped to caller) | — (`learner/route.ts:12-33`) |
| `/api/learner/review` | GET | identity | default 120/min | 429 `RATE_LIMITED` (`learner/review/route.ts:13-19`) |
| `/api/sources` | GET | identity | — | — (`sources/route.ts:8-21`) |
| `/api/sources/upload` | POST | identity | upload 10/min | 429 `RATE_LIMITED`; 400 `NO_FILE`; 413 `FILE_TOO_LARGE`; 415 `BAD_FILE`; 422 `PARSE_FAILED` (`upload/route.ts:48-88`) |
| `/api/me/data` | DELETE | identity | — | — wipes caller's data + clears cookie (`me/data/route.ts:9-17`) |
| `/api/health` | GET | none | — | — liveness only (`health/route.ts:2-4`) |
| `/api/health/ready` | GET | none | — | 503 when the configured store is unreachable (`health/ready/route.ts:8-17`) |

Every JSON mutating route validates with Zod before any upstream or store
call; malformed input is a coded 400, never an uncaught throw. Binary routes
validate their own envelope contracts instead: WAV/RIFF header bounds for
dictation, `%PDF` magic + size + chunk caps for upload.

## TranscriptionProvider (sync / event / async)

`src/lib/assemblyai.ts` — one interface, three modes
(`ASSEMBLYAI_TRANSCRIPTION_MODE`, default `sync`):

| Mode | Path | When |
|---|---|---|
| `sync` (default, verified contract) | `POST {SYNC_BASE}/transcribe`, multipart `audio`+`config`, header `X-AAI-Model: universal-3-5-pro` (`assemblyai.ts:120-146`) | hold-to-talk clips |
| `event-dictation` | `POST ASSEMBLYAI_DICTATION_URL` (hackathon beta) | only when the URL is configured; accepts `{text\|transcript}` shapes only, anything else is an honest `BAD_RESPONSE` error (`assemblyai.ts:171-201`) |
| `async` | `/v2/upload` + `/v2/transcript` poll, bounded 100s (`assemblyai.ts:203-242`) | long lecture audio only — never the hot path |

Key never reaches the browser (all calls server-side). Production never
selects fixture transcription: `resolveTranscriptionProvider()` throws
`NO_API_KEY` (503) when the key is absent (`assemblyai.ts:274-277`), the
fixture refuses production (`assemblyai.ts:246-264`), and the live route
constructs the real provider directly with the key checked inside `apiKey()`
(`transcribe/route.ts:55-63`, `assemblyai.ts:80-84`).

## WAV contract (credits are spent only on valid audio)

Sync STT accepts **only 16-bit WAV or raw PCM S16LE** — never WebM/Opus.

- Client: `blobToWav16kMono` decodes any captured blob → 16 kHz mono 16-bit
  WAV, pure byte ops + WebAudio, no FFmpeg (`src/lib/audio/wav.ts:14-34`).
- Server: `validateWavInput` checks RIFF/`WAVE` magic, PCM format, 16-bit,
  rate ∈ {8000…48000}, duration 80ms–120s, ≤40MB — returning coded errors
  (415/413) **before any upstream call**
  (`src/lib/audio/wav.ts:67-105`, enforced in
  `src/app/api/dictation/transcribe/route.ts:47-53`).
- Sync semantics honored: 32s upstream abort, 30s provider deadline mapped to
  `PROVIDER_TIMEOUT`/504, 429 propagates `Retry-After`
  (`assemblyai.ts:90-104,139,164`).

## Voice pipeline deep-dive (exact bytes)

From push-to-talk to a persisted Thought Mark, there is no FFmpeg and no
WebM/Opus on the wire to the provider:

1. **Capture** — `getUserMedia({audio:true})`, live level meter is UI-only;
   `MediaRecorder` records browser-native `audio/webm` (or its default codec
   when webm is unsupported) (`VoiceButton.tsx:61,79-81`). A blob under
   800 bytes is discarded silently — no request is made
   (`VoiceButton.tsx:86`).
2. **Encode** — `blobToWav16kMono(blob)` (`wav.ts:14-34`): `arrayBuffer()` →
   `AudioContext.decodeAudioData` (accepts any browser format) →
   `OfflineAudioContext(1, ceil(duration×16000), 16000)` render → mono
   `Float32Array` → `pcm16ToWav` (`wav.ts:40-62`) writes a 44-byte RIFF
   header (`"RIFF"`, size, `"WAVE"`, `"fmt "` 16, PCM=1, mono=1,
   rate=16000, byteRate=32000, blockAlign=2, bits=16, `"data"`) followed by
   little-endian int16 samples. Non-finite/loud samples clamp to ±1.
3. **Upload** — `POST /api/dictation/transcribe` with
   `Content-Type: audio/wav` and an informational
   `X-VIVA-Audio-Duration-Ms` (`VoiceButton.tsx:91-95`); the server never
   trusts that header — it recomputes duration from the RIFF `data` chunk.
4. **Validate before credits** — `Buffer.from(arrayBuffer)` →
   `validateWavInput` (`wav.ts:67-105`, called at
   `transcribe/route.ts:47-53`): empty → `EMPTY_AUDIO`; >40 MB →
   `AUDIO_TOO_LARGE`; RIFF/`WAVE` magic; chunk walk finds `fmt ` + `data`;
   PCM=1 and 16-bit; rate ∈ {8000,16000,22050,24000,32000,44100,48000};
   mono/stereo; 80 ms–120 s. Raw `audio/pcm` is accepted by byte-count
   duration under the same envelope. Coded 413/415 responses happen **before
   any upstream call**.
5. **Transcribe** — Sync `POST {syncBase}/transcribe` multipart: `audio`
   part (`clip.wav`) + JSON `config` `{prompt, keyterms_prompt[≤2048 chars],
   language_code:"en", conversation_context[last 6], timestamps:false}`,
   header `X-AAI-Model: universal-3-5-pro`, `Authorization: <key>`, 32 s
   abort (`assemblyai.ts:118-169`).
6. **Persist** — response `{text, confidence, audio_duration_ms,
   session_id, request_time_ms}` returns to the client; the client POSTs the
   text to `/api/events/compile`, attaching `confidence`/`latencyMs`/
   `transcriptionSessionId` **only when `inputKind === "voice"`**
   (`compile/route.ts:76-78,126-131`). Typed input carries `origin:"typed"`
   with null transcription fields — provenance is never blurred.

## Postgres schema + file fallback + DATA_DIR + serverless note

**Postgres** (`migrations/001_init.sql`) — 12 tables, every row carries
`user_id` ownership: `users, courses, sources, source_chunks, concepts,
concept_edges, learning_sessions, learning_events, mastery_state,
review_queue, tutor_messages, product_events, eval_runs`.

- FTS: `source_chunks.search TSVECTOR GENERATED ALWAYS … STORED` + GIN index
  (`001_init.sql:44,47`); retrieval is `ts_rank + plainto_tsquery` with an
  active-source filter, all parameterized (`src/lib/store/pg.ts:261-280`).
- Idempotency: `UNIQUE(user_id, idempotency_key)` (`001_init.sql:99`).
- Concurrency: `recordLearning` runs in ONE transaction with
  `SELECT … FOR UPDATE` on the mastery row (`pg.ts:144-205`).
- Pool: max 10, idle 20s, connect 5s, statement 8s, SSL in production
  (`src/lib/db/db.ts:23-30`).

**File fallback** (`src/lib/store/file.ts`) — one JSON doc per user in
`DATA_DIR` (default `.data/`; `/tmp/.viva-data` on Vercel — `file.ts:46-52`),
atomic tmp+rename writes, per-user async mutex. Same interface, same reducer,
lexical retrieval. Durable on a disk; **ephemeral on serverless**
(per-instance filesystem) — readiness says so explicitly
(`src/lib/db/db.ts:70`).

**Backend precedence** (`src/lib/store/index.ts`): Postgres → Blob → file.
First configured durable backend wins; `/api/health/ready` names the active
one and returns 503 when a configured backend is unreachable.

**Blob store** (`src/lib/store/blob.ts`, live store `viva-data`, iad1, private
blobs) — durable managed persistence with zero new accounts:
- Events are IMMUTABLE objects (`viva/events/{userId}/{eventId}.json`):
  concurrent writers cannot corrupt history.
- Mastery snapshot (`viva/mastery/{userId}.json`) is a best-effort cache;
  reads merge every newer event, so stale/lost snapshots self-heal.
  Genesis priors persist as durable history (`viva/seed/{userId}.json`), so a
  refold reproduces file/pg backends exactly.
- Idempotency: check-then-write on the key; a lost race leaves two objects
  with one key, which the read path dedupes (earliest wins) and heals via
  best-effort delete — proven in `tests/blob.test.ts` (race simulation,
  snapshot-loss refold, isolation, review derivation).
- Uploads: `viva/sources/{userId}/{sourceId}.json` (private). Retrieval is
  lexical over merged seeded+uploaded chunks (FTS/pgvector stay Postgres-only
  documented upgrades).
- Privacy: `access:'private'` on every put; transcripts never have public URLs.
- Lights up with zero code changes the moment `BLOB_READ_WRITE_TOKEN` is set
  (dashboard: Storage → viva-data → Connect project → redeploy).
- Auth note (research 2026-09-10, ARCHITECTURE_RESEARCH_2026.md §B): VIVA is
  on the documented long-lived-token path; the SDK prefers OIDC automatically
  once the store is project-connected, but the one manual read fetch
  (`blob.ts:73`) would need `VERCEL_OIDC_TOKEN` or the SDK `get()`. Private
  reads stay server-side either way.
- Blob is CDN-cached for reads, and an overwrite at the same pathname can
  take up to 60 s to propagate (Vercel private-storage docs, 2026-08-26).
  This is structurally safe here: events are immutable (never overwritten);
  the only overwritten object is the mastery snapshot, which is a
  self-healing cache — the read path merges every event newer than the
  snapshot anchor (`blob.ts:161-197`), so a stale snapshot is tolerated by
  design.

### Persistence ladder (pg → Blob → file)

Selection happens once per process: `backendKind()` returns the first
configured durable backend, and `getStore()` commits to it
(`src/lib/store/index.ts:8-13`, `src/lib/db/db.ts:20-24`). There is no
per-request fallback — a configured backend is the contract, and readiness
names the live rung (`db.ts:48-71`).

| Rung | Backend | Selected when | Durability | Status 2026-09-10 |
|---|---|---|---|---|
| 1 | Postgres (`pg.ts`, `migrations/001_init.sql`) | `DATABASE_URL` set | Durable; single tx + `SELECT … FOR UPDATE`; FTS `tsvector`+GIN; idempotency `UNIQUE(user_id, idempotency_key)` | **Upgrade, code-ready** — FTS/vector path; not provisioned |
| 2 | Blob (`blob.ts`, store `viva-data`, iad1, private) | else `BLOB_READ_WRITE_TOKEN` set | Durable managed; immutable event objects; self-healing snapshot | **LIVE in production** — readiness reports `backend:"blob"`; a written event survived a full production redeploy under the same demo identity (2026-09-10) |
| 3 | File (`file.ts`, `DATA_DIR` / `/tmp` on Vercel) | else | Durable on disk; **ephemeral on serverless** | Fallback for local dev/tests; readiness says so honestly |

## Demo identity + ownership (Privy live since 2026-09-10)

Privy Google + email login is live on `/learn` (`@privy-io/react-auth` login
UI, `@privy-io/server-auth` `PrivyClient.verifyAuthToken` — fail-closed to
the demo identity on any error). Authed API calls carry
`Authorization: Bearer <privy-token>` and scope to `privy_{userId}`; garbage
tokens resolve to the demo identity, never to another user (verified on prod).

The demo runs on an **isolated demo identity**: random 128-bit id in HttpOnly
cookie `viva_did` (`SameSite=Lax`, `Secure` in production — `identity.ts:49-51`).
There is no user-switching parameter anywhere; the cookie IS the identity
boundary. Every repository call is scoped to it; `GET /api/learner?reset=1`
deletes **only the caller's** data (`src/app/api/learner/route.ts:16-18`);
`DELETE /api/me/data` wipes the caller's courses/sources/events/mastery/messages
and clears the cookie (`src/app/api/me/data/route.ts:9-17`).
Proven by `tests/idor.test.ts` + `tests/store.test.ts` (cross-user isolation).

## Idempotency

Compile, exam-answer, and teachback-answer accept `clientEventId`
(`compile/route.ts:20,69`; `exam/answer/route.ts:13,45`;
`teachback/answer/route.ts:14,61`). Retries with the same key return the
original event with `duplicate: true` — never a second Thought Mark
(`pg.ts:148-168`, `file.ts:98-101`; Blob dedupes on read + heals). Covered by
`tests/store.test.ts:35` ("network retry with same key returns the original").

## FTS retrieval (and what it is not)

- Postgres path: ranked full-text search (`ts_rank`, GIN) — `pg.ts:261-280`.
- File path: lexical overlap + active-source boost + concept boost + exact-phrase
  bonus — `src/lib/retrieval.ts:21-48`.
- Same `retrieveEvidence` interface on both; pgvector can replace scoring later
  without moving API contracts. **No pgvector today**: migration installs only
  `pgcrypto` + `pg_trgm` (`001_init.sql:5-6`); `pgvector` appears solely in a
  code comment as a future scoring swap (`retrieval.ts:19`).
- Source text is DATA: grounding does keyword containment only, chunks are never
  prompt-injected — prompt-injection inside a source is inert
  (`retrieval.ts:58-62`; proven by `tests/grounding.test.ts:16`).

## Harnesses A–E

| Harness | File | Contract |
|---|---|---|
| A — Semantic Compiler | `src/lib/compiler.ts:50-111` | deterministic intent + concepts + importance/confusion; cleanup never drops negation, numbers, names |
| B — Evidence Grounding | `src/lib/retrieval.ts:63-91` | support/contradiction/insufficient + coverage; contradiction heuristic for the order-vs-importance misconception |
| C — Mastery Reducer | `src/lib/mastery.ts:29-104` | pure fold; confusion −0.08, wrong claim −0.12, correct teachback +0.12 (teachback > recognition), clamped [0,1], every delta ships a reason; displayed as *VIVA estimate* |
| D — Socratic Tutor + assessment | `src/lib/tutor.ts:131-186,68-122` (+ teachback rubric `213-248`) | smallest useful hint first; exam questions get guided reasoning, never answer dumps; jargon gate on "explain simply"; negation-aware affirmed-mention scoring |
| E — Response Verifier | `src/lib/tutor.ts:193-206` | 1 repair pass max: evidence attached, citation ids resolve, jargon cap, speakable length |

## ReasoningProvider seam (enrichment only, $0 default)

`src/lib/ai/provider.ts` — phrasing enrichment ONLY; nothing on the
mastery/evidence hot path may call it. Default `HeuristicProvider`
(extractive, deterministic, ≤400 chars). Opt-in `OpenAICompatibleProvider`
(any OpenAI-compatible endpoint; temperature 0.2, 20s timeout, one repair
retry, then schema-validated fallback — never throws raw output). Missing
`LLM_*` env → coded `CONFIG_MISSING`, never a silent downgrade
(`provider.ts:142-153`). Default path costs **$0 LLM** (COST_MODEL.md).

## Limits / breaker / observe / health

- Limits: token buckets per IP (demo cookie is client-resettable, so identity
  is not the key) — transcribe 12/min, compile 60/min, exam 30/min, upload
  10/min, default 120 (`src/lib/limits.ts:22-28`); 429 + `Retry-After` on every
  guarded route; bucket map bounded at 10k entries (`limits.ts:12-18`).
- Breaker: 5 consecutive failures → open 60s → half-open probe
  (`src/lib/circuit.ts:12-48`); only retryable/5xx trip it
  (`dictation/transcribe/route.ts:89`).
- Observe: request ids, per-stage timings
  (capture/encode/upload/AAI/compile/retrieval/tutor/db), safe JSON logs —
  never keys/audio/transcripts/cookies (`src/lib/observe.ts:1-4`).
- Health: `GET /api/health` liveness (no deps, no secrets);
  `GET /api/health/ready` readiness (transcription configured? database
  reachable? — honestly reported, 503 when not ready).
- **No Redis**: limits are an instance-local `Map`, the breaker is per-process —
  both comments name the shared-store upgrade (`limits.ts:4-6`,
  `circuit.ts:6-8`). Correct on one instance; migration at S1 (SCALE_MODEL.md).

## Teachback

`POST /api/teachback/start` picks the caller's weakest exam-covered concept
(`teachback/start/route.ts:44-51`); required keywords stay server-side
(`start/route.ts:63-64`). `POST /api/teachback/answer` scores affirmed-mention
coverage → strong/developing/needs-work, folds into mastery with the +0.12
teachback gain, caps displayed misses at 4
(`teachback/answer/route.ts:56-96`). Negated keywords never count
(`tutor.ts:29-57`; `tests/teachback.test.ts:28`).

## Upload pipeline

`POST /api/sources/upload` (multipart `file`): 10MB cap → `%PDF` magic-byte
check (never MIME/filename) → server-side `pdf-parse` (externalized from the
bundle — `next.config.ts:9`) → normalize → ~800-char chunks (≤200) →
persisted scoped to the caller, seeded demo preserved
(`upload/route.ts:39-107`). Filename is untrusted (basename + printable run,
title only — `upload/route.ts:15-19`). Uploaded chunks join the caller's merged
retrieval pool (`file.ts:139-153`, `pg.ts:261-280`).

## Scale progression S0→S4 (summary — full math in SCALE_MODEL.md)

| Stage | Registered / concurrent (assumed) | Breaks first | Migration |
|---|---|---|---|
| S0 | ~1k / ~50 | durability, not throughput — but Blob now covers redeploy persistence (file mode remains ephemeral) | set `BLOB_READ_WRITE_TOKEN` (live) or `DATABASE_URL` |
| S1 | ~10k / ~500 | limiter/breaker divergence (instance-local ×N) | shared Redis limiter + breaker state |
| S2 | ~100k / ~5k | async poll loops in functions; FTS on primary | durable queue for long audio; read replicas |
| S3 | 1M concurrent | single primary writes; STT concurrency + spend | shard by `user_id`; event stream; regional Sync |
| S4 | theoretical | physics + budget (session concurrency, STT spend) | multi-region, on-device VAD — labeled theoretical |

Coded budgets (transcribe 12/min, compile 60/min, exam 30/min, upload
10/min, breaker 5→60 s, pg pool 10, clip 80 ms–120 s/≤40 MB) are enumerated
in SCALE_MODEL §27; the measured sample is in EVALS.md. No throughput number
in this file is invented — serverless ceilings remain arithmetic from coded
budgets plus the vendor durations cited in SCALE_MODEL.

## Failure playbook (what the user sees when a dependency dies)

| Failure | Detection / mechanism | User-visible result |
|---|---|---|
| AssemblyAI erroring | Consecutive-failure breaker: 5 retryable/5xx failures → open 60 s → half-open probe (`circuit.ts:12-48`); only retryable/5xx trip it (`transcribe/route.ts:89`) | Breaker open → 503 `PROVIDER_BUSY` (`retryable:true`); hot-path failures map to typed codes (`PROVIDER_TIMEOUT`, `RATE_LIMITED` + `Retry-After`, `AUTH_FAILED`) with human messages (`transcribe/route.ts:94-117`). Recording is **not** saved; typed input remains available — voice is never required (`VoiceButton.tsx:110-113,146-153`) |
| AssemblyAI key absent | `apiKey()` throws `NO_API_KEY` before any call (`assemblyai.ts:80-84`) | 503 `NO_API_KEY` with "Live voice is not configured… Type instead — nothing is faked" (`transcribe/route.ts:91-93`); production has been live-verified (README), local dev without the key degrades honestly |
| Vercel Blob unreachable | Readiness probes `listEntries("viva/health/")`; failure is reported, not hidden (`db.ts:60-68`); reads that fail return `null` and are treated as absent data, never fabricated (`blob.ts:66-79`) | `/api/health/ready` → 503 `{ready:false, backend:"blob", detail:"unreachable: …"}`; compile/read routes surface store errors as server errors — no silent partial success |
| File store on serverless | Per-instance `/tmp` filesystem (`file.ts:47-53`) | Readiness reports "file … ephemeral on serverless" (`db.ts:70`); no durability claim is made |
| LLM enrichment (optional) | Default `HeuristicProvider` never throws; `OpenAICompatibleProvider` is opt-in with timeout + 1 repair + schema fallback (`ai/provider.ts`); missing `LLM_*` → coded `CONFIG_MISSING` | Tutor still answers from deterministic paths; no silent downgrade and no raw model output on failure (`provider.ts:142-153`); nothing on the mastery/evidence hot path calls it |
| Abuse burst | Per-IP token buckets, map bounded at 10k (`limits.ts:11-18`) | 429 + `Retry-After` on every guarded route; the 429s are designed backpressure, measured at c=50 with zero 5xx (EVALS.md) |

## What is honest about the limits (2026-09-10)

- Persistence: Blob (`viva-data`, private, iad1) is LIVE in production and
  redeploy-persistent (event read back after a full redeploy, same demo
  identity). File mode remains per-instance and ephemeral on serverless —
  readiness names whichever backend is active. Postgres (FTS/vector) stays
  the documented upgrade; not provisioned.
- Privy is wired at the boundary and the demo needs no account by design.
- Retrieval is FTS-ranked on Postgres, lexical in file and Blob modes;
  embeddings are a configured upgrade, not a hidden dependency.
- "Mastery %" is a *VIVA estimate*, exam verdicts are *practice assessment*,
  no zero-hallucination or brain-modelling claim is made anywhere.
- Live voice is configured in production (README records two live Sync
  proofs, 0.996 confidence, real `session_id`); where `ASSEMBLYAI_API_KEY`
  is absent (e.g. local dev) the mic path 503s with `NO_API_KEY` and the UI
  offers typing. Nothing is faked.
