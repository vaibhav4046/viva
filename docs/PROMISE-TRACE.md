# Promise trace

The promise: "Give VIVA your material. Close the notes and talk. VIVA asks questions that adapt, catches a misconception against your own pages, lets you interrupt, remembers what you got wrong, and hands you tomorrow's revision plan."

This file breaks the promise into seven clauses. Each row names the code, the test, the live evidence and the demo moment. The status is computed from what exists in the repository at branch `oral`, commit `c21726e`, on 2026-09-29, and re-computed for clauses 3 and 6 on branch `wt/core2` at commit `96074cb` (clause 1 and 7 copy corrected in the commit after it). It is not a forecast.

Status rules:

- **green**: code path exists, its tests pass when run alone, live evidence from the real AssemblyAI service exists, and a judge can see it in the Plan A take on today's screen.
- **amber**: the mechanism exists and is tested, but part of the clause is missing, unmeasured, or not yet visible on screen. Public copy may state only the part that is green.
- **red**: no test or no live evidence proves the clause as worded. The clause must not appear in public copy.

Live evidence in this repository means: the real AssemblyAI Voice Agent API, a Node WebSocket client that runs `src/lib/oral/socket.ts`, and a synthetic learner voice (Windows System.Speech WAV files in `fixtures/audio`), against a local server on port 3101. No browser and no human microphone were involved. Every probe file says so in its `learner` and `transport` fields.

## Summary

| # | Clause | Status |
|---|---|---|
| 1 | Give VIVA your material | amber |
| 2 | Close the notes and talk | amber |
| 3 | Adaptive follow-ups | amber |
| 4 | Misconception caught against source passages | green |
| 5 | Natural interruption | amber |
| 6 | Remembered weaknesses | amber |
| 7 | Tomorrow's revision plan | amber |

Tests were run alone, per clause, on 2026-09-29 (`npx vitest run <files>`). On branch `wt/core2` the oral group passed: `tests/oral-*.test.ts` 14 files, 225 tests, 0 failed; the full suite passed: 80 files, 1228 passed, 1 skipped.

## 1. Give VIVA your material: amber

| Item | Where |
|---|---|
| Code | Upload and paste intake: `src/app/api/subjects/create/route.ts`, `src/lib/intake/*`. Sample course: `src/lib/sample-course.ts` (`course_transformers_w4`), `src/lib/courses/`. |
| Tests | `tests/intake.test.ts`, `tests/intake-sources.test.ts`, `tests/courses.test.ts`, `tests/subjects-create.test.ts`. Run alone: 4 files, 46 tests passed. |
| Live evidence | `docs/evidence/sample-path.2026-09-29.txt`: landing to `/oral` with the sample course, session config loads (200), local production build, 2522 ms from load to the `/oral` URL. |
| Demo moment | 0:15 to 0:35: press "Try a sample exam". |

What is missing:

- After an upload, `/subjects` prints the concept, question and passage counts (`src/app/(app)/subjects/page.tsx`, the "is ready" card). It does not list titles or page numbers.
- The sample path opens `/oral` directly. No screen lists what was ingested.
- Upload has no live evidence against production. Production does not yet run the oral build.

Public copy consequence: the landing sentence "VIVA shows how many passages it read, their titles and page numbers before you start" was not true. `src/app/page.tsx`, step 1, now says that after an upload VIVA shows how many concepts, questions and passages it found.

## 2. Close the notes and talk: amber

| Item | Where |
|---|---|
| Code | `src/app/(app)/oral/page.tsx` (one "Start the exam" button), `src/app/api/voice-agent/token/route.ts` (short-lived token, key stays on the server), `src/lib/oral/socket.ts`, `src/lib/oral/machine.ts`, `src/components/oral/mic.ts`. |
| Tests | `tests/oral-wire.test.ts`, `tests/oral-socket.test.ts`, `tests/oral-machine.test.ts`, `tests/oral-failures.test.ts`, `tests/oral-security.test.ts`, `tests/oral-token-expiry.test.ts`. Run alone (first four): 100 passed. |
| Live evidence | `docs/evidence/probes/oral-live-roundtrip.2026-09-29.json`: session ready median 444 ms, first agent audio median 958 ms, n=3, 2026-09-29. `numbers.json` keys `oral.roundtrip.*`. |
| Demo moment | 0:00 to 0:35 and every later scene: one click, then talk. |

