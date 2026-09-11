import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { handleResponses } from "../../src/server/responses/core";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

// Provider-opted visible thinking (showThinkingSummary): a provider that serves
// genuine user-facing reasoning surfaces it on the summary channel even when the
// client omits reasoning.summary (the Codex default, which otherwise hides all
// thinking in replay-only envelopes). An explicit client summary of "none" still
// wins and keeps thinking hidden.

function shownSeed() {
  const seed = providerConfigSeed(getProviderRegistryEntry("deepseek")!);
  return { ...seed, apiKey: "sk-test", showThinkingSummary: true } as OcxProviderConfig;
}

function sseFrame(payload: unknown): string {
  return "data: " + JSON.stringify(payload) + "\n\n";
}

const SSE_UPSTREAM = [
  sseFrame({ type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } }),
  sseFrame({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", status: "in_progress", content: [], summary: [] } }),
  sseFrame({ type: "response.reasoning_text.delta", content_index: 0, delta: "think", item_id: "rs_1", output_index: 0 }),
  sseFrame({ type: "response.reasoning_text.done", content_index: 0, text: "think", item_id: "rs_1", output_index: 0 }),
  sseFrame({ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_1", status: "completed", content: [{ type: "reasoning_text", text: "think" }], summary: [] } }),
  sseFrame({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [{ type: "reasoning", id: "rs_1", status: "completed", content: [{ type: "reasoning_text", text: "think" }], summary: [] }] } }),
].join("");

async function runHandleResponses(body: Record<string, unknown>, seed: OcxProviderConfig) {
  const encoder = new TextEncoder();
  globalThis.fetch = (async () => new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(SSE_UPSTREAM));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )) as typeof fetch;
  const config = { providers: { deepseek: seed } } as unknown as OcxConfig;
  return handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    config,
    { model: "", provider: "" },
    { abortSignal: AbortSignal.timeout(5_000) },
  );
}

describe("showThinkingSummary provider option", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("omitted client summary still surfaces thinking on the summary channel", async () => {
    const response = await runHandleResponses(
      { model: "deepseek-v4-flash", input: "ping", stream: true },
      shownSeed(),
    );
    const text = await response.text();
    expect(text).toContain("response.reasoning_summary_text.delta");
    expect(text).toContain('"summary":[{"type":"summary_text","text":"think"}]');
  });

  test("explicit client summary none keeps thinking hidden", async () => {
    const response = await runHandleResponses(
      { model: "deepseek-v4-flash", input: "ping", stream: true, reasoning: { summary: "none" } },
      shownSeed(),
    );
    const text = await response.text();
    expect(text).not.toContain("response.reasoning_summary_text.delta");
    expect(text).toContain("response.reasoning_text.delta");
  });

  test("without the provider option, omitted summary stays hidden", async () => {
    const seed = { ...providerConfigSeed(getProviderRegistryEntry("deepseek")!), apiKey: "sk-test" } as OcxProviderConfig;
    const response = await runHandleResponses(
      { model: "deepseek-v4-flash", input: "ping", stream: true },
      seed,
    );
    const text = await response.text();
    expect(text).not.toContain("response.reasoning_summary_text.delta");
    expect(text).toContain("response.reasoning_text.delta");
  });

  test("google-antigravity preset opts in", () => {
    expect(providerConfigSeed(getProviderRegistryEntry("google-antigravity")!).showThinkingSummary).toBe(true);
    expect(providerConfigSeed(getProviderRegistryEntry("deepseek")!).showThinkingSummary).toBeUndefined();
  });

  test("CCA thought parts surface on the summary channel", async () => {
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
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(input));
      return Response.json({
        response: {
          candidates: [{
            content: { parts: [{ thought: true, text: "cca-think" }, { text: "OK" }] },
            finishReason: "STOP",
          }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15, thoughtsTokenCount: 3 },
        },
      });
    }) as typeof fetch;
    try {
      const seed = {
        ...providerConfigSeed(getProviderRegistryEntry("google-antigravity")!),
        liveModels: false,
        models: ["gemini-3.8-flash"],
      } as OcxProviderConfig;
      // Simulate a saved provider row written before the registry learned the flag:
      // the request path must backfill it from the registry entry (routedProviderConfig),
      // enrichProviderFromRegistry never runs there.
      delete (seed as Record<string, unknown>).showThinkingSummary;
      const config = { providers: { "google-antigravity": seed } } as unknown as OcxConfig;
      const response = await handleResponses(
        new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "google-antigravity/gemini-3.8-flash", input: "ping", stream: false, reasoning: { effort: "low" } }),
        }),
        config,
        { model: "", provider: "" },
        { abortSignal: AbortSignal.timeout(10_000) },
      );
      const text = await response.text();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain("v1internal:generateContent");
      expect(text).toContain('"summary":[{"type":"summary_text","text":"cca-think"}]');
      expect(text).toContain("OK");
    } finally {
      if (prevHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
