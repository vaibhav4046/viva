#!/usr/bin/env node
/**
 * Build VIVA's preloaded library from openly licensed textbooks.
 *
 *   npx tsx scripts/seed-corpus.mjs                # rebuild every subject
 *   npx tsx scripts/seed-corpus.mjs --only=psych   # one of them
 *   npx tsx scripts/seed-corpus.mjs --dry          # fetch and chunk, no model, no write
 *
 * What it does, per entry in MANIFEST:
 *   1. resolves the book in OpenStax's own archive and reads the licence OFF
 *      the source rather than off a note in this file;
 *   2. refuses anything that is not CC BY 4.0 — the NonCommercial and
 *      ShareAlike books are real books with real terms, and honouring those
 *      terms properly is a decision for a person, not for this script;
 *   3. pulls one chapter's sections, turns the HTML into prose, and cuts it
 *      with the SAME chunker the student's own uploads go through;
 *   4. asks the configured model to write the concept map and the questions;
 *   5. writes src/lib/corpus/library.json — passages, map, and the attribution
 *      the licence requires, which the app then shows.
 *
 * Nothing here invents subject matter. The passages are the textbook's own
 * words; the map is a model reading those words, and every subject records
 * `builtBy: "model"` so the app can say so.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OpenAICompatibleProvider, setReasoningProvider } from "../src/lib/ai/provider.ts";
import { chunkPages } from "../src/lib/intake/chunk.ts";
import { extractReadable } from "../src/lib/intake/html.ts";
import { normalizePlan, planSubject } from "../src/lib/intake/model.ts";
import { checkClaim } from "../src/lib/tutor/claim.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "src", "lib", "corpus", "library.json");

/**
 * Chapters chosen for prose: a student can be quizzed on sentences, not on
 * stripped equations.
 *
 * The list is ordered by SUBJECT rather than by book, because that is what a
 * student picking VIVA up is looking for. Where a second chapter of a book
 * appears it is because the chapter is its own module on most timetables —
 * genetics and ecology are not "more biology", they are the two other papers.
 *
 * Every id here is a book OpenStax publishes under CC BY 4.0, checked again at
 * run time off the CMS rather than trusted from this list. The obvious gaps —
 * Biology 2e, Chemistry 2e, University Physics, Psychology 2e, Microbiology,
 * U.S. History, Principles of Marketing — are CC BY-NC-SA 4.0 and are not
 * here; `buildOne` would refuse them anyway. There is no CC BY U.S. history
 * book: "Life, Liberty, and the Pursuit of Happiness" is CC BY but has no
 * published version in the archive, so it has nothing to read.
 */
const BOOK = {
  bio: "185cbf87-c72e-48f5-b51e-f14f21b5eabd", // Biology
  anat: "14fb4ad7-39a1-4eee-ab6e-3ef2482e3e22", // Anatomy and Physiology
  chem: "85abf193-2bd2-4908-8563-90b8a7ac8df6", // Chemistry
  phys: "031da8d3-b525-429c-80cf-6c8ed997733a", // College Physics
  astro: "2e737be8-ea65-48c3-aa0a-9f35b4c6a966", // Astronomy
  psych: "4abf04bf-93a0-45c3-9cbc-2cefd46e68cc", // Psychology
  soc: "02040312-72c8-441e-a685-20e9333f3e1d", // Introduction to Sociology 2e
  micro: "5c09762c-b540-47d3-9541-dda1f44f16e5", // Principles of Microeconomics 2e
  macro: "27f59064-990e-48f1-b604-5188b9086c29", // Principles of Macroeconomics 2e
  stats: "30189442-6998-4686-ac05-ed152b91b9de", // Introductory Statistics
  alg: "9b08c294-057f-4201-9f48-5d6ad992740d", // College Algebra
  trig: "13ac107a-f15f-49d2-97e8-60ab2e3b519c", // Algebra and Trigonometry
  gov: "30e47181-f52c-4a91-9c11-33380c428268", // American Government 3e
  biz: "4e09771f-a8aa-40ce-9063-aa58cc24e77f", // Introduction to Business
  ip: "1b4ee0ce-ee89-44fa-a5e7-a0db9f0c94b1", // Introduction to Intellectual Property
};

