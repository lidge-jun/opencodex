/**
 * OCX-11 at the subagent model fallback (src/codex/subagent-model-fallback.ts): refused, a spawn
 * keeps its model and the request answers fallback_refused without contacting the fallback model;
 * allowed, the rewrite is unchanged.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  applySubagentModelFallback,
  noteSubagentModelFailure,
  resetSubagentModelFallbackStateForTests,
} from "../../src/codex/subagent-model-fallback";
import { handleResponses } from "../../src/server/responses";
import { clearFallbackEventsForTests } from "../../src/routing/fallback-policy";
import type { OcxConfig } from "../../src/types";
import type { OcxFallbackConfig } from "../../src/types/fallback";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const originalFetch = globalThis.fetch;
const SPAWN = { "x-openai-subagent": "collab_spawn" };
let home: TempHome;
let releaseSpendHome: (() => void) | undefined;

beforeEach(() => {
  home = createTempHome("ocx-subagent-fallback-off-");
  releaseSpendHome = acquireOwnedSpendHome();
  resetSubagentModelFallbackStateForTests();
  clearFallbackEventsForTests();
});
afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = originalFetch;
  resetSubagentModelFallbackStateForTests();
  clearFallbackEventsForTests();
  home.remove();
});

const chat = (host: string) => ({ adapter: "openai-chat", apiKey: "test", baseUrl: "https://" + host + "/v1" });

function cfg(chain: string[], fallback?: OcxFallbackConfig): OcxConfig {
  return {
    port: 10100,
    providers: { alpha: chat("alpha.example"), beta: chat("beta.example") },
    defaultProvider: "alpha",
    subagentModelFallback: chain,
    ...(fallback ? { fallback } : {}),
  } as unknown as OcxConfig;
}

function spawnParsed() {
  return { modelId: "alpha/big", options: {}, context: { messages: [] }, _rawBody: { model: "alpha/big" } };
}

describe("subagent model fallback with fallback off", () => {
  test("allowed: an exhausted primary is rewritten to the next model as before", () => {
    const config = cfg(["beta/other"]);
    noteSubagentModelFailure("alpha/big", "quota exhausted", config, null);
    const parsed = spawnParsed();
    expect(applySubagentModelFallback(parsed as never, new Headers(SPAWN), config)?.to).toBe("beta/other");
    expect(parsed.modelId).toBe("beta/other");
  });

  test("provider fallback off: the spawn keeps its model and carries the refusal", async () => {
    const config = cfg(["beta/other"], { provider: false });
    noteSubagentModelFailure("alpha/big", "quota exhausted", config, null);
    const parsed = spawnParsed();
    const result = applySubagentModelFallback(parsed as never, new Headers(SPAWN), config);
    expect(parsed.modelId).toBe("alpha/big");
    expect(result?.to).toBe("alpha/big");
    expect(result?.refusal?.status).toBe(503);
    const body = await result!.refusal!.json() as { error: { fallback: Record<string, string> } };
    expect(body.error.fallback).toMatchObject({ kind: "provider", from: "alpha/big", to: "beta/other", trigger: "unavailable" });
  });

  test("model fallback off refuses a same-provider rewrite; provider off alone does not", () => {
    const sameProvider = ["alpha/small"];
    const off = cfg(sameProvider, { model: false });
    noteSubagentModelFailure("alpha/big", "quota exhausted", off, null);
    expect(applySubagentModelFallback(spawnParsed() as never, new Headers(SPAWN), off)?.refusal).toBeDefined();
    const providerOff = cfg(sameProvider, { provider: false });
    expect(applySubagentModelFallback(spawnParsed() as never, new Headers(SPAWN), providerOff)?.to).toBe("alpha/small");
  });

  test("end to end: the spawn answers fallback_refused and the fallback model is never contacted", async () => {
    const config = cfg(["beta/other"], { provider: false });
    noteSubagentModelFailure("alpha/big", "quota exhausted", config, null);
    const hosts: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      hosts.push(new URL(input instanceof Request ? input.url : String(input)).host);
      return Response.json({ error: { message: "unexpected send" } }, { status: 500 });
    }) as typeof fetch;
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", ...SPAWN },
      body: JSON.stringify({ model: "alpha/big", stream: false, input: "hello" }),
    }), config, { model: "", provider: "" });
    expect(response.status).toBe(503);
    expect(response.headers.get("x-opencodex-fallback")).toBe("refused");
    expect(hosts).toEqual([]);
  });
});
