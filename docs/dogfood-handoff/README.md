# DOGFOOD hand-off

DOGFOOD (`D:\project\dogfood-2026` on the original machine) is not in this repository and was not reachable from the cloud session that built VIVA RedTeam. **Nothing about DOGFOOD was verified, changed or frozen in that session.** The last state reported by the earlier OpenCode session (7/7 official acceptance, 101 tests, 28/28 route probe, 19/19 browser assertions) is that session's claim, not something re-run here.

What is needed from you, in order:

1. `cd D:\project\dogfood-2026; git status` — commit anything outstanding (the OpenCode session's last command was an auth-related commit; check it landed).
2. Push the repository to GitHub (private is fine) and, if you want the cloud session to work on it, add it to the session's repository scope.
3. Copy `container-proof.yml` from this folder to `.github/workflows/` in that repository and push. A green run is the container evidence the earlier session said it lacked. Do not claim it before a run is green.
4. With Docker available locally, `docker compose up --build` and `python official/run.py .dogfood.toml` is the same check by hand.
5. Regenerate the acceptance report (`npm run acceptance:save`), confirm the tree is clean, tag, and stop.

The "Explain this rank" panel was not started.
