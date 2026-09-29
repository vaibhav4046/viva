# Human steps for VIVA Oral

Only Vaibhav can do these: logins, the recording, the upload and the Submit button. Each has the exact command or link and an estimate in minutes. Secrets never go in chat or in a file in this repository.

State when this was written (2026-09-29, about 22:40 UTC): the production URL https://viva-five-murex.vercel.app already answers `/oral`, the session config and the token route, and `/api/health/ready` reports a durable Postgres store. It serves a build older than branch `oral` (`/privacy`, `/terms` and `/recorded` return 404). The Vercel CLI is installed on this machine, the project is linked at `D:\project\viva\.vercel`, and the CLI is logged out.

| # | Step | Minutes |
|---|---|---|
| H1 | Merge and push (coordinator) | 3 |
| H2 | Vercel login | 2 |
| H3 | Check environment variable names on the project | 3 |
| H4 | Deploy from `main` | 6 |
| H5 | Preflight | 1 |
| H6 | Record the Plan A take | 10 |
| H7 | Fill captions, upload the video | 10 |
| H8 | Fill the two URLs into `docs/SUBMISSION.md` | 2 |
| H9 | Submit on lablab | 8 |

Total about 45 minutes. The lablab page says the hackathon runs September 1 to 30, 2026. It does not state the deadline time or timezone, so treat the end of 29 September as the working deadline and submit as early as the steps allow.

## H1. Merge and push (coordinator, not the owner)

Branch `oral` and the worker branches must be merged into `main` and pushed, because the submission links a public repository and the deployment is built from `main`. Remote `main` was `ca7ea4b` on 2026-09-29 and had none of the oral work.

```
git -C D:\project\viva switch main
git -C D:\project\viva merge --ff-only oral
git -C D:\project\viva push origin main
```

Run `npm run typecheck`, `npx vitest run` and `npm run lint:copy` on `main` after the merge. The build gate is `npm run build`, run once in `D:\project\viva`.

## H2. Vercel login (2 minutes)

```
vercel login
vercel whoami
```

`vercel login` opens a browser and shows a device code. Approve it. `vercel whoami` must print your username.

## H3. Environment variable names (3 minutes)

Names only, listed from `.env.example` and the code. Check which exist, then add what is missing. The value prompt is hidden and is typed into the CLI, not pasted anywhere else.

```
cd D:\project\viva
vercel env ls production
```

| Name | Needed for | If missing |
|---|---|---|
| `ASSEMBLYAI_API_KEY` | token route for the Voice Agent, dictation | the oral exam cannot start |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | the `verify_claim` judge, which catches the misconception | the examiner cannot confirm or correct; every claim comes back "not in the material" |
| `LLM_FALLBACKS` | extra model providers in the failover chain | one provider only |
| `AI_PROVIDER` | provider selection (`openai-compatible`) | check `.env.example` |
| `DATABASE_URL` | durable learner store (Postgres) | storage resets on restart; say so on camera |
| `NEXT_PUBLIC_APP_URL` | absolute URLs in page metadata | metadata points at the default host |

Add one that is missing:

```
vercel env add ASSEMBLYAI_API_KEY production
```

## H4. Deploy from main (6 minutes)

```
cd D:\project\viva
git status
vercel --prod
```

`git status` must show `main`, clean, at the merged commit. When the deploy prints the production URL, open `/oral`, `/privacy` and `/recorded` once each. If the domain assigned to the project shows a login wall instead of the app, follow `reference_vercel_deployment_protection` in your notes: assign the production domain, do not chase the dashboard toggle.

## H5. Preflight (1 minute)

```
cd D:\project\viva
node scripts/demo-preflight.mjs --base https://viva-five-murex.vercel.app
```

It must print `GO`. It checks health, the model provider, storage durability, the token mint, the sample course, the scripted false claim (must come back contradicted with a page) and the public pages. Warnings are listed, not fatal. A `NO-GO` prints the reasons. Do not record on a NO-GO.

## H6. Record the Plan A take (10 minutes)

1. Work through `docs/demo/CHECKLIST.md` (ten items, about three minutes).
2. Record from `docs/demo/SCRIPT.md`. One take, real microphone, headphones on. Retake if the examiner does not check the material before correcting you.
3. Check the length: `ffprobe -v error -show_entries format=duration -of csv=p=0 take.mp4`. Aim for under 3:00. Keep it under 5:00.

## H7. Captions and upload (10 minutes)

1. Open `docs/demo/captions.srt`. Replace each bracketed examiner cue with the exact words from the on-screen transcript of your take, and re-time the cues to the recording.
2. Upload the video to YouTube as unlisted, or to the host lablab accepts, with the SRT. The description must say:
   - "Sample course: VIVA's own Transformers notes, written for this demo."
   - "Examiner audio and all tool calls are from a live AssemblyAI Voice Agent session recorded on <date>. The learner voice is my own, on a real microphone."
   - "Numbers were measured on 29 September 2026, three runs each, with a synthetic learner voice against a local server."

## H8. Two URLs into the submission text (2 minutes)

In `docs/SUBMISSION.md` replace `[LIVE_URL]` and `[VIDEO_URL]`. Commit on `main` with a message file, no attribution lines.

## H9. Submit on lablab (8 minutes)

1. Open https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon, sign in and open your project submission.
2. Paste from `docs/SUBMISSION.md`: title, tagline, short description, long description, tags.
3. Add the live URL, https://github.com/vaibhav4046/viva, and the video URL.
4. Attach `docs/deck/viva-oral.pdf` if the form takes slides.
5. Read the form's own required fields and limits. This pack recorded them as unpublished, so anything the form asks that is not in `docs/SUBMISSION.md` is yours to fill honestly.
6. Press Submit yourself.

## Still open, not blocking the submission

- Set a real security contact address in `SECURITY.md` and the legal pages (they hold a placeholder).
- Rotate any credential that was ever pasted into a chat, a log or a file. This pack did not check for one.
- After the take, re-check `docs/PROMISE-TRACE.md`. If the UI worker's debrief sheet or passage card is in the take, update clauses 4 and 7 and the deck.
