import { describe, expect, it } from "vitest";
import { buildDocument } from "@/lib/redteam/document";
import { enforceGrounding, evaluateClaim } from "@/lib/redteam/evaluate";
import { createSession, looksLikeClaim } from "@/lib/redteam/session";
import type { ClaimStatus, ReviewMode, SourceDocument } from "@/lib/redteam/types";

/**
 * A second claim corpus, over five documents that are not engineering designs:
 * a thesis chapter, a product requirements document, a data policy, an
 * investor memo and a service level agreement.
 *
 * The standard is the one `redteam-corpus.test.ts` states, and it is
 * asymmetric on purpose. A wrong SUPPORTED or a wrong CONTRADICTED tells a
 * person something untrue about their own document; a cautious PARTIAL or
 * UNSUPPORTED only says less. So every row names the statuses it ACCEPTS, a row
 * never accepts a SUPPORTED or CONTRADICTED the document does not justify, and
 * its probe says which rule of the engine it is there to catch.
 */

type Row = [claim: string, accept: ClaimStatus[], probe: string];

const S: ClaimStatus = "SUPPORTED";
const P: ClaimStatus = "PARTIAL";
const C: ClaimStatus = "CONTRADICTED";
const U: ClaimStatus = "UNSUPPORTED";
const R: ClaimStatus = "UNRESOLVED";

type Corpus = { name: string; title: string; text: string; rows: Row[]; talk: string[] };

const THESIS: Corpus = {
  name: "thesis",
  title: "Retrieval Practice and Exam Performance in Introductory Statistics",
  text: `# Retrieval Practice and Exam Performance in Introductory Statistics

## 3.1 Design
We ran a pre-registered randomised controlled trial during the autumn 2023 term at two public universities. We randomly assigned 412 undergraduate students to either weekly low-stakes quizzes or an equal amount of guided re-reading. Randomisation was stratified by course section, and there were six sections in total.

## 3.2 Measures
The primary outcome was the score on a common 60-question final exam. Exam graders did not know which condition a student was in, but students could not be blinded to their own condition. Weekly study time was self-reported through an online survey with a 68% response rate.

## 3.3 Results
Students in the quiz condition scored higher on the final exam than students in the re-reading condition, with a standardised effect size of d = 0.34 (95% CI 0.15 to 0.53). Attrition was 11% and did not differ between conditions. Among students in the quiz condition, the number of quizzes completed was correlated with exam score (r = 0.29), but this association is observational and should not be read causally.

## 3.4 Limitations
The trial lasted a single semester, so we cannot say whether the benefit persists. The results may not generalise beyond introductory statistics. We cannot rule out that instructor enthusiasm for quizzing contributed to the effect.`,
  rows: [
    ["We randomly assigned 412 undergraduate students.", [S], "verbatim"],
    ["The trial randomised 412 students.", [S, P], "paraphrase with the same number"],
    ["We randomly assigned 214 undergraduate students.", [C], "transposed digits"],
    ["The sample was more than 400 students.", [S, P], "comparative the exact number satisfies"],
    ["The sample was more than 500 students.", [C, U], "comparative the exact number violates"],
    ["The effect size was d = 0.34.", [S], "decimal effect size"],
    ["The effect size was 0.43.", [C], "swapped decimal digits"],
    ["The 95% confidence interval ran from 0.25 to 0.63.", [C], "wrong range bounds"],
    ["Attrition was 11 percent.", [S, P], "percent spelled out"],
    ["Attrition was higher in the quiz condition.", [C, U], "comparative the document denies"],
    ["The trial was not pre-registered.", [C], "negation"],
    ["It is not true that the trial was not pre-registered.", [S, P, U], "double negation must never be CONTRADICTED"],
    ["Data were collected in autumn 2022.", [C], "year swap"],
    ["Exam graders were blind to condition.", [S, P, U], "the passage's 'could not be blinded' is about students, so never CONTRADICTED"],
    ["Students were blinded to their condition.", [C, U], "negated in the passage, never SUPPORTED"],
    ["Completing more quizzes causes higher exam scores.", [P, U, C], "causal overreach from an observational association"],
    ["Instructor enthusiasm did not contribute to the effect.", [C, U, P], "claim and passage both negate, so polarity matching alone must not SUPPORT"],
    ["The results generalise to every university subject.", [U, P, C], "'may not generalise' can never SUPPORT a universal"],
    ["The benefit was shown to persist after the semester.", [C, U, P], "the document says it cannot say"],
    ["Randomisation was stratified by gender.", [C, U], "different attribute in the same slot"],
    ["The study was funded by the National Science Foundation.", [U], "not addressed"],
    ["Maybe the effect size was around 0.34, I'm not sure.", [S, P], "speaker hedge on a true fact"],
    ["Learners who were tested did better.", [U], "paraphrase with no shared words stays UNSUPPORTED"],
    ["The survey response rate was at least 60%.", [S, P], "lower bound satisfied"],
    ["The final exam had 50 questions.", [C], "number inside a hyphenated compound"],
  ],
  talk: ["What was the effect size?"],
};

