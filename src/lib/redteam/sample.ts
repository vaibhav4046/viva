/**
 * The sample document the golden demo runs on.
 *
 * It is written for this product, labelled as sample material everywhere it
 * appears, and deliberately contains a few honest weaknesses — a single
 * primary, manual recovery, a cache that is not strongly consistent — because
 * a document with no weak points would give a red team nothing to find. It
 * says nothing at all about compliance certifications: a claim of one is the
 * "cannot find it in the document" case.
 */

export const SAMPLE_TITLE = "Reliable AI Evaluation Service — technical design (sample material)";

export const SAMPLE_TEXT = `# Reliable AI Evaluation Service

## 1. Overview
This sample design describes a service that scores submissions with a language model and returns the scores to a reviewer dashboard. It is written as sample material for a review exercise.

## 2. Data storage
The service keeps all evaluation state in one primary Postgres instance. Read replicas exist for reporting queries only.
Automatic replica failover is not configured. If the primary becomes unavailable, recovery is manual: an on-call operator promotes a replica, and the documented recovery target is 30 minutes.

## 3. Request handling and retries
Failed provider calls are retried automatically up to 3 times with exponential backoff. Retries are bounded, and after the third failure the request fails with an explicit error.
Writes are idempotent by request id, so a retried write cannot be applied twice.

## 4. Model claims
Every model-generated claim must cite at least one source passage. Claims without a citation are rejected before they are returned to the reviewer.

## 5. Caching
The result cache is eventually consistent. Two workers can briefly serve different scores for the same submission, and the design does not guarantee cache consistency.

## 6. Operations
Evaluation inputs are retained for 90 days and then deleted.
There is no on-call rotation outside business hours. Alerts are reviewed at 09:00 UTC on working days.
Dashboards exist for latency and error rate. Distributed tracing is not implemented.
`;
