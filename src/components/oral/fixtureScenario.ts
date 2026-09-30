import { ORAL_FAILURES } from "@/lib/oral/failures";
import { ORAL_STATES, type OralState } from "@/lib/oral/machine";

/** The scenarios /dev/oral-states can draw. Kept out of the client component so the server page can parse them. */
export type Scenario = { kind: "state"; state: OralState } | { kind: "failure"; id: string } | { kind: "typed" } | { kind: "diag" };

export function parseScenario(raw: string | undefined): Scenario | null {
  if (!raw) return null;
  if (raw === "typed") return { kind: "typed" };
  if (raw === "diag") return { kind: "diag" };
  const state = ORAL_STATES.find((s) => s.toLowerCase() === raw.toLowerCase());
  if (state) return { kind: "state", state };
  if (raw.startsWith("failure-")) {
    const id = raw.slice("failure-".length);
    if (ORAL_FAILURES.some((f) => f.id === id)) return { kind: "failure", id };
  }
  return null;
}
