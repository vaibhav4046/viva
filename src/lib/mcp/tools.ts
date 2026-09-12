import { z } from "zod";
import { bandLabelFor } from "@/lib/mastery";
import { ACCESS_TTL_SECONDS, cookieFor, identityForCall, mintToken, readToken } from "./auth";
import { ToolFailure, callViva, callVivaStream, type ApiContext, type Fetcher } from "./api";

/**
 * The tools a student's assistant can call, named for the student.
 *
 * Every one of them is a thin client over a route that already exists, so the
 * quiz an assistant asks is the quiz the app asks, marked by the same code,
 * against the same passages, and every mastery number is still written in one
 * place. What the tool layer owns is the wording that comes back and the rule
 * that decides whose rows were read.
 */

type SchemaProp = { type: "string" | "number" | "boolean"; description: string; maxLength?: number };
type ToolSchema = {
  type: "object";
  properties: Record<string, SchemaProp>;
  required?: string[];
  additionalProperties: false;
};

export type ToolArgs = Record<string, string | number | boolean>;

type Tool = {
  name: string;
  title: string;
  description: string;
  schema: ToolSchema;
  /** `pairing` tools take a pairing code; `account` tools take a paired key. */
  auth: "pairing" | "account";
  run: (args: ToolArgs, ctx: ApiContext) => Promise<string>;
};

/* ----------------------------- shared bits ----------------------------- */

const CONNECT_FIRST =
  "This assistant is not connected to a VIVA account yet. Open VIVA in the browser you study in, go to the Connect page, copy the code it shows, and call connect_my_viva_account with it.";

/** Every account tool takes the same optional key, so define it once. */
const ACCOUNT_TOKEN: SchemaProp = {
  type: "string",
  description:
    "Your VIVA key, if this connection does not already send it as an Authorization header. connect_my_viva_account hands you one.",
  maxLength: 200,
};

const SUBJECT_ID: SchemaProp = {
  type: "string",
  description:
    "Which subject, by the id list_my_subjects gives. Leave it out to use the one they were last studying.",
  maxLength: 80,
};

function text(args: ToolArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function subjectQuery(args: ToolArgs): string {
  const id = text(args, "subject_id");
  return id ? `?subject=${encodeURIComponent(id)}` : "";
}

/** Cut a quote down to something an assistant can repeat without a wall of text. */
function shorten(value: string, max = 220): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function where(locator: { section?: string | null; page?: number | null } | null | undefined): string | null {
  if (!locator) return null;
  if (typeof locator.page === "number") return `p.${locator.page}`;
  return locator.section ? locator.section : null;
}

/* ------------------------------ responses ------------------------------ */

const SubjectList = z.object({
  subjects: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        demo: z.boolean().optional(),
        builtBy: z.string().nullable().optional(),
        conceptCount: z.number().optional(),
        examCount: z.number().optional(),
      })
    )
    .default([]),
});

const BuiltSubject = z.object({
  subject: z.object({
    id: z.string(),
    title: z.string(),
    builtBy: z.string().nullable(),
    concepts: z.number(),
    questions: z.number(),
    passages: z.number(),
    storageNote: z.string().nullable().optional(),
  }),
});

const Turn = z.object({
  tutor: z.object({
    text: z.string(),
    question: z.string().nullable().optional(),
    citations: z.array(z.object({ quote: z.string() })).default([]),
  }),
  event: z
    .object({
      sourceLocator: z.object({ section: z.string().nullish(), page: z.number().nullish() }).nullish(),
    })
    .nullish(),
  band: z.object({ conceptId: z.string(), label: z.string() }).nullable().optional(),
  quiz: z
    .object({
      open: z.boolean(),
      questionId: z.string().nullable(),
      question: z.string().nullable(),
      attemptsLeft: z.number(),
    })
    .optional(),
});

const AskedQuestion = z.object({
  id: z.string(),
  question: z.string(),
  hint: z.string().optional(),
  conceptId: z.string().optional(),
  courseId: z.string().optional(),
});

const Marked = z.object({
  verdict: z.enum(["correct", "partial", "incorrect"]),
  feedback: z.string(),
  missingPoints: z.array(z.string()).default([]),
  fullAnswerCovers: z.array(z.string()).default([]),
  band: z.object({ label: z.string() }).nullable().optional(),
  closed: z.boolean(),
  attemptsLeft: z.number(),
  canRetry: z.boolean(),
});

