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
