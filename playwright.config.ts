import { defineConfig, devices } from "@playwright/test";

/**
 * Accessibility audits. Boot a server yourself first (`npm run dev`), then:
 *   A11Y_BASE=http://localhost:3000 npx playwright test
 *
 * No hardcoded browser path here on purpose — it used to pin one machine's
 * Chrome cache, which broke the suite on every other checkout. Playwright's
 * own managed Chromium is used instead (`npx playwright install chromium`).
 */
export default defineConfig({
  testDir: "./tests/a11y",
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: process.env.A11Y_BASE ?? "http://localhost:3000",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
