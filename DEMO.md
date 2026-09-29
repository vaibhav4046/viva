# Demo guide — VIVA RedTeam

There are two ways to see it. Only the first one is the Voice Agent.

## A. The real thing: voice, with barge-in

Use a server that has an AssemblyAI key: the deployed app (⟨LIVE_URL⟩), or locally:

```bash
npm ci
npm run build
ASSEMBLYAI_API_KEY=... npm start        # open http://localhost:3000/redteam in Chrome
```

**Use headphones.** Without them the agent's own voice comes back into the microphone and is heard as you interrupting.

1. Leave **Sample technical design** and **Skeptic** selected and press **Begin the review**. The "Sample material" label stays on screen for the whole review.
2. Press **Start voice review** and allow the microphone. The status reads *Connecting*, then *Listening*, and VIVA asks what happens if the single Postgres primary becomes unavailable.
3. Answer naturally: **"We automatically fail over to a replica."**
   - The status goes *VIVA is composing a reply*, then *Checking the document*, then *VIVA is speaking*.
   - A card lands in **Contradicted**, and the sentence *"Automatic replica failover is not configured."* is marked in the source on the left.
4. **While VIVA is still talking**, cut in: **"Wait — I meant manual failover."**
   - VIVA's audio stops at once, and the status reads *Cut off*.
   - The card says *cut off · awaiting your correction*.
   - A moment later the same card moves to **Supported** with the tag *Contradicted → Supported*, now citing *"recovery is manual: an on-call operator promotes a replica"*.
5. Say: **"We guarantee GDPR compliance and SOC 2 certification for all customer data."**
   - **Unsupported.** No passage is cited, and VIVA says *"I can't find that in the supplied material."*
6. Say **"I'm done."** VIVA confirms, the Defensibility Report appears, and the voice session ends.

The agent's exact wording comes from the language model and will vary. The verdicts do not vary, because they come from the document. Open **Session timeline** to see every step: question, claim, verdict, interruption, correction.

### Check the voice flow automatically

This spends about ten seconds of agent audio to synthesise the two test sentences, plus one short session. It needs no microphone and no recordings:

```bash
BASE=http://localhost:3000 npm run test:redteam-live -- --synthesize
```

It drives the browser's own socket client and state machine against the real service, and asserts each step:
1. the session opens
2. the agent speaks
3. the claim is recorded as CONTRADICTED
4. playback is flushed on the barge-in
5. the machine passes through INTERRUPTED
6. the correction turns the claim SUPPORTED, and it is still the same claim

The result is written to `docs/submission/live-redteam-result.json`. To use your own voice instead, record two clips and pass their paths:

```bash
ffmpeg -i claim.m4a -ar 24000 -ac 1 -c:a pcm_s16le claim.wav
BASE=http://localhost:3000 npm run test:redteam-live -- claim.wav correction.wav
```

## B. Typed review: no microphone, no key, same screen, same checks

**Type instead** opens a text box and a **Cut VIVA off** button. It runs the same claim checks and the same ledger, and is labelled *Typed review — not the Voice Agent*.

`docs/submission/demo-typed-walkthrough.webm` is a captioned recording of exactly this path, and it says so on screen.

```bash
npm run build && npm start &
npm run test:redteam-e2e -- http://localhost:3000     # the golden flow, keyboard, phone width, a hostile document
npm run test:redteam-a11y -- http://localhost:3000    # axe over every state of the room
```

⟨IMPORT_DEMO⟩

## Troubleshooting

| You see | Why |
|---|---|
| "Voice is not switched on for this deployment" | `ASSEMBLYAI_API_KEY` is not set on the server |
| "Microphone access is blocked" | The browser denied the microphone. The typed box is offered instead |
| "Some voice settings were refused" | The service rejected an optional setting, so the session runs on its defaults |
| The agent interrupts itself | No headphones. Echo cancellation cannot always prevent it |
| "That review is not here any more" | The review expired (six hours), or the server lost it and could not restore it. Start a new one |
| 429 / "Slow down a little" | The limit is 10 new reviews a minute and 30 calls a minute |
