import { describe, expect, it } from "vitest";
import { clampVoiceAgentExpiry, MAX_EXPIRY_SEC, DEFAULT_EXPIRY_SEC } from "@/app/api/voice-agent/token/route";

/**
 * The Voice Agent token endpoint's real contract.
 *
 * These numbers were measured against the live API on 2026-09-28, and they
 * contradict the published events reference, which does not mention the expiry
 * parameter at all. The route sent no parameter and answered 502 to every
 * caller. Measured responses:
 *
 *   no parameter            -> 422 {"type":"missing","loc":["query","expires_in_seconds"]}
 *   expires_in_seconds=3600 -> 422 {"type":"less_than_equal","le":600}
 *   expires_in_seconds=600  -> 200 {"token":"…2486 chars…","expires_in_seconds":600}
 *
 * So the clamp is not defensive tidiness, it is the only thing standing
 * between a client and a 422, and the test is what stops someone "simplifying"
 * the query away.
 */
describe("voice agent token expiry", () => {
  it("defaults to the endpoint's own maximum", () => {
    expect(DEFAULT_EXPIRY_SEC).toBe(MAX_EXPIRY_SEC);
    expect(clampVoiceAgentExpiry(null)).toBe(600);
  });

  it("clamps a request longer than the endpoint allows", () => {
    // 3600 was the original value and is rejected outright by the API.
    expect(clampVoiceAgentExpiry("3600")).toBe(600);
    expect(clampVoiceAgentExpiry("86400")).toBe(600);
  });

  it("clamps a request below the floor", () => {
    expect(clampVoiceAgentExpiry("1")).toBe(60);
    expect(clampVoiceAgentExpiry("0")).toBe(60);
    expect(clampVoiceAgentExpiry("-5")).toBe(60);
  });

  it("passes a legal value through unchanged", () => {
    expect(clampVoiceAgentExpiry("600")).toBe(600);
    expect(clampVoiceAgentExpiry("300")).toBe(300);
    expect(clampVoiceAgentExpiry("60")).toBe(60);
  });

  it("falls back to the default on input that parses to no number", () => {
    for (const junk of ["", "abc", "NaN", "null", "undefined"]) {
      expect(clampVoiceAgentExpiry(junk)).toBe(600);
    }
  });

  it("treats a leading-number string as that number, not as junk", () => {
    // `parseInt` stops at the first non-digit, so "1e999" is 1 and "12;drop"
    // is 12. Both land on the floor, which is a legal value the endpoint
    // accepts, safer than echoing an unparseable value into the query.
    expect(clampVoiceAgentExpiry("1e999")).toBe(60);
    expect(clampVoiceAgentExpiry("12;drop")).toBe(60);
    expect(clampVoiceAgentExpiry("600abc")).toBe(600);
  });

  it("never exceeds the ceiling under any input", () => {
    for (const v of ["1", "60", "599", "600", "601", "3600", "999999999"]) {
      expect(clampVoiceAgentExpiry(v)).toBeLessThanOrEqual(MAX_EXPIRY_SEC);
      expect(clampVoiceAgentExpiry(v)).toBeGreaterThanOrEqual(60);
    }
  });
});
