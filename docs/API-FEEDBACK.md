# Notes on the Dictation and Streaming APIs

Everything here was measured against the live endpoints while building VIVA
between 9 and 13 September 2026, with the response recorded, and every section
names the probe that produced it. One item is recollection rather than a probe
and says so where it appears: the sample-rate overcharge in section 8 was our
own production incident. Where a probe turned out to be measuring our own
mistake rather than the API's behaviour, that is said so too.

Every section was re-probed on 13 September before this was sent, and six
findings did not survive the second look. They are corrected in place, and the
correction is named where it happened: the trailing `Turn` in section 3 appears
on only one of the two models, `Begin` echoes no sample rate (section 4), the
concurrency close is *not* indistinguishable from a validation close (section
5), the part-order 400 does name its cause (section 7), the speaker-label leak
in section 9 no longer reproduces at all, and `keyterms_prompt` on the batch
endpoint changed nothing on our own clip (closing section). Five of the six made
the API look worse than it is; the sixth claimed a benefit for it we cannot
demonstrate. They are called out rather than quietly edited, because a vendor
cannot act on a report whose errors are hidden.
Where a number moved between runs it is given as a range with its sample size,
not as a median that looks firmer than the measurement behind it.

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

A one-line list of accepted codes in the streaming docs would have saved us
three bad entries in a twenty-option picker: `pl`, `uk` and `en,hi`. Nothing
kills a session now, because we clamp anything the socket does not serve to
`multi` before sending it — but a clamp is a workaround for a list we could
only get by feeding the endpoint garbage.

## 2. Naming a language silently changes the model, and the two behave differently

Ask for `language_code=en` and `Begin` reports `universal-3-5-pro`. Ask for
`multi` and it reports `universal-streaming-multilingual`. That substitution is
not documented, and it changes the API's observable contract. Same 9.5 s clip,
fed to both in real time over a raw socket on 13 September — three runs each for
the settle and cadence rows, two each for the lag row:

| | `universal-3-5-pro` (`en`) | multilingual (`multi`) |
|---|---|---|
| `word_is_final` during a turn | never — every word stays `false`, all flip together at `end_of_turn` | words finalise one at a time |
| words settled before their turn closed | **0**, all three runs | **17 of the clip's 19** — every word but the last of each turn |
| partial cadence | ~1.3 s (1245-1301 ms) | 313-377 ms here; not robust, see below |
| first word behind the voice | 254-255 ms | 458-459 ms |
| turns the clip was cut into | 4 at 100 ms frames, 5 at 50 ms | 2, identically every run |

The multilingual cadence is the one number in this document we cannot pin down.
Our own harness gives 313-340 ms at 100 ms frames and 373-377 ms at 50 ms
frames; two independently written harnesses on the same clip and the same day
gave 170-192 ms and 449 ms. So take the shape of it — several partials per
second against roughly one — and not a band. An earlier draft of this table
quoted "~250-400 ms" and "2 vs 22 words"; the word counts were plain wrong (the
clip has nineteen words in it, so 22 was never reachable) and the band was
narrower than the measurement supports.

Both are reasonable models. The problem is that the choice is made by a
parameter that looks like it only selects a language, and the difference decides
whether a progressive-transcript UI is possible at all. We built a settle
animation against `word_is_final`, shipped `en` as the default, and the
animation never fired for anyone — the transcript arrived in 1.3 s lumps. We
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
produces something different again. Four cells, measured:

| model | `Terminate` sent | `Turn` frames after it |
|---|---|---|
| `universal-3-5-pro` | after the last turn closed, or after 1 s of silence | **none** |
| `universal-3-5-pro` | mid-turn | **one, fully populated** — `end_of_turn: true` with the words heard so far |
| multilingual | after the last turn closed, or after silence | **one, empty**, as above |
| multilingual | mid-turn | **the populated flush, and then the empty one** |

In all four a `Termination` frame arrives last, before the close. That is the
frame worth keying cleanup off, and this section never used to mention it.

The mid-turn flush is genuinely useful and undocumented: it means a client can
stop a recording early without losing the audio it has already sent. The ask is
one table like this one in the docs, because a parser written against either
model breaks on the other, and ours was.

## 4. `keyterms_prompt` on the streaming socket: parsed, but shape-sensitive and silent

It is a real parameter — a malformed shape is rejected, which is how we know it
is parsed rather than ignored:

| form | result |
|---|---|
| `keyterms_prompt=["a","b"]` (JSON array) | `Begin`, session opens |
| `keyterms_prompt=a&keyterms_prompt=b` (repeated) | closed, `3006` |
| `keyterms_prompt=a,b` (CSV) | closed, `3006` |
| a parameter name that does not exist at all | ignored, session opens |

Both rejections say `Invalid 'keyterms_prompt': Value error, Invalid JSON array`,
which is a good error — it names the parameter and the expected shape.

