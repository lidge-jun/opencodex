import { afterEach, describe, expect, test } from "bun:test";
import {
  ADVISOR_INTERNAL_CAPABILITY_HEADER,
  internalCallCapability,
  isInternalCallCapability,
  setInternalCallCapabilityForTests,
} from "../../src/lib/local-internal-call-capability";
import { consultAdvisor } from "../../src/advisor/consult";
import { parseRequest } from "../../src/responses/parser";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

afterEach(() => {
  setInternalCallCapabilityForTests(null);
});

describe("internal-call capability — server-owned authority", () => {
  test("a forged literal header value is NOT internal authority", () => {
    // This is the spoof the fence must reject: any external caller can send it.
    expect(isInternalCallCapability("1")).toBe(false);
    expect(isInternalCallCapability("true")).toBe(false);
    expect(isInternalCallCapability("")).toBe(false);
    expect(isInternalCallCapability(null)).toBe(false);
    expect(isInternalCallCapability(undefined)).toBe(false);
  });

  test("a random or malformed token is NOT internal authority", () => {
    expect(isInternalCallCapability("Z".repeat(43))).toBe(false);
    expect(isInternalCallCapability("short")).toBe(false);
    expect(isInternalCallCapability("x".repeat(43))).toBe(false);
  });

  test("an unminted process capability rejects shaped input without minting", () => {
    setInternalCallCapabilityForTests(null);
    expect(isInternalCallCapability("Z".repeat(43))).toBe(false);
  });

  test("the process's own capability IS accepted, and the header name is stable", () => {
    expect(ADVISOR_INTERNAL_CAPABILITY_HEADER).toBe("x-opencodex-advisor-internal");
    expect(internalCallCapability()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isInternalCallCapability(internalCallCapability())).toBe(true);
  });

  test("a capability from an older process is worthless after a restart", () => {
    const mintedBeforeRestart = internalCallCapability();
    // A restart mints a fresh value; the captured one no longer matches.
    setInternalCallCapabilityForTests("A".repeat(43));
    expect(isInternalCallCapability(mintedBeforeRestart)).toBe(false);
    expect(isInternalCallCapability("A".repeat(43))).toBe(true);
  });
});

describe("internal-call capability — confidentiality", () => {
  test("the capability never rides the advisor payload or its request body", async () => {
    let seenBody = "";
    let seenHeaders: Record<string, string> = {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenBody = String(init?.body);
      seenHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return new Response(JSON.stringify({ choices: [{ message: { content: "advice" } }] }), {
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const parsed = parseRequest({ model: "m", stream: false, input: [{ role: "user", content: "task" }] });
      const result = await consultAdvisor(
        { parsed, workerIdentity: "w", advisorModel: "expert/model", reason: "manual" },
        {}, "max", 5_000, undefined, "http://advisor.test",
      );
      expect(result.ok).toBe(true);
      const capability = internalCallCapability();
      // It is presented as the fence value on the loopback request...
      expect(seenHeaders[ADVISOR_INTERNAL_CAPABILITY_HEADER]).toBe(capability);
      // ...and nowhere else: not in the prompt body, not as a second header.
      expect(seenBody).not.toContain(capability);
      for (const [name, value] of Object.entries(seenHeaders)) {
        if (name === ADVISOR_INTERNAL_CAPABILITY_HEADER) continue;
        expect(value).not.toContain(capability);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("an advisor failure message cannot leak the capability", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("upstream exploded", { status: 503 })) as typeof fetch;
    try {
      const parsed = parseRequest({ model: "m", stream: false, input: [{ role: "user", content: "task" }] });
      const result = await consultAdvisor(
        { parsed, workerIdentity: "w", advisorModel: "expert/model", reason: "manual" },
        {}, "max", 5_000, undefined, "http://advisor.test",
      );
      expect(result.ok).toBe(false);
      expect(String(result.error)).not.toContain(internalCallCapability());
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("internal-call capability — ingress contract", () => {
  test("the chat ingress judges the header by capability, never by a literal", () => {
    // Regression guard for the spoof that shipped: `header === "1"` handed internal authority to
    // any caller. The ingress must route through the server-owned capability helper.
    const source = readFileSync(repoPath("src", "server", "chat-completions.ts"), "utf8");
    expect(source).toContain("isInternalCallCapability(");
    expect(source).toContain("ADVISOR_INTERNAL_CAPABILITY_HEADER");
    expect(source).not.toContain('get("x-opencodex-advisor-internal")');
    expect(source).not.toMatch(/advisor-internal"\s*\)\s*===\s*"1"/);
  });

  test("the capability module keeps the value process-local (no config, disk, or log write)", () => {
    const source = readFileSync(repoPath("src", "lib", "local-internal-call-capability.ts"), "utf8");
    expect(source).toContain("randomBytes(32)");
    // No persistence or logging surfaces may appear in this module.
    for (const forbidden of ["writeFile", "console.", "JSON.stringify", "OcxConfig"]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