const MANIFEST = [
  // Life sciences
  { key: "bio", code: "BIO4", subject: "Biology", cnxId: BOOK.bio, chapter: /cell structure/i },
  { key: "photo", code: "BIO8", subject: "Photosynthesis", cnxId: BOOK.bio, chapter: /^chapter 8 photosynthesis$/i },
  { key: "genetics", code: "BIO12", subject: "Genetics", cnxId: BOOK.bio, chapter: /mendel's experiments and heredity/i },
  { key: "evolution", code: "BIO18", subject: "Evolution", cnxId: BOOK.bio, chapter: /evolution and the origin of species/i },
  { key: "ecology", code: "BIO44", subject: "Ecology", cnxId: BOOK.bio, chapter: /ecology and the biosphere/i },
  { key: "anat", code: "ANAT1", subject: "Anatomy and physiology", cnxId: BOOK.anat, chapter: /introduction to the human body/i },
  { key: "neuro", code: "ANAT12", subject: "Neuroscience", cnxId: BOOK.anat, chapter: /the nervous system and nervous tissue/i },
  { key: "heart", code: "ANAT19", subject: "Cardiovascular physiology", cnxId: BOOK.anat, chapter: /cardiovascular system: the heart/i },
  { key: "immune", code: "ANAT21", subject: "Immunology", cnxId: BOOK.anat, chapter: /lymphatic and immune system/i },
  // Physical sciences
  { key: "chem", code: "CHEM1", subject: "Chemistry", cnxId: BOOK.chem, chapter: /essential ideas/i },
  { key: "thermo", code: "CHEM5", subject: "Thermochemistry", cnxId: BOOK.chem, chapter: /^chapter 5 thermochemistry$/i },
  { key: "bonding", code: "CHEM7", subject: "Chemical bonding", cnxId: BOOK.chem, chapter: /chemical bonding and molecular geometry/i },
  { key: "phys", code: "PHYS4", subject: "Physics", cnxId: BOOK.phys, chapter: /newton's laws of motion/i },
  { key: "energy", code: "PHYS7", subject: "Energy and work", cnxId: BOOK.phys, chapter: /work, energy, and energy resources/i },
  { key: "waves", code: "PHYS16", subject: "Waves and oscillations", cnxId: BOOK.phys, chapter: /oscillatory motion and waves/i },
  { key: "emag", code: "PHYS18", subject: "Electricity and magnetism", cnxId: BOOK.phys, chapter: /electric charge and electric field/i },
  { key: "astro", code: "ASTR2", subject: "Astronomy", cnxId: BOOK.astro, chapter: /birth of astronomy/i },
  { key: "solarsys", code: "ASTR7", subject: "The solar system", cnxId: BOOK.astro, chapter: /other worlds: an introduction to the solar system/i },
  { key: "stars", code: "ASTR18", subject: "Stars", cnxId: BOOK.astro, chapter: /the stars: a celestial census/i },
  // Social sciences
  { key: "psych", code: "PSY8", subject: "Psychology", cnxId: BOOK.psych, chapter: /^chapter 8 memory$/i },
  { key: "learn", code: "PSY6", subject: "Learning and behaviour", cnxId: BOOK.psych, chapter: /^chapter 6 learning$/i },
  { key: "devpsych", code: "PSY9", subject: "Developmental psychology", cnxId: BOOK.psych, chapter: /lifespan development/i },
  { key: "socpsych", code: "PSY12", subject: "Social psychology", cnxId: BOOK.psych, chapter: /^chapter 12 social psychology$/i },
  { key: "soc", code: "SOC3", subject: "Sociology", cnxId: BOOK.soc, chapter: /^chapter 3 culture$/i },
  { key: "crime", code: "SOC7", subject: "Criminology", cnxId: BOOK.soc, chapter: /deviance, crime, and social control/i },
  { key: "econ", code: "ECON3", subject: "Economics", cnxId: BOOK.micro, chapter: /demand and supply/i },
  { key: "elastic", code: "ECON5", subject: "Elasticity", cnxId: BOOK.micro, chapter: /^chapter 5 elasticity$/i },
  { key: "macro", code: "MACR8", subject: "Macroeconomics", cnxId: BOOK.macro, chapter: /^chapter 8 unemployment$/i },
  { key: "gov", code: "GOV2", subject: "American government", cnxId: BOOK.gov, chapter: /constitution and its origins/i },
  { key: "liberties", code: "GOV4", subject: "Civil liberties", cnxId: BOOK.gov, chapter: /^chapter 4 civil liberties$/i },
  // Quantitative
  { key: "stats", code: "STAT1", subject: "Statistics", cnxId: BOOK.stats, chapter: /sampling and data/i },
  { key: "normal", code: "STAT6", subject: "The normal distribution", cnxId: BOOK.stats, chapter: /^chapter 6 the normal distribution$/i },
  { key: "hypo", code: "STAT9", subject: "Hypothesis testing", cnxId: BOOK.stats, chapter: /hypothesis testing with one sample/i },
  { key: "alg", code: "ALG3", subject: "Algebra", cnxId: BOOK.alg, chapter: /^chapter 3 functions$/i },
  { key: "logs", code: "ALG6", subject: "Logarithms and exponentials", cnxId: BOOK.alg, chapter: /exponential and logarithmic functions/i },
  { key: "trig", code: "TRIG7", subject: "Trigonometry", cnxId: BOOK.trig, chapter: /the unit circle: sine and cosine functions/i },
  // Professional
  { key: "biz", code: "BUS4", subject: "Business", cnxId: BOOK.biz, chapter: /forms of business ownership/i },
  { key: "ip", code: "IP3", subject: "Intellectual property", cnxId: BOOK.ip, chapter: /copyright basics/i },
];

/** Sections that are exercises, glossaries or front matter rather than teaching prose. */
const SKIP_SECTION = /^(introduction|summary|key terms|key concepts|chapter summary|review questions|critical thinking|free response|problems|exercises|references|visual connection|art connection|test prep|glossary|solutions|conceptual questions|practice test|homework|bringing it together|chapter review|section exercises)/i;

/** Per subject: enough passages that retrieval has somewhere to go, not a whole textbook in the repo. */
const TARGET_CHARS = 13_000;
const PER_SECTION_CHARS = 4_200;

const ACCEPTED_LICENCE = {
  match: /^Creative Commons Attribution License$/i,
  name: "CC BY 4.0",
  url: "https://creativecommons.org/licenses/by/4.0/",
};

const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith("--only=")) ?? "").split("=")[1] || null;
const dry = args.includes("--dry");

