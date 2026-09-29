# Submission — VIVA RedTeam

Everything below is ready to paste into the hackathon form. The items marked **[YOU]** need you to do them personally.

## Project title
VIVA RedTeam

## Tagline
Rehearse the questions your document cannot answer.

## Short description (under 200 characters)
A voice red-team for documents you have to defend. It cross-examines you out loud, checks every claim you speak against your own text, and lets you interrupt to correct yourself.

## Long description
You wrote something important: a design doc, a thesis chapter, a PRD, a policy, an investor memo. Attack it yourself before someone important does.

VIVA RedTeam reads your document, then cross-examines you out loud through AssemblyAI's Voice Agent. Every statement you make becomes an explicit claim, and every claim is checked against the text you supplied. Each claim gets one of five statuses: **Supported, Partial, Contradicted, Unsupported, Unresolved**. Supported, Partial and Contradicted are never given without a sentence from your own document to point at. Unsupported means the document is silent, not that you are wrong.

The moment the product is built around works like this:
1. You say something your document contradicts, and VIVA starts explaining why.
2. You cut in: *"Wait, I meant manual failover."*
3. VIVA's speech stops, and the claim it was explaining is marked as waiting for your correction.
4. The document is searched again with what you meant, and the same claim moves from Contradicted to Supported on a live Defensibility Map.
The interruption changes the state of the review, not just the audio.

At the end you get a Defensibility Report with six sections: claims that held, claims that needed qualification, contradictions found (including the ones you fixed), unsupported claims, the questions you still can't answer, and the sections of your document to reopen. There is no score.

Three review modes turn the same challenge policy toward different weak points: **Skeptic** targets unsupported claims and contradictions, **Architect** targets assumptions and failure modes, and **Operator** targets recovery, observability and security. Every question quotes your document or something you already said.

## How it uses AssemblyAI
- **Voice Agent API, end to end**:
  - 24 kHz PCM16 streaming
  - native turn detection
  - agent speech that can be cancelled mid-word
  - semantic barge-in
  - server-side tool calls in `hold` mode, whose results are queued until `reply.done`, discarded if the reply was interrupted, and waited for if the check is slower than the reply
  - a mid-session `session.update` that keeps the agent's view of the ledger current
  - `session.resume` with back-off after a drop, and `session.end`
- **Temporary authentication**: a server route mints a token of 600 seconds or less for each connection. The account key never reaches the browser.
- **Barge-in drives state**: an interruption flushes playback, drops stale tool results, and marks the claim being explained. The correction then re-runs the check on that same claim. This happens from protocol events and your transcript, so it does not depend on the model choosing to call a tool.
- **Keyterms** from your document bias transcription.
- It builds on VIVA's earlier use of AssemblyAI's Dictation and Universal-Streaming APIs, from the Dictation hackathon.

## Why you can trust a verdict
- The agent cannot write a verdict. It has six tools, and none of them accepts a status, a verdict or an evidence list. Your words go in and the document's answer comes out.
- Passage ids are minted per document and per owner. An id from another document, or from another user, is refused.
- The check is a readable set of rules over your document's words, not a model. It handles:
  - negation, and "planned" or "not yet"
  - opposites, such as automatic vs manual
  - numbers, units, times of day and rate periods
  - "only", which it treats as exclusive
  - refusals ("rejected before they are returned")
  - each sentence of an utterance on its own
- ⟨CORPUS_LINE⟩ Most of those claims were written by an adversarial reviewer to break the checker.
- The document is data, not instructions. It never enters the system prompt, and instruction-shaped phrases are removed from what the agent reads. Only you can end the review: `finish` is refused unless you have asked for it.

## Who it is for
Engineering teams before an architecture review, researchers before a thesis defence, founders before investor diligence, product teams before a design review, and policy teams before stakeholder review. They share one job: *"I wrote something important. Attack it before someone important does."*

## Built with
Next.js 16, React 19, TypeScript, AssemblyAI Voice Agent API, Web Audio (`AudioWorklet`), Zod, optional Postgres, Vitest, Playwright and axe-core.

## Honest limits
- The claim check is lexical. A paraphrase that shares no words with your document comes back **Unsupported**, which is worded as "not found" and never as "false".
- Voice is configured for English.
- ⟨LIVE_STATUS_LINE⟩

## Links
- **Repository**: https://github.com/vaibhav4046/viva — the RedTeam work is on branch `claude/hackathon-dogfood-viva-submission-xd7cor` in PR #1. **[YOU]** Merge it to `main` and make sure the repository is public.
- **Live app**: ⟨LIVE_URL⟩ — **[YOU]** Set `ASSEMBLYAI_API_KEY` on the Vercel project (Production and Preview) and redeploy. The submission link should point at `/redteam`.
- **Video**: ⟨VIDEO_URL⟩ — **[YOU]** Record it following `docs/submission/VIDEO-SCRIPT.md` (with voice and headphones), upload it, and paste the link here.
- **Slides**: `docs/submission/slides.pdf`
- **Cover image**: `docs/submission/cover.png`
- **Screenshots**: `docs/submission/screenshots/` (`hero-*.png` for desktop, `m1-review.png`, `m2-map.png` and `m3-source.png` for phone)
- **Captions**: `docs/submission/captions.srt`

## Before you submit (only you can do these)
1. **Run the live check once**, with your key, against the deployed app or a local build. It uses about ten seconds of agent audio to synthesise the two test utterances, plus one short session:
   `BASE=https://<your-app> npm run test:redteam-live -- --synthesize`
   It writes `docs/submission/live-redteam-result.json`. Commit that file; it is the evidence for the voice half.
2. **Record the video** with your real voice and headphones. Do not present the typed walkthrough as the Voice Agent.
3. **Deploy** with `ASSEMBLYAI_API_KEY` set. `DATABASE_URL` is optional.
4. **Merge PR #1 to `main`** and confirm the repository is public.
5. Check the hackathon rules on pre-existing code. This entry is built on VIVA's earlier study codebase, and the README's appendix says what existed before.
