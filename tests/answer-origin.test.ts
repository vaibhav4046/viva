import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { POST as examAnswer } from "@/app/api/exam/answer/route";
import { POST as teachAnswer } from "@/app/api/teachback/answer/route";

/**
 * How the words arrived must survive grading.
 *
 * Both answer routes used to hardcode `origin: "voice"` on the recorded
 * event, so a typed exam answer or a typed teach-back was filed as spoken.
 * The pages already know (MicButton hands every submit its origin); the
 * routes threw it away. The record distinguishes the two — sync replays it,
 * the UI chips it — so the lie compounded downstream.
 */

let tmp: string;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "viva-answer-origin-"));
  process.env.DATA_DIR = tmp;
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
});

afterEach(async () => {
  for (const f of await fs.readdir(tmp)) await fs.rm(path.join(tmp, f), { force: true });
});

function req(body: unknown): Parameters<typeof examAnswer>[0] {
  return new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof examAnswer>[0];
}

describe("graded answers keep their origin", () => {
  it("exam/answer files a typed answer as typed", async () => {
    const res = await examAnswer(
      req({ questionId: "ex_pos_2", answer: "Attention compares tokens.", origin: "typed" })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.event.origin).toBe("typed");
  });

  it("exam/answer still defaults an absent origin to voice", async () => {
    const res = await examAnswer(req({ questionId: "ex_pos_2", answer: "Attention compares tokens." }));
    expect(res.status).toBe(200);
    expect((await res.json()).event.origin).toBe("voice");
  });

  it("teachback/answer files a typed teach-back as typed", async () => {
    const res = await teachAnswer(
      req({ conceptId: "c_position", transcript: "Position tells order.", origin: "typed" })
    );
    expect(res.status).toBe(200);
    expect((await res.json()).event.origin).toBe("typed");
  });

  it("teachback/answer still defaults an absent origin to voice", async () => {
    const res = await teachAnswer(req({ conceptId: "c_position", transcript: "Position tells order." }));
    expect(res.status).toBe(200);
    expect((await res.json()).event.origin).toBe("voice");
  });
});
