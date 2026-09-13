/*
 * Run the live AssemblyAI suite on purpose.
 *
 * `VIVA_LIVE=1 vitest …` is not portable to the shell npm uses on Windows, and
 * without the flag `vitest.config.mts` excludes the suite — which is how it
 * came to be skipped silently on every run, including its own script. Setting
 * it here keeps one command that works everywhere.
 *
 * What it spends depends on whether the audio fixture is on disk. Without it
 * the suite only checks provider resolution, error mapping and recorded shapes
 * and costs nothing — which is what it did for its whole life, while this
 * comment claimed otherwise and a 623 ms pass got quoted as integration
 * evidence. With `.viva/fixtures/spoken-sentence.wav` present it sends one real
 * clip to the Dictation endpoint and asserts the words that come back. That is
 * the run worth quoting, and the reason this is not in `npm run verify`.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Run vitest's own entry with this node, rather than spawning npx: spawning a
// .cmd shim on Windows fails with EINVAL unless you opt into a shell, and
// opting into a shell means quoting arguments by hand.
const vitest = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));

const child = spawn(
  process.execPath,
  [vitest, "run", "tests/assemblyai-live.test.ts", ...process.argv.slice(2)],
  { stdio: "inherit", env: { ...process.env, VIVA_LIVE: "1" } }
);

child.on("exit", (code) => process.exit(code ?? 1));
