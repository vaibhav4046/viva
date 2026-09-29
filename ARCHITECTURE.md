# VIVA RedTeam — architecture

One idea shapes everything below: **the voice agent proposes words; the server decides what the document says about them.** The agent is a language model and is allowed to be wrong about anything except the verdict, because it never gets to write one.

```
browser                                      our server                       AssemblyAI
───────                                      ──────────                       ──────────
mic ─ AudioWorklet (24 kHz PCM16) ──────────────────────────────────────────▶ wss://agents.assemblyai.com/v1/ws
                                                                                   ▲            │ reply.audio, transcript.*,
GET /api/voice-agent/token ──▶ mint token (server-held key, ≤600 s) ─▶ POST /v1/token             │ tool.call, reply.done
        ◀── short-lived token only                                                 │            ▼
socket client + state machine ◀───────────────────────────────────────────────────┘
   │  tool.call ──▶ POST /api/redteam/tool ──▶ runTool ─▶ claim engine ─▶ ledger ─▶ store
   │  reply.done(interrupted) ─▶ flush playback ─▶ POST /api/redteam/turn {interrupted}
   │  transcript.user (final) ──▶ POST /api/redteam/turn {user_final}
   ▼
controller (no React) ── renders ──▶ /redteam: Source · Voice review · Defensibility map · Timeline · Report
```

## What is AssemblyAI's and what is ours

| AssemblyAI Voice Agent (the service) | VIVA (this repo) |
|---|---|
| Speech-to-text, native turn detection, the language model, text-to-speech, semantic barge-in | The document, the claim engine, the ledger, the tools the agent may call, the screen |
| Emits `transcript.user`, `reply.audio`, `reply.done{status}`, `tool.call`, `session.error` | Handles each one in `src/lib/redteam/machine.ts` and `socket.ts` |
| Holds a session for 30 s after a drop | Resumes it with `session.resume` and a fresh token, or starts a new one and keeps the ledger |

AssemblyAI is structurally necessary: the product *is* a spoken cross-examination that can be interrupted. Remove the Voice Agent and what is left is the typed fallback, which is deliberately labelled "Typed — not the Voice Agent".

## Modules

| Path | Job |
|---|---|
| `src/lib/redteam/document.ts` | Text → sections and one-sentence passages. Passage ids are `<hash(owner,title,text)>.<n>`, so two documents never share an id. |
| `src/lib/redteam/evaluate.ts` | The claim engine. `evaluateClaim(claim, doc) → Verdict`. Pure. Plus `enforceGrounding`, the second lock. |
| `src/lib/redteam/text.ts` | Stemming, compounds (`fail over` → `failover`), negation and "planned/TBD" cues, opposite qualifiers, numbers with units, and `neutralise` for instruction-shaped text. |
| `src/lib/redteam/session.ts` | The Claim Ledger and every function that changes it. No function takes a status as input. |
| `src/lib/redteam/challenge.ts` | What to ask next. Seven kinds; three modes are three weightings of one policy. |
| `src/lib/redteam/report.ts` | The Defensibility Report. Sections, not a score. |
| `src/lib/redteam/tools.ts` | The six agent tools: typed input (strict zod), typed output, error results instead of throws. |
| `src/lib/redteam/machine.ts` | The 12-state protocol machine and the tool-result queue. Pure. |
| `src/lib/redteam/socket.ts` | The WebSocket client: handshake, degrade-and-retry, resume, clean end. |
| `src/lib/redteam/controller.ts` | Glue with no React: protocol events in, server calls out, one ordered queue. |
| `src/lib/redteam/store.ts` | Sessions in Postgres if `DATABASE_URL` is set, else memory + temp dir. Ownership enforced here. |
| `src/app/api/redteam/*`, `src/app/api/voice-agent/token` | The routes. All go through `handle()`: identity, rate limit per class, body cap, ownership. |
| `src/components/redteam/*`, `src/app/redteam/*` | The screen. |

## The claim engine, and its honest ceiling

`evaluateClaim` reads the document's own words. It does not call a model. For each clause of a claim it finds passages that share the subject, then decides `support`, `contradict`, `partial` or `none` from:

- **negation and "not yet"** in the passage's clause (`is not configured`, `not implemented`, `planned`, `TBD`)
- **opposite qualifiers**: automatic/manual, sync/async, strong/eventual, single/multiple, and so on
- **numbers with their unit**: "up to 5 times" against "up to 3 times"

A compound claim is split so the report can say *which part* has evidence. Statuses:

| Status | Means | Needs |
|---|---|---|
| SUPPORTED | a passage says it | ≥ 1 real passage id |
| CONTRADICTED | a passage says otherwise | ≥ 1 real contradicting passage id |
| PARTIAL | part of it is backed | ≥ 1 real passage id, and `parts[]` says which |
| UNSUPPORTED | relevant evidence was not found | none — worded "I could not find this", never "this is false" |
| UNRESOLVED | nothing checkable was said (fragment, "maybe…") | none |

**Ceiling.** It does not understand paraphrase it has no shared words for. Such a claim comes back UNSUPPORTED, which errs toward saying less. It is a floor a model could sit on top of (choose among the given passage ids, quote must be a substring), and it is not one today.

## Grounding is enforced twice

