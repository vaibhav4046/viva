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
          // Tighter threshold = more eager to treat a pause as end-of-turn.
          // A student thinking mid-sentence gets cut off at 0.5 often enough
          // to be maddening, so 0.6, and a long window before it counts.
          turn_detection: {
            vad_threshold: 0.6,
            // Let a real pause happen. These are the names the API uses; if a
            // field is rejected the server answers `invalid_config` and the
            // client falls back to defaults rather than retrying blindly.
            silence_duration_ms: 1200,
            interrupt_during_agent_speech: true,
            interrupt_threshold: 0.8,
            interrupt_duration_ms: 320,
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
