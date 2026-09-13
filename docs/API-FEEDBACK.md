# Notes on the Dictation and Streaming APIs

Everything here was measured against the live endpoints while building VIVA
between 9 and 13 September 2026. **Every section names the script that produced
it**, all of them committed under `scripts/api-probes/`, and the numbers quoted
are the output of a run on 13 September. Each reads `ASSEMBLYAI_API_KEY` from
`.env.local` at runtime and none embeds a credential; the ones that send audio
need a 16 kHz mono WAV, which the repo does not ship — any recording of someone
reading a sentence aloud will do:

| script | what it establishes |
|---|---|
| `scripts/api-probes/probe-dictation-contract.mjs` | §7 part order, §7 415 bodies, §8 sample-rate validation, the `keyterms_prompt` A/B and `request_time_ms` in the closing section |
| `scripts/api-probes/probe-auth-header.mjs` | §7, the `Authorization` header |
| `scripts/api-probes/probe-streaming-shape.mjs` | §1 language codes, §4 the `Begin` payload, §5 the concurrency cap |
| `scripts/api-probes/probe-stream-timing.mjs` | §2 lag, cadence, settle and turn counts; §3 the `Terminate` table |
| `scripts/api-probes/keyterms-probe.mjs` | §4 the accepted shape of `keyterms_prompt` |
| `scripts/api-probes/api-feedback-probe.mjs` | §1 the 44-code sweep, §6 the token bounds |
| `scripts/api-probes/probe-stt-prompt-leak.mjs` | §9 |

Two items are recollection rather than probe and say so where they appear: the
sample-rate overcharge in section 8 was our own production incident, and the
retry policy at the end of section 5. Where a probe turned out to be measuring
our own mistake rather than the API's behaviour, that is said so too.

Every section was re-probed on 13 September before this was sent, and the
corrections are named where they happened rather than quietly edited, because a
vendor cannot act on a report whose errors are hidden:

- the trailing `Turn` in section 3 appears on only one of the two models;
- `Begin` echoes no sample rate (section 4);
- the concurrency close is *not* indistinguishable from a validation close (§5);
- the part-order 400 does name its cause (section 7);
- **the `Bearer` complaint in section 7 was simply wrong** — a prefixed key is
  accepted, and we had told you otherwise;
- the speaker-label leak in section 9 no longer reproduces at all;
- `keyterms_prompt` changed nothing we can measure on our own clip, on either
  endpoint;
- **every timing number in section 2 moved**, the lag figures by a factor of
  three or more, once they were measured at the socket instead of at our own
  DOM.

Most of these made the API look worse than it is. Where a number moved between
runs it is given as a range with its sample size, not as a median that looks
firmer than the measurement behind it.

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
though the batch Dictation API takes `language_codes` plural. One socket per
code, `scripts/api-probes/probe-streaming-shape.mjs`:

```
  en     -> Begin, model universal-3-5-pro
  hi     -> Begin, model universal-3-5-pro
  multi  -> Begin, model universal-streaming-multilingual
  en,hi  -> closed close 3006 {"error_code":3006,"error":"User Input Validation Error: Invalid 'language_code.0': …"}
  pl     -> closed close 3006 {"error_code":3006,"error":"User Input Validation Error: Invalid 'language_code.0': …"}
  uk     -> closed close 3006 {"error_code":3006,"error":"User Input Validation Error: Invalid 'language_code.0': …"}
```

A one-line list of accepted codes in the streaming docs would have saved us
three bad entries in a twenty-option picker: `pl`, `uk` and `en,hi`. Nothing
kills a session now, because we clamp anything the socket does not serve to
`multi` before sending it — but a clamp is a workaround for a list we could
only get by feeding the endpoint garbage.

## 2. Naming a language silently changes the model, and the two behave differently

Ask for `language_code=en` and `Begin` reports `universal-3-5-pro`. Ask for
`multi` and it reports `universal-streaming-multilingual`. That substitution is
not documented, and it changes the API's observable contract.

Same 9.55 s clip, fed to both in real time over a raw socket by
`scripts/api-probes/probe-stream-timing.mjs` on 13 September. Three runs per cell, and the
whole probe was run three times, so each figure below is nine runs unless the
row says otherwise.