const PRD: Corpus = {
  name: "PRD",
  title: "PRD: Offline Mode for the FieldCheck Inspections App",
  text: `# PRD: Offline Mode for the FieldCheck Inspections App

## Problem
Inspectors lose work when they lose signal on remote sites. Last quarter, 18% of support tickets were about lost inspections.

## Goals
Offline mode must let inspectors complete an entire inspection without connectivity. The app must sync queued inspections within 5 minutes of reconnecting. We aim to reduce lost-inspection tickets by at least 50% within two quarters of launch.

## Requirements
Photos should be supported up to 20 MB each. Video capture may be added in a later release, but it is out of scope for version 1. Offline data is stored on the device in SQLite, capped at 2 GB per device. Queued inspections sync to the existing PostgreSQL cluster. When two edits conflict, the last writer wins for notes, but photos are never overwritten. Only admins can delete a submitted inspection. The offline screens must meet WCAG 2.1 AA.

## Rollout
Version 1 ships on iOS only, and Android follows in version 2. The beta starts on 15 March 2027 with 200 inspectors. General availability is planned for 1 June 2027. We expect to reach 3,000 inspectors across 40 regions by the end of Q3 2027.`,
  rows: [
    ["Offline mode must let inspectors complete an entire inspection without connectivity.", [S], "verbatim requirement"],
    ["The app must sync queued inspections within five minutes of reconnecting.", [S, P], "number word against a digit"],
    ["The app must sync queued inspections within 15 minutes of reconnecting.", [C], "wrong duration"],
    ["Photos must be supported up to 20 MB each.", [P, U], "claim says must where the document says should"],
    ["Photos should be supported up to 20 MB each.", [S], "same modal as the document"],
    ["Photos up to 200 MB are supported.", [C, U], "upper bound ten times the document's"],
    ["Video capture is in scope for version 1.", [C, U], "the document puts it out of scope"],
    ["Offline data is stored in SQLite.", [S, P], "named technology, same entity"],
    ["Offline data is stored in Realm.", [C, U], "different named technology in the same slot"],
    ["Queued inspections sync to the existing Postgres cluster.", [S, P], "same product under its short name"],
    ["Queued inspections sync to the existing MySQL cluster.", [C, U], "MySQL must not alias to PostgreSQL"],
    ["Offline storage is capped at 2 MB per device.", [C], "unit swap GB to MB"],
    ["Photos use last writer wins when edits conflict.", [C, U], "shares the sentence with notes, never SUPPORTED"],
    ["Notes use last writer wins when edits conflict.", [S, P], "the right half of a contrastive sentence"],
    ["Not only notes but also photos use last writer wins.", [C, P], "'not only X but also Y' is an assertion of both"],
    ["Inspectors can delete a submitted inspection.", [C, U], "exclusivity: only admins"],
    ["Only admins can delete a submitted inspection.", [S], "exclusivity kept"],
    ["Version 1 ships on Android.", [C, U], "Android appears in the passage for version 2"],
    ["Version 1 ships on iOS and Android.", [C, P], "compound with one false half"],
    ["The beta starts on 15 May 2027.", [C], "month swap in a date"],
    ["General availability is 1 June 2027.", [P, U], "a plan stated as fact"],
    ["We will reach 3,000 inspectors by the end of Q3 2027.", [P, U], "expectation stated as fact"],
    ["We expect to reach 3000 inspectors across 40 regions.", [S, P], "thousands separator dropped"],
    ["We expect to reach 30,000 inspectors across 40 regions.", [C], "order of magnitude"],
    ["We expect to reach 3,000 inspectors across 40 regions by the end of Q4 2027.", [C, P], "quarter swap"],
    ["We aim to reduce lost-inspection tickets by at least 75%.", [C, U], "different lower bound"],
    ["We will reduce lost-inspection tickets by 80%.", [P, U], "exact value consistent with 'at least 50%': neither SUPPORTED nor CONTRADICTED"],
    ["Most support tickets last quarter were about lost inspections.", [C, U], "18% is not most"],
    ["The offline screens must meet WCAG 2.2 AAA.", [C, U], "version and level swap"],
    ["Offline data is encrypted at rest.", [U], "not addressed"],
    ["The beta starts with at least 100 inspectors.", [S, P], "lower bound satisfied"],
  ],
  talk: ["Should Android be in version 1?"],
};

