import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blankMastery } from "@/lib/mastery";

/**
 * The map has to show the work the store lost, not only what the store returned.
 *
 * /study and /today both hand the browser's copy of the record back on load
 * (`syncRecord`) and union whatever comes back with what the browser holds
 * (`mergeLearner`), because every write lands in one instance's own /tmp and
 * the next read can answer from an instance that never saw the turn. /map
 * fetched GET /api/learner and rendered the answer as-is, so a student who
 * answered while the store was degraded opened their map and their own words
 * were not on it.
 *
 * There is no DOM in this suite, so the page is driven through a hook runtime
 * small enough to fit here: render the component function, run its effects,
 * repeat until the state settles. What is asserted is what the page would put
 * on screen — the element tree it returns.
 */

/* ------------------------------ hook runtime ----------------------------- */

const rt = vi.hoisted(() => {
  type Slot = { deps?: unknown[]; value?: unknown };
  const s = { slots: [] as Slot[], i: 0, dirty: false, effects: [] as (() => void)[] };
  const same = (a?: unknown[], b?: unknown[]) =>
    Boolean(a) && Boolean(b) && a!.length === b!.length && a!.every((v, i) => Object.is(v, b![i]));
  const slot = (init: () => unknown): Slot => {
    const i = s.i++;
    if (!s.slots[i]) s.slots[i] = { value: init() };
    return s.slots[i];
  };
  return {
    s,
    reset() {
      s.slots = [];
      s.i = 0;
      s.dirty = false;
      s.effects = [];
    },
    beginRender() {
      s.i = 0;
      s.effects = [];
    },
    useState(init: unknown) {
      const cell = slot(() => (typeof init === "function" ? (init as () => unknown)() : init));
      const set = (next: unknown) => {
        const value = typeof next === "function" ? (next as (p: unknown) => unknown)(cell.value) : next;
        if (Object.is(value, cell.value)) return;
        cell.value = value;
        s.dirty = true;
      };
      return [cell.value, set];
    },
    useRef(init: unknown) {
      return slot(() => ({ current: init })).value;
    },
    useCallback(fn: unknown, deps: unknown[]) {
      const cell = slot(() => fn);
      if (!same(cell.deps, deps)) {
        cell.deps = deps;
        cell.value = fn;
      }
      return cell.value;
    },
    useMemo(fn: () => unknown, deps: unknown[]) {
      const cell = slot(fn);
      if (!same(cell.deps, deps)) {
        cell.deps = deps;
        cell.value = fn();
      }
      return cell.value;
    },
    useEffect(fn: () => void, deps?: unknown[]) {
      const cell = slot(() => undefined);
      const first = cell.deps === undefined && cell.value === undefined;
      if (first || !same(cell.deps, deps)) {
        cell.deps = deps;
        cell.value = true;
        s.effects.push(fn);
      }
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: rt.useState,
    useRef: rt.useRef,
    useCallback: rt.useCallback,
    useMemo: rt.useMemo,
    useEffect: rt.useEffect,
  };
});

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

type Node = { type?: unknown; props?: { children?: unknown; [k: string]: unknown } } | string | number | null;

/** Render, run effects, settle. Returns the last element tree the page produced. */
async function drive(Page: () => unknown): Promise<unknown> {
  let tree: unknown = null;
  for (let pass = 0; pass < 12; pass++) {
    rt.s.dirty = false;
    rt.beginRender();
    tree = Page();
    for (const effect of rt.s.effects) effect();
    await flush();
    if (!rt.s.dirty) break;
  }
  return tree;
}

/** Every string the tree would paint, so an assertion can read the screen. */
function text(node: unknown, out: string[] = []): string[] {
  if (node == null || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) text(child, out);
    return out;
  }
  const props = (node as Exclude<Node, string | number | null>)?.props;
  if (!props) return out;
  // A banner carries its words as a prop, not as children.
  if (typeof props.message === "string") out.push(props.message);
  text(props.children, out);
  return out;
}

/** Find the first element whose props satisfy `pick` — the map, in practice. */
function findProps(node: unknown, pick: (p: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  if (node == null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findProps(child, pick);
      if (hit) return hit;
    }
    return null;
  }
  const props = (node as { props?: Record<string, unknown> }).props;
  if (props && pick(props)) return props;
  return props ? findProps(props.children, pick) : null;
}

/* -------------------------------- fixtures ------------------------------- */

const COURSE = "course_transformers_w4";
const CONCEPT = "c_self_attention";
const SPOKEN = "Attention compares every token with every other token in the sequence.";

const SERVER_CONCEPT = { id: CONCEPT, name: "Self-attention", description: "How tokens attend." };

