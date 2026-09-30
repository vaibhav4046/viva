import { z } from "zod";
import { handle, persist, reviewFields } from "@/lib/redteam/http";
import { createSession } from "@/lib/redteam/session";
import { buildVoiceConfig } from "@/lib/redteam/prompt";
import { SAMPLE_TEXT, SAMPLE_TITLE } from "@/lib/redteam/sample";
import { MAX_DOC_CHARS, ReviewModeSchema } from "@/lib/redteam/types";

/**
 * POST /api/redteam/session — start a review.
 *
 * Either the labelled sample document, or the user's own pasted text. Returns
 * the session (document, ledger, timeline), a sealed copy of it the browser can
 * hand back if a server instance forgets the review, and the Voice Agent
 * configuration the browser sends as `session.update`. The configuration
 * carries no key.
 */
const Body = z
  .object({
    mode: ReviewModeSchema.default("SKEPTIC"),
    sample: z.boolean().optional(),
    title: z.string().max(200).optional(),
    text: z.string().max(MAX_DOC_CHARS + 1000).optional(),
  })
  .strict();

export async function POST(req: Request): Promise<Response> {
  return handle(req, { limit: "upload", schema: Body }, async ({ userId, body }) => {
    const useSample = body.sample === true || !body.text;
    const s = createSession({
      userId,
      mode: body.mode,
      title: useSample ? SAMPLE_TITLE : body.title || "Untitled document",
      text: useSample ? SAMPLE_TEXT : body.text,
      sample: useSample,
    });
    await persist(s);
    return Response.json({ ...reviewFields(s), voice: buildVoiceConfig(s) }, { status: 201 });
  });
}
