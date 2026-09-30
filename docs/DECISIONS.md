# Decisions

Dated entries, newest last. Each says what was chosen, what it was scored against, and why.

## 2026-09-29: the typed path on /oral

Options scored on: works with no microphone, verified against the live service, size of change to code owned by another stream.

| Option | No mic | Verified | Size |
|---|---|---|---|
| A. Send the typed text into the open Voice Agent socket as a `conversation.message` | no, needs a session | not verified live; the reference says it injects context, not that it triggers a reply | edits socket.ts |
| B. Typed exam on the existing quiz endpoints (`/api/exam/start`, `/api/exam/answer`) | yes | endpoints already tested and used by `/exam` | one component |
| C. Both | yes | half | both |

Chosen: B. It covers a denied microphone, no device, an insecure page and a learner who prefers typing, and every graded answer becomes a debrief entry. Choosing Type instead during a live exam ends the voice session first. A is left out until a live probe shows the service replies to injected text.

## 2026-09-29: where the diagnostics numbers come from

`?diag=1` sets `globalThis.__VIVA_ORAL_TRACE__` before the socket opens; the socket already writes event names and `performance.now()` stamps there. The drawer derives every number from that array (`src/components/oral/diag.ts`, tested against a scripted trace). No number is stored or prefilled, and the socket needed no change for this. Barge-in is labelled "speech-started event to playback flushed" because that is the interval the client can measure; it does not include the service's own detection time.

## 2026-09-29: start and stop shortcut

Alt+Shift+M. Space is not usable (it belongs to focused buttons and page scroll, see `src/lib/audio/shortcut.ts`), a single letter would break WCAG 2.1.4, and Ctrl+Shift+Space belongs to another app on this owner's machine. A chord with Alt and Shift does not collide with a browser or screen reader shortcut on Windows, macOS or Linux in the browsers tested. It is shown in the controls bar and hidden on coarse pointers.

## 2026-09-29: live captions

The examiner line appears word by word from `transcript.agent.delta` (one word per event per the events reference), then is replaced by the final `transcript.agent` text. This needed one forwarding line in `src/lib/oral/socket.ts` (`onAgentDelta`). Partial learner transcript deltas are shown in the "You" card and are not announced by any live region.
