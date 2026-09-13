/*
 * Run the live AssemblyAI suite on purpose.
 *
 * `VIVA_LIVE=1 vitest …` is not portable to the shell npm uses on Windows, and
 * without the flag `vitest.config.mts` excludes the suite — which is how it
 * came to be skipped silently on every run, including its own script. Setting
 * it here keeps one command that works everywhere.
 *
 * This spends real AssemblyAI credits, which is why it is not in `npm run
 * verify`.
 */
import { spawn } from "node:child_process";

const child = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["vitest", "run", "tests/assemblyai-live.test.ts", ...process.argv.slice(2)],
  { stdio: "inherit", env: { ...process.env, VIVA_LIVE: "1" } }
);

child.on("exit", (code) => process.exit(code ?? 1));