| | `universal-3-5-pro` (`en`) | multilingual (`multi`) |
|---|---|---|
| `word_is_final` during a turn | never — every word stays `false`, all flip together at `end_of_turn` | words finalise one at a time |
| words settled before their turn closed *(6 runs)* | **0 of 19**, every run | **17 of 19**, every run |
| partial cadence, median gap between updates | 971-1342 ms | 438-680 ms |
| updates across the clip | 8-12 | 19, every run |
| first partial behind the voice *(3 runs)* | 683-864 ms | 1263-1651 ms |
| turns the clip was cut into | 4-5, varying run to run at both frame sizes | 2, identically every run |

Five things about those numbers, because the previous draft of this table got
every one of them wrong:

- **The lag row is the number we are least sure of.** It is the arrival of the
  first partial minus the moment the voice
  actually starts, and finding that moment took two attempts: our first onset
  detector took its noise floor from the clip's leading 200 ms, which on this
  clip already contains speech, so it found no onset at all and silently
  reported zero. Speech begins **120 ms** into the file. The two earlier runs of
  this probe are therefore 120 ms high on this row and are not quoted here.
- **The cadence is a median of the gaps between updates, and the gaps are very
  uneven**: 38-1290 ms on multilingual within a single run. Take the shape of
  it — several partials per second against roughly one — and not a band. An
  earlier draft quoted "313-377 ms" for multilingual, which is outside every
  median we can now measure; the honest figure is around half a second.
- **The turn count is not a function of frame size.** An earlier draft said "4
  at 100 ms frames, 5 at 50 ms" as though that were a rule. Across nine runs at
  each frame size we saw 4 and 5 at both, with no pattern.
- **Frame size barely matters, and where it does it is the wrong way round.**
  Halving the frame from 100 ms to 50 ms made the first partial *later* on both
  models, not earlier.
- An earlier draft also cited "two independently written harnesses" giving
  170-192 ms and 449 ms. Neither harness is in this repository and neither
  result can be reproduced, so both are withdrawn rather than restated.

One difference we did not expect and have not seen documented: **the two models
punctuate differently on the same audio.** Same clip, same probe:

```
en     "Um. I don't really understand why attention needs positional encoding. I think, maybe. It's about which words are important?"
multi  "Um, I don't really understand why attention needs positional encoding. I think, maybe, it's about which words are important."
```

Sentence splits, commas and the final mark all move. Anything that diffs a
transcript across a language change — a cache key, a golden test, a
"did the student say the same thing twice" check — will see a difference that
has nothing to do with what was said.

Both are reasonable models. The problem is that the choice is made by a
parameter that looks like it only selects a language, and the difference decides
whether a progressive-transcript UI is possible at all. We built a settle
animation against `word_is_final`, shipped `en` as the default, and the
animation never fired for anyone — the transcript arrived in lumps about a
second apart. We
only found it by diffing socket frames between two language settings.

Suggestion: report the model in `Begin` (you already do — thank you, that is how
we found it) **and** say in the docs that `language_code` selects a model
family, with a note on which ones progress `word_is_final` mid-turn.

## 3. What arrives after `Terminate` depends on the model, and on when you send it

On `universal-streaming-multilingual`, terminating after the speech has ended
gets you one more `Turn`:

```json
{"end_of_turn": true, "transcript": "", "words": []}
```

Our first parser read `words[words.length - 1].text` and crashed on it. This
document previously said that was simply what a terminated session does. It is
not — on `universal-3-5-pro` that frame never appears, and terminating mid-turn
produces something different again. Four cells, from
`scripts/api-probes/probe-stream-timing.mjs`, identical across three independent runs:

| model | `Terminate` sent | `Turn` frames after it |
|---|---|---|
| `universal-3-5-pro` | after the last turn closed | **none** |
| `universal-3-5-pro` | mid-turn | **one, fully populated** — `{end_of_turn:true, transcript:"I don't really understand why attention needs", words:7}` |
| multilingual | after the last turn closed | **one, empty** — `{end_of_turn:true, transcript:"", words:0}` |
| multilingual | mid-turn | **four**: two more partials, then the populated flush, then the empty one |

The multilingual mid-turn cell in full, because "the flush and then the empty
one" undersold it — the partials keep coming after `Terminate` has been sent:

```
{end_of_turn:false, transcript:"Um, I don't really understand why", words:7}
{end_of_turn:false, transcript:"Um, I don't really understand why attention", words:8}
{end_of_turn:true,  transcript:"Um, I don't really understand why attention need", words:8}
{end_of_turn:true,  transcript:"", words:0}
```

