import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearEconomicState, setEconomicQuotaSnapshot, selectEconomicTarget } from "../src/combos/economy";
import type { OcxConfig, OcxProviderConfig } from "../src/types";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../src/combos";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const actualResolver = await import("../src/server/adapter-resolve");
const actualResolveAdapter = actualResolver.resolveAdapter;

let customFetchResponse: ((request: Request, context?: unknown) => Promise<Response>) | undefined;

mock.module("../src/server/adapter-resolve", () => ({
  ...actualResolver,
  resolveAdapter(provider: OcxProviderConfig, cacheRetention?: "none" | "short" | "long") {
    if (provider.adapter === "test-response") {
      const base = actualResolveAdapter({ ...provider, adapter: "openai-chat" }, cacheRetention);
      return {
        ...base,
        name: "test-response",
        async fetchResponse(request: Request) {
          if (!customFetchResponse) throw new Error("customFetchResponse not installed");
          return customFetchResponse(request);
        },
      };
    }
    return actualResolveAdapter(provider, cacheRetention);
  },
}));

const { handleResponses } = await import("../src/server/responses");
const { handleComboResponses } = await import("../src/server/responses/core");

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-econ-reservation-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-econ-res-"));
  process.env.OPENCODEX_HOME = testDir;
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearEconomicState();
  customFetchResponse = undefined;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearEconomicState();
});

function provider(url: string): OcxProviderConfig {
  return { adapter: "test-response", baseUrl: url, allowPrivateNetwork: true, authMode: "key", apiKey: "key" };
}

describe("economic reservation terminal failure", () => {
  test("reservation is released on non-retryable 400 so next request can use quota", async () => {
    const NOW = Date.now();
    const cfg: OcxConfig = {
      port: 0,
      defaultProvider: "cheap",
      providers: {
        cheap: provider("https://cheap.test/v1"),
        payg: provider("https://payg.test/v1"),
      },
      economicAllowances: {
        budget: {
          unit: "credits",
          capacity: 10,
          window: { kind: "balance" },
          source: "manual",
          rates: { inputPerMillion: 1 },
        },
      },
      combos: {
        bulk: {
          strategy: "economy",
          economy: { unknownQuota: "reject", maxMarginalUsd: 10 },
          targets: [
            { provider: "cheap", model: "m", allowances: ["budget"] },
            { provider: "payg", model: "m", pricing: { inputUsdPerMillion: 1 } },
          ],
        },
      },
    };
    setEconomicQuotaSnapshot("budget", { remaining: 1, updatedAt: NOW, source: "manual", confidence: "authoritative" });

    // First dispatch: cheap target fails with non-retryable 400 context_length_exceeded (stop)
    customFetchResponse = async (req) => {
      const body = JSON.parse(String(req.body)) as { model?: string };
      if (body.model === "m") {
        return Response.json({ error: { code: "context_length_exceeded", message: "too long" } }, { status: 400 });
      }
      return Response.json({ id: "x", object: "response", status: "completed", model: "m", output: [] });
    };

    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/bulk", input: "hello", max_output_tokens: 100 }),
    });
    const res = await handleResponses(req, cfg, { model: "", provider: "" }, {});
    expect(res.status).toBe(400);

    // Second selection should still be able to pick cheap if reservation was released.
    // If leaked, reserved 1 credit still counts, remaining 1 -1 =0, second request needs 1 credit -> post 0 -> still ok? Need to make consumption =1, remaining 1, reservation 1 => second would see 0 remaining => falls to PAYG if leaked.
    // Use estimate that consumes 1 credit: input 1M tokens with rate 1 per million
    const second = selectEconomicTarget(cfg, "bulk", { inputTokens: 1_000_000, outputTokens: 0, kind: "configured" }, NOW);
    expect(second.target?.provider).toBe("cheap");
  });

  test("reservation is released when child dispatch throws", async () => {
    const now = Date.now();
    const cfg: OcxConfig = {
      port: 0,
      defaultProvider: "cheap",
      providers: {
        cheap: provider("https://cheap.test/v1"),
        payg: provider("https://payg.test/v1"),
      },
      economicAllowances: {
        budget: {
          unit: "credits",
          capacity: 10,
          window: { kind: "balance" },
          source: "manual",
          rates: { inputPerMillion: 1 },
        },
      },
      combos: {
        bulk: {
          strategy: "economy",
          economy: { unknownQuota: "reject", maxMarginalUsd: 10 },
          targets: [
            { provider: "cheap", model: "m", allowances: ["budget"] },
            { provider: "payg", model: "m", pricing: { inputUsdPerMillion: 1 } },
          ],
        },
      },
    };
    setEconomicQuotaSnapshot("budget", { remaining: 1, updatedAt: now, source: "manual", confidence: "authoritative" });
    customFetchResponse = async () => Response.json({
      id: "response-1",
      object: "response",
      status: "completed",
      model: "m",
      output: [],
    });

    const rawBody = { model: "combo/bulk", input: "hello", max_output_tokens: 100 };
    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rawBody),
    });
    const throwingOptions = {} as Record<string, unknown>;
    Object.defineProperty(throwingOptions, "testThrow", {
      enumerable: true,
      get() { throw new Error("child option spread failed"); },
    });
    await expect(handleComboResponses(req, rawBody, "bulk", cfg, { model: "", provider: "" }, throwingOptions as never))
      .rejects.toThrow("child option spread failed");

    const second = selectEconomicTarget(cfg, "bulk", { inputTokens: 1_000_000, outputTokens: 0, kind: "configured" }, now);
    expect(second.target?.provider).toBe("cheap");
  });
});
