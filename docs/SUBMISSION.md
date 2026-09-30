# Submission: lablab.ai AssemblyAI Voice Agent Hackathon

Prepared 2026-09-29 from branch `oral` at commit `c21726e`. Every claim below points at a file in this repository or a command that reproduces it. Anything the evidence does not support is left out. The four items removed from the public promise are listed in `docs/PROMISE-TRACE.md`.

## What lablab publishes, and what it does not

Read on 2026-09-29 from https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon:

- Dates: September 1 to 30, 2026, online. Registration stays open through the window.
- Prize pool: $10,000 ($5,000 cash and $5,000 in AssemblyAI credits).
- Submission fields, video length limit, deck requirement, judging criteria, tracks and the exact deadline with its timezone: not stated on the page.
- A search-result summary of other pages mentions a video under 5 minutes and 300 MB, a public GitHub repository, and a live demo URL on Vercel or a similar host. That summary is not from lablab's page. It is treated here as a planning limit, and this pack meets it: video plan 2:50, public repository, live URL.

Assumption, recorded because the criteria are unpublished: judging on application of the technology, presentation, business value and originality. The deck and the video are built to those four. If lablab publishes different criteria, re-check this file against them.

## Form fields

### Project title

VIVA Oral

### Tagline

An oral exam on your own lecture notes, checked against your own pages.

### Short description

VIVA Oral asks you exam questions out loud on your own lecture notes, using AssemblyAI's Voice Agent API. When you say something your pages contradict, it looks up the passage, reads you the exact line, and names the page.

### Long description

**The problem.** A student can recognise the right answer on the page and still fail to say it aloud. Flashcards and chat-with-your-PDF tools test recognition. An oral exam tests whether you can explain, and nobody rehearses one alone.

**What it does.** You pick the sample course or paste your own notes. You press Start the exam and talk. The examiner speaks first, asks one question at a time, and listens with AssemblyAI's own turn detection. When you make a claim, the examiner calls a tool, `verify_claim`, that runs on VIVA's server against your passages. If the passages contradict you, the examiner reads back the quoted line, says the page number, and asks you to restate the fact. If the passages do not settle it, the examiner says so and moves on. It does not guess. You can interrupt at any moment. The examiner stops mid-sentence and answers what you said.

**Why the quote can be trusted.** A language model proposes the verdict. Code decides whether the citation is allowed: a quoted line is accepted only if every piece of it is an exact substring of the passage the model named, in order, after whitespace is normalised. A fabricated or altered quote is downgraded to "not in the material". This is tested with a mutation: change one word of a real quote and the verdict is downgraded (`tests/oral-verify-claim-set.test.ts`).

**What it does about your weak concepts.** Before an exam the server reads your stored map for the subject and opens on the weakest concept in it, or says there is no history. After each checked answer, code (`src/lib/oral/next-concept.ts`) picks the next concept and question kind from that verdict and your weakest concept, and hands it to the examiner as `next_focus`. Both are unit-tested and were run live 3 times with a synthetic learner (`docs/evidence/probes/oral-memory-live.2026-09-29.json`).

**What it does not do yet.** The examiner's wording is the model's: it followed `next_focus` by name in 2 of 3 live runs. History survives a restart only on the Postgres store. On the deployed build the debrief sheet may not be on screen. See the limits below and `docs/PROMISE-TRACE.md`.

**Who it is for, and who it is not.** For students revising from their own text notes who want to rehearse explaining out loud. Not for scans without a text layer (there is nothing to quote), not for checking whether your notes are right (it only checks your answer against them), and not a substitute for an examiner's marking.

### Tracks and tags

lablab tracks are not published. Suggested tags: AssemblyAI, Voice Agent API, voice agents, education, tool calling, Next.js, TypeScript.

### Links

| Field | Value |
|---|---|
| Live URL | `[LIVE_URL]` Currently https://viva-five-murex.vercel.app. On 2026-09-29 at 22:30 UTC it served `/oral`, the session config and the token route, but `/privacy`, `/terms` and `/recorded` returned 404, so the deployed build is older than branch `oral`. Deploy the final build, then re-run `node scripts/demo-preflight.mjs`. |
| Repository | https://github.com/vaibhav4046/viva (public; MIT). Branch `oral` must be merged and pushed before the form is submitted. |
| Video | `[VIDEO_URL]` Set after the Plan A take is uploaded. |
| Deck | `docs/deck/viva-oral.pdf` (nine slides, built from `docs/deck/index.html`). |

## How AssemblyAI is used

