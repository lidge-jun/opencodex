import { describe, expect, test } from "bun:test";
import { runWebSearch as runOpenAiWebSearch } from "../../src/web-search/executor";
import { listOpenAiForwardSidecarCandidates } from "../../src/providers/openai-sidecar";
import type { OcxConfig } from "../../src/types";

function testConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "routed",
    providers: {},
    ...overrides,
  };
}

describe("web-search sidecar 429 replays", () => {
  function sidecarProvider() {
    const cfg = testConfig({
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
      },
    });
    return listOpenAiForwardSidecarCandidates(cfg)[0]!.provider;
  }

  function sseDone(): Response {
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  }

  function searchWith(fetchImpl: () => Promise<Response>) {
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    return runOpenAiWebSearch(
      "current docs",
      { type: "web_search" },
      sidecarProvider(),
      new Headers({ authorization: "Bearer selected-token" }),
      { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 30_000 },
    );
  }

  test("a burst 429 is replayed and the recovered answer is returned", async () => {
    let calls = 0;
    const outcome = await searchWith(async () => {
      calls += 1;
      if (calls === 1) return new Response("rate limited", { status: 429 });
      return sseDone();
    });
    expect(calls).toBe(2);
    expect(outcome.error).toBeUndefined();
  });

  test("a persistent 429 ends with the 429 after bounded attempts", async () => {
    let calls = 0;
    const outcome = await searchWith(async () => {
      calls += 1;
      return new Response("rate limited", { status: 429 });
    });
    expect(calls).toBe(3);
    expect(outcome.error).toContain("429");
  });

  test("a Retry-After past the ceiling ends with the 429 without parking", async () => {
    let calls = 0;
    const outcome = await searchWith(async () => {
      calls += 1;
      return new Response("slow down", { status: 429, headers: { "retry-after": "120" } });
    });
    expect(calls).toBe(1);
    expect(outcome.error).toContain("429");
  });
});
