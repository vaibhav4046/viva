import { describe, expect, it } from "vitest";
import { buildDocument } from "@/lib/redteam/document";
import { evaluateClaim } from "@/lib/redteam/evaluate";
import { SAMPLE_TEXT, SAMPLE_TITLE } from "@/lib/redteam/sample";
import type { ClaimStatus, SourceDocument } from "@/lib/redteam/types";

/**
 * A corpus of claim / expected-verdict pairs, most of them written by an
 * adversarial reviewer to make the engine say SUPPORTED or CONTRADICTED when the
 * document does not decide the claim.
 *
 * The standard the engine is held to is asymmetric on purpose. A wrong
 * SUPPORTED or a wrong CONTRADICTED tells a person something untrue about their
 * own document. A cautious PARTIAL or UNSUPPORTED only says less. So each row
 * names the statuses it will ACCEPT, and the rows that used to go wrong accept
 * anything except the one that was wrong.
 */

const sample = (): SourceDocument => buildDocument({ ownerId: "u", title: SAMPLE_TITLE, text: SAMPLE_TEXT, sample: true });

type Row = [claim: string, accept: ClaimStatus[]];

const NOT_SUPPORTED: ClaimStatus[] = ["PARTIAL", "UNSUPPORTED", "CONTRADICTED", "UNRESOLVED"];
const NOT_CONTRADICTED: ClaimStatus[] = ["SUPPORTED", "PARTIAL", "UNSUPPORTED", "UNRESOLVED"];

const SAMPLE_ROWS: Row[] = [
  // What the document says, in its own terms.
  ["We manually fail over to a replica.", ["SUPPORTED"]],
  ["Failed calls are retried automatically up to 3 times.", ["SUPPORTED"]],
  ["Every claim cites a source passage.", ["SUPPORTED"]],
  ["We retain evaluation inputs for 90 days.", ["SUPPORTED"]],
  ["Alerts are reviewed at 09:00 UTC on working days.", ["SUPPORTED"]],
  ["The recovery target is 30 minutes.", ["SUPPORTED"]],
  ["Distributed tracing is not implemented.", ["SUPPORTED"]],
  ["Two workers can serve different scores for the same submission.", ["SUPPORTED"]],
  ["The result cache is eventually consistent.", ["SUPPORTED"]],
  ["Writes are idempotent by request id.", ["SUPPORTED"]],
  ["Dashboards exist for latency and error rate.", ["SUPPORTED"]],
  ["Read replicas exist for reporting queries only.", ["SUPPORTED"]],
  ["The database is a single primary Postgres.", ["SUPPORTED"]],

  // What it contradicts.
  ["We automatically fail over to a replica.", ["CONTRADICTED"]],
  ["Failed calls are retried automatically up to 5 times.", ["CONTRADICTED"]],
  ["The cache is strongly consistent.", ["CONTRADICTED"]],
  ["We have distributed tracing.", ["CONTRADICTED"]],
  ["We retain evaluation inputs for 30 days.", ["CONTRADICTED"]],
  ["The recovery target is 30 seconds.", ["CONTRADICTED"]],
  ["The recovery target is 30 hours.", ["CONTRADICTED"]],
  ["Alerts are reviewed at 3am.", ["CONTRADICTED"]],
  ["Alerts are reviewed at midnight every day.", ["CONTRADICTED", "PARTIAL"]],
  ["Read replicas are used for writes.", ["CONTRADICTED"]],
  ["Claims without a citation are returned to the reviewer.", ["CONTRADICTED"]],
  ["There is a 24/7 on call rotation.", ["CONTRADICTED"]],
  ["We retry 3 times and failover is automatic.", ["CONTRADICTED"]],

  // Reviewer's cases: never SUPPORTED, because the document does not say them.
  ["We keep evaluation inputs for one year.", NOT_SUPPORTED],
  ["Dashboards exist for cost.", NOT_SUPPORTED],
  ["We retry 3 times with linear backoff.", NOT_SUPPORTED],
  ["The request silently succeeds after the third failure.", NOT_SUPPORTED],
  ["There are 2 read replicas.", NOT_SUPPORTED],
  ["The service runs in the EU region only.", NOT_SUPPORTED],
  ["Passwords are hashed with bcrypt.", NOT_SUPPORTED],
  ["We have a globally replicated Kubernetes cluster.", ["UNSUPPORTED", "PARTIAL"]],
  ["We guarantee GDPR compliance and SOC 2 certification for all customer data.", ["UNSUPPORTED"]],
  ["We are certified for SOC 2 and ISO 27001.", ["UNSUPPORTED"]],

  // Cautious is acceptable; wrongly contradicting a true statement is not.
  ["The service keeps evaluation state in Postgres.", NOT_CONTRADICTED],
  ["Retries use exponential backoff.", NOT_CONTRADICTED],
  ["Two workers can briefly serve different scores.", NOT_CONTRADICTED],
];

