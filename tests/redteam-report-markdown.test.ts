import { describe, expect, it } from "vitest";
import { createSession, finish, recordUtterance } from "@/lib/redteam/session";
import { md, reportToMarkdown } from "@/lib/redteam/reportMarkdown";

describe("the Markdown export is inert", () => {
  it("escapes links, HTML and headings in user text", () => {
    expect(md("[click](javascript:alert(1))")).not.toMatch(/\[click\]\(/);
    expect(md("<img src=x onerror=alert(1)>")).toMatch(/^\\<img/); // `\<` is a literal "<" in Markdown, not a tag
    expect(md("# not a heading")).toMatch(/^\\#/);
  });

  it("a hostile document title and claim cannot inject a link into the exported report", () => {
    const s = createSession({
      userId: "u",
      mode: "SKEPTIC",
      title: "[Pwn](https://evil.example) <script>",
      text: "# Plan\nThe gateway runs [one worker](https://evil.example) behind a queue.\nThe queue has a single consumer that drains it every minute.",
    });
    recordUtterance(s, "The gateway runs [two workers](javascript:alert(1)) behind a queue.");
    const out = reportToMarkdown(finish(s));
    expect(out).not.toMatch(/\]\((?:https?|javascript):/);
    expect(out).not.toMatch(/(?<!\\)<script>/);
    expect(out).toMatch(/^# Defensibility Report/m);
  });
});
