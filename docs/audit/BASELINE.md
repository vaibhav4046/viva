# BASELINE, VIVA

Audit date: 2026-09-28. Every claim below is backed by a command, a file path,
or a live HTTP response captured at audit time. Nothing here is estimated.

## 1. Workspace topology

`D:\project` is a monorepo of ~100 independent subprojects (root `package.json`
is `cineverse`, a Vite app). Each subproject carries its own git history.

| Product | Path | Git | State |
|---|---|---|---|
| VIVA | `D:\project\viva` | own repo, branch `main`, remote `github.com/vaibhav4046/viva` | exists, mature, deployed |
| DOGFOOD |, |, | **does not exist anywhere on this machine** |

## 2. VIVA architecture map (verified)

| Property | Value | Evidence |
|---|---|---|
| Framework | Next.js `16.3.4` (App Router), React `19.2.8` | `package.json` |
| Language | TypeScript 5, `strict` | `tsconfig.json` |
| Styling | Tailwind CSS v4 (`@tailwindcss/postcss`) | `package.json`, `postcss.config.mjs` |
| Data | Postgres via `pg` when `DATABASE_URL` set, else per-instance file store | `src/lib/store/index.ts:153` |
| Auth | None. HttpOnly cookie identity, per-browser learner | `tests/auth-cookie.test.ts` |
| Motion | `motion` (Framer Motion) v13 + `three` types | `package.json` |
| Deployment | Vercel, `https://viva-five-murex.vercel.app` | live probe |
| Deps | 9 runtime, 14 dev, a genuinely small surface | `package.json` |

### Routes (23 API routes, 7 pages)

Pages: `/`, `/connect`, `/demo`, `/exam`, `/map`, `/memory`, `/study`, `/subjects`, `/today`.

API groups: `voice` (`stream-token`, `transcribe`, `telemetry`, `warm`),
`study/turn`, `subjects/create`, `exam/*`, `teachback/*`, `learner/*`,
`mcp/*`, `sources`, `courses`, `health`, `health/ready`, `events/compile`.

### AssemblyAI integration, what is actually wired

This is the most important finding in the audit, and it is **not** what the
brief assumed.

| Capability | Implemented? | Evidence |
|---|---|---|
| AssemblyAI **Dictation** beta endpoint | YES, server-side | `POST https://dictation.assemblyai.com/v1/transcribe/live`; `.env.local` `ASSEMBLYAI_DICTATION_URL`; `mode: "dictation"` in live health |
| `keyterms_prompt` | YES, per subject | `src/lib/assemblyai*`, `README.md:48` |
| `stt_prompt` (recent turns) | YES | `README.md:51` |
| `llm_instruction` (filler removal, hedge retention) | YES | `README.md:55` |
| `confidence` surfaced to UI | YES | live response `confidence: 0.9873…` |
| Universal-Streaming v3 websocket, live partial words | YES, browser-side | `wss://streaming.assemblyai.com/v3/ws`, token from `/api/voice/stream-token` |
| Sync API fallback | YES | `ASSEMBLYAI_TRANSCRIPTION_MODE` |
| One mic → two consumers via single AudioWorklet | YES | `README.md:69-71` |
| **Voice Agent API** (barge-in, native turn detection, server-side tool calls) | **NO** | no `/v2/agent` or `/v1/agent` reference anywhere in `src/` |
| **Barge-in / interruption** | **NO** | push-to-talk capture, release-to-transcribe; no agent speech to interrupt |
| **TTS / spoken agent output** | **NO** | `ELEVENLABS_API_KEY` present in `.env.local` but unreferenced in `src/` |

**Consequence:** VIVA is a *dictation* product. The brief's requirements for
barge-in, native turn detection, agent-initiated tool calls and spoken replies
are **greenfield**, not repairs. The push-to-talk model means there is no
agent-speaking phase to interrupt.

## 3. Test state (measured, not claimed)

```
npm run typecheck   → PASS, 0 errors
npm test            → 63 files, 967 passed, 1 skipped, 968 total, 10.31s
```

No test failures. The suite is unusually well-targeted for its size: it
includes genuine adversarial tests, not just coverage, 

- `tests/idor.test.ts`, `tests/security-hardening.test.ts`, `tests/security-ssrf.test.ts`, `tests/security-delete.test.ts`
- `tests/claim-recall.test.ts` (51 tests), proves the model contradicts itself
  under 0.8% of its own true sentences
- `tests/voice-silence-guard.test.ts`, `tests/voice-spoof-bucket.test.ts`
- `tests/claim-check.test.ts`, enforces "no citation without a passage"
- `tests/provider-failover.test.ts`, `tests/provider-health.test.ts`
- `tests/store-pg-isolation.test.ts`, `tests/store-degradation.test.ts`

Note: `tests/assemblyai-live.test.ts` requires a real key and is not part of the
default run, the 1 skip is expected.

**Honest weakness:** there is no test that exercises a *live* AssemblyAI
connection in CI. The live-path evidence in the README is from manual probes
recorded on 2026-09-13, and the README is admirably careful to state the
spread rather than a single number.

## 4. Build state

`npm run build` was not run during this audit pass (typecheck + tests + live
probes were run first). `next build` output exists from prior sessions
(`.next/`, `.next-live/`), indicating it has built successfully before. **A
clean build is not yet re-verified today and must not be claimed.**

## 5. Deployment state, DEFECTIVE (P0)

Live probe, 2026-09-28T18:20:21Z:

```json
{"ready":true,"durable":true,"degraded":false,
 "transcription":{"configured":true,"mode":"dictation"},
 "provider":{"configured":true,"credentials":10,"model":"openai/gpt-oss-120b","usable":true},
 "database":{"ok":false,"durable":false,"backend":"postgres","detail":"unreachable"},
 "store":{"mode":"ephemeral"}}
```

