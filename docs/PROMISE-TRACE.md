# Promise trace

The promise: "Give VIVA your material. Close the notes and talk. VIVA asks questions that adapt, catches a misconception against your own pages, lets you interrupt, remembers what you got wrong, and hands you tomorrow's revision plan."

This file breaks the promise into seven clauses. Each row names the code, the test, the live evidence and the demo moment. The status is computed from what exists in the repository at branch `oral`, commit `c21726e`, on 2026-09-29. It is not a forecast.

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
| 3 | Adaptive follow-ups | red |
| 4 | Misconception caught against source passages | green |
| 5 | Natural interruption | green |
| 6 | Remembered weaknesses | red |
| 7 | Tomorrow's revision plan | amber |

Tests were run alone, per clause, on 2026-09-29 (`npx vitest run <files>`), and the full oral group passed: `tests/oral-*.test.ts` 11 files, 193 tests, 0 failed.

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

Public copy consequence: the landing sentence "VIVA shows how many passages it read, their titles and page numbers before you start" (`src/app/page.tsx`, step 1) is not true today. State only the passage count for uploads. Owned by the UI worker; listed in the removal list at the end.

## 2. Close the notes and talk: amber

| Item | Where |
|---|---|
| Code | `src/app/(app)/oral/page.tsx` (one "Start the exam" button), `src/app/api/voice-agent/token/route.ts` (short-lived token, key stays on the server), `src/lib/oral/socket.ts`, `src/lib/oral/machine.ts`, `src/components/oral/mic.ts`. |
| Tests | `tests/oral-wire.test.ts`, `tests/oral-socket.test.ts`, `tests/oral-machine.test.ts`, `tests/oral-failures.test.ts`, `tests/oral-security.test.ts`, `tests/oral-token-expiry.test.ts`. Run alone (first four): 100 passed. |
| Live evidence | `docs/evidence/probes/oral-live-roundtrip.2026-09-29.json`: session ready median 444 ms, first agent audio median 958 ms, n=3, 2026-09-29. `numbers.json` keys `oral.roundtrip.*`. |
| Demo moment | 0:00 to 0:35 and every later scene: one click, then talk. |

What is missing: the click-to-first-sentence path in a real browser with a real microphone has not been recorded. The probes drive the socket code from Node. `README.md` states the audio path has not run on a phone. The Plan A take is the first browser run that will count. Cold-click timing against production (ledger V13) does not exist because production does not serve `/oral` yet.

## 3. Adaptive follow-ups: red

| Item | Where |
|---|---|
| Code | One instruction in the examiner prompt: "After each answer, choose the weakest concept so far for the next question. Alternate recall, why, and application questions." (`src/lib/oral/prompt.ts`). The `grade_my_answer` tool returns a grade the model can read. |
| Tests | `tests/oral-prompt.test.ts` pins the prompt text with a snapshot. It proves the sentence is in the prompt. It does not prove any question changed because of an answer. |
| Live evidence | None. The live probes run one to three turns and check for the tool call and the spoken citation, not the choice of the next question. |
| Demo moment | 0:35 to 1:15: the correct answer, then the next question. |

Nothing in the code computes the weakest concept. The server does not send stored weakness to the model (the session route builds the prompt from the subject, the concept names and the sources only). The behaviour rests on the model following one sentence.

Public copy consequence: do not write "adaptive". Say "the examiner is instructed to pick the weakest concept so far". If the Plan A take visibly shows the next question following the previous answer, quote that take instead, with its date. Until then this clause is not demonstrable.

## 4. Misconception caught against source passages: green

| Item | Where |
|---|---|
| Code | `src/lib/oral/verify-claim.ts` (`quoteSpans`: every quoted piece must be an exact substring of the named passage, whitespace-normalised, in order; otherwise the verdict falls back to `not_in_material`), `src/lib/oral/tools.ts` (`verify_claim`), `src/app/api/oral/tool/route.ts`, rules in `src/lib/oral/prompt.ts` (correct only after a `contradicted` verdict, say the page aloud). |
| Tests | `tests/oral-verify-claim.test.ts`, `tests/oral-verify-claim-set.test.ts` (labelled set replay, and a mutation block that changes one word of a quote and expects a downgrade), `tests/oral-tools.test.ts`, `tests/oral-wire.test.ts`. Run alone (first two): 15 passed. |
| Live evidence, tool round trip | `docs/evidence/probes/oral-live-roundtrip.2026-09-29.json`: 3 of 3 runs. The synthetic learner says "I think it runs a single head over the input." The judge returns `contradicted`, page 15, the examiner speaks the quote and "page fifteen". Tool round trip median 2470 ms (`toolCallToResultMs`), n=3. |
| Live evidence, verifier accuracy | `docs/evidence/probes/verify-claim-live-2026-09-29.json`: 54 labelled claims over two courses, judge `openai/gpt-oss-120b`, 0 false `supported`, 0 false `contradicted`, supported precision 1.0 and recall 1.0 (19 of 19), contradicted precision 1.0 and recall 0.889 (24 of 27, the 3 misses were downgraded to `not_in_material`), median judge time 590 ms, p95 2067 ms (n=53 model calls). |
| Demo moment | 1:15 to 1:55: the deliberate misconception. |