const POLICY: Corpus = {
  name: "data policy",
  title: "Customer Data Retention and Access Policy (v3.2)",
  text: `# Customer Data Retention and Access Policy (v3.2)

## Retention
Application logs are retained for 30 days and then deleted. Encrypted backups are retained for 35 days. Customer data is deleted within 90 days of contract termination, unless a legal hold applies.

## Access
Only members of the on-call SRE group may access production databases, and only through the bastion host with hardware-key MFA. Access lists are reviewed quarterly by the security team. Support staff may view account metadata but must never view message contents.

## Exceptions
Any exception to this policy requires written approval from the CISO and expires after 14 days.

## Residency and encryption
EU customer data is stored only in the Frankfurt region. Backups are encrypted with AES-256, and encryption keys are managed in AWS KMS. Audit logs are shipped to Splunk and kept for one year.

## Incidents
We notify affected customers within 72 hours of confirming a breach. An external firm performs a penetration test annually.`,
  rows: [
    ["Application logs are retained for 30 days.", [S], "verbatim"],
    ["Application logs are retained for 90 days.", [C], "a number that appears elsewhere in the document"],
    ["Backups are retained for 30 days.", [C], "the log sentence's number on the backup subject"],
    ["Backups are encrypted with AES-128.", [C], "cipher strength swap"],
    ["Encryption keys are managed in HashiCorp Vault.", [C, U], "different named product in the same slot"],
    ["Audit logs are shipped to Datadog.", [C, U], "different named product in the same slot"],
    ["Audit logs are kept for 30 days.", [C, U], "application-log retention on the audit-log subject"],
    ["Customer data is always deleted within 90 days of contract termination.", [P, U], "'always' drops the legal-hold exception"],
    ["Customer data is deleted immediately when a contract ends.", [C, P, U], "timing overstatement"],
    ["Customer data may be kept longer than 90 days under a legal hold.", [S, P, U], "'longer than' against 'within' must not become CONTRADICTED"],
    ["Any engineer may access production databases.", [C, U], "exclusivity: only on-call SREs"],
    ["Not only SREs but also contractors can access production databases.", [C, P, U], "'not only' widens an exclusive grant"],
    ["Production database access requires hardware-key MFA.", [S, P], "paraphrase"],
    ["Access lists are reviewed monthly.", [C], "frequency swap"],
    ["Support staff may view message contents.", [C], "nearly every word is in the passage, but it says never"],
    ["Support staff may view account metadata.", [S, P], "the permitted half"],
    ["Exceptions require written approval from the CTO.", [C, U], "role swap CISO to CTO"],
    ["Exceptions expire after two weeks.", [S, P, U], "unit conversion must never be CONTRADICTED"],
    ["Exceptions never expire.", [C, U], "negation"],
    ["EU customer data is stored in the Dublin region.", [C, U], "location swap against 'only'"],
    ["US customer data is stored only in the Frankfurt region.", [U, P], "different subject: neither SUPPORTED nor CONTRADICTED"],
    ["We notify affected customers within 24 hours of confirming a breach.", [C], "wrong notification window"],
    ["We notify affected customers within three days of confirming a breach.", [S, P, U], "72 hours is three days, never CONTRADICTED"],
    ["Penetration tests are run by our internal red team.", [C, U], "internal against external"],
    ["We are ISO 27001 certified.", [U], "not addressed"],
  ],
  talk: ["Who approves exceptions to this policy?"],
};