This response is **self-contradictory** and the contradiction is a real code
bug, not a stale deployment:

- `database.durable` is `false` and `store.mode` is `ephemeral`
- but top-level `durable` is `true` and `degraded` is `false`

**Root cause.** `src/app/api/health/ready/route.ts` probes the database
**twice**:

1. line 22, `const database = await dbStatus();`
2. line 43, `const { durable } = await storeDurability();`, and
   `storeDurability()` internally calls `dbStatus()` **again**
   (`src/lib/store/index.ts:140`)

Two independent probes of a failing connection pool. When the database is
flapping, the first probe reports unreachable and the second reports reachable.
The operator-visible `database` block and the top-level `durable` flag are
therefore derived from *different* samples and can disagree. The endpoint whose
entire job is honest disclosure is the one place that cannot be trusted.

**Why this is P0 and not cosmetic:** the README's headline durability claim, 
"The deployment above runs on Postgres and `GET /api/health/ready` reports
`durable: true`, so a map survives a redeploy" (`README.md:263-264`), is
**false against production right now.** The database is unreachable, so a
learner map does *not* survive a redeploy. A judge who checks the documented
durability claim finds it broken.

**Fix:** probe once, derive both fields from the single result. See §8.

## 6. What works / what is fake / what is broken

### Genuinely works (verified or well-evidenced)
- Server-side AssemblyAI call; the API key never reaches the browser
  (enforced by `tests/voice-token-identity.test.ts`).
- Grounded citation: a reply cannot cite a passage that was not retrieved
  (`tests/claim-check.test.ts`).
- Mastery is computed by a pure reducer, never written by a model
  (`src/lib/mastery.ts`).
- Honest degradation: no key → typed input still works, honest 503 from the mic.
- Degraded-store latch with a cooldown re-probe (`src/lib/store/index.ts:66`).
- README is unusually honest: it quotes four superseded latency numbers and
  tells the reader to take the spread, and it lists screen-reader contrast as
  *unadjudicated* rather than verified.

### Fake / overstated
- `README.md:263-264` durability claim, false in production today (§5).
- **Screen-reader accessibility**, `README.md:269-278` states this correctly
  itself: axe reports 0 serious violations but returns **189 "needs review"**
  results, 185 of them colour contrast. Contrast is *unadjudicated*, not
  passing. Any claim of "accessible" is unsupported.
- Non-English accuracy, two synthesised clips only; the live Hindi line was
  "badly wrong" (`README.md:266-272`).

### Broken
- Database unreachable in production (§5).
- `.env.local` contains **live secrets** (AssemblyAI key, 10 LLM fallback
  credentials, a 149-char `DATABASE_URL`, an ElevenLabs key, `MCP_TOKEN_SECRET`).
  It is gitignored, **verify** with `git check-ignore` before any push, and
  never let it reach a public repo.
- `scripts/e2e-golden.py` is modified and uncommitted in the working tree.

## 7. Dead code / vibe-code debt
- `ELEVENLABS_API_KEY` in `.env.local` is unreferenced in `src/`, a
  half-wired spoken-output path.
- `.data/` holds **470** `demo_*.json` session files, 3 distinct sizes
  (229 / 991 / 6397 bytes) suggesting repeated identical seeding runs.
- `.viva/` holds multiple overlapping QA screenshot rounds
  (`round-1/2/3`, `shots/`, `ui/shots/`, `_judgeshots/`), accumulated debris
  that inflates the repo.
- `VIVA_MASTER_PROMPT.md` is 49 KB of instruction text at the repo root.

## 8. Highest-value opportunities (ranked, for a 48-hour window)

1. **Fix the readiness double-probe** (§5). Small, provable, restores trust in
   the single endpoint a judge is most likely to check.
2. **Fix or retract the durability claim** in the README so it matches reality.
3. **Re-verify a clean build**, it has not been re-run today.
4. **Adjudicate contrast**, or state the limit honestly. 185 unresolved contrast
   results is the largest a11y liability and it is cheap to measure and fix.
5. **Do not** begin a Voice Agent API / barge-in / tools rebuild on this
   timeline. See §9.

## 9. Scope reality check (the decisive finding)

The AssemblyAI Voice Agent Hackathon runs **Sep 1-30, 2026** (lablab.ai,
$10,000 pool: $5k cash + $5k AAI credits). **Today is 2026-09-28, the window
closes in roughly 48 hours.**

The brief asks for, on VIVA: Voice Agent API session state machine, barge-in
with flushed output, typed tool registry, verification layer, layered persistent
memory, self-improving loop, model routing, a premium GSAP UI rebuild, a
landing page, mobile, a11y, instrumentation and benchmarks, 6 test directories,
a 90-150 s golden demo, a recorded fallback, a video package, and submission
artifacts.

None of that exists. Barge-in, native turn detection, agent speech and tool
calls are all greenfield. This is a multi-week build, not a 48-hour one.

**Recommendation:** treat the existing, working, honest VIVA as the submission
and spend the remaining window on (1) credibility repairs, (2) the acceptance
and submission artifacts, and (3) a *small* number of high-signal additions
that use the Voice Agent API if time genuinely permits. Do not start a rewrite
that cannot finish, a broken half-migration is strictly worse than a working
product with documented limits.

## 10. Reproduction commands for this baseline

```powershell
cd D:\project\viva
npm run typecheck                                    # PASS, 0 errors
npm test                                             # 63 files / 967 pass / 1 skip
Invoke-WebRequest https://viva-five-murex.vercel.app/api/health/ready -UseBasicParsing
git log -1 --format="%h %ad" --date=iso              # 10f24bc 2026-09-13
```