const DailyPath = z.object({
  path: z
    .array(
      z.object({
        kind: z.string(),
        conceptName: z.string().optional(),
        minutes: z.number(),
        why: z.string(),
      })
    )
    .default([]),
});

const LearnerState = z.object({
  mastery: z
    .record(z.object({ mastery: z.number(), exposureCount: z.number().optional() }).passthrough())
    .default({}),
  concepts: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()).default([]),
});

/** A route answered, but not in the shape this reader expects. Say so plainly. */
const ODD_SHAPE = "VIVA answered in a shape this connection did not understand. Try again in the app.";

function parsed<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> | null {
  const result = schema.safeParse(data);
  return result.success ? result.data : null;
}

/* -------------------------------- tools -------------------------------- */

const TOOLS: Tool[] = [
  {
    name: "connect_my_viva_account",
    title: "Connect a VIVA account",
    description:
      "Connect this assistant to a VIVA study account. Open VIVA in the browser you study in, go to the Connect page, and paste the code it shows here. You get a key back that every other VIVA tool needs.",
    auth: "pairing",
    schema: {
      type: "object",
      properties: {
        pairing_code: {
          type: "string",
          description: "The code the Connect page in VIVA showed you.",
          maxLength: 200,
        },
      },
      required: ["pairing_code"],
      additionalProperties: false,
    },
    run: async (args) => {
      const check = readToken(text(args, "pairing_code"), "pair");
      if (!check.ok) {
        const why: Record<string, string> = {
          missing: "No code came through. Open the Connect page in VIVA and copy the one it shows.",
          malformed: "That does not look like a VIVA connection code. Copy the whole thing from the Connect page.",
          forged: "That code did not check out. Generate a fresh one on the Connect page in VIVA.",
          expired: "That code has run out. Generate a fresh one on the Connect page in VIVA.",
          wrong_purpose: "That is a VIVA key, not a connection code. You are already connected — use the key.",
        };
        throw new ToolFailure(why[check.reason], check.reason);
      }
      const key = mintToken(check.did, "access");
      const days = Math.round(ACCESS_TTL_SECONDS / 86400);
      return [
        `Connected. This key is the student's VIVA account for the next ${days} days:`,
        key,
        "Pass it as account_token on the other VIVA tools, or set it as this connection's Authorization bearer header and never pass it again. Anyone holding it can read and add to this study account, so keep it where you keep your other keys.",
      ].join("\n\n");
    },
  },

  {
    name: "list_my_subjects",
    title: "List my subjects",
    description:
      "List what is in this VIVA account: the subjects the student built from their own notes, plus the ones VIVA ships with. Call it first when you need a subject id for another VIVA tool.",
    auth: "account",
    schema: { type: "object", properties: { account_token: ACCOUNT_TOKEN }, additionalProperties: false },
    run: async (_args, ctx) => {
      const res = await callViva<unknown>(ctx, "/api/subjects");
      if (!res.ok) throw new ToolFailure(res.message, res.code);
      const list = parsed(SubjectList, res.data);
      if (!list) throw new ToolFailure(ODD_SHAPE, "ODD_SHAPE");
      if (list.subjects.length === 0) {
        return "There is nothing in this account yet. Add one with add_subject_from_notes.";
      }
      const lines = list.subjects.map((s) => {
        const built = s.demo
          ? "comes with VIVA"
          : s.builtBy
            ? `built from their own notes, read by ${s.builtBy}`
            : "built from their own notes";
        const counts = [
          typeof s.conceptCount === "number" ? `${s.conceptCount} concepts` : null,
          typeof s.examCount === "number" ? `${s.examCount} questions` : null,
        ]
          .filter(Boolean)
          .join(", ");
        return `- ${s.title} — id ${s.id} — ${built}${counts ? ` — ${counts}` : ""}`;
      });
      return [`${list.subjects.length} subjects in this account:`, ...lines].join("\n");
    },
  },

  {
    name: "add_subject_from_notes",
    title: "Add a subject from notes",
    description:
      "Turn pasted notes into a VIVA subject: VIVA splits them into passages, pulls out the concepts and writes practice questions from the student's own words. It needs a few paragraphs to work with, and will refuse a bare topic name rather than invent material.",
    auth: "account",
    schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "What to call the subject, for example Histology methods.",
          maxLength: 120,
        },
        notes: { type: "string", description: "The notes themselves. A few paragraphs is enough.", maxLength: 200000 },
        account_token: ACCOUNT_TOKEN,
      },
      required: ["title", "notes"],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const res = await callVivaStream<unknown>(ctx, "/api/subjects/create", {
        kind: "paste",
        title: text(args, "title"),
        text: text(args, "notes"),
      });
      if (!res.ok) throw new ToolFailure(res.message, res.code);
      const built = parsed(BuiltSubject, res.data);
      if (!built) throw new ToolFailure(ODD_SHAPE, "ODD_SHAPE");
      const s = built.subject;
      const who = s.builtBy ? ` Read by ${s.builtBy}.` : "";
      return [
        `${s.title} is ready — id ${s.id}.`,
        `${s.concepts} concepts, ${s.questions} practice questions, ${s.passages} passages from the notes.${who}`,
        s.storageNote ?? "",
      ]
        .filter(Boolean)
        .join("\n");
    },
  },

  {
    name: "tell_viva",
    title: "Say something to VIVA",
    description:
      "Say something to VIVA in the student's own words: a note, a question, or a belief they want checked. VIVA files it against the right concept in their subject and answers Socratically, quoting the line in their own material it is going from. Use it both to save a note and to get a reply that stays inside their source.",
    auth: "account",
    schema: {
      type: "object",
      properties: {
        said: { type: "string", description: "What the student said, or wants kept.", maxLength: 6000 },
        subject_id: SUBJECT_ID,
        account_token: ACCOUNT_TOKEN,
      },
      required: ["said"],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const res = await callViva<unknown>(ctx, "/api/study/turn", {
        method: "POST",
        body: { text: text(args, "said"), subjectId: text(args, "subject_id"), origin: "typed" },
      });
      if (!res.ok) throw new ToolFailure(res.message, res.code);
      const turn = parsed(Turn, res.data);
      if (!turn) throw new ToolFailure(ODD_SHAPE, "ODD_SHAPE");
      const quote = turn.tutor.citations[0]?.quote;
      const at = where(turn.event?.sourceLocator);
      const lines = [`Kept it. VIVA says: ${turn.tutor.text}`];
      if (quote) lines.push(`From their own source${at ? ` (${at})` : ""}: “${shorten(quote)}”`);
      if (turn.band) lines.push(`That moved their map: the concept it touched now reads ${turn.band.label}.`);
      if (turn.quiz?.open && turn.quiz.question) {
        lines.push(
          `A question is open: ${turn.quiz.question} — answer it with answer_quiz_question, question_id ${turn.quiz.questionId}.`
        );
      }
      return lines.join("\n");
    },
  },

  {
    name: "quiz_me",
    title: "Quiz me",
    description:
      "Ask the student one question from their own material. Name a concept to drill it, or leave it out and VIVA picks whatever they are weakest on. The marking key never leaves VIVA — send their answer to answer_quiz_question and VIVA marks it.",
    auth: "account",
    schema: {
      type: "object",
      properties: {
        subject_id: SUBJECT_ID,
        concept_id: {
          type: "string",
          description: "Drill one concept, by the id what_am_i_mixed_up_about gives. Leave it out for the weakest one.",
          maxLength: 80,
        },
        account_token: ACCOUNT_TOKEN,
      },
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const res = await callViva<unknown>(ctx, "/api/exam/start", {
        method: "POST",
        body: { conceptId: text(args, "concept_id"), courseId: text(args, "subject_id") },
      });
      if (!res.ok) throw new ToolFailure(res.message, res.code);
      const q = parsed(AskedQuestion, res.data);
      if (!q) throw new ToolFailure(ODD_SHAPE, "ODD_SHAPE");
      return [
        q.question,
        `Answer it with answer_quiz_question: question_id ${q.id}${q.courseId ? `, subject_id ${q.courseId}` : ""}.`,
        q.hint ? `A nudge, if they are stuck: ${q.hint}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    },
  },

  {
    name: "answer_quiz_question",
    title: "Answer a quiz question",
    description:
      "Hand the student's answer to VIVA in their words. VIVA marks it against their own material and moves their map. Do not mark it yourself, and do not tidy up what they said.",
    auth: "account",
    schema: {
      type: "object",
      properties: {
        question_id: { type: "string", description: "The question_id quiz_me gave.", maxLength: 120 },
        answer: { type: "string", description: "What the student said, as they said it.", maxLength: 2000 },
        subject_id: SUBJECT_ID,
        account_token: ACCOUNT_TOKEN,
      },
      required: ["question_id", "answer"],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const res = await callViva<unknown>(ctx, "/api/exam/answer", {
        method: "POST",
        body: {
          questionId: text(args, "question_id"),
          answer: text(args, "answer"),
          subjectId: text(args, "subject_id"),
        },
      });
      if (!res.ok) throw new ToolFailure(res.message, res.code);
      const marked = parsed(Marked, res.data);
      if (!marked) throw new ToolFailure(ODD_SHAPE, "ODD_SHAPE");
      const lines = [marked.feedback];
      if (marked.band) lines.push(`Their map now reads ${marked.band.label} on that concept.`);
      if (marked.canRetry) lines.push(`They can go again — ${marked.attemptsLeft} tries left on this one.`);
      if (marked.closed && marked.fullAnswerCovers.length > 0) {
        lines.push(`A full answer covers: ${marked.fullAnswerCovers.join(", ")}.`);
      }
      return lines.join("\n");
    },
  },

  {
    name: "what_should_i_study_today",
    title: "What should I study today",
    description:
      "Today's ten minutes: what VIVA would put in front of the student next, in order, with the minutes each part takes and why it is there. Built from what they have actually said and answered.",
    auth: "account",
    schema: {
      type: "object",
      properties: { subject_id: SUBJECT_ID, account_token: ACCOUNT_TOKEN },
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const res = await callViva<unknown>(ctx, `/api/learner/path${subjectQuery(args)}`);
      if (!res.ok) throw new ToolFailure(res.message, res.code);
      const plan = parsed(DailyPath, res.data);
      if (!plan) throw new ToolFailure(ODD_SHAPE, "ODD_SHAPE");
      if (plan.path.length === 0) {
        return "Nothing is queued yet — there is no history to plan from. Say something with tell_viva, or take a question with quiz_me, and today's ten minutes will have something in it.";
      }
      const total = plan.path.reduce((n, step) => n + step.minutes, 0);
      const lines = plan.path.map(
        (step, i) => `${i + 1}. ${step.conceptName ?? "Write it down"} — ${step.minutes} min — ${step.why}`
      );
      return [`Today, ${total} minutes:`, ...lines].join("\n");
    },
  },

  {
    name: "what_am_i_mixed_up_about",
    title: "What am I mixed up about",
    description:
      "Where the student stands, concept by concept, in the words on their VIVA map: Solid, Getting there, Shaky, Mixed up, Not yet. Weakest first, so you know what to work on.",
    auth: "account",
    schema: {
      type: "object",
      properties: { subject_id: SUBJECT_ID, account_token: ACCOUNT_TOKEN },
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const res = await callViva<unknown>(ctx, `/api/learner${subjectQuery(args)}`);
      if (!res.ok) throw new ToolFailure(res.message, res.code);
      const state = parsed(LearnerState, res.data);
      if (!state) throw new ToolFailure(ODD_SHAPE, "ODD_SHAPE");
      if (state.concepts.length === 0) throw new ToolFailure("There are no concepts on this subject's map yet.", "NO_CONCEPTS");
      const ranked = state.concepts
        .map((c) => {
          const record = state.mastery[c.id];
          return { id: c.id, name: c.name, label: bandLabelFor(record), score: record?.mastery ?? 1.1 };
        })
        .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
      if (ranked.every((c) => c.label === "Not yet")) {
        return `Nothing is tracked on this map yet — all ${ranked.length} concepts read Not yet. Take a question with quiz_me and it starts filling in.`;
      }
      const worst = ranked.filter((c) => c.label === "Mixed up" || c.label === "Shaky");
      const head =
        worst.length > 0
          ? `Mixed up or shaky on ${worst.length} of ${ranked.length}: ${worst.map((c) => c.name).join(", ")}.`
          : "Nothing reads Mixed up or Shaky right now.";
      return [head, ...ranked.map((c) => `- ${c.name} — ${c.label} — id ${c.id}`)].join("\n");
    },
  },
];

/* ------------------------------ dispatch ------------------------------- */

export const TOOL_LIST = TOOLS.map((t) => ({
  name: t.name,
  title: t.title,
  description: t.description,
  inputSchema: t.schema,
}));

/** Type and length checks read straight off the schema, so there is one source. */
function validate(schema: ToolSchema, raw: unknown): { ok: true; args: ToolArgs } | { ok: false; message: string } {
  if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    return { ok: false, message: "That tool takes named arguments." };
  }
  const input = (raw ?? {}) as Record<string, unknown>;
  const args: ToolArgs = {};
  for (const [key, value] of Object.entries(input)) {
    const prop = schema.properties[key];
    if (!prop) return { ok: false, message: `${key} is not an argument this tool takes.` };
    if (value === null || value === undefined) continue;
    if (typeof value !== prop.type) return { ok: false, message: `${key} must be a ${prop.type}.` };
    if (prop.maxLength !== undefined && typeof value === "string" && value.length > prop.maxLength) {
      return { ok: false, message: `${key} is longer than VIVA takes in one go.` };
    }
    args[key] = value as string | number | boolean;
  }
  for (const key of schema.required ?? []) {
    const value = args[key];
    if (value === undefined || (typeof value === "string" && value.trim() === "")) {
      return { ok: false, message: `${key} is required.` };
    }
  }
  return { ok: true, args };
}

export type ToolEnvironment = {
  origin: string;
  authorization: string | null;
  forwardedFor: string | null;
  fetch: Fetcher;
};

export type ToolOutcome = { text: string; isError: boolean };

/**
 * Run one tool.
 *
 * The identity comes from `identityForCall` and nowhere else: not from a
 * cookie on this request, not from an argument naming a user, not from the id
 * of a subject the caller happens to know. A caller holding another student's
 * subject id gets the refusal the app already gives — the route resolves that
 * id against the key's own rows and finds nothing there.
 */
export async function callTool(name: string, rawArgs: unknown, env: ToolEnvironment): Promise<ToolOutcome> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { text: `There is no VIVA tool called ${name}.`, isError: true };

  const checked = validate(tool.schema, rawArgs);
  if (!checked.ok) return { text: checked.message, isError: true };

  if (tool.auth === "pairing") return run(tool, checked.args, noCalls(env));

  const identity = identityForCall(env.authorization, checked.args.account_token);
  if (!identity.ok) {
    const why: Record<string, string> = {
      missing: CONNECT_FIRST,
      malformed: "That VIVA key is not readable. Connect again from the Connect page in VIVA.",
      forged: "That VIVA key did not check out. Connect again from the Connect page in VIVA.",
      expired: "That VIVA key has run out. Connect again from the Connect page in VIVA.",
      wrong_purpose: "That is a connection code, not a key. Exchange it with connect_my_viva_account first.",
    };
    return { text: why[identity.reason], isError: true };
  }

  const ctx: ApiContext = {
    origin: env.origin,
    cookie: cookieFor(identity.did),
    forwardedFor: env.forwardedFor,
    fetch: env.fetch,
  };
  return run(tool, checked.args, ctx);
}

/** A refusal comes back as a readable result the model can act on, never a crash. */
async function run(tool: Tool, args: ToolArgs, ctx: ApiContext): Promise<ToolOutcome> {
  try {
    return { text: await tool.run(args, ctx), isError: false };
  } catch (error) {
    if (error instanceof ToolFailure) return { text: error.message, isError: true };
    return { text: "Something broke on VIVA's side running that. Nothing was lost — try it again.", isError: true };
  }
}

/** A pairing tool reaches no route, so it gets a context that cannot reach one. */
function noCalls(env: ToolEnvironment): ApiContext {
  return {
    origin: env.origin,
    cookie: "",
    forwardedFor: env.forwardedFor,
    fetch: () => Promise.reject(new Error("pairing tools make no calls")),
  };
}
