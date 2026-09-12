import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { handleResponses } from "../../src/server/responses/core";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

// Provider-opted visible thinking (showThinkingSummary). parseRequest hides thinking whenever the
// client omits `reasoning.summary`, which is the Codex default, so genuine user-facing reasoning —
// Gemini `thought` parts on the Cloud Code Assist wire — would otherwise reach the client only as a
// hidden replay envelope. A provider opts in; an explicit client `reasoning.summary: "none"` still
// wins and keeps it hidden.
//
// The assertions deliberately do NOT pin which channel carries the text. That belongs to the
// bridge, not to this flag: today raw reasoning rides the summary channel, and #4301 moves it to
// the content channel (the native gpt-oss shape, where the desktop band shows the generic
// placeholder and the CLI gates raw display behind `show_raw_agent_reasoning`). Pinning a channel
// here would assert the opposite of whichever behaviour is current, so these tests pin what the
// flag actually owns: visible reasoning versus the hidden envelope. The companion request-side half
// — asking Cloud Code Assist for `includeThoughts` across the Gemini/non-Gemini wire families — is
// pinned in tests/adapters/google/google-adapter.test.ts.

const THOUGHT = "cca-think";

function ccaUpstream(): Response {
  return Response.json({
    response: {
      candidates: [{
        content: { parts: [{ thought: true, text: THOUGHT }, { text: "OK" }] },
        finishReason: "STOP",
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15, thoughtsTokenCount: 3 },
    },
  });
}

/** Whether the thought text is visible on whichever channel the bridge assigns it to. */
function reasoningIsVisible(text: string): boolean {
  return text.includes(`"summary":[{"type":"summary_text","text":"${THOUGHT}"}]`)
    || text.includes(`"content":[{"type":"reasoning_text","text":"${THOUGHT}"}]`);
}

async function runCcaTurn(options: {
  showThinkingSummary?: boolean;
  reasoning?: Record<string, unknown>;
} = {}): Promise<{ text: string; upstream: Array<{ url: string; body: string }> }> {
  const home = mkdtempSync(join(tmpdir(), "ocx-show-thinking-"));
  const prevHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  writeFileSync(join(home, "auth.json"), JSON.stringify({
    "google-antigravity": {
      activeAccountId: "active",
      accounts: [{
        id: "active",
        credential: {
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 3_600_000,
          projectId: "project-id",
        },
      }],
    },
  }));
  // Simulate a saved provider row written before the registry learned the flag: the routed request
  // path backfills it from the registry entry (enrichProviderFromRegistry never runs there), while an
  // explicit `false` still wins.
  const seed = {
    ...providerConfigSeed(getProviderRegistryEntry("google-antigravity")!),
    liveModels: false,
    models: ["gemini-3.8-flash"],
    ...(options.showThinkingSummary === undefined ? {} : { showThinkingSummary: options.showThinkingSummary }),
  } as OcxProviderConfig;
  const upstream: Array<{ url: string; body: string }> = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    upstream.push({ url: String(input), body: String(init?.body ?? "") });
    return ccaUpstream();
  }) as typeof fetch;
  try {
    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "google-antigravity/gemini-3.8-flash",
          input: "ping",
          stream: false,
          reasoning: { effort: "low", ...(options.reasoning ?? {}) },
        }),
      }),
      { providers: { "google-antigravity": seed } } as unknown as OcxConfig,
      { model: "", provider: "" },
      { abortSignal: AbortSignal.timeout(10_000) },
    );
    return { text: await response.text(), upstream };
  } finally {
    globalThis.fetch = prevFetch;
    if (prevHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
}

describe("showThinkingSummary provider option", () => {
  test("omitted client summary still surfaces CCA thinking as visible reasoning", async () => {
    const { text, upstream } = await runCcaTurn();
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.url).toContain("v1internal:generateContent");
    // Request-side half: Cloud Code Assist reports `thoughtsTokenCount` either way but sends no
    // `thought` text at all unless the request opts in, so the flag has to reach the wire.
    expect(upstream[0]!.body).toContain('"includeThoughts":true');
    expect(reasoningIsVisible(text)).toBe(true);
    expect(text).toContain("OK");
    // The hidden envelope is exactly what this flag takes the turn out of.
    expect(text).not.toContain("encrypted_content");
  });

  test("an explicit client summary none keeps thinking in the hidden envelope", async () => {
    const { text, upstream } = await runCcaTurn({ reasoning: { summary: "none" } });
    expect(reasoningIsVisible(text)).toBe(false);
    expect(text).toContain("encrypted_content");
    // ...and the turn does not pay for text nobody will render.
    expect(upstream[0]!.body).not.toContain("includeThoughts");
  });

  test("an explicit false opts the provider back out", async () => {
    const { text, upstream } = await runCcaTurn({ showThinkingSummary: false });
    expect(reasoningIsVisible(text)).toBe(false);
    expect(text).toContain("encrypted_content");
    expect(upstream[0]!.body).not.toContain("includeThoughts");
  });

  test("google-antigravity preset opts in, other providers stay untouched", () => {
    expect(providerConfigSeed(getProviderRegistryEntry("google-antigravity")!).showThinkingSummary).toBe(true);
    expect(providerConfigSeed(getProviderRegistryEntry("deepseek")!).showThinkingSummary).toBeUndefined();
  });
});