In all four a `Termination` frame arrives last, before the close. That is the
frame worth keying cleanup off, and this section never used to mention it.

The mid-turn flush is genuinely useful and undocumented: it means a client can
stop a recording early without losing the audio it has already sent. The ask is
one table like this one in the docs, because a parser written against either
model breaks on the other, and ours was.

## 4. `keyterms_prompt` on the streaming socket: parsed, but shape-sensitive and silent

It is a real parameter — a malformed shape is rejected, which is how we know it
is parsed rather than ignored. `scripts/api-probes/keyterms-probe.mjs`:

| form | result |
|---|---|
| `keyterms_prompt=["a","b"]` (JSON array) | `Begin`, session opens |
| `keyterms_prompt=a&keyterms_prompt=b` (repeated) | closed, `3006` |
| `keyterms_prompt=a,b` (CSV) | closed, `3006` |
| a parameter name that does not exist at all | ignored, session opens |

Both rejections carry the same `Error` frame, and it is a good error — it names
the parameter and the expected shape:

```json
{"type":"Error","error_code":3006,
 "error":"User Input Validation Error: Invalid 'keyterms_prompt': Value error, Invalid JSON array"}
```

Two asks. First, the accepted shape is not in the streaming docs, and the two
natural guesses both kill the session. Second, `Begin` does not echo
`keyterms_prompt`, so there is no way to confirm it was applied. Its whole
payload, dumped from the socket on both models by
`scripts/api-probes/probe-streaming-shape.mjs`:

```json
{"type":"Begin","id":"ca416285-b9fc-4604-b670-0bb4c2472205","expires_at":1789323759,
 "configuration":{"model":"universal-streaming-multilingual","mode":null,
                  "api_version":"2025-05-12","speaker_labels":false,"redact_pii":false,
                  "filter_profanity":false,"domain":null,"voice_focus":null}}
```

The same eight `configuration` keys appear on both models; only their values
differ (`mode` is `"balanced"` on `universal-3-5-pro` and `null` on the
multilingual model). No sample rate, and no `keyterms_prompt`, even when two
terms were sent on that very socket. (An earlier draft of this section said
`Begin` echoes the sample rate. It does not, and we had no business saying so:
we had confused it with the query parameters we sent.)

We ran the socket A/B on identical audio with and without five terms
(`scripts/api-probes/keyterms-ab.mjs`): the same number of in-flight partials both times and
the same settled text, with the partials landing on slightly different word
boundaries — ordinary streaming jitter, not an effect we can attribute to the
terms. So we cannot tell whether the terms did not help on that clip or were
never applied, and we did not ship it. Echoing the value back in `Begin` would
settle that in one frame.

## 5. The concurrency cap is easy to trip, and we misread it ourselves

Opening sockets in a loop returns `error_code 1008`. Ten opens fired together in
one `Promise.all`, after a 30 s cooldown so the count measures the account cap
and not our own draining slots (`scripts/api-probes/probe-streaming-shape.mjs`):

```
  Begin: 5   refused: 5
    x5  close 1008 {"error_code":1008,"error":"Unauthorized Connection: Too many concurrent sessions"}
```

**Slots take far longer to free than "a few seconds".** The same probe then
tries to reopen one socket per second from the moment that burst closed:

```
  +1.2 s: still 1008
  +9.1 s: still 1008
  +17.1 s: still 1008
  +25.0 s: still 1008
  first successful open 27.7 s after the parallel burst closed
```

Twenty-seven and a half seconds of `1008` after five well-behaved sockets closed
is a long time for a client that has no documented number to back off against.
This is the one number in this document we would most like to see in the docs.

This section used to say that close is indistinguishable from the close for a
bad parameter, and asked for a distinct error string. **That was wrong, and it
is the correction we most want on the record.** A bad `language_code` closes
`3006` with `"User Input Validation Error: …"`; the cap closes `1008` with
`"Unauthorized Connection: Too many concurrent sessions"`. Different close code,
different error string, both carried in an `Error` frame before the socket goes.
The distinct string we were about to ask for already exists.

The mistake was ours and it is worth describing, because it is an easy one. A
language-support probe of ours (`scripts/api-probes/api-feedback-probe.mjs`) opened 44
sockets in sequence and recorded 22 languages as "refused". Its own saved output
in `.viva/api-feedback-evidence.json` has `1008` against those 22 and `3006`
against the 11 genuinely invalid ones — the API had told us plainly and the
probe collapsed both into one bucket. We nearly filed the resulting nonsense as
feedback.