loadEnvLocal();

/**
 * The seed can be pointed at a different model than the app serves.
 *
 * Not a preference — a rate limit. The provider's tokens-per-minute budget is
 * per model and shared across everything using that key, and the app's own
 * model is busy answering study turns. Seeding eleven subjects against it
 * returned 429 thirty-three times in a row. A sibling model has its own
 * budget, produces the same schema through the same code path, and the model
 * that actually wrote each map is recorded in the output file.
 */
const model = (args.find((a) => a.startsWith("--model=")) ?? "").split("=")[1] || process.env.LLM_MODEL;
process.env.LLM_MODEL = model;

/**
 * The shape hint, and why a seeding script gets one when the app does not.
 *
 * `planSubject` validates its reply against a Zod schema but never shows the
 * model that schema, so the model infers the shape from the prose rules. The
 * app's own model usually infers it; the smaller sibling this script has to
 * use omits `related` on most concepts and the whole map is thrown away for
 * a missing empty array. This says what the keys are — formatting, not
 * subject matter — through the provider seam the app already exposes, so the
 * prompt, the schema, the repair retry and the normalisation are all still
 * the app's own. The app's intake would benefit from the same hint; that is a
 * change to shared code, and it is noted rather than made here.
 */
const SHAPE_HINT = [
  "",
  "The JSON object has exactly these keys:",
  'title (string), subject (string),',
  'concepts: array of 6-10 objects, EVERY one with id, name, aliases (array of 1-8 strings), description, related (array of other concept ids — use [] when there are none; never omit it),',
  'examQuestions: array of 5-8 objects with conceptId, question, hint, and requiredKeywords — AT LEAST THREE strings in every single one, up to six,',
  'explainers: an object keyed by EVERY concept id, each { formal, jargonFree, missing: [] },',
  'traps: array of 2-4 objects with conceptId, statement, whyWrong, correct,',
  'teachback: { keywords: object keyed by concept id to 3-8 strings, hints: object keyed by concept id to one sentence },',
  "keyterms: array of strings.",
  "Every field is required. Output the JSON object and nothing else.",
].join("\n");

