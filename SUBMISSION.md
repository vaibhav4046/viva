# Submission copy — VIVA RedTeam

Everything below is written to be pasted. Items marked **[YOU]** need a person.

## Name
VIVA RedTeam

## Tagline
Rehearse the questions your document cannot answer.

## One-liner (≤ 200 characters)
A live voice red-team for documents you have to defend. It cross-examines you by voice, checks every claim you speak against your source, and lets you interrupt to correct yourself.

## Description
You wrote something important: a design doc, a thesis, a policy, an investor memo. Before someone important attacks it, attack it yourself.

VIVA RedTeam reads your document, then cross-examines you out loud with AssemblyAI's Voice Agent. Everything you say is turned into an explicit claim, and every claim is checked against the text you supplied. Each gets a status — **Supported, Partial, Contradicted, Unsupported, Unresolved** — and no status is ever given without a sentence from your document to point at. Say something the document contradicts and VIVA starts explaining why. Interrupt it — *"Wait, I meant manual failover"* — and it stops mid-word, searches the document again with what you meant, and the same claim can move from Contradicted to Supported on a live Defensibility Map. You finish with a Defensibility Report: what held, what needed qualifying, what was contradicted, what is unsupported, the questions you still can't answer, and the sections to reopen. There is no score.

## How it uses AssemblyAI
- **Voice Agent API** end to end: 24 kHz PCM16 streaming, native turn detection, agent speech, **semantic barge-in**, **tool calls** (`hold` mode, results held until `reply.done` and discarded if the reply was interrupted), `session.resume` after a drop, `session.end`, and one plain sentence for every error code.
- **Temporary authentication**: the browser never sees the long-lived key. A server route mints a ≤600 s token per connection.
- **Interruption changes state**: a barge-in flushes playback, marks the claim being explained as awaiting correction, and the correction re-runs the check on the same claim. This works from protocol events, not from the model deciding to call a tool.
- The document's distinctive terms are sent as keyterms to bias transcription.
- Built on VIVA's earlier use of the Dictation and Universal-Streaming APIs.

## What is different from a spoken-quiz tutor
It is not an examiner asking you generic questions. It challenges you on *your* document and on *what you just said*, contradicts you with the document's own words, and produces an artefact you can act on. The agent cannot decide whether you are right; the document can.

## Built with
Next.js 16, React 19, TypeScript, AssemblyAI Voice Agent API, Web Audio (`AudioWorklet`), Zod, Postgres (optional), Vitest, Playwright, axe-core.

## Honest limits (say them; they are in the README too)
- The claim check is lexical: negation, "planned/not yet", opposite qualifiers (automatic/manual), numbers with units. It does not understand paraphrase with no shared words; those claims come out **Unsupported**, which is worded as "not found", never "false".
- English voice only. Plain text or Markdown documents up to 60 000 characters.
- The RedTeam golden flow has been exercised end to end through the real socket client and routes with a fake WebSocket, and in a real browser on the typed path. **The live Voice Agent run of this exact flow is `scripts/live-redteam.mts` and had not been run at the time of writing.**
- Review sessions are stored in Postgres when `DATABASE_URL` is set; that path is tested against a fake `pg`, not a live database.

## Links
- Repository: https://github.com/vaibhav4046/viva (branch `claude/hackathon-dogfood-viva-submission-xd7cor` until merged) — **[YOU]** confirm it is public and merge to `main`
- Live app: **[YOU]** deploy and paste the URL (the existing deployment `viva-five-murex.vercel.app` predates RedTeam; set `ASSEMBLYAI_API_KEY`, and `DATABASE_URL` so sessions survive between serverless instances)
- Video: **[YOU]** record per `docs/submission/VIDEO-SCRIPT.md`, upload, paste the link
- Cover image: `docs/submission/cover.png`
- Screenshots: `docs/submission/screenshots/hero-*.png`, phone views `m1-review.png`, `m2-map.png`, `m3-source.png`

## Before you submit — the things only you can do
1. **Run the live check** with your key and two recordings (`docs/submission/live-redteam-result.json` is the evidence; commit it). Fix anything it flags; it is the only proof of the voice half.
2. **Record the video** (voice, headphones). Do not present the typed walkthrough as the Voice Agent.
3. **Deploy** with `ASSEMBLYAI_API_KEY` (+ `DATABASE_URL`), then run `npm run test:redteam-e2e -- https://your-url` against it.
4. **Merge the branch to `main`** and make sure the repository is public.
5. Read the hackathon rules for whether pre-existing code (VIVA's study codebase) needs a disclosure line. This submission is built on it and the README says so.
