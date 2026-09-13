import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/study/turn/route";

function post(body: unknown, ip: string) {
  return POST(
    new Request("http://localhost/api/study/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }) as unknown as Parameters<typeof POST>[0]
  );
}

describe("adversarial: study/turn bodies", () => {
  it("malformed bodies are 400s, never 500s", async () => {
    const shapes: unknown[] = [
      {}, { text: "" }, { text: 42 }, { text: null }, [],
      "just a string", { text: "x".repeat(6001) },
      { transcript: "ok", origin: "telepathy" },
      { text: "hello", confidence: "high" },
      { text: "hello", asr: { mode: "shout" } },
      { text: "hello", subjectId: "x".repeat(81) },
    ];
    for (const shape of shapes) {
      const res = await post(shape, `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`);
      expect(res.status, JSON.stringify(shape).slice(0, 60)).toBe(400);
      const body = await res.json();
      expect(body.error?.code).toBe("BAD_REQUEST");
    }
  });

  it("non-JSON is a 400", async () => {
    const res = await post("{broken", "10.8.9.9");
    expect(res.status).toBe(400);
  });
});