1. `evaluateClaim` only ever copies ids out of `doc.passages`.
2. `enforceGrounding` re-checks every verdict before it reaches the ledger: SUPPORTED with no evidence becomes UNSUPPORTED; CONTRADICTED with no contradicting passage is downgraded; ids the document did not mint are dropped.

And the agent cannot bypass either: tool schemas are `.strict()` and contain no status, verdict or evidence field. `normalized_claim` (the model's tidy-up of what you said) is accepted only if it adds no qualifier, negation or number you did not say (`faithfulNormalisation`); otherwise your own words are checked.

## The state machine

`IDLE → CONNECTING → READY → LISTENING ⇄ USER_SPEAKING → THINKING → CHECKING_SOURCE → SPEAKING → INTERRUPTED → …`, plus `RECOVERING`, `ERROR`, `ENDED`. A table (`TRANSITIONS`) says what may follow what; an illegal move is refused rather than drawn. The label on screen is a function of the state (`status.ts › stateLine`), so nothing can say "thinking" for a state the protocol is not in.

Protocol rules the machine encodes (from the Voice Agent events reference):

- `tool.result` is sent when `reply.done` is the latest event, never straight back on `tool.call`.
- `reply.done` with `status: "interrupted"`: flush playback, **discard pending tool results from that reply**, count the interruption. A result computed for a reply the user abandoned never reaches the next one.
- `transcript.user.delta` carries the full text so far; it replaces, never appends.
- After delivering tool results the machine is `THINKING`, not `LISTENING`: the service is composing the spoken answer.
- `input.speech.started` may arrive before the `reply.done(interrupted)` that explains it, so `SPEAKING → USER_SPEAKING` is legal.

## Barge-in changes application state

Not a checkbox. On `reply.done(interrupted)`:

1. `flushAudio()` — every scheduled `AudioBufferSourceNode` is stopped (`audio.ts`).
2. The machine forces `INTERRUPTED` and clears the tool queue.
3. `POST /api/redteam/turn {interrupted}` marks the claim being explained `awaitingCorrection`; the card shows *cut off · awaiting your correction* and the timeline gets an **Interrupted** entry.
4. The next finished user transcript that reads as a correction (`I meant…`, `Wait, …`) is sent to `/turn {user_final}` **by the browser, in order**. The server re-searches the document with the corrected wording and moves the *same* ledger row, e.g. CONTRADICTED → SUPPORTED, and the card changes band.
5. The agent's own `reevaluate_claim` call arrives afterwards and lands on the same revision (idempotent).

Steps 3 and 4 come from protocol events, not from the model choosing to call a tool. If the model is slow or forgets, the map still moves. `redteam-golden.test.ts` drives this with a fake socket and the real routes, including the case where the model never calls a tool.

## Failure handling

| Failure | Behaviour |
|---|---|
| No API key / token mint fails | Plain sentence, non-retryable if config, "type instead" always offered |
| Mic denied / no worklet / offline | Plain sentence from `voiceMessage()`; typed path runs the same ledger |
| `session.update` refused (unknown field) | Retry with fewer optional fields (level 1: VAD threshold + keyterms; level 2: none), then a fatal error. Surfaced in the UI as "some voice settings were refused". |
| Socket drops | `RECOVERING`; `session.resume` with a **fresh token**; on `session_not_found/expired/forbidden`, a fresh session with a "your review is intact" greeting. The ledger lives server-side, so nothing is lost. |
| Stale socket after a retry | Unhooked before it is closed; its late frames and `onclose` are ignored |
| Page reload | `GET /api/redteam/session/:id` restores ledger and timeline; the greeting says "Picking up where we left off" |
| Database down | Sessions fall back to this instance's memory/disk and the review continues |

## Security

- **Key handling.** `ASSEMBLYAI_API_KEY` is read in one route (`/api/voice-agent/token`), sent as the `Authorization` header to AssemblyAI, and never returned. Tokens are minted per connection, ≤ 600 s. Tests assert the key is absent from every RedTeam response and from upstream error bodies.
- **CSP.** `connect-src` allows exactly `wss://agents.assemblyai.com` in addition to the existing streaming host.
- **Ownership.** Identity is the existing HttpOnly cookie. `getSession(userId, id)` and every SQL statement are scoped by user; a session that is someone else's answers exactly like one that does not exist (no id probing).
- **Documents are data.** The document never enters the system prompt (only a sanitised one-line title does). Passages reach the agent only inside tool results, with instruction-shaped phrases (`ignore previous instructions`, `you are now…`, `system prompt`) replaced. A test feeds a hostile document and asserts it cannot change a verdict or end the session.
- **XSS.** Passages render as React text nodes. The browser test pastes `<script>`/`<img onerror>` and asserts nothing runs and no such element exists.
- **Rate limits.** Per class *and* per address/cookie: 10 review creations a minute, 30 tool/turn calls. (A shared-key bug that let creations starve tool calls was found by the browser run and is regression-tested.)
- **Input.** Strict zod on every body, 96 KB cap, 60 000-character documents, ids checked against a UUID pattern before SQL.

## What this is not

Not a model-graded verdict, not multi-agent, no vector index, no accounts. Sessions expire after six hours. Voice is English-only in the shipped config. Not verified against a real Postgres (tested against a fake `pg` that stores rows and enforces the parameters).
