import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Load `.env.local` the way Next does, because vitest does not.
 *
 * Without this, `tests/assemblyai-live.test.ts` was opt-never rather than
 * opt-in: it guards on `process.env.ASSEMBLYAI_API_KEY`, nothing ever set it,
 * so `describe.skipIf` skipped it silently — including when you ran its own
 * `npm run test:assemblyai-live` script on purpose. A live integration test
 * that has never once executed is worse than not having one, because it reads
 * like coverage in the test count.
 */
// ONLY for the live run. Loading these into the whole suite changes what every
// other test sees — DATABASE_URL, the LLM chain, the AssemblyAI key — and tests
// that assert the no-key and no-database behaviour started failing in droves.
// The default gate must run against a bare environment.
for (const file of process.env.VIVA_LIVE === "1" ? [".env.local", ".env"] : []) {
  let raw: string;
  try {
    raw = fs.readFileSync(new URL(file, import.meta.url), "utf8");
  } catch {
    continue;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    // First file wins, and a real environment variable always beats a file.
    if (process.env[key] !== undefined) continue;
    process.env[key] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
}

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    /*
     * The ceiling is a deadline on a machine whose speed we do not control, so
     * it is set from the worst stretch measured, not from the work.
     *
     * The suite went red about four runs in nine, always a 5000 ms timeout,
     * never an assertion, and a different subset each time — study-loop,
     * store, marking-honesty. None of them is slow. Measured 2026-09-13, the
     * same three tests, same box (12 CPUs):
     *
     *   condition                                     worst test in the three
     *   each file run on its own                                    109-129 ms
     *   the three files run together                                109-194 ms
     *   whole suite, --fileParallelism=false                         95-124 ms
     *   whole suite, parallel, idle box                            168-1844 ms
     *   whole suite, parallel, 12 busy processes alongside        1363-3510 ms
     *
     * So it is ~100 ms of work stretched up to 35x by running 52 files across
     * eleven forks on twelve cores. Not a deadlock: sequential is instant, and
     * the cost scales smoothly with load rather than parking at a fixed point.
     * Running sequentially would fix it and cost 48 s a run against 11 s.
     *
     * Raising the ceiling instead, and raising it here rather than on the
     * three files that happened to fail: the same loaded run put sync at
     * 3929 ms and tutor-brain at 3002 ms, neither of which was ever reported.
     * The three names were a sample, not the population. 30 s is 8x the worst
     * stretch seen and still fails a genuine hang — one costs 30 s in a suite
     * that finishes in 11.
     *
     * Files that are honestly slow keep saying so themselves: claim-recall's
     * recall sweep carries its own 120_000, and it means it.
     */
    testTimeout: 30_000,
    /*
     * The live suite spends real AssemblyAI credits and depends on someone
     * else's uptime, so it is not part of the gate every commit runs — but it
     * must run when asked. `npm run test:assemblyai-live` sets VIVA_LIVE=1.
     * Excluding it unconditionally would reproduce the original bug in a new
     * place: a suite that cannot be run deliberately is indistinguishable from
     * one that is broken.
     */
    exclude: process.env.VIVA_LIVE === "1" ? ["node_modules/**"] : ["node_modules/**", "tests/assemblyai-live.test.ts"],
  },
});
