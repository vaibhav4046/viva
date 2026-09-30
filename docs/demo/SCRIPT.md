# Plan A: one real take, real microphone

One take by Vaibhav on a real microphone, screen recorded, about 2:50. Everything on screen is the product running. The examiner audio, the tool call and the correction come from a live AssemblyAI Voice Agent session. The sample course is VIVA's own Transformers notes, written for the demo, and the video says so.

Human time: about 10 minutes, including one retake. Run the preflight first: `node scripts/demo-preflight.mjs`. Record only on GO.

Rules for the take:

- Say the lines below in your own rhythm. The words in quotation marks are the ones that matter. Do not read them like a script.
- The examiner is a live model. Its wording changes on every run. What must happen is listed under "Must happen". If it does not happen, stop and retake. Do not edit around it.
- Do not narrate anything the screen does not show. If the screen shows "Checking your material", say that. Do not say "Checking page 19" unless the screen says it.
- Do not describe a debrief or a revision plan unless the debrief sheet is on screen in the take (see 2:15).
- Do not say "learns from you". Say "adapts" or "remembers" only as far as `docs/PROMISE-TRACE.md` clauses 3 and 6 go: the next question follows your last verdict and your weakest concept, and a second exam in the same browser opens on the weakest concept in the stored map. Show it on screen or do not say it.

## Storyboard

| Time | Screen | You say | Must happen |
|---|---|---|---|
| 0:00 to 0:15 | The front page at `/`. | "VIVA gives you an oral exam on your own lecture notes. It asks the questions out loud, checks each answer against your pages, and tells you what to revise tomorrow." | Speak to the page, unhurried. About 12 seconds. |
| 0:15 to 0:35 | Press **Try a sample exam**. `/oral` opens. Press **Start the exam**. | "This is the sample course: VIVA's own notes on transformers, written for this demo, twelve passages over pages four to twenty-four. One click and the examiner is on." | The examiner greets: "You're being examined. Tell me what you want to be asked on, and I'll start there." |
| 0:35 to 1:15 | Transcript scrolls. State line changes as you talk. | "Examine me on self-attention." Then, when it asks its question: "Every token compares itself with every other token. The scores go through a softmax into weights, and the output is a weighted average of the value vectors." | The examiner asks a question about self-attention, then responds to your answer and moves on. Do not claim it adapted. |
| 1:15 to 1:55 | The state line shows the checking state while the tool runs. | "Now examine me on multi-head attention." When it asks: "I think it runs a single head over the input." | The screen shows the checking state, then the examiner says the page number aloud (fifteen) and reads a line from the material: "Multi-head attention runs the query-key-value computation h times in parallel, each in a smaller subspace." It asks you to restate it. |
| 1:55 to 2:15 | The examiner is mid-sentence in the correction. | About two seconds into the examiner's correction, say clearly: "Wait, can you repeat the question?" | The examiner's voice stops and the transcript marks the line as cut off. It then answers your new request. Expect roughly 1.3 to 1.5 seconds before the service reports your speech, then the examiner falls silent (median of 3 live runs each, see the numbers below; the time to silence itself was not measured in a browser). |
| 2:15 to 2:40 | Press **End the exam**. | If a debrief sheet appears: "Here is the debrief: which concepts held up, which are shaky, and what to revise tomorrow." Read what is on the sheet. If no sheet appears: cut this scene and give the time to 2:40. | Nothing invented. The words you say match the pixels. |
| 2:40 to 2:55 | The front page, or a slide from `docs/deck/viva-oral.pdf` with the numbers. | "It runs on AssemblyAI's Voice Agent API. The measured numbers, the limits and the link are on screen and in the description." Then stay quiet for the last ten seconds while the captions carry the numbers. | On screen: slide 7 of the deck or the captions. Every figure matches `numbers.json`. The captions say the set is small and the judge can be wrong. |

## Numbers to say, and where they come from

| Line | Value | Source |
|---|---|---|
| Session ready | 444 ms median, n=3, 2026-09-29 | `docs/evidence/probes/oral-live-roundtrip.2026-09-29.json` |
| First examiner audio | 958 ms median, n=3, 2026-09-29 | same file |
| Interruption detection latency | 1286 ms median from the first loud sample to the service reporting speech, n=3; not a measured playback stop | `docs/evidence/probes/oral-live-bargein.2026-09-29.json` |
| Claim check | 54 labelled claims, 0 false supported, 0 false contradicted | `docs/evidence/probes/verify-claim-live-2026-09-29.json` |

Those runs used a synthetic learner voice against a local server, not a human on a microphone in a browser. Say "with a synthetic learner voice" every time you quote them. Do not put them on screen as if the take produced them.

## If it goes wrong

| What you see | What to do |
|---|---|
| Preflight prints NO-GO | Read the reasons. Do not record. Fix or ask for the fix. |
| The examiner corrects you without the checking state, or with no page number | Stop. Retake. This is the moment the video exists for. |
| The examiner says "the material does not settle that" | The judge abstained. Retake with the same words once. If it repeats, use the second misconception below. |
| No audio, or the microphone is blocked | Allow the microphone in the address bar, or press Type instead and record that. Say so on camera. |
| The session drops and says it is reconnecting | Let it finish. The service refused a true resume in live runs, so the exam continues in a new session with the recent turns. Say "it reconnected" only if the screen says so. |
| Your interruption does not stop the examiner | Wait for a longer sentence and interrupt again. If it fails twice, do not fake it. Retake. |

Second misconception, if the first will not land: ask to be examined on backpropagation, then say "Backpropagation and gradient descent are the same thing." The material (pages nineteen and twenty) separates them. This one has a labelled claim in the verifier set but no live tool round trip of its own, so use it only as a fallback.

## Labels the video must carry

- First seconds and description: "Sample course: VIVA's own Transformers notes, written for this demo."
- Description: "Examiner audio and all tool calls are from a live AssemblyAI Voice Agent session recorded on <date of the take>. The learner voice is Vaibhav's own, on a real microphone."
- Closing numbers: "Measured 29 September 2026, n=3 runs, synthetic learner voice, local server."

## After the take

1. Watch it once with sound off. The captions and the screen must carry it.
2. Check the duration with `ffprobe -v error -show_entries format=duration -of csv=p=0 take.mp4`. Under 3:00 is the plan; the platform limit is not published on the hackathon page (see `docs/SUBMISSION.md`), so keep it under 5:00 at most.
3. Replace the bracketed examiner cues in `captions.srt` with the exact words from the on-screen transcript of your take, and re-time the cues to the recording.
4. Fill the video URL into `docs/SUBMISSION.md`.