/** One turn the browser minted while the store was degraded. */
const MIRRORED_EVENT = {
  id: "e_local_1",
  clientEventId: "c_local_1",
  userId: "u_map",
  sessionId: "s_map",
  courseId: COURSE,
  sourceId: null,
  createdAt: "2026-09-13T10:00:00.000Z",
  transcript: SPOKEN,
  cleanedTranscript: SPOKEN,
  origin: "voice",
  transcriptionConfidence: null,
  transcriptionLatencyMs: null,
  intent: "answer",
  conceptIds: [CONCEPT],
  primaryConceptId: CONCEPT,
  importance: 0.5,
  confusion: 0,
  confidenceSelfReport: null,
  sourceLocator: null,
  interpretationConfidence: 0.9,
  evidenceIds: [],
  requestedAction: "none",
  status: "responded",
};

/** What a cold instance answers: the concept and a map row, but not the turn. */
const THIN_SERVER_PAYLOAD = {
  mastery: { [CONCEPT]: blankMastery(CONCEPT, "2026-09-13T09:00:00.000Z") },
  events: [],
  concepts: [SERVER_CONCEPT],
};

let store: Record<string, string>;

function stubBrowser(record: unknown): void {
  store = record ? { "viva.record.v1": JSON.stringify(record) } : {};
  const localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
  };
  (globalThis as { window?: unknown }).window = {
    localStorage,
    location: { search: "" },
    matchMedia: () => ({ matches: false }),
  };
}

/** `learner` decides what GET /api/learner answers; null means it fails. */
function stubFetch(opts: { sync: unknown | null; learner: unknown | null }) {
  const calls: string[] = [];
  const reply = (body: unknown) =>
    body === null
      ? Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as Response)
      : Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
  vi.stubGlobal("fetch", (url: string) => {
    calls.push(String(url));
    if (String(url).startsWith("/api/courses")) return reply({ courses: [] });
    if (String(url).startsWith("/api/learner/sync")) return reply(opts.sync);
    if (String(url).startsWith("/api/learner")) return reply(opts.learner);
    return reply(null);
  });
  return calls;
}

async function loadPage(): Promise<() => unknown> {
  const mod = await import("@/app/(app)/map/page");
  return mod.default as unknown as () => unknown;
}

beforeEach(() => {
  rt.reset();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { window?: unknown }).window;
});

/* --------------------------------- tests --------------------------------- */

describe("/map reconciles the server's answer with the browser's copy", () => {
  it("shows a turn the browser holds and the server response leaves out", async () => {
    stubBrowser({ v: 1, mastery: {}, events: [MIRRORED_EVENT], subjects: {} });
    const calls = stubFetch({ sync: THIN_SERVER_PAYLOAD, learner: THIN_SERVER_PAYLOAD });

    const Page = await loadPage();
    await drive(Page);

    // The map is drawn, so a concept can be picked.
    const graph = findProps(await drive(Page), (p) => typeof p.onSelect === "function" && "mastery" in p);
    expect(graph, "the map never rendered").not.toBeNull();
    (graph!.onSelect as (id: string) => void)(CONCEPT);

    const painted = text(await drive(Page)).join(" ");
    expect(painted).toContain(SPOKEN);
    expect(calls.some((u) => u.startsWith("/api/learner/sync"))).toBe(true);
  });

  it("renders the server's answer untouched when the browser holds nothing", async () => {
    stubBrowser(null);
    stubFetch({ sync: THIN_SERVER_PAYLOAD, learner: THIN_SERVER_PAYLOAD });

    const Page = await loadPage();
    const graph = findProps(await drive(Page), (p) => typeof p.onSelect === "function" && "mastery" in p);
    expect(graph, "the map never rendered").not.toBeNull();
    expect(Object.keys(graph!.mastery as Record<string, unknown>)).toEqual([CONCEPT]);
    expect(text(await drive(Page)).join(" ")).not.toContain("Couldn't open your map");
  });

  it("keeps the map and stays quiet when the hand-back fails", async () => {
    stubBrowser({ v: 1, mastery: {}, events: [MIRRORED_EVENT], subjects: {} });
    stubFetch({ sync: null, learner: THIN_SERVER_PAYLOAD });

    const Page = await loadPage();
    const tree = await drive(Page);
    const graph = findProps(tree, (p) => typeof p.onSelect === "function" && "mastery" in p);
    expect(graph, "a failed hand-back blanked the map").not.toBeNull();
    expect(text(tree).join(" ")).not.toContain("Couldn't open your map");
  });

  it("still says so when nothing answers and there is nothing held", async () => {
    stubBrowser(null);
    stubFetch({ sync: null, learner: null });

    const Page = await loadPage();
    expect(text(await drive(Page)).join(" ")).toContain("Couldn't open your map");
  });
});
