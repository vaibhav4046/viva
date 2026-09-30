# audit-vibe warning review

Each `warn` finding from `node scripts/audit-vibe.mjs` needs a line here naming the file and the decision.

| File | Rule | Decision |
|---|---|---|
| src/app/(app)/connect/page.tsx | R16 | Keep. A single copy button that swaps a copy glyph for a check glyph when the copy succeeds. It is not a list of checkmark bullets. The screen is off the golden path and is restyled by token only. |
| src/app/(app)/exam/page.tsx | R16 | Keep. Each chip is a point the marker found correct in a typed teach-back answer, drawn as a check plus the point's own words, so the mark is never the only signal. Off the golden path. |
| src/app/(app)/oral/page.tsx | X06 | Interim. The screen is replaced by the Examiner's table /oral build, which sets nothing under 12 px. |
| src/components/course/CoursePicker.tsx | R21 | Keep. This file is the shared course-list fetch helper and the storage key, not a component. The screens that call it own the loading state. Not checked per screen; listed as follow-up in docs/DESIGN.md. |
| src/components/voice/MicButton.tsx | R21 | Keep. The two fetches are the transcription request, whose progress is the "transcribing" phase of the mic button, and a telemetry beacon that shows nothing. Off the golden path. |
| src/styles/tokens.css | R30 | Keep. The two flagged tokens are the warm paper surfaces (--surface-1, --elevated). They are the "Examiner's table" direction in docs/DESIGN.md: warm neutrals close to white, hue about 40 degrees, no accent hue. They are not pastel accent backgrounds. Contrast on them is asserted in tests/design-tokens.test.ts. |
| (repo) | R02 | Keep for now. 17 distinct lucide-react imports remain on screens outside the golden path (study, subjects, today, map, exam, connect). The golden path (landing, /oral, debrief, intake front door, trust pages, shell) imports none. Removal is listed in docs/DESIGN.md as follow-up. |
