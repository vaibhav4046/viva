import { resolveIdentity } from "@/lib/auth/identity";
import { withIdentityCookie } from "@/lib/http";
import { getStore } from "@/lib/store";
import { resolveSubject, subjectMissing, keytermsFrom } from "@/lib/courses/subject";
import { toolDefsForWire } from "@/lib/oral/tools";
import { ORAL_EXAMINER_RULES } from "@/lib/oral/prompt";
import { err } from "@/lib/types";

/**
 * GET /api/oral/session — the session config the client sends as its
 * `session.update`.
 *
 * The system prompt is built here rather than in the browser for one reason: it
 * is assembled from the caller's own material, so it can name their subject
 * and their concepts, and because it must carry the grounding rules. A prompt
 * string living in client code is a prompt string that ships to production and
 * is edited by whatever is convenient, so the rules about treating material as
 * data and about what `consistent` means would eventually get lost.
 *
 * The material itself is NOT in this response. The agent gets it through
 * tools, which is what makes the citations real: the passages it quotes are
 * the ones a tool returned for this caller's store, not text pasted into a
 * prompt at build time.
 */

/** Documented range 0 to 1000 ms. Measured effect on stop latency: docs/evidence/probes/oral-live-bargein.*.json. */
const INTERRUPTION_DELAY_MS = 0;

/** The rules that make the exam an exam. */

export async function GET(req: Request): Promise<Response> {
  const { identity, setCookie } = await resolveIdentity(req);
  const subjectId = new URL(req.url).searchParams.get("subjectId");

  try {
    const store = getStore();
    const subject = await resolveSubject(store, identity.userId, subjectId ?? null);
    const concepts = subject.concepts.slice(0, 40).map((c) => c.name);
    const keyterms = keytermsFrom(subject.concepts);

    const system_prompt = [
      ORAL_EXAMINER_RULES,
      "",
      `THE STUDENT'S SUBJECT: ${subject.title}`,
      concepts.length ? `CONCEPTS IN PLAY: ${concepts.join(", ")}` : "",
      `SOURCE LANGUAGES: ${(subject.languageCodes ?? ["en"]).join(", ")}`,
      subject.sources?.length
        ? `THEIR SOURCES: ${subject.sources.map((s) => s.title).join("; ")}`
        : "",
      "",
      "Open the exam by asking for the first thing they want to be examined on.",
    ]
      .filter(Boolean)
      .join("\n");

    return withIdentityCookie(
      Response.json(
        {
          subjectId: subject.id,
          system_prompt,
          greeting: "You're being examined. Tell me what you want to be asked on, and I'll start there.",
          // Only the fields the turn-detection reference documents. An earlier
          // version sent undocumented names (silence_duration_ms, interrupt_*),
          // which the service accepted and ignored, so the settings looked
          // applied and were not. interruption_delay is how long the student
          // must keep talking before the agent is cut off.
          turn_detection: {
            vad_threshold: 0.6,
            interrupt_response: true,
            interruption_delay: INTERRUPTION_DELAY_MS,
          },
          transcription_mode: "balanced",
          language_codes: subject.languageCodes?.length ? subject.languageCodes : ["en"],
          keyterms,
          tools: toolDefsForWire(),
        },
        { headers: { "Cache-Control": "no-store" } }
      ),
      setCookie
    );
  } catch (e) {
    if (e instanceof Error && e.name === "SubjectNotFoundError") return withIdentityCookie(subjectMissing(e), setCookie);
    serverLogFailure(e);
    return withIdentityCookie(err("ORAL_UNAVAILABLE", "The oral exam is not available right now.", true, 503), setCookie);
  }
}

function serverLogFailure(e: unknown): void {
  // Kept local so this GET has no logging dependency to get wrong.
  console.error("oral_session.failed", (e as Error)?.message?.slice(0, 200) ?? "unknown");
}
