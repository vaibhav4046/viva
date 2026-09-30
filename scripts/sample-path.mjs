#!/usr/bin/env node
/**
 * Front-door walk: open /, press "Try a sample exam", confirm /oral opens with the
 * sample course selected and that the oral session config for that course loads.
 *
 *   BASE_URL=http://localhost:3121 node scripts/sample-path.mjs
 *
 * Prints one line per check. Exit 1 on the first failure. One Chromium, closed at the end.
 */
import { chromium } from "@playwright/test";

const base = process.env.BASE_URL ?? "http://localhost:3121";
const browser = await chromium.launch();
let failed = false;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "pass" : "FAIL"} ${name}${detail ? ": " + detail : ""}`);
  if (!ok) failed = true;
};

try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const t0 = Date.now();
  await page.goto(base + "/", { waitUntil: "load" });
  check("landing has one h1", (await page.locator("h1").count()) === 1);
  await page.getByRole("link", { name: "Try a sample exam" }).click();
  await page.waitForURL(/\/oral\?subjectId=course_transformers_w4/, { timeout: 30000 });
  check("sample button opens /oral with the sample course", true, `${Date.now() - t0} ms from load to /oral URL`);
  const stored = await page.evaluate(() => [localStorage.getItem("viva.courseId"), localStorage.getItem("viva_course")]);
  check("sample course stored for both screens", stored[0] === "course_transformers_w4" && stored[1] === "course_transformers_w4", stored.join(","));
  await page.getByRole("button", { name: /Start the exam/ }).waitFor({ timeout: 30000 });
  check("start control is present", true);
  const res = await page.evaluate(async () => {
    const r = await fetch("/api/oral/session?subjectId=course_transformers_w4", { cache: "no-store" });
    const b = await r.json().catch(() => null);
    return { status: r.status, hasPrompt: Boolean(b && b.system_prompt), subjectId: b && b.subjectId, code: b && b.error && b.error.code };
  });
  check("oral session config loads for the sample course", res.status === 200 && res.hasPrompt, JSON.stringify(res));
  await ctx.close();
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