| Piece | What VIVA does | File |
|---|---|---|
| Voice Agent API | The browser opens a WebSocket to AssemblyAI's Voice Agent endpoint and streams 24 kHz PCM16 microphone audio. The examiner's speech comes back as `reply.audio` frames. | `src/lib/oral/socket.ts`, `src/components/oral/mic.ts` |
| Token flow | The server route `GET /api/voice-agent/token` calls AssemblyAI's `/v1/token` with the account key and returns a token that lives at most 600 seconds. The browser holds only that token. A fresh token is requested for every connection attempt. The key is read in one server route and appears in no client file (a test scans for it). | `src/app/api/voice-agent/token/route.ts`, `tests/oral-security.test.ts` |
| Session configuration | The first frame is `session.update` with the examiner prompt (versioned, snapshot-tested), the three tools, key terms taken from the course's concept names, the source language codes and `transcription_mode: balanced`. | `src/app/api/oral/session/route.ts`, `src/lib/oral/prompt.ts` |
| Native turn detection | VIVA sends only fields the turn-detection reference documents: `vad_threshold` 0.6, `interrupt_response` true, `interruption_delay` 0. An earlier version sent undocumented field names that the service accepted and ignored; that was found by probing the live service. | `src/app/api/oral/session/route.ts` |
| Tool calling | Three tools go to the agent with `execution_mode: hold`: `search_my_material`, `verify_claim`, `grade_my_answer`. A `tool.call` becomes a `POST /api/oral/tool` with the caller's cookie, the server runs it against the caller's own passages, and the result is sent back as `tool.result` only when `reply.done` is the latest event, as the events reference requires. | `src/lib/oral/tools.ts`, `src/app/api/oral/tool/route.ts`, `src/lib/oral/machine.ts` |
| Barge-in | On `input.speech.started` the client flushes playback and drops audio that arrives after the flush. On `reply.done` with status `interrupted` it discards any pending tool result from that reply. | `src/lib/oral/socket.ts`, `src/lib/oral/machine.ts` |
| Reconnect | After a drop the client tries `session.resume`. In both live trials the service refused it (`session_not_found`), and the client continued in a new session carrying the recent turns. It is a reconnect with history, not a true resume. | `docs/evidence/probes/oral-live-resume.2026-09-29.json` |
| Earlier study loop | The written study screens use AssemblyAI's Dictation endpoint and Universal-Streaming for push-to-talk answers. That work predates the oral exam and is described in `README.md`. | `src/app/api/voice/*` |

## Measured numbers

All from live sessions against the real AssemblyAI Voice Agent API on 2026-09-29. The learner is a synthetic voice (Windows System.Speech WAV files in `fixtures/audio`) played through a Node client that runs the same `socket.ts` as the browser, against a local server on port 3101. No browser, no human microphone. Medians of n runs. Values are in `numbers.json`; each row names its file.

| Measure | Median | n | Evidence |
|---|---|---|---|
| Session ready after connect | 444 ms | 3 | `docs/evidence/probes/oral-live-roundtrip.2026-09-29.json` |
| First examiner audio | 958 ms | 3 | same file |
| Tool round trip (`tool.call` to `tool.result`, the whole HTTP call to `/api/oral/tool`; the model judge took 415 ms of it in run 1) | 2470 ms | 3 | same file |
| Barge-in detection latency: first loud learner sample to the service reporting speech | 1286 ms (values 1286, 1768, 1214) | 3 | `docs/evidence/probes/oral-live-bargein.2026-09-29.json` |
| Barge-in detection latency with a tool in flight: first loud sample to speech reported | 1456 ms (values 1739, 1456, 1316) | 3 | `docs/evidence/probes/oral-live-bargein_tool.2026-09-29.json` |
| Stale audio chunks handed to playback after the flush call | 0 (147 to 209 dropped per run) | 6 | both barge-in files |
| Continuation after a socket drop: drop to `session.ready` on a fresh session (the live `session.resume` was refused with `session_not_found`) | 986 ms (values 921, 1050) | 2 | `docs/evidence/probes/oral-live-resume.2026-09-29.json` |
| `verify_claim` judge over a labelled set | 0 false supported, 0 false contradicted; supported precision 1.0 and recall 1.0 (19 of 19); contradicted precision 1.0 and recall 0.889 (24 of 27, the three misses abstained as "not in material") | 54 claims, 2 courses | `docs/evidence/probes/verify-claim-live-2026-09-29.json` |
| `verify_claim` judge latency | median 590 ms, p95 2067 ms | 53 model calls | same file |
| Front page, throttled mobile profile, local production build | 139.5 KB gzip JS, LCP 1080 ms, CLS 0.0001 | 5 | `docs/evidence/perf/perf.2026-09-29.json` |
| `/oral`, same profile | 178.4 KB gzip JS, CLS 0 | 5 | same file |
| Accessibility, axe wcag2a and wcag2aa, local production build | 0 serious or critical violations on 13 routes; 15 of 15 checks passed | 13 routes | `docs/evidence/a11y/axe-2026-09-29.txt` |
| Unit tests, `npx vitest run` on branch `wt/core2`, 2026-09-29 | 1228 passed, 1 skipped, 80 files | n/a | run output |

The 1.3 to 1.5 s barge-in figure is detection latency: the service noticing the learner's speech. The probe's playback is a stub, so it does not measure how long real audio takes to go silent in a browser. A second run (`oral-live-bargein-min_latency-ab.2026-09-29.json`) gave a median of 1454 ms, n=3.

## Verified live, and unit-tested only