Two things would still help. Say in the docs that a per-account concurrency cap
exists, roughly where it sits and how long a slot takes to free; we had to find
all three by hitting them. And say whether reconnecting on 1008 extends the
wait. *(That last one is a development recollection, not a probe: our impression
at the time was that hammering it made recovery slower, so we treat 1008 as
terminal rather than retrying. We have not measured it, and the 27.7 s above was
measured with exactly one open attempt per second, so it does not settle the
question either.)*

## 6. `/v3/token` clamps sensibly, and says so clearly

Not a complaint — a note that this is well done. `expires_in_seconds` is bounded
to 1..600 and the 422 names the bound (`scripts/api-probes/api-feedback-probe.mjs`):

```
asked       1s -> 200 granted 1
asked     600s -> 200 granted 600
asked    3600s -> 422 "Input should be less than or equal to 600"
asked      -1s -> 422 "Input should be greater than or equal to 1"
```

A short-lived, streaming-scoped token is exactly the right primitive for a
browser client, and it is the reason our API key never has to leave the server.

## 7. Dictation: the multipart part order matters, and the 400 does say so

`POST https://dictation.assemblyai.com/v1/transcribe/live` requires the `config`
part **before** the `audio` part. This section used to complain that sending it
the other way round fails without naming the cause. Re-probed directly against
the endpoint by `scripts/api-probes/probe-dictation-contract.mjs`, that is not true:

```
config first  -> 200
audio first   -> 400 {"error":"the `config` part must be sent before the `audio`
                      part on the streaming endpoint, because the upstream call
                      cannot be opened without it","error_code":"bad_request"}
```

That names the cause and the fix in one line, and the complaint is withdrawn.
What is left is a documentation ask: a multipart form is not usually
order-sensitive, so nobody writing the client thinks to check, and the ordering
requirement is not in the docs — it is only in the 400 you get after guessing.

**A correction we owe you.** This section previously said `Authorization` takes
the raw key with **no** `Bearer` prefix, "unlike most APIs". That is false. The
endpoint accepts both, and the key is genuinely checked either way
(`scripts/api-probes/probe-auth-header.mjs`):

```
  raw key              -> 200 (transcript returned)
  Bearer <key>         -> 200 (transcript returned)
  bearer <key> (lc)    -> 200 (transcript returned)
  Bearer <garbage>     -> 401 {"status":401,"title":"Unauthorized","detail":"Invalid API key"}
  <garbage>            -> 401 {"status":401,"title":"Unauthorized","detail":"Invalid API key"}
  no header            -> 401 {"status":401,"title":"Unauthorized","detail":"Missing Authorization header"}
```

We do not know where our original belief came from; most likely we hit a 401 for
an unrelated reason and blamed the prefix. It is the kind of thing that ends up
in a blog post and then in everyone's client, so it is worth stating plainly:
the prefix is optional and case-insensitive, and it is not a gotcha.

The one that *is* worth documenting is compressed audio. It returns 415, and the
body is one of the better errors in the API:

```
  audio/webm  -> 415 {"status":415,"title":"Unsupported Media Type","detail":"'audio/webm' cannot be decoded incrementally; send it to the buffered /v1/transcribe endpoint instead"}
  audio/mpeg  -> 415 {"status":415,"title":"Unsupported Media Type","detail":"'audio/mpeg' cannot be decoded incrementally; send it to the buffered /v1/transcribe endpoint instead"}
```

The constraint is reasonable and the error names the way out — but
`MediaRecorder` in a browser only emits WebM or Opus, so a browser client cannot
use the live endpoint without an AudioWorklet that produces PCM itself, and that
is the single biggest piece of work in integrating this API from a browser. It
belongs in the docs, not only in a 415.

## 8. Audio duration is taken from the declared sample rate

*This one is recollection, not a probe: it was our own production incident on 12
September and we did not keep the response.* We declared 48 kHz stereo audio as
16 kHz mono. Declaring half the channels and a third of the rate means the byte
stream is read at one sixth speed, so the clip was read as six times its length
and billed accordingly — an overcharge caused entirely by us. The 6× is
arithmetic and certain; the clip length is the part we are quoting from memory,
and elsewhere in this codebase it is recorded against the 9.55 s reference clip,
which would have been read as roughly 57 s.

Since the audio is raw PCM, the declared rate is the only thing that can
determine duration, so this is not a defect. But the failure is silent and
expensive in the direction that costs the customer money.