describe("claim corpus, sample document", () => {
  const d = sample();
  for (const [claim, accept] of SAMPLE_ROWS) {
    it(`${claim} → ${accept.join(" | ")}`, () => {
      const v = evaluateClaim(claim, d);
      expect(accept, `${claim}: got ${v.status} (${v.basis})`).toContain(v.status);
      if (v.status === "SUPPORTED") expect(v.evidencePassageIds.length).toBeGreaterThan(0);
      if (v.status === "CONTRADICTED") expect(v.contradictionPassageIds.length).toBeGreaterThan(0);
    });
  }
});

const OTHER_DOC = `# Security notes

Passwords are hashed with bcrypt and never stored in plaintext.
Backups run nightly, and restores are not tested.
Deploys happen only on Tuesdays.
The API allows 100 requests per minute per key.
All traffic uses TLS 1.3.
Customer data is stored in the EU region only.
`;

const OTHER_ROWS: Row[] = [
  ["Passwords are hashed with bcrypt.", ["SUPPORTED"]],
  ["Passwords are stored in plaintext.", ["CONTRADICTED"]],
  ["Backups run nightly.", ["SUPPORTED"]],
  ["Restores are tested.", ["CONTRADICTED"]],
  ["Deploys happen on Fridays.", NOT_SUPPORTED],
  ["Deploys happen only on Tuesdays.", ["SUPPORTED"]],
  ["The API allows 100 requests per hour per key.", ["CONTRADICTED"]],
  ["The API allows 100 requests per minute per key.", ["SUPPORTED"]],
  ["All traffic uses TLS 1.2.", ["CONTRADICTED"]],
  ["All traffic uses TLS 1.3.", ["SUPPORTED"]],
  ["Customer data is stored in the US region.", NOT_SUPPORTED],
  ["Customer data is stored in the EU region only.", ["SUPPORTED"]],
  ["We use two factor authentication for staff.", ["UNSUPPORTED"]],
];

describe("claim corpus, a second document", () => {
  const d = buildDocument({ ownerId: "u2", title: "Security notes", text: OTHER_DOC });
  for (const [claim, accept] of OTHER_ROWS) {
    it(`${claim} → ${accept.join(" | ")}`, () => {
      const v = evaluateClaim(claim, d);
      expect(accept, `${claim}: got ${v.status} (${v.basis})`).toContain(v.status);
    });
  }
});

describe("an utterance is judged sentence by sentence", () => {
  it("a true sentence cannot carry a false one", () => {
    const v = evaluateClaim("We retain evaluation inputs for 90 days. We also have distributed tracing in every service.", sample());
    expect(v.status).toBe("CONTRADICTED");
    expect(v.parts.map((p) => p.status)).toEqual(["SUPPORTED", "CONTRADICTED"]);
  });

  it("a claim built from real words in the wrong order is not a match for the passage that has them", () => {
    const v = evaluateClaim("Retries use linear backoff.", sample());
    expect(v.status).not.toBe("SUPPORTED");
  });
});
