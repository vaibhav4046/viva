# Video script — 2:30, opens on the contradiction

**Do not start with a title card.** The first frame is VIVA already explaining a contradiction.

**Record the real thing** (see [DEMO.md](../../DEMO.md) part A): Chrome, headphones, sample document, Skeptic mode, screen + system audio + microphone. Run the whole flow once, then cut so the video begins at the moment VIVA starts explaining the contradiction. Everything on screen must be the live app; do not mock, speed up, or re-voice the agent.

`demo-typed-walkthrough.webm` in this folder is a *typed-path* recording made without a microphone. It is captioned as such. It is a stand-in for the screen half, **not** a substitute for the voice half, and should not be presented as the Voice Agent.

| Time | On screen | Audio |
|---|---|---|
| 0:00–0:12 | The room. Contradicted card on the map; the passage *"Automatic replica failover is not configured."* marked in the source. Status: *VIVA is speaking*. | **VIVA:** "…but your document says automatic replica failover is not configured. Recovery is manual. An on-call operator promotes a replica…" |
| 0:12–0:24 | You start talking over it. Status flips to *Cut off*. The card shows *cut off · awaiting your correction*. The waveform changes from VIVA's voice to yours. | **You:** "Wait. I meant manual failover." **VIVA's voice stops mid-word.** |
| 0:24–0:40 | The card slides from Contradicted to Supported. The tag reads *Contradicted → Supported*. A new passage is marked: *"recovery is manual…"* | **VIVA:** "That changes it. The document supports manual failover — section two, data storage." |
| 0:40–0:55 | Cut to the setup screen: *Rehearse the questions your document cannot answer.* | **Voiceover:** "This is VIVA RedTeam. You give it something you have to defend. It reads it, then cross-examines you out loud." |
| 0:55–1:15 | You claim the GDPR/SOC 2 guarantee. Card lands in Unsupported with no passage cited. | **VIVA:** "I can't find that in the supplied material." **Voiceover:** "Unsupported means the document is silent. It does not mean you are wrong, and VIVA never pretends to know." |
| 1:15–1:45 | Split: the timeline (question, claim, verdict, interruption, correction) beside the code path `reply.done → interrupted → flush → turn → re-check`. | **Voiceover:** "The Voice Agent does the listening, the turn-taking and the talking. When you interrupt, the service tells us, we cut playback, mark the claim, and re-search the document with what you meant. The agent's tools return what the source says. No tool takes a verdict, so the agent can't invent one." |
| 1:45–2:05 | The Defensibility Report: held, qualification, contradictions (including the one you fixed), unsupported, questions you cannot answer, sections to review. | **Voiceover:** "You leave with sections to reopen, not a score." |
| 2:05–2:30 | Setup screen list: engineering teams, researchers, founders, product teams, policy teams. Then the README's verification table. | **Voiceover:** "For anyone who wrote something important and wants it attacked first. The claim check is lexical, and the README says so. The rest is tested, and the one thing tests can't prove, the live service, has its own script." |

## Voiceover (read as one piece, ~230 words)

> This is VIVA RedTeam. You give it something you have to defend — a design doc, a thesis, a policy. It reads it, then cross-examines you out loud.
>
> Every claim you speak is checked against your actual text. Contradicted, supported, partly backed, unsupported, or unresolved, and never a verdict without a sentence from your document to point at.
>
> Here's what makes it more than a chatbot with a microphone. I say something wrong. VIVA catches it and starts to explain. I interrupt. The service tells us, VIVA's voice stops, the claim is marked as waiting for me, and when I say what I meant, the document is searched again and the same claim changes from contradicted to supported. The interruption changes the state of the review.
>
> AssemblyAI's Voice Agent does the hearing, the turn-taking, the interruption and the speaking. Our server holds the document, runs the checks, and mints short-lived tokens so the real key never reaches the browser. The agent can call six tools. None of them can write a verdict.
>
> When I claim something the document never says, VIVA says so — and cites nothing.
>
> At the end there's a report: what held, what needed qualifying, what was contradicted, what's unsupported, the questions I still can't answer, and the sections to reopen. No score.
>
> It's for anyone who wrote something important and wants it attacked before someone important does. The claim check is lexical, and the README says so.

Captions: [captions.srt](captions.srt) (matches the table above).
