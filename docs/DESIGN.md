# VIVA design notes: Examiner's table

An oral exam is two people and a stack of papers. The interface is a quiet desk: warm paper, ink, one red pen.
This file records the product answers, the direction, the tokens, the icon inventory, the reasons for every
allowlisted audit finding, and the rules for adding a component. The gates that enforce it are
`npm run audit:vibe`, `npm run check:contrast`, `npm run lint:copy` and `npm run shoot`.

## Product answers (checked against the code)

| Question | Answer for VIVA |
|---|---|
| Primary user | A university student revising from their own lecture notes. |
| Problem | They can recognise the right answer on a page but cannot say whether they can explain it aloud. |
| Main action | Start a spoken exam on your material (`/oral`). |
| Visible at once | What it is, "Try a sample exam", the headphones and microphone note, a real excerpt of the product. |
| Shown on request | Diagnostics, method labels, upload details, history. |
| Trust | Corrections quoted from your own pages and checked by code as substrings; privacy and data pages generated from the code; measured numbers only, none published yet. |
| Demonstrate, not describe | The landing excerpt uses the real components; `/recorded` plays a recorded session once one is published. |
| Should not exist | Pricing, testimonials, logos, generic chat-with-PDF UI, mascots, sparkle marks, gradients, orbs. |

## Direction

- Surfaces: `--canvas` page, `--surface-1` sheets, `--surface-2` recessed notes, `--elevated` for fields and the one modal.
  No pure white anywhere. There is no dark theme.
- Five hues, one job each: ink `--primary` (actions), red pen `--correction` (a wrong statement, never decoration),
  source green `--success` (checked against your pages), amber `--warning`, blue `--info` (information and the focus ring).
- Type: Newsreader for display and the exam question, IBM Plex Sans for the interface, IBM Plex Mono for page numbers,
  timings and passage ids. Self-hosted through `next/font`, display swap, weights as used (Newsreader 400 and 500, Plex
  Sans 400, 500 and 600, Plex Mono 400 and 500). Not Inter, Geist or Space Grotesk: those are the default of every
  generated interface. A serif question reads as a page being read to you.
- Radius 2, 4 and 6 px; 10 px for the modal only; a pill only for status chips. Borders and tone separate surfaces.
  The only shadow is `--shadow-overlay`, on the modal and popover.
- Motion 120 to 280 ms, all of it switched off by `prefers-reduced-motion`. No page transitions, no decorative loops.
  `motion` stays installed and is provided only inside the `(app)` layout (`MotionProvider`), so `/` ships none of it.

## Tokens

`src/styles/tokens.css` is the source. `src/app/globals.css` bridges the tokens to Tailwind utilities
(`bg-canvas`, `text-ink`, `border-rule`) and keeps the older `--color-obsidian ... --color-band-notyet` names as aliases
so screens not yet rebuilt pick up the new palette. New code uses the semantic names. Components read variables, never
raw hex; the audit fails a hex value in a component (X03). `tests/design-tokens.test.ts` pins every value and recomputes
contrast; `design/contrast-pairs.json` lists each text-on-surface pair and `scripts/check-contrast.mjs` checks it
(32 pairs, lowest ratio 3.17 for input edges against 3:1).

Interaction states exist for every interactive element: default, hover, active, focus-visible (2 px ring, 2 px offset,
`--border-focus`), disabled, loading (`aria-busy`, label changes, size stays), error (`aria-invalid`, text message
tied by `aria-describedby`). `/dev/kitchen-sink` shows all of them; it returns 404 in production.

## Icon inventory

Six custom marks in `src/components/ui/icons.tsx`, 24 px grid, 1.5 px stroke, `currentColor`: microphone, stop, keyboard
(type instead), page mark, play, download. Plus the brand mark. No icon library on the golden path. `lucide-react` is
still imported by 17 names on screens outside it (study, subjects, today, map, exam, connect) and is listed in
`THIRD-PARTY.md` for that reason only.

## Allowlist reasons

`design/audit-allowlist.json` has five entries; each names a product or platform reason.

- `themeColor` in `src/app/layout.tsx`: a browser API that needs a literal colour. The value equals `--canvas`.
- The blinking caret in `LiveTranscript.tsx`: marks a live transcript still being written. It is state, and the
  reduced-motion block switches it off.
- A regular expression in `src/lib/intake/html.ts` that matches dashes in fetched page titles. It is input, not copy.
- Two interim entries for the pre-rebuild `/oral` page. They are deleted when the rebuilt screen lands.

Warnings are reviewed line by line in `design/audit-review.md`.

## Rules for adding a component

1. Read the tokens first. If the design needs a value that is not there, add the token and its contrast pair, then use it.
2. A new hue needs a job that none of the five has. There has not been one yet.
3. Every interactive element gets all six states and is added to the kitchen sink in the same commit.
4. Text is a label. A seventh icon needs a written reason here and a reason that words cannot carry.
5. No shadow except overlays, no gradient, no blur, no coloured stripe, no radius above 6 px outside the modal, no hover
   transform. Use a border, a tone change and spacing.
6. Async areas ship a fixed-size skeleton, an empty state that says what belongs there and what to do, and an error
   state with cause, consequence and an action.
7. Copy names the input, the action and the output. No dashes, no exclamation marks, none of the words in
   `scripts/lint-copy-voice.mjs`.
8. Run `npm run audit:vibe`, `npm run check:contrast` and `npm run lint:copy` before the commit.

## Known follow-ups

- Restyle by token only so far: `/study`, `/subjects`, `/today`, `/map`, `/exam`, `/connect`. They still use lucide icons,
  some `chip` pills that are not status chips, and older component names.
- `/oral` and the debrief sheet belong to the next design pass; they should render the shared components in
  `src/components/ui/exam.tsx`.
- Loading states on screens that fetch (`CoursePicker` callers, `MicButton`) were reviewed as warnings, not checked one by one.
- After the branches merge, run `node scripts/strip-dashes.mjs --write --include-deferred` and set `VOICE_STRICT=1`.