/**
 * Repair by DELETING, never by inventing.
 *
 * The model this script can get budget for is a smaller sibling of the one the
 * app serves, and it slips on the countable rules: five entries in a field
 * capped at four, two required keywords where the schema asks for three. Zod
 * then throws the whole map away over an array length. So before validation,
 * anything over a limit is trimmed and anything under one is dropped — an
 * exam question with two keywords is removed, not topped up with a third that
 * nobody wrote. If enough is dropped to fall below the schema's minimums the
 * map fails, which is the correct outcome.
 */
function repair(value) {
  if (!value || typeof value !== "object") return value;
  const clip = (s, max) => {
    const text = String(s ?? "").trim();
    if (text.length <= max) return text;
    const cut = text.slice(0, max);
    const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
    return stop > max * 0.5 ? cut.slice(0, stop + 1) : cut;
  };
  const concepts = (Array.isArray(value.concepts) ? value.concepts : [])
    .filter((c) => c && typeof c.id === "string" && typeof c.name === "string" && String(c.description ?? "").length >= 10)
    .slice(0, 10);
  const ids = new Set(concepts.map((c) => c.id));
  for (const c of concepts) {
    c.aliases = [...new Set((Array.isArray(c.aliases) ? c.aliases : []).filter((a) => typeof a === "string" && a.trim().length >= 2))].slice(0, 8);
    if (!c.aliases.length) c.aliases = [c.name];
    c.related = (Array.isArray(c.related) ? c.related : []).filter((r) => ids.has(r) && r !== c.id).slice(0, 4);
    c.description = clip(c.description, 400);
    c.name = clip(c.name, 70);
  }
  const explainers = {};
  for (const [id, e] of Object.entries(value.explainers ?? {})) {
    if (!ids.has(id) || !e) continue;
    const formal = clip(e.formal, 700);
    const jargonFree = clip(e.jargonFree, 700);
    if (formal.length < 20 || jargonFree.length < 20) continue;
    explainers[id] = { formal, jargonFree, missing: (Array.isArray(e.missing) ? e.missing : []).map((m) => clip(m, 160)).slice(0, 4) };
  }
  const teachback = value.teachback ?? {};
  const keywords = {};
  const hints = {};
  for (const [id, k] of Object.entries(teachback.keywords ?? {})) {
    if (ids.has(id) && Array.isArray(k)) keywords[id] = k.filter((w) => typeof w === "string" && w.trim().length >= 2).slice(0, 8);
  }
  for (const [id, h] of Object.entries(teachback.hints ?? {})) if (ids.has(id)) hints[id] = clip(h, 240);
  return {
    title: clip(value.title, 90),
    subject: clip(value.subject, 60),
    concepts,
    examQuestions: (Array.isArray(value.examQuestions) ? value.examQuestions : [])
      .filter((q) => q && ids.has(q.conceptId) && Array.isArray(q.requiredKeywords) && q.requiredKeywords.length >= 3 && String(q.hint ?? "").length >= 5)
      .map((q) => ({ ...q, question: clip(q.question, 220), hint: clip(q.hint, 240), requiredKeywords: q.requiredKeywords.slice(0, 6) }))
      .slice(0, 8),
    explainers,
    traps: (Array.isArray(value.traps) ? value.traps : [])
      .filter((t) => t && ids.has(t.conceptId) && String(t.whyWrong ?? "").length >= 10)
      .map((t) => ({ ...t, statement: clip(t.statement, 300), whyWrong: clip(t.whyWrong, 500), correct: clip(t.correct, 300) }))
      .slice(0, 4),
    teachback: { keywords, hints },
    keyterms: (Array.isArray(value.keyterms) ? value.keyterms : []).filter((k) => typeof k === "string" && k.length >= 2).map((k) => k.slice(0, 50)).slice(0, 60),
  };
}

