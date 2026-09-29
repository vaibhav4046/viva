# Demo guide — VIVA RedTeam

Two ways to see it. Only the first is the Voice Agent.

## A. The real thing: voice, with barge-in (needs a microphone and an AssemblyAI key)

```bash
npm ci
ASSEMBLYAI_API_KEY=... npm run build && npm start
# open http://localhost:3000/redteam in Chrome, allow the microphone, use headphones
```

Headphones matter: without them the agent's own voice comes back into the microphone and is heard as an interruption.

1. Leave **Sample technical design** and **Skeptic** selected. **Begin the review.** The sample label is on screen.
2. Press **Start voice review**. Status goes *Connecting → Listening*. VIVA speaks its opening question about the single primary Postgres.
3. Answer, naturally: **"We automatically fail over to a replica."**
   - The map gets a card in **Contradicted**. The passage *"Automatic replica failover is not configured."* is marked on the left. VIVA starts to explain.
4. **While it is still talking**, cut in: **"Wait. I meant manual failover."**
   - VIVA's audio stops at once (status: *Cut off*). The card shows *cut off · awaiting your correction*.
   - A moment later the same card moves to **Supported** with the tag *Contradicted → Supported*, citing *"recovery is manual: an on-call operator promotes a replica"*. VIVA says the verdict changed.
5. Say: **"We guarantee GDPR compliance and SOC 2 certification for all customer data."**
   - **Unsupported.** No passage is cited. VIVA says *"I can't find that in the supplied material."*
6. Say **"I'm done"** (or press **Finish and build report**). The Defensibility Report appears.

If the agent's wording differs from the above, that is the language model. The verdicts do not: they come from the document. Open **Session timeline** to see every step.

### Verify it automatically (spends AssemblyAI credit; well under a minute of audio)

Record two clips of yourself, then convert them: `ffmpeg -i claim.m4a -ar 24000 -ac 1 -c:a pcm_s16le claim.wav`.

```bash
BASE=http://localhost:3000 npm run test:redteam-live -- claim.wav correction.wav
```

It drives the browser's own socket client and asserts: session opens, agent speaks, claim → CONTRADICTED, playback flushed on barge-in, machine went through INTERRUPTED, correction → SUPPORTED. It writes `docs/submission/live-redteam-result.json`.

## B. Typed fallback (no microphone, no key): same screen, same checks

`Type instead` opens a text box and a **Cut VIVA off** button. It runs the identical claim engine and ledger and is labelled *Typed — not the Voice Agent*. `docs/submission/demo-typed-walkthrough.webm` is a captioned recording of exactly this, and says so on screen.

```bash
npm run build && npm start &
npm run test:redteam-e2e     # 32 browser assertions on the typed path
npm run test:redteam-a11y    # axe across every state of the room
```

## Troubleshooting

| You see | Cause |
|---|---|
| "Voice is not switched on for this deployment" | `ASSEMBLYAI_API_KEY` is not set on the server |
| "Microphone access is blocked" | Browser permission denied; the typed box is offered |
| "Some voice settings were refused" | The service rejected an optional `turn_detection` field; the session runs on defaults |
| The agent interrupts itself | No headphones; echo cancellation cannot always save you |
| "That review is not here any more" | The session expired (6 h) or the server restarted without `DATABASE_URL`; start a new one |
| 429 / "Slow down" | 10 reviews a minute, 30 calls a minute, per address |