Limits that stay attached to this clause: the set is small and was written in this repository; the judge model can be wrong; the quote check proves the words are in the passage, not that the verdict is right. On screen today the correction appears as spoken audio and as transcript text. The passage card and the "Checking page N" state line in the storyboard are not on the `/oral` screen at this commit: the state line reads "Checking your material" (`src/app/(app)/oral/page.tsx`). The UI worker's screen may add them; re-check before recording.

## 5. Natural interruption: green

| Item | Where |
|---|---|
| Code | `src/lib/oral/socket.ts` (flush playback on `input.speech.started`, drop audio that arrives after the flush), `src/lib/oral/machine.ts` (tool-result queue, discard on `reply.done` with status `interrupted`). |
| Tests | `tests/oral-wire.test.ts` ("discards a queued result when the student barges in", "drops a result that resolves after the interruption", "keeps the mic open"), `tests/oral-machine.test.ts`. Run alone: 41 passed. |
| Live evidence | `docs/evidence/probes/oral-live-bargein.2026-09-29.json` and `oral-live-bargein_tool.2026-09-29.json`, 3 of 3 runs each. Playback flush 0 ms after the service reported speech. Speech reported a median of 1286 ms after the first loud sample of the learner clip (values 1286, 1768, 1214 ms, n=3); with a tool in flight, 1456 ms (values 1739, 1456, 1316). Stale audio chunks played after the flush: 0 in all 6 runs. Chunks dropped after the flush: 147 to 209 per run. The examiner answers the interruption: "Wait, can you repeat the question?" is followed by the quote again. |
| Demo moment | 1:55 to 2:15: the interruption line. |

Read the number honestly: the 1.3 to 1.5 s is the provider's detection of speech after the learner starts. VIVA's own part, the flush, is 0 ms. Do not write "instant" or "prompt". A second run (`oral-live-bargein-min_latency-ab.2026-09-29.json`) gave a median of 1454 ms, n=3; the file does not record what differed.

Not proven live: discarding a tool result that is still pending when the learner interrupts. The probe for it (`oral-live-interrupt-during-pending-tool-negative.2026-09-29.json`) failed 3 of 3 with "timeout waiting for input.speech.started" and is kept as a negative result. That rule is unit-tested only. In the live tool-plus-interruption runs, `discards` was 0.

## 6. Remembered weaknesses: red

| Item | Where |
|---|---|
| Code | `src/app/api/oral/tool/route.ts` writes each tool verdict to the learner store with `recordLearning` (same event shape as the written study loop, folded by `src/lib/mastery.ts`). |
| Tests | `tests/mastery.test.ts`, `tests/daily-path.test.ts`, `tests/store.test.ts`. Run alone with `tests/oral-debrief.test.ts`: 32 passed. They prove the fold and the planner. No test drives the oral tool route and then reads the map. |
| Live evidence | None for persistence across two sessions. |
| Demo moment | None recorded. |

Two gaps make the clause as worded untrue:

1. The next oral session does not read stored weakness. `src/app/api/oral/session/route.ts` gives the model concept names, not mastery.
2. Persistence needs `DATABASE_URL`. Without it storage is a file on the server's temporary disk and is wiped on restart (`docs/evidence/data-inventory.md`, `README.md` known limits). The 2026-09-28 baseline recorded the production database as unreachable, and production has not been redeployed with `/oral`.

Public copy consequence: remove "remembered weaknesses shape the next session". True and allowed: "each checked answer is written to your map, which drives the Today page; on the demo server this resets on restart".

## 7. Tomorrow's revision plan: amber

| Item | Where |
|---|---|
| Code | `src/lib/oral/debrief.ts` (`buildDebrief`: strong, shaky, weak from the session record, citations re-checked, plan from `selectDailyPath` in `src/lib/planner.ts`), `src/app/api/oral/debrief/route.ts` (returns the debrief and a printable text form). |
| Tests | `tests/oral-debrief.test.ts`, 8 passed: standing rules, misconception with verbatim quote and page, fabricated quote dropped, plan within ten minutes with the weak concept in it, empty session. |
| Live evidence | None. No live session was fed to the debrief route. |
| Demo moment | 2:15 to 2:40: the debrief sheet. |

What is missing: no client code calls `/api/oral/debrief` at this commit (`grep` over `src` finds the route and the library only), so no debrief sheet is shown after an exam. The debrief is derived, not stored, so "saved" is true only through the learner map, with the durability limit from clause 6. The landing sentence "It prints" and "You leave with a sheet" depend on the UI worker's sheet.

Public copy consequence: state the debrief only if the sheet is on screen in the take. Do not say "saved".

## Clauses that are not demonstrable today, and copy to remove

| Clause | Remove from public copy | Where the words live |
|---|---|---|
| 3 Adaptive follow-ups | "adapts", "the next question depends on your answer" | check `src/app/(app)/oral/page.tsx` description and any deck or submission text |
| 6 Remembered weaknesses | "remembers what you got wrong and shapes your next session" | not in the landing page today; keep it out of the submission |
| 1 (part) | "titles and page numbers before you start" | `src/app/page.tsx`, step 1 |
| 7 (part) | "It prints", "You leave with a sheet" until the sheet ships | `src/app/page.tsx`, step 3 |

`docs/SUBMISSION.md` and `docs/deck/` follow this table. They do not claim any of the four items above.