What is missing: the click-to-first-sentence path in a real browser with a real microphone has not been recorded. The probes drive the socket code from Node. `README.md` states the audio path has not run on a phone. The Plan A take is the first browser run that will count. Cold-click timing against production (ledger V13) does not exist because production does not serve `/oral` yet.

## 3. Adaptive follow-ups: amber

| Item | Where |
|---|---|
| Code | `src/lib/oral/next-concept.ts` (`chooseNext`, pure): first question on the weakest concept as a recall question; after an incorrect or partial answer it stays on that concept for at most two questions in a row (recall after incorrect, the next kind after partial); after a correct or unsettled answer it moves to the weakest concept; kinds rotate recall, why, apply; a concept asked three times is skipped while others remain. `src/lib/oral/steering.ts` rebuilds this exam's turns from the stored events and folds the just-checked answer with the learner-map reducer. `src/app/api/oral/tool/route.ts` returns the result as `next_focus` (concept, kind, reason) with every checked answer. `src/lib/oral/prompt.ts` (version `2026-09-29.3`) tells the examiner to ask a question of that kind on that concept. |
| Tests | `tests/oral-next-concept.test.ts` (16), `tests/oral-tool-focus.test.ts` (2, real tool route on a temp file store), `tests/oral-prompt.test.ts` (5). Run alone: 16, 2 and 5 passed. Mutation: with the stay rule disabled, 4 of these tests failed; restored, they passed. |
| Live evidence | `docs/evidence/probes/oral-memory-live.2026-09-29.json`, n=3, 2026-09-29, real AssemblyAI Voice Agent, synthetic learner voice, local server. In 3 of 3 runs the learner's correct positional answer was graded partial, the tool result carried `next_focus` = Positional information, kind why, and the examiner asked a why question about positional encodings next. The spoken question contained the chosen concept's name in 2 of 3 runs; in the third it asked about positional encodings without those two words. |
| Demo moment | 0:35 to 1:15: the answer, then the next question. |

What is still missing: the model chooses the words, so the spoken question follows `next_focus` by instruction and not by construction (2 of 3 name-matched, n=3). The probe drives the socket from Node; no browser take with a human microphone shows it. The screen does not display `next_focus`.

Public copy consequence: "the next question is chosen from your last answer and your weakest concept" is supported. Do not say "adapts to you" without the qualifier that the wording is the model's.

## 4. Misconception caught against source passages: green

| Item | Where |
|---|---|
| Code | `src/lib/oral/verify-claim.ts` (`quoteSpans`: every quoted piece must be an exact substring of the named passage, whitespace-normalised, in order; otherwise the verdict falls back to `not_in_material`), `src/lib/oral/tools.ts` (`verify_claim`), `src/app/api/oral/tool/route.ts`, rules in `src/lib/oral/prompt.ts` (correct only after a `contradicted` verdict, say the page aloud). |
| Tests | `tests/oral-verify-claim.test.ts`, `tests/oral-verify-claim-set.test.ts` (labelled set replay, and a mutation block that changes one word of a quote and expects a downgrade), `tests/oral-tools.test.ts`, `tests/oral-wire.test.ts`. Run alone (first two): 15 passed. |
| Live evidence, tool round trip | `docs/evidence/probes/oral-live-roundtrip.2026-09-29.json`: 3 of 3 runs. The synthetic learner says "I think it runs a single head over the input." The judge returns `contradicted`, page 15, the examiner speaks the quote and "page fifteen". Tool round trip median 2470 ms (`toolCallToResultMs`), n=3. |
| Live evidence, verifier accuracy | `docs/evidence/probes/verify-claim-live-2026-09-29.json`: 54 labelled claims over two courses, judge `openai/gpt-oss-120b`, 0 false `supported`, 0 false `contradicted`, supported precision 1.0 and recall 1.0 (19 of 19), contradicted precision 1.0 and recall 0.889 (24 of 27, the 3 misses were downgraded to `not_in_material`), median judge time 590 ms, p95 2067 ms (n=53 model calls). |
| Demo moment | 1:15 to 1:55: the deliberate misconception. |