| Behaviour | Live against AssemblyAI (synthetic learner, Node client) | Live against production (curl, 2026-09-29 22:30 UTC) | Unit-tested |
|---|---|---|---|
| Handshake, session ready, first audio | yes, n=3 | token mint 200, session config 200 | yes |
| Tool round trip with a spoken citation and page | yes, 3 of 3 | `verify_claim` on the scripted false claim returned `contradicted`, page 15, 874 ms | yes |
| Barge-in flush, stale audio dropped | yes, 6 of 6 | not run | yes |
| Pending tool result discarded on interruption | no; the live probe failed 3 of 3 (`timeout waiting for input.speech.started`), kept as a negative result | not run | yes |
| Reconnect after a drop | yes, 2 of 2, as a new session with history | not run | yes |
| Quote-substring rule and mutation downgrade | n/a | n/a | yes |
| `verify_claim` accuracy on 54 labelled claims | yes, live model judge | n/a | replay of recorded decisions in tests |
| Twelve machine states reachable, failure screens | n/a | n/a | yes (`tests/oral-failures.test.ts`) |
| Debrief builder and plan | n/a | n/a | yes (`tests/oral-debrief.test.ts`) |
| Whole exam in a real browser with a real microphone | not done | not done | n/a |
| Debrief sheet on screen after an exam | not done | not done | n/a |
| Two exams in a row where the second uses the first | yes, n=3, local server on the file store (`oral-memory-live.2026-09-29.json`) | not run; the deployed build predates this | yes (`tests/oral-memory.test.ts`) |
| Next question chosen from the last verdict and the weakest concept | yes, n=3: `next_focus` returned, examiner named the concept in 2 of 3 | not run | yes (`tests/oral-next-concept.test.ts`, `tests/oral-tool-focus.test.ts`) |

## Known limits

- Claim verification is quote-checked, and the judge model can still be wrong. Code guarantees the quoted words are in the named passage. It does not guarantee the verdict is right: a wrong "contradicted" with a real quote would still pass the check. The labelled set has 54 claims over two courses, written in this repository, with no recorded split between tuning and testing. The misconception used in the demo ("multi-head attention runs a single head over the input") is claim T17 in that set. Read 0 false confirmations on 54 as a small result, not a rate.
- The judge on 2026-09-29 was `openai/gpt-oss-120b` through a chain of model providers. Passage text is sent to the providers in the configured chain. `docs/evidence/data-inventory.md` shows where the chain is set and the privacy page describes it.
- Barge-in detection takes 1.3 to 1.5 s from the learner's first word (the service noticing speech). The time from the first word to real silence in a browser was not measured. Discarding a pending tool result on interruption is unit-tested only; the live probe for it failed 3 of 3, and in the recorded live shape the service flags `transcript.agent` as interrupted and then sends `reply.done` with status `completed`. The client now handles that shape, replayed in a unit test and not re-run live.
- Reconnect is a new session with the recent turns. The service refused `session.resume` in every live trial.
- Adaptive questioning is a computed choice of concept and kind, and the examiner's wording is still the model's: it named the chosen concept in 2 of 3 live runs (n=3, one seeded map, one synthetic learner utterance). The live runs did not exercise a move to a different concept after a correct answer; that path is unit-tested only. The stored map also holds evidence from the written study loop, and the exam prompt calls it "recorded answers". Without a Postgres store the history is lost on restart, and the prompt and the config's `memory` block say so.
- The debrief is built from the session record by `/api/oral/debrief` and is derived, not stored. No screen calls it at this commit.
- Storage: without `DATABASE_URL` the store is a file on the server's temporary disk and is wiped on restart. With it the store is Postgres. On 2026-09-29 at 22:30 UTC `/api/health/ready` on the production URL reported `durable: true`, backend postgres, "reachable, schema present". The 2026-09-28 baseline had recorded that database as unreachable, so this can change; check `/api/health/ready` before relying on it.
- Production deployment: the URL serves an `/oral` build that is older than branch `oral` (three trust and recording pages return 404). The final build is not deployed as of this file.
- The audio path has not been run in a browser with a human microphone on a phone or laptop for this build. The Plan A take is the first such run.
- Text only: a scan with no text layer gives VIVA nothing to quote.
- Legal pages (privacy, terms, accessibility) are drafts marked for professional review. The security contact in `SECURITY.md` is a placeholder until the owner sets a real address.
- The sample course is VIVA's own Transformers notes, written for the demo, and is labelled as such wherever it is shown.

## Human checklist

Full steps and minutes are in `docs/HUMAN-TODO.md`. In order:

1. Merge branch `oral` into `main` and push (coordinator).
2. `vercel login`, link, add the environment variable names listed in `docs/HUMAN-TODO.md`, deploy from `main`.
3. `node scripts/demo-preflight.mjs` prints GO.
4. Record the Plan A take from `docs/demo/SCRIPT.md`, fill `docs/demo/captions.srt` from its transcript, upload the video.
5. Put the live URL and the video URL into this file, replacing `[LIVE_URL]` and `[VIDEO_URL]`.
6. On lablab: paste the fields above, attach `docs/deck/viva-oral.pdf`, and press Submit yourself.
