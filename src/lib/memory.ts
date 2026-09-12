/**
 * Compound memory: statements built ONLY from what actually happened.
 * Max 3 statements. Returns [] when history is thin (the opening event only).
 *
 * Concept names come from the caller (the subject the learner is in), so this
 * file knows nothing about any particular subject and the same three rules
 * work on notes about the Krebs cycle as on the starters.
 */

const SUCCESS_INTENTS = new Set(["remember", "claim", "teachback", "quiz_request", "exam_marker"]);
const STRUGGLE_INTENTS = new Set(["confusion", "question", "explain"]);

export type MemoryEvent = {
  intent: string;
  primaryConceptId: string | null;
  cleanedTranscript: string;
};

export function compoundMemory(events: MemoryEvent[], conceptNames: Record<string, string> = {}): string[] {
  if (events.length <= 1) return [];
  const out: string[] = [];
  const name = (id: string) => conceptNames[id] ?? id;

  // Order of first mention, so the same history always reads the same way.
  const order: string[] = [];
  for (const e of events) {
    if (e.primaryConceptId && !order.includes(e.primaryConceptId)) order.push(e.primaryConceptId);
  }

  // (a) Repeated confusions on the same concept.
  const confusions = new Map<string, number>();
  for (const e of events) {
    if (e.intent === "confusion" && e.primaryConceptId) {
      confusions.set(e.primaryConceptId, (confusions.get(e.primaryConceptId) ?? 0) + 1);
    }
  }
  for (const id of order) {
    if (out.length >= 3) break;
    const n = confusions.get(id) ?? 0;
    if (n >= 2) out.push(`You've flagged ${name(id)} as confusing ${n} times.`);
  }

  // (b) Failed recall (confusion) then later success on the same concept.
  for (const id of order) {
    if (out.length >= 3) break;
    let firstConfusion = -1;
    let laterSuccess = false;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.primaryConceptId !== id) continue;
      if (firstConfusion === -1 && e.intent === "confusion") firstConfusion = i;
      else if (firstConfusion !== -1 && SUCCESS_INTENTS.has(e.intent)) {
        laterSuccess = true;
        break;
      }
    }
    if (firstConfusion !== -1 && laterSuccess) {
      out.push(`${name(id)} improved after a wrong attempt — it held.`);
    }
  }

  // (c) Weakest concept by struggle signal (confusion/question/explain volume).
  if (out.length < 3) {
    const struggle = new Map<string, number>();
    for (const e of events) {
      if (e.primaryConceptId && STRUGGLE_INTENTS.has(e.intent)) {
        struggle.set(e.primaryConceptId, (struggle.get(e.primaryConceptId) ?? 0) + 1);
      }
    }
    let weakest: string | null = null;
    let best = 0;
    for (const id of order) {
      const n = struggle.get(id) ?? 0;
      if (n > best) {
        best = n;
        weakest = id;
      }
    }
    if (weakest) out.push(`Your least-settled concept right now is ${name(weakest)}.`);
  }

  return out.slice(0, 3);
}