What makes it worth an ask is that **the endpoint already does this kind of
validation for a format that can state its own rate.** Posting headerless PCM
while declaring the part as `audio/wav` is refused on the spot
(`scripts/api-probes/probe-dictation-contract.mjs`):

```
  audio/wav   -> 400 {"status":400,"title":"Bad Audio","detail":"malformed WAV: missing RIFF/WAVE preamble"}
```

So the machinery to check a declaration against the bytes exists. For raw PCM
there is no header to check, but the response already carries
`audio_duration_ms` and the transcript's own word timings; a warning when a
declared duration and the last word's end time disagree by 6× would have caught
this immediately. We now resample and downmix server-side and reject
`audio/pcm` from callers outright.

## 9. Speaker labels in `stt_prompt`: an observation we cannot reproduce

On 12 September a `stt_prompt` beginning `"Student:"` produced transcripts that
started picking up the label, so we added a strip that removes speaker labels
before sending. The strip is real and pinned by a test.

Re-probing on 13 September we could not make it happen again
(`scripts/api-probes/probe-stt-prompt-leak.mjs`) — two clips, three posts each: no
`stt_prompt`, one whose prompt is thick with `Student:` and `Tutor:`, and the
same prompt with the labels stripped:

```
confusion-16k.wav (9.55 s):
  no stt_prompt    -> 200 leak:no  "Um, I don't really understand why attention needs positional encoding. …"
  labelled prompt  -> 200 leak:no  "Um, I don't really understand why attention needs positional encoding. …"
  stripped prompt  -> 200 leak:no  "Um, I don't really understand why attention needs positional encoding. …"
  all three byte-identical: true
claim-16k.wav (4.78 s):
  no stt_prompt    -> 200 leak:no  "Positional encoding tells the model which words matter most in the sentence."
  labelled prompt  -> 200 leak:no  "Positional encoding tells the model which words matter most in the sentence."
  stripped prompt  -> 200 leak:no  "Positional encoding tells the model which words matter most in the sentence."
  all three byte-identical: true
speaker label appeared in any transcript: NO
```

So take this as a single unreproduced observation, not a documented behaviour.
We are keeping the strip — it costs nothing and a prompt is a bad place to put
words the learner did not say — and keeping the note, but it should not cost
anyone an investigation on our say-so.

---

## What worked well, since bug reports are a biased sample

- `llm_instruction` is the reason we chose this API over a plain transcript. We
  ask it to remove filler and false starts but keep hedges exactly, because
  *"I think, maybe, it's about which words are important"* is the single most
  useful sentence a struggling student can say, and a tidier transcript that
  drops the *I think* throws the signal away. Getting both the verbatim and the
  cleaned text in one response is what makes that possible.
- `keyterms_prompt` on the Dictation endpoint is accepted, shape-checked and
  easy to build a subject's vocabulary into, and we send the concept names of
  whatever the student is studying with every clip. We cannot show it changing a
  transcript. An earlier draft of this line said it "measurably fixes subject
  vocabulary — 'positional encoding' instead of 'positional and coding'". An A/B
  on our reference clip — same audio, four terms against none, twice each,
  alternating (`scripts/api-probes/probe-dictation-contract.mjs`) — came back byte-identical
  in all four posts, and "positional encoding" was already right without the
  terms. "Positional and coding" appeared in neither. Section 4 says the same
  thing about the streaming socket, and the two agree.
- `request_time_ms` on the 9.55 s reference clip, posted straight at the
  endpoint from a UK machine, twelve runs (`scripts/api-probes/probe-dictation-contract.mjs`):
  **538-1700 ms, median 552 ms** — eleven runs inside 538-583 and one at 1700.
  Through our own Vercel deployment, two runs of twelve on the same afternoon
  (`scripts/api-probes/lat.mjs`) gave `request_time_ms` medians of **605 ms** and **558 ms**,
  inside end-to-end medians of 1215 ms and 1300 ms. An earlier draft said
  "546-580 ms, consistently" and a later one "560-591 ms across twelve runs";
  neither band survives two runs of the same probe, and the outlier is the
  point — it is fast, and it is not a stable property of the audio. The one
  thing on this clip that *is* perfectly stable is `confidence`: twelve runs,
  one value (`0.9873139746014078`), twelve distinct session ids.
- `Begin` reporting the resolved model. It is the only reason section 2 above
  is a documentation note rather than a mystery.
