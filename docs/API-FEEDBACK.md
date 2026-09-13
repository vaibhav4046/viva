# Notes on the Dictation and Streaming APIs

Everything here was measured against the live endpoints while building VIVA
between 9 and 13 September 2026, with the response recorded. Nothing is taken
from documentation or from memory. Where a probe turned out to be measuring our
own mistake rather than the API's behaviour, that is said so.

---

## 1. The streaming endpoint accepts 32 language codes, not 18

The hackathon announcement and the submission form both say 18 languages. The
endpoint's own validation error enumerates thirty-two, plus `multi`:

```
POST wss://streaming.assemblyai.com/v3/ws?language_code=zzz-not-a-language
{"type":"Error","error_code":3006,
 "error":"User Input Validation Error: Invalid 'language_code.0': Input should be
  'en', 'es', 'de', 'fr', 'it', 'pt', 'tr', 'nl', 'sv', 'no', 'da', 'fi', 'hi',
  'vi', 'ar', 'he', 'ja', 'ur', 'zh', 'ru', 'ko', 'ca', 'gl', 'ro', 'et', 'fa',
  'yue', 'af', 'mr', 'zu', 'xh', 'nn' or 'multi'"}
```

This is worth correcting in the announcement, because it undersells the API by
almost half. It also matters the other way round: **Polish and Ukrainian are
not on that list**, and a reasonable person building an "18 languages" language
picker would put them in. We had `pl` and `uk` as presets, and both close the
socket on connect. So does `en,hi` — streaming takes one code, not a list, even
though the batch Dictation API takes `language_codes` plural.

A one-line list of accepted codes in the streaming docs would have saved us a
picker that killed the session for two of its nineteen options.

## 2. Naming a language silently changes the model, and the two behave differently

Ask for `language_code=en` and `Begin` reports `universal-3-5-pro`. Ask for
`multi` and it reports `universal-streaming-multilingual`. That substitution is
not documented, and it changes the API's observable contract:

| | `universal-3-5-pro` (`en`) | multilingual (`multi`) |
|---|---|---|
| `word_is_final` during a turn | never — every word stays `false`, all flip together at `end_of_turn` | words finalise one at a time |
| words settled individually, same 10 s clip | **2** | **22** |
| partial cadence | ~1.2 s | ~250-400 ms |
| first word behind the voice | 209-259 ms | ~940 ms |
| last word to final turn | 1083-1289 ms | 1819 ms |

Both are reasonable models. The problem is that the choice is made by a
parameter that looks like it only selects a language, and the difference decides
whether a progressive-transcript UI is possible at all. We built a settle
animation against `word_is_final`, shipped `en` as the default, and the
animation never fired for anyone — the transcript arrived in 1.2 s lumps. We
only found it by diffing socket frames between two language settings.

Suggestion: report the model in `Begin` (you already do — thank you, that is how
we found it) **and** say in the docs that `language_code` selects a model
family, with a note on which ones progress `word_is_final` mid-turn.

## 3. A terminated session emits a trailing empty Turn

After `Terminate`, the socket sends one more `Turn`:

```json
{"end_of_turn": true, "transcript": "", "words": []}
```

Our first parser read `words[words.length - 1].text` and crashed on it. Easy to
defend against once you know, and worth one line in the docs.

## 4. `keyterms_prompt` on the streaming socket: parsed, but shape-sensitive and silent

It is a real parameter — a malformed shape is rejected, which is how we know it
is parsed rather than ignored:

| form | result |
|---|---|
| `keyterms_prompt=["a","b"]` (JSON array) | `Begin`, session opens |
| `keyterms_prompt=a&keyterms_prompt=b` (repeated) | closed, `3006` |
| `keyterms_prompt=a,b` (CSV) | closed, `3006` |
| a parameter name that does not exist at all | ignored, session opens |

Two asks. First, the accepted shape is not in the streaming docs, and the two
natural guesses both kill the session. Second, `Begin` echoes the model and the
sample rate but **not** `keyterms_prompt`, so there is no way to confirm it was
applied. We ran an A/B on identical audio with and without it and got byte-identical
transcripts, which could mean the terms did not help on that clip or that they
were never applied — we could not tell, so we did not ship it. Echoing it back in
`Begin` would settle that in one frame.

## 5. The concurrency cap is easy to trip and easy to misread

Opening sockets in a loop returns `error_code 1008`, and slots take seconds to
free. That is fair enough, but two things make it costly:

- The close code for "you have too many sessions" is the same shape as the close
  for a bad parameter, so a language-support probe that opens 44 sockets in
  sequence reports 22 languages as "rejected" when they were merely rate
  limited. We nearly filed exactly that as feedback. A distinct error string
  would prevent it.
- Reconnecting on 1008 makes it worse, so it has to be treated as terminal
  rather than retried. Worth saying explicitly.

## 6. `/v3/token` clamps sensibly, and says so clearly

Not a complaint — a note that this is well done. `expires_in_seconds` is bounded
to 1..600 and the 422 names the bound:

```
asked       1s -> 200 granted 1
asked     600s -> 200 granted 600
asked    3600s -> 422 "Input should be less than or equal to 600"
asked      -1s -> 422 "Input should be greater than or equal to 1"
```

A short-lived, streaming-scoped token is exactly the right primitive for a
browser client, and it is the reason our API key never has to leave the server.

## 7. Dictation: the multipart part order matters and the error does not say so

`POST https://dictation.assemblyai.com/v1/transcribe/live` requires the `config`
part **before** the `audio` part. Sent the other way round the request fails in a
way that does not name the cause. One sentence in the docs, or an error that
says "config must precede audio", saves an hour.

Also worth stating in the docs, since all three cost us time:

- `Authorization` takes the raw key with **no** `Bearer` prefix, unlike most APIs.
- Compressed audio returns 415. `MediaRecorder` in a browser only emits WebM or
  Opus, so a browser client cannot use the endpoint without an AudioWorklet that
  produces PCM itself. That is a reasonable constraint, but it is the single
  biggest piece of work in integrating this API from a browser and the docs do
  not warn you.

## 8. Audio duration is taken from the declared sample rate

We shipped a bug where 48 kHz stereo was declared as 16 kHz mono. A 3 second
clip was read as 18 seconds and billed accordingly — a 6× overcharge caused
entirely by us.

Since the audio is raw PCM, the declared rate is the only thing that can
determine duration, so this is not a defect. But the failure is silent and
expensive in the direction that costs the customer money, and the response
already carries `audio_duration_ms`. A warning when the declared duration and
the byte count disagree with the transcript's own word timings would have caught
it immediately. We now resample and downmix server-side and reject
`audio/pcm` outright.

## 9. Speaker labels in `stt_prompt` leak into the transcript

A `stt_prompt` beginning `"Student:"` produced transcripts that started
picking up the label. We strip speaker labels before sending. Probed live on
12 September 2026.

---

## What worked well, since bug reports are a biased sample

- `llm_instruction` is the reason we chose this API over a plain transcript. We
  ask it to remove filler and false starts but keep hedges exactly, because
  *"I think, maybe, it's about which words are important"* is the single most
  useful sentence a struggling student can say, and a tidier transcript that
  drops the *I think* throws the signal away. Getting both the verbatim and the
  cleaned text in one response is what makes that possible.
- `keyterms_prompt` on the batch endpoint measurably fixes subject vocabulary —
  "positional encoding" instead of "positional and coding".
- 546-580 ms `request_time_ms` on a ten-second clip, consistently, across five
  runs a day apart.
- `Begin` reporting the resolved model. It is the only reason section 2 above
  is a documentation note rather than a mystery.