Two asks. First, the accepted shape is not in the streaming docs, and the two
natural guesses both kill the session. Second, `Begin` does not echo
`keyterms_prompt`, so there is no way to confirm it was applied. Its whole
payload is `type`, `id`, `expires_at` and a `configuration` of `model`, `mode`,
`api_version`, `speaker_labels`, `redact_pii`, `filter_profanity`, `domain`,
`voice_focus` — on both models. (An earlier draft of this section said `Begin`
echoes the sample rate too. It does not, and we had no business saying so: we
had confused it with the query parameters we sent.) We ran an A/B on identical
audio with and without the terms and got byte-identical transcripts, which could
mean the terms did not help on that clip or that they were never applied — we
could not tell, so we did not ship it. Echoing it back in `Begin` would settle
that in one frame.

## 5. The concurrency cap is easy to trip, and we misread it ourselves

Opening sockets in a loop returns `error_code 1008`, and slots take seconds to
free. Ten parallel opens on our account: five got `Begin`, five got

```
close 1008  {"error_code":1008,"error":"Unauthorized Connection: Too many concurrent sessions"}
```

This section used to say that close is indistinguishable from the close for a
bad parameter, and asked for a distinct error string. **That was wrong, and it
is the correction we most want on the record.** A bad `language_code` closes
`3006` with `"User Input Validation Error: …"`; the cap closes `1008` with
`"Unauthorized Connection: Too many concurrent sessions"`. Different close code,
different error string, both carried in an `Error` frame before the socket goes.
The distinct string we were about to ask for already exists.

The mistake was ours and it is worth describing, because it is an easy one. A
language-support probe of ours opened 44 sockets in sequence and recorded 22
languages as "refused". Its own saved output has `1008` against those 22 and
`3006` against the genuinely invalid ones — the API had told us plainly and the
probe collapsed both into one bucket. We nearly filed the resulting nonsense as
feedback.

Two things would still help. Say in the docs that a per-account concurrency cap
exists, and roughly where it sits; we had to find ours by hitting it. And say
that reconnecting on 1008 makes it worse, so it has to be treated as terminal
rather than retried — that one we did get right, and it cost a session to learn.

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

## 7. Dictation: the multipart part order matters, and the 400 does say so

`POST https://dictation.assemblyai.com/v1/transcribe/live` requires the `config`
part **before** the `audio` part. This section used to complain that sending it
the other way round fails without naming the cause. Re-probed directly against
the endpoint, that is not true:

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

Also worth stating in the docs, since both of these cost us time:

- `Authorization` takes the raw key with **no** `Bearer` prefix, unlike most APIs.
- Compressed audio returns 415, and the body is one of the better errors in the
  API: `"'audio/webm' cannot be decoded incrementally; send it to the buffered
  /v1/transcribe endpoint instead"`. Same for `audio/mpeg`. The constraint is
  reasonable and the error names the way out — but `MediaRecorder` in a browser
  only emits WebM or Opus, so a browser client cannot use the live endpoint
  without an AudioWorklet that produces PCM itself, and that is the single
  biggest piece of work in integrating this API from a browser. It belongs in
  the docs, not only in a 415.

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

## 9. Speaker labels in `stt_prompt`: an observation we cannot reproduce

On 12 September a `stt_prompt` beginning `"Student:"` produced transcripts that
started picking up the label, so we added a strip that removes speaker labels
before sending. The strip is real and pinned by a test.

Re-probing on 13 September we could not make it happen again. Two clips, three
posts each — no `stt_prompt`, one whose prompt is thick with `Student:` and
`Tutor:`, and the same prompt with the labels stripped — returned
byte-identical transcripts in all six. So take this as a single unreproduced
observation, not a documented behaviour. We are keeping the strip and keeping
the note, but it should not cost anyone an investigation on our say-so.

---

## What worked well, since bug reports are a biased sample

- `llm_instruction` is the reason we chose this API over a plain transcript. We
  ask it to remove filler and false starts but keep hedges exactly, because
  *"I think, maybe, it's about which words are important"* is the single most
  useful sentence a struggling student can say, and a tidier transcript that
  drops the *I think* throws the signal away. Getting both the verbatim and the
  cleaned text in one response is what makes that possible.
- `keyterms_prompt` on the batch endpoint is accepted, shape-checked and easy to
  build a subject's vocabulary into, and we send the concept names of whatever
  the student is studying with every clip. We cannot show it changing a
  transcript. An earlier draft of this line said it "measurably fixes subject
  vocabulary — 'positional encoding' instead of 'positional and coding'". An A/B
  on our reference clip, same audio, four terms against none, twice: the
  transcripts came back byte-identical and "positional encoding" was already
  right without the terms. "Positional and coding" appeared in neither. Section
  4 says the same thing about the streaming socket, and the two should agree.
- `request_time_ms` on a 9.5 s clip: **560-591 ms across twelve runs**, median
  566 ms, through our own endpoint on 13 September. An earlier draft said
  "546-580 ms, consistently"; it is not consistent, and a 34 ms band was never
  ours to quote. Two reviewers re-running the same probe against the same
  deployment the same day got medians of 578 ms and 590 ms with single runs at
  623 and 644 ms, and posting the identical clip straight to the endpoint from
  this machine returned 594, 796, 880 and 2106 ms. It is fast, and it is not a
  stable property of the audio.
- `Begin` reporting the resolved model. It is the only reason section 2 above
  is a documentation note rather than a mystery.