Limits that stay attached to this clause: the set is small and was written in this repository; the judge model can be wrong; the quote check proves the words are in the passage, not that the verdict is right. On screen today the correction appears as spoken audio and as transcript text. The passage card and the "Checking page N" state line in the storyboard are not on the `/oral` screen at this commit: the state line reads "Checking your material" (`src/app/(app)/oral/page.tsx`). The UI worker's screen may add them; re-check before recording.

## 5. Natural interruption: amber

| Item | Where |
|---|---|
| Code | `src/lib/oral/socket.ts` (flush playback on `input.speech.started`, drop audio that arrives after the flush; `transcript.agent` with `interrupted: true` also counts as an interruption), `src/lib/oral/machine.ts` (tool-result queue; on an interruption only the dying reply's calls are discarded and an earlier reply's slow call gets an error result; each call id is counted once; a tool result is sent only when `reply.done` is the latest event and never onto a new session; the screen leaves INTERRUPTED when the next reply starts and shows the student talking over the examiner). |
| Tests | `tests/oral-wire.test.ts` ("discards a queued result when the student barges in", "drops a result that resolves after the interruption", "keeps the mic open"), `tests/oral-machine.test.ts`, `tests/oral-socket.test.ts`, `tests/oral-mic.test.ts`. Run alone: oral-wire and oral-machine 62 passed; oral-socket and oral-mic 71 passed. |
| Live evidence | `docs/evidence/probes/oral-live-bargein.2026-09-29.json` and `oral-live-bargein_tool.2026-09-29.json`, 3 of 3 runs each. The probe hands the client a stub in place of audio playback, so it shows that the client calls flush and hands no later chunk to playback; it does not measure how long real audio takes to go silent in a browser. Speech reported a median of 1286 ms after the first loud sample of the learner clip (values 1286, 1768, 1214 ms, n=3); with a tool in flight, 1456 ms (values 1739, 1456, 1316). Stale audio chunks played after the flush: 0 in all 6 runs. Chunks dropped after the flush: 147 to 209 per run. The examiner answers the interruption: "Wait, can you repeat the question?" is followed by the quote again. |
| Demo moment | 1:55 to 2:15: the interruption line. |

Read the number honestly: the 1.3 to 1.5 s is detection latency, the time from the learner's first loud sample to the service reporting speech (`stopFromVoiceOnsetMs` in the evidence file is that interval to the client's flush call). It is not a measured playback stop, and no browser take measures the time to silence. Do not write "instant", "prompt" or "flush 0 ms". A second run (`oral-live-bargein-min_latency-ab.2026-09-29.json`) gave a median of 1454 ms, n=3; the file does not record what differed.

Not proven live, and the reason this clause is amber: discarding a tool result that is still pending when the learner interrupts. The probe for it (`oral-live-interrupt-during-pending-tool-negative.2026-09-29.json`) failed 3 of 3 with "timeout waiting for input.speech.started" and is kept as a negative result. That rule is unit-tested only. In the live tool-plus-interruption runs, `discards` was 0.

That same file records what the service sent when it did interrupt a reply: `transcript.agent` with `interrupted: true`, then `reply.done` with status `completed`, then a new `reply.started`, and no `reply.done` with status `interrupted`. Before commit a02946a the client did nothing on that shape (no flush, no discard, no INTERRUPTED). It now treats the flag as the interruption, and `tests/oral-socket.test.ts` replays that recorded order. That fix has not been re-run against the live service.

## 6. Remembered weaknesses: amber

