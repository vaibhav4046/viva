import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

/**
 * The mic path loads its AudioWorklet from the same origin
 * (/worklets/pcm16.js, see components/oral/mic.ts and lib/audio/stream.ts).
 * A blob: worker-src would only widen what injected script could start.
 */
describe("content security policy", () => {
  const csp = proxy(new NextRequest("http://localhost/oral")).headers.get("Content-Security-Policy") ?? "";
  const directive = (name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `));

  it("keeps worker-src to the same origin", () => {
    expect(directive("worker-src")).toBe("worker-src 'self'");
  });

  it("still allows the two AssemblyAI sockets and nothing else off origin", () => {
    expect(directive("connect-src")).toContain("wss://agents.assemblyai.com");
    expect(directive("connect-src")).toContain("wss://streaming.assemblyai.com");
  });
});
