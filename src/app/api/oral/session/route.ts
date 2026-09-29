import { resolveIdentity } from "@/lib/auth/identity";
import { withIdentityCookie } from "@/lib/http";
import { getStore, storeDurability } from "@/lib/store";
import { resolveSubject, subjectMissing, keytermsFrom } from "@/lib/courses/subject";
import { toolDefsForWire } from "@/lib/oral/tools";
import { buildOralSystemPrompt, ORAL_PROMPT_VERSION } from "@/lib/oral/prompt";
import { buildLearnerBrief } from "@/lib/oral/learner-brief";
import { err } from "@/lib/types";

/**
 * GET /api/oral/session, the session config the client sends as its
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

    // The stored map for this learner and this subject: the examiner opens on the
    // weakest concept and is told, in words, when there is no history or the
    // store is the temporary one. A failed read is an empty brief, never a guess.
    const [mastery, durability] = await Promise.all([
      store.getMastery(identity.userId).catch(() => ({})),
      storeDurability().catch(() => ({ durable: false })),
    ]);
    const brief = buildLearnerBrief({
      concepts: subject.concepts.map((c) => ({ id: c.id, name: c.name })),
      mastery,
      durable: durability.durable,
    });

    const system_prompt = buildOralSystemPrompt({
      subjectTitle: subject.title,
      concepts,
      languages: subject.languageCodes ?? ["en"],
      sourceTitles: subject.sources?.map((s) => s.title) ?? [],
      brief,
    });

    return withIdentityCookie(
      Response.json(
        {
          subjectId: subject.id,
          system_prompt,
          promptVersion: ORAL_PROMPT_VERSION,
          memory: { status: brief.status, durable: brief.durable, note: brief.note, opening: brief.opening?.name ?? null },
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