| Item | Where |
|---|---|
| Code | `src/app/api/oral/tool/route.ts` writes each tool verdict to the learner store (`recordLearning`, folded by `src/lib/mastery.ts`). `src/app/api/oral/session/route.ts` now reads that map for the subject before the exam: `src/lib/oral/learner-brief.ts` builds a brief (touched concepts of this subject, weakest first, or an explicit "none stored" statement, and a warning when the store is the temporary file store), and `buildOralSystemPrompt` and `oralGreeting` in `src/lib/oral/prompt.ts` put it in the prompt and the spoken greeting. The exam opens on the weakest concept by the same ranking `chooseNext` uses. The session config also returns a `memory` block for the screen. |
| Tests | `tests/oral-memory.test.ts` (14): a map folded from a first session gives a second prompt that differs from the first and lists Multi-head attention first; empty map, ephemeral with an empty map, ephemeral with a stored map, all-solid map, other subject's concepts ignored; the session route on a real temp file store gives a different prompt and greeting after two recorded wrong answers, with `VERCEL` set (not durable) and unset (durable). Run alone: 14 passed. Mutation: session route reading an empty map, the route test failed; restored, passed. |
| Live evidence | `docs/evidence/probes/oral-memory-live.2026-09-29.json`, n=3: empty store reports `empty`; two real `verify_claim` calls (contradicted on multi-head attention, page 15; supported on positional information, page 11) seed the map; the next session config reports `stored`, opens on Multi-head attention, and the live service spoke that greeting in 3 of 3 runs. |
| Demo moment | None recorded. Needs two exams in one identity. |

What is still missing: the probe used the file store on a local server. The Postgres path is the same `getMastery` call but was not exercised by this probe. On the deployed URL the stored map lives in Postgres (`/api/health/ready` reported `durable: true`, backend postgres at 23:02 UTC on 2026-09-29, `docs/evidence/live-url-check.2026-09-29.txt`), and that deploy predates this branch, so the steering is not live there until the release deploy. With no `DATABASE_URL`, or on Vercel without a database, history is lost on restart and the prompt and screen say so. The map holds evidence from the written study loop as well as oral exams, and the prompt says "your recorded answers", not "your earlier exams".

Public copy consequence: "the exam opens on the concept your recorded answers show as weakest" is supported. "Remembers you across sessions" needs the durable store and the release deploy.

## 7. Tomorrow's revision plan: amber

| Item | Where |
|---|---|
| Code | `src/lib/oral/debrief.ts` (`buildDebrief`: strong, shaky, weak from the session record, citations re-checked, plan from `selectDailyPath` in `src/lib/planner.ts`), `src/app/api/oral/debrief/route.ts` (returns the debrief and a printable text form). |
| Tests | `tests/oral-debrief.test.ts`, 8 passed: standing rules, misconception with verbatim quote and page, fabricated quote dropped, plan within ten minutes with the weak concept in it, empty session. |
| Live evidence | None. No live session was fed to the debrief route. |
| Demo moment | 2:15 to 2:40: the debrief sheet. |

What is missing: no client code calls `/api/oral/debrief` at this commit (`grep` over `src` finds the route and the library only), so no debrief sheet is shown after an exam. The debrief is derived, not stored, so "saved" is true only through the learner map, with the durability limit from clause 6. The landing sentence "It prints" and "You leave with a sheet" depend on the UI worker's sheet.

Public copy consequence: state the debrief only if the sheet is on screen in the take. Do not say "saved". The landing sentence for step 3 no longer says "each tied to a page" (only checked claims carry a page) and says the sheet prints or saves as a PDF, which is true once `wt/ui2` (it renders `/api/oral/debrief` and has the print button) is merged.

## Clauses that are not demonstrable today, and copy to remove

| Clause | Remove from public copy | Where the words live |
|---|---|---|
| 3 Adaptive follow-ups | "adapts to you" without the qualifier that the examiner's wording is the model's | none in `src/app/page.tsx`; check `docs/demo/SCRIPT.md` |
| 6 Remembered weaknesses | "remembers you" until the release deploy runs on the durable store | none in the landing page; keep it out of the submission until then |
| 1 (part) | "titles and page numbers before you start" | removed from `src/app/page.tsx`, step 1; the uploads card shows concept, question and passage counts |
| 7 (part) | "each tied to a page" and "It prints" | `src/app/page.tsx`, step 3, now says what the sheet holds and that it prints or saves as a PDF. That is true only once branch `wt/ui2` (the debrief screen and its print button) is merged |

`docs/SUBMISSION.md` and `docs/deck/` follow this table.
