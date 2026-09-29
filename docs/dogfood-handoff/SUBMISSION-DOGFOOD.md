# DOGFOOD — submission copy (draft)

> Paste-ready, but **every number below is the earlier OpenCode session's claim**, not something verified from the cloud session. Run `freeze.ps1` first and change any number its logs in `freeze-evidence\` disagree with. Delete this note before you submit.

## One line
Hackathon judging you can audit: every judge's score normalised deterministically, every rank explainable, every action on the record.

## The problem
Judging panels are uneven. One judge scores everything a 9, another never gives above a 6, and one of them sees your project while the other doesn't. Raw averages turn "who reviewed you" into "where you ranked". Organizers can't show why a project placed where it did, and a leaked peer score can end a hackathon's credibility.

## What DOGFOOD does
- **Judge Desk:** judges score against weighted criteria and see only their own scores.
- **Deterministic normalisation:** judge severity is corrected with shrinkage toward the panel mean for judges with few reviews. The same input always gives the same ranking, and every run carries a normalisation fingerprint.
- **Calibration Lab:** organizers see raw scores, judge severity, the normalisation adjustment and the resulting rank side by side, plus a normalisation proof.
- **Organizer Control Room:** review coverage, progress and exceptions.
- **Audit trail and CSV export:** every score change is recorded, and results export as CSV.

## Evidence
| Check | Result |
|---|---|
| Official acceptance suite (vendored unmodified) | 7 / 7 PASS — T1 and T2 |
| Project test suite | 101 passing |
| Route probe | 28 / 28 |
| Browser assertions | 19 / 19, plus a responsive screenshot suite |
| Authorization red-team sweep | done — found a real peer-score leak and fixed it |
| Container run | `container-proof` GitHub Actions run — ⟨link to the green run, or remove this row⟩ |

## Security
- There is a threat model in the repo.
- Judges cannot read other judges' scores. This was verified by the authorization sweep that found and fixed the peer-score leak.
- Organizer actions are audited.

## Built with
⟨stack from the repo's package.json⟩

## Links
- Repository: ⟨https://github.com/vaibhav4046/dogfood-2026⟩
- Demo video: ⟨link⟩
- Docs: README, architecture, data model, judging docs (all in the repo)

## Honest limits
- Container verification counts only if the CI run is green. If it isn't, say "Docker authored, not exercised" here.
- "Explain this rank" as a single per-project panel was not added. The Calibration Lab already shows the underlying numbers.