const INVESTOR: Corpus = {
  name: "investor memo",
  title: "Investment Memo: Loomwork Series A",
  text: `# Investment Memo: Loomwork Series A

## Summary
Loomwork sells scheduling software to mid-sized textile manufacturers. We recommend leading its $12M Series A at a $60M post-money valuation.

## Traction
Annual recurring revenue reached $2.4M in June 2026, up from $0.8M a year earlier, which is 200% year-over-year growth. Loomwork has 140 paying customers, and the top 10 customers account for 38% of ARR. Net revenue retention is 124% and gross margin is 71%.

## Market
We estimate the serviceable market at $4.1B across North America and Europe. Loomwork's main competitors are Tessel and Brightloom.

## Financials and projections
The company burns $310K per month, which gives 22 months of runway after this round. We expect ARR to reach $6M by the end of 2027, although this projection assumes sales cycles stay near the current average of 74 days.

## Risks
The largest customer represents 9% of ARR. The team of 34 people is based in Toronto, and it has not yet hired a CFO.`,
  rows: [
    ["Annual recurring revenue reached $2.4M in June 2026.", [S], "verbatim currency"],
    ["Annual recurring revenue reached 2.4 million dollars in June 2026.", [S, P], "currency spelled out"],
    ["Annual recurring revenue reached $24M in June 2026.", [C], "decimal point dropped"],
    ["Annual recurring revenue reached $2.4B in June 2026.", [C], "multiplier swap M to B"],
    ["ARR grew 300% year over year.", [C], "wrong growth rate"],
    ["Revenue tripled in a year.", [S, P, U], "200% growth is tripling, never CONTRADICTED"],
    ["Loomwork has more than 100 paying customers.", [S, P], "comparative satisfied"],
    ["Loomwork has more than 200 paying customers.", [C, U], "comparative violated"],
    ["The largest customer accounts for 38% of ARR.", [C, U], "the top-10 share put on the largest customer"],
    ["The largest customer represents 9% of ARR.", [S], "verbatim"],
    ["Net revenue retention is 142%.", [C], "transposed digits"],
    ["Gross margin is above 80%.", [C, U], "comparative violated"],
    ["The serviceable market is $4.1B.", [P, U], "an estimate stated as fact"],
    ["We estimate the serviceable market at $41B.", [C], "decimal point dropped"],
    ["Brightloom is one of Loomwork's main competitors.", [S, P], "member of a stated list"],
    ["Stripe is one of Loomwork's main competitors.", [U, C], "named company not in the list"],
    ["The company burns $310M per month.", [C], "multiplier swap K to M"],
    ["Runway is 12 months after this round.", [C], "12 appears elsewhere as $12M"],
    ["Loomwork will reach $6M ARR by the end of 2027.", [P, U], "projection stated as fact"],
    ["We expect ARR to reach $6M by the end of 2028.", [C], "year swap in a projection"],
    ["We expect ARR to reach $60M by the end of 2027.", [C], "the valuation's number put on ARR"],
    ["The Series A is $12M at a $60M pre-money valuation.", [C, P, U], "pre-money against post-money"],
    ["The team is based in Vancouver.", [C, U], "city swap"],
    ["Loomwork has hired a CFO.", [C], "'has not yet hired' negation"],
    ["Loomwork is profitable.", [U, C], "not stated; never SUPPORTED"],
    ["Sales cycles currently average 74 days.", [S, P], "number buried in a projection's assumption"],
  ],
  talk: ["Is that growth rate sustainable?"],
};

