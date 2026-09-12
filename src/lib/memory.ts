/**
 * Compound memory: deterministic statements built ONLY from actual history.
 * Max 3 statements. Returns [] when history is thin (seed event only).
 */

export const MEMORY_CONCEPT_NAMES: Record<string, string> = {
  c_position: "positional information",
  c_self_attention: "self-attention",
  c_qkv: "queries, keys and values",
  c_multihead: "multi-head attention",
  c_backprop: "backpropagation vs gradient descent",
  c_policy_value: "policy vs value iteration",
};

const CONCEPT_ORDER = [
  "c_position",
  "c_self_attention",
  "c_qkv",
  "c_multihead",
  "c_backprop",
  "c_policy_value",
];

const SUCCESS_INTENTS = new Set(["remember", "claim", "teachback", "quiz_request", "exam_marker"]);
const STRUGGLE_INTENTS = new Set(["confusion", "question", "explain"]);

export type MemoryEvent = {
  intent: string;
  primaryConceptId: string | null;
  cleanedTranscript: string;
};

export function compoundMemory(events: MemoryEvent[]): string[] {
  if (events.length <= 1) return [];
  const out: string[] = [];
  const name = (id: string) => MEMORY_CONCEPT_NAMES[id] ?? id;

  // (a) Repeated confusions on the same concept.
  const confusions = new Map<string, number>();
  for (const e of events) {
    if (e.intent === "confusion" && e.primaryConceptId) {
      confusions.set(e.primaryConceptId, (confusions.get(e.primaryConceptId) ?? 0) + 1);
    }
  }
  for (const id of CONCEPT_ORDER) {
    if (out.length >= 3) break;
    const n = confusions.get(id) ?? 0;
    if (n >= 2) out.push(`You've flagged ${name(id)} as confusing ${n} times.`);
  }

  // (b) Failed recall (confusion) then later success on the same concept.
  for (const id of CONCEPT_ORDER) {
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
    for (const id of CONCEPT_ORDER) {
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