if (!dry) {
  const base = process.env.LLM_BASE_URL;
  const key = process.env.LLM_API_KEY;
  if (!base || !key || !model) {
    console.error("No model configured. Set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL (usually in .env.local).");
    process.exit(1);
  }
  const provider = new OpenAICompatibleProvider(base, key, model);
  setReasoningProvider({
    name: `seed:${model}`,
    generateText: (input) => provider.generateText(input),
    // Same endpoint, same prompt, same schema as the app — plus the shape hint
    // and the subtractive repair above, both of which exist only because this
    // script cannot have the app's model.
    generateObject: async (input) => {
      const res = await fetch(`${base.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          response_format: { type: "json_object" },
          // Room to finish the object. Without a ceiling this model spent its
          // whole completion on reasoning and returned an empty generation,
          // which the provider reports as "failed to validate JSON".
          max_completion_tokens: 6_000,
          ...(model.includes("gpt-oss") ? { reasoning_effort: "low" } : {}),
          messages: [
            { role: "system", content: `${input.system}\n${SHAPE_HINT}` },
            { role: "user", content: input.user },
          ],
        }),
        signal: AbortSignal.timeout(input.timeoutMs ?? 45_000),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        // A per-DAY cap is not a minute to wait out. The retry loop below is
        // built for the per-minute window; against an exhausted daily budget it
        // spends three attempts and two minutes per subject discovering the
        // same refusal, thirty-odd times over. Say so once and stop, so the
        // subjects already built are written and the run can resume tomorrow
        // or on another credential.
        if (res.status === 429 && /per day|\bTPD\b|\bRPD\b/i.test(detail)) {
          exhausted = `daily budget exhausted for ${model}: ${detail.slice(0, 200)}`;
        }
        throw new Error(`provider returned ${res.status}: ${detail.slice(0, 300)}`);
      }
      const data = await res.json();
      return input.schema.parse(repair(JSON.parse(data.choices?.[0]?.message?.content ?? "{}")));
    },
  });
}

const strip = (s) => String(s ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/**
 * Set when the provider says the DAY's budget is gone, not the minute's.
 *
 * `reasonObject` turns every provider failure into `null` so a learner never
 * sees an exception, which is right for the app and blind for this script: the
 * retry loop cannot tell "wait a minute" from "come back tomorrow", and against
 * an exhausted daily cap it burns two minutes and three attempts per subject,
 * for every subject in the manifest. This is the one thing the script needs to
 * know, so the provider seam writes it here on the way past.
 */
let exhausted = null;

/** .env.local is where this repo keeps LLM_*; the script is run by hand, not by Next. */
function loadEnvLocal() {
  try {
    const raw = readFileSync(path.join(ROOT, ".env.local"), "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
      if (!m) continue;
      const value = m[2].replace(/^["']|["']$/g, "");
      if (!process.env[m[1]] && value) process.env[m[1]] = value;
    }
  } catch {
    /* no .env.local: the model path will simply be unavailable, and we say so. */
  }
}

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function openstaxIndex() {
  const release = await getJson("https://openstax.org/rex/release.json");
  const archive = `https://openstax.org${release.archiveUrl}`;
  const cms = await getJson(
    "https://openstax.org/apps/cms/api/v2/pages/?type=books.Book&fields=title,cnx_id,license_name,license_url,slug&limit=200"
  );
  const byId = new Map();
  for (const item of cms.items) {
    if (item.cnx_id) byId.set(item.cnx_id, { ...item, slug: item.meta?.slug });
  }
  return { archive, release, byId };
}

function chapterPages(tree, wanted) {
  const chapters = [];
  const walk = (node) => {
    for (const child of node.contents ?? []) {
      if (child.toc_type === "chapter") chapters.push(child);
      else if (child.contents) walk(child);
    }
  };
  walk(tree);
  const chapter = chapters.find((c) => wanted.test(strip(c.title)));
  if (!chapter) return null;
  const pages = (chapter.contents ?? []).filter(
    (c) => c.toc_type === "book-content" && !SKIP_SECTION.test(strip(c.title).replace(/^\d+(\.\d+)?\s*/, ""))
  );
  return { title: strip(chapter.title), pages };
}

async function buildOne(entry, index) {
  const meta = index.byId.get(entry.cnxId);
  if (!meta) return { skipped: `${entry.key}: not in the OpenStax book list` };
  if (!ACCEPTED_LICENCE.match.test(meta.license_name ?? "")) {
    return { skipped: `${entry.key}: licence is "${meta.license_name}", not CC BY 4.0 — not seeded` };
  }
  const version = index.release.books[entry.cnxId]?.defaultVersion;
  if (!version) return { skipped: `${entry.key}: no published version in the archive` };

  const book = await getJson(`${index.archive}/contents/${entry.cnxId}@${version}.json`);
  const chapter = chapterPages(book.tree, entry.chapter);
  if (!chapter) return { skipped: `${entry.key}: no chapter matching ${entry.chapter}` };

  const pages = [];
  let total = 0;
  for (const page of chapter.pages) {
    if (total >= TARGET_CHARS) break;
    const uuid = String(page.id).split("@")[0];
    const doc = await getJson(`${index.archive}/contents/${entry.cnxId}@${version}:${uuid}.json`);
    const readable = extractReadable(String(doc.content ?? ""));
    const sectionTitle = strip(page.title);
    // One page per textbook section, so the chunker cuts its own 800/120
    // windows across the whole section instead of one window per paragraph.
    const body = [];
    let used = 0;
    for (const section of readable.sections) {
      if (used >= PER_SECTION_CHARS || total + used >= TARGET_CHARS) break;
      body.push(section.text);
      used += section.text.length;
    }
    if (!used) continue;
    pages.push({ text: body.join(" "), section: sectionTitle });
    total += used;
    process.stdout.write(`    · ${sectionTitle} (${used} chars)\n`);
  }
  if (total < 4_000) return { skipped: `${entry.key}: only ${total} readable characters in that chapter` };

  const sourceId = `src_os_${entry.key}`;
  const chunks = chunkPages(pages, sourceId, chapter.title);
  const chapterTitle = chapter.title.replace(/^Chapter\s+\d+\s*/i, "").trim() || chapter.title;
  const bookUrl = `https://openstax.org/books/${meta.slug}`;
  const firstPage = chapter.pages[0]?.slug ? `${bookUrl}/pages/${chapter.pages[0].slug}` : bookUrl;

  console.log(`    ${chunks.length} passages, ${total} chars`);
  if (dry) return { dry: true, key: entry.key, chunks: chunks.length };

  /*
   * A thin map is a retry, not a skip.
   *
   * `tidy` drops any concept the model did not explain twice, and this model
   * writes one explainer instead of six often enough that half the manifest
   * was being abandoned on a first attempt that a second attempt then got
   * right. The check therefore lives INSIDE the retry, where "the model came
   * back with nothing usable" already lives — same outcome, same loop. What is
   * still refused is a subject that stays thin across every attempt: shipping
   * two concepts and calling it a subject is worse than not shipping it.
   */
  let thin = null;
  const body = await withRetries(entry.key, async (attempt) => {
    const plan = await planSubject({
      title: `${chapterTitle} (${meta.title})`,
      passages: modelPassages(chunks, attempt),
    });
    if (!plan) return null;
    const candidate = tidy(normalizePlan(plan), entry.key);
    if (candidate.concepts.length < 6 || candidate.examQuestions.length < 5) {
      thin = `${candidate.concepts.length} complete concepts and ${candidate.examQuestions.length} questions`;
      console.log(`    attempt ${attempt}: only ${thin} — asking again`);
      return null;
    }
    return candidate;
  });
  if (!body) {
    return { skipped: `${entry.key}: ${thin ? `only ${thin}` : "the model did not return a usable map"}` };
  }

  const course = {
    id: `course_os_${entry.key}`,
    code: entry.code,
    title: chapterTitle,
    subject: entry.subject,
    demo: true,
    builtBy: "model",
    sources: [
      {
        id: sourceId,
        title: `${meta.title} — ${chapterTitle}`,
        type: "textbook",
        licence: {
          name: ACCEPTED_LICENCE.name,
          url: ACCEPTED_LICENCE.url,
          attribution: `OpenStax, ${meta.title}. Access for free at ${bookUrl}`,
          sourceUrl: firstPage,
          workTitle: meta.title,
          shareAlike: false,
          nonCommercial: false,
        },
        chunks,
      },
    ],
    concepts: body.concepts,
    examQuestions: body.examQuestions,
    teachback: body.teachback,
    explainers: body.explainers,
    traps: body.traps,
  };

  const dropped = course.traps.length - (course.traps = usableTraps(course)).length;
  if (dropped) console.log(`    dropped ${dropped} trap(s) the claim check could not tell apart`);
  return { course };
}

/**
 * A trap VIVA can actually catch, or no trap at all.
 *
 * The app checks a student's claim against the passages with `checkClaim`, and
 * a trap is only worth shipping if that check calls the misconception wrong and
 * leaves the correct version alone. The hand-written labs were authored to
 * satisfy that; a trap a model wrote may read fine and still be invisible to
 * the checker — which would mean warning a student about a mistake the product
 * cannot then recognise when they make it. Those are dropped here.
 */
function usableTraps(course) {
  const chunks = course.sources.flatMap((s) => s.chunks);
  return course.traps.filter((trap) => {
    const right = checkClaim({ claim: trap.correct, chunks, course, conceptId: trap.conceptId });
    const wrong = checkClaim({ claim: trap.statement, chunks, course, conceptId: trap.conceptId });
    return right.status !== "contradicted" && wrong.status === "contradicted";
  });
}

/**
 * Every passage is kept for retrieval; the model is shown a prefix of them.
 *
 * The tokens-per-minute ceiling on the configured provider is small enough
 * that a whole chapter in one prompt is refused outright. A map written from
 * the first two thirds of the chapter still describes the chapter — and a
 * refused call describes nothing.
 */
function modelPassages(chunks, attempt = 1) {
  // Prompt and completion share one per-minute budget, so a chapter that ran
  // out of room mid-JSON gets a shorter prompt on the next attempt rather than
  // the same one again.
  const budget = Math.max(3_000, 6_500 - (attempt - 1) * 1_500);
  const out = [];
  let used = 0;
  for (const c of chunks) {
    if (used + c.text.length > budget && out.length >= 8) break;
    out.push({ id: c.id, text: c.text });
    used += c.text.length;
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The provider's minute window is shared with whatever else is running. */
async function withRetries(key, work, attempts = 3) {
  for (let i = 1; i <= attempts; i += 1) {
    const value = await work(i);
    if (value) return value;
    if (exhausted) return null;
    if (i < attempts) {
      console.log(`    no map on attempt ${i} for ${key}; waiting out the provider's minute…`);
      await sleep(65_000);
    }
  }
  return null;
}

/**
 * Make the model's map fit what the app guarantees, without inventing anything.
 *
 * Two rules. A concept the model did not explain twice is DROPPED, along with
 * its questions and traps — writing the missing explanation here would be this
 * script making up subject matter, which is the one thing it may not do. And
 * every concept id is prefixed with the subject key, because concept ids are
 * unique across the whole library and "energy" belongs to more than one book.
 */
function tidy(body, key) {
  const ns = (id) => `${key}_${id}`.slice(0, 60);
  const keep = new Set(
    body.concepts
      .filter((c) => (body.explainers[c.id]?.formal ?? "").length > 0 && (body.explainers[c.id]?.jargonFree ?? "").length > 0)
      .map((c) => c.id)
  );

  const concepts = body.concepts
    .filter((c) => keep.has(c.id))
    .map((c) => ({ ...c, id: ns(c.id), related: c.related.filter((r) => keep.has(r)).map(ns) }));

  const explainers = {};
  for (const id of keep) explainers[ns(id)] = body.explainers[id];

  const keywords = {};
  const hints = {};
  for (const c of body.concepts) {
    if (!keep.has(c.id)) continue;
    const given = body.teachback.keywords[c.id] ?? [];
    // Three is what teach-back grading needs. The concept's own name and
    // aliases are the material's own words, so topping up from them adds no
    // claim the textbook did not make.
    const filled = [...new Set([...given, c.name, ...c.aliases].map((w) => w.trim()).filter(Boolean))];
    // A concept with one alias and no keywords from the model would leave two,
    // and teach-back grading needs three. The next words come from the
    // concept's own description, which is the material's own wording.
    for (const word of c.description.split(/[^\p{L}\p{N}-]+/u)) {
      if (filled.length >= 3) break;
      if (word.length > 5 && !filled.some((f) => f.toLowerCase() === word.toLowerCase())) filled.push(word);
    }
    keywords[ns(c.id)] = filled.slice(0, 8);
    hints[ns(c.id)] = body.teachback.hints[c.id] || `Say what ${c.name.toLowerCase()} is, in your own words, and give an example from the reading.`;
  }

  return {
    concepts,
    explainers,
    teachback: { keywords, hints },
    examQuestions: body.examQuestions
      .filter((q) => keep.has(q.conceptId))
      .map((q) => ({ ...q, id: ns(q.id), conceptId: ns(q.conceptId) })),
    traps: body.traps.filter((t) => keep.has(t.conceptId)).map((t) => ({ ...t, id: ns(t.id), conceptId: ns(t.conceptId) })),
  };
}

async function main() {
  const index = await openstaxIndex();
  let entries = MANIFEST.filter((m) => !only || m.key === only);
  if (args.includes("--fill")) {
    let have = [];
    try {
      have = JSON.parse(readFileSync(OUT, "utf-8")).subjects.map((s) => s.id);
    } catch {
      have = [];
    }
    entries = entries.filter((m) => !have.includes(`course_os_${m.key}`));
    console.log(`--fill: ${entries.length} subject(s) still to build`);
  }
  const courses = [];
  const skipped = [];

  for (const [i, entry] of entries.entries()) {
    // One subject per provider minute. Slower than it needs to be on a bigger
    // key, and the alternative is eleven refusals in eleven seconds.
    if (i > 0 && !dry) await sleep(20_000);
    console.log(`\n${entry.key} — ${entry.subject}`);
    try {
      const result = await buildOne(entry, index);
      if (result.course) {
        courses.push(result.course);
        console.log(
          `    ok · ${result.course.concepts.length} concepts · ${result.course.examQuestions.length} questions · ${result.course.traps.length} traps`
        );
      } else if (result.skipped) {
        skipped.push(result.skipped);
        console.log(`    SKIPPED — ${result.skipped}`);
      }
    } catch (error) {
      const line = `${entry.key}: ${error instanceof Error ? error.message : String(error)}`;
      skipped.push(line);
      console.log(`    FAILED — ${line}`);
    }
    if (exhausted) {
      // Everything built so far is still written below; the rest of the
      // manifest is a `--fill` run away on another credential or another day.
      console.log(`\nSTOPPING — ${exhausted}`);
      skipped.push(exhausted);
      break;
    }
  }

  if (dry) return;

  // Always a merge, never a replace. The provider this runs against has a
  // small per-minute budget shared with everything else on the key, so a run
  // that only lands four subjects is normal — run it again for the rest. A
  // subject that was skipped keeps whatever was built for it last time.
  let existing = [];
  try {
    existing = JSON.parse(readFileSync(OUT, "utf-8")).subjects ?? [];
  } catch {
    existing = [];
  }
  write(existing.filter((s) => !courses.some((c) => c.id === s.id)).concat(courses));

  console.log(`\nwrote ${courses.length} subject(s) to ${path.relative(ROOT, OUT)}`);
  if (skipped.length) console.log(`skipped:\n  ${skipped.join("\n  ")}`);
}

function write(subjects) {
  const sorted = subjects.slice().sort((a, b) => a.id.localeCompare(b.id));
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), source: "scripts/seed-corpus.mjs", model, subjects: sorted }, null, 1)}\n`,
    "utf-8"
  );
}

await main();