const SLA: Corpus = {
  name: "SLA",
  title: "Enterprise Service Level Agreement (Schedule B)",
  text: `# Enterprise Service Level Agreement (Schedule B)

## Availability
We commit to 99.9% monthly uptime for the Enterprise plan. This SLA applies only to the Enterprise plan and does not cover Starter or Team plans. Scheduled maintenance of up to 4 hours per month is excluded from the uptime calculation, provided it is announced at least 48 hours in advance.

## Service credits
If monthly uptime falls below 99.9%, the customer receives a credit of 10% of the monthly fee. If it falls below 99.0%, the credit rises to 25%. Credits are capped at 50% of the monthly fee and must be requested within 30 days of the end of the affected month. Credits are the customer's sole remedy for downtime.

## Support
Severity 1 incidents receive a response within 1 hour, 24 hours a day. Severity 2 incidents receive a response within 8 business hours. Support is provided in English and German.`,
  rows: [
    ["We commit to 99.9% monthly uptime for the Enterprise plan.", [S], "verbatim"],
    ["We commit to 99.99% monthly uptime.", [C], "one extra nine"],
    ["We commit to 99% monthly uptime.", [C], "99.0 appears in the credit clause"],
    ["We guarantee 100% uptime.", [C, U], "absolute overstatement"],
    ["We commit to at least 99.5% monthly uptime.", [S, P, U], "a weaker bound the commitment implies, never CONTRADICTED"],
    ["The SLA applies to the Starter plan.", [C], "explicitly excluded"],
    ["Scheduled maintenance of up to 8 hours per month is excluded.", [C], "8 appears in the support clause"],
    ["Maintenance must be announced at least two days in advance.", [S, P, U], "48 hours is two days, never CONTRADICTED"],
    ["Below 99.9% uptime the credit is 25% of the monthly fee.", [C, P, U], "the next tier's credit on this tier"],
    ["Credits are uncapped.", [C, U], "negates the cap"],
    ["Credits are applied automatically without a request.", [C, U], "the document requires a request"],
    ["Customers can also claim damages for downtime.", [C, U], "credits are the sole remedy"],
    ["Severity 2 incidents receive a response within 1 hour.", [C, U], "the Severity 1 window on Severity 2"],
    ["Severity 1 incidents receive a response within one hour.", [S, P], "number word"],
    ["Support is provided in English and French.", [C, P, U], "compound with a swapped language"],
    ["Severity 1 support is available around the clock.", [S, P, U], "paraphrase of 24 hours a day, never CONTRADICTED"],
    ["The SLA covers data loss.", [U], "not addressed"],
  ],
  talk: ["Um, okay, so, let me see."],
};

const CORPORA: Corpus[] = [THESIS, PRD, POLICY, INVESTOR, SLA];

const build = (c: Corpus): SourceDocument => buildDocument({ ownerId: `corpus2-${c.name}`, title: c.title, text: c.text });

/**
 * Two standards. SAFETY is absolute and per row: the engine never gives a
 * SUPPORTED or CONTRADICTED that the row does not accept, never cites a
 * passage the document did not mint, and every verdict survives the grounding
 * lock. STRENGTH is a ratchet over the whole corpus: how many rows get one of
 * the verdicts the row names. A row the engine answers more cautiously than it
 * could (PARTIAL where CONTRADICTED is right) is a known gap, not a failure;
 * the ratchet stops the count going down.
 */
const STRENGTH_FLOOR = 82;

const results: { claim: string; got: ClaimStatus; accept: ClaimStatus[] }[] = [];

for (const corpus of CORPORA) {
  describe(`claim corpus 2, ${corpus.name}`, () => {
    const d = build(corpus);
    const known = new Set(d.passages.map((p) => p.id));
    for (const [claim, accept, probe] of corpus.rows) {
      it(`${claim} is never wrongly decided (${probe})`, () => {
        const v = evaluateClaim(claim, d);
        results.push({ claim, got: v.status, accept });
        if (v.status === S || v.status === C) expect(accept, `${claim}: got ${v.status} (${v.basis})`).toContain(v.status);
        if (v.status === S) expect(v.evidencePassageIds.length).toBeGreaterThan(0);
        if (v.status === C) expect(v.contradictionPassageIds.length).toBeGreaterThan(0);
        for (const id of [...v.evidencePassageIds, ...v.contradictionPassageIds]) expect(known.has(id)).toBe(true);
        expect(enforceGrounding(v, d).status).toBe(v.status);
      });
    }
    for (const talk of corpus.talk) {
      it(`"${talk}" is talk, not a claim`, () => {
        expect(looksLikeClaim(talk)).toBe(false);
      });
    }
  });
}

describe("claim corpus 2, strength", () => {
  it(`at least ${STRENGTH_FLOOR} rows get a verdict the row names`, () => {
    const total = CORPORA.reduce((n, c) => n + c.rows.length, 0);
    expect(results.length).toBe(total);
    const exact = results.filter((r) => r.accept.includes(r.got)).length;
    expect(exact).toBeGreaterThanOrEqual(STRENGTH_FLOOR);
  });
});

void createSession;
void (null as unknown as ReviewMode);
