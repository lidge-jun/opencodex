import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setFetchCursorUsableModelsForTests } from "../../../src/adapters/cursor/live-models";
import { fetchProviderModels } from "../../../src/codex/catalog/provider-fetch";
import { clearModelCache, providerCacheGenerations } from "../../../src/codex/model-cache";
import type { OcxProviderConfig } from "../../../src/types";

/**
 * The live GetUsableModels roster is plan-specific: it is an observation made
 * under one credential and must never be served to another, whether fresh,
 * stale, or through a failure cooldown. The scoped spelling and Max-Mode maps
 * (#5229) do not cover the cached roster itself; these cases pin the roster
 * cache to the credential fingerprint that produced it.
 */

const PROVIDER = "cursor-roster-scope-test";

beforeEach(() => {
  clearModelCache(PROVIDER);
  providerCacheGenerations.delete(PROVIDER);
});

afterEach(() => {
  setFetchCursorUsableModelsForTests(null);
  clearModelCache(PROVIDER);
  providerCacheGenerations.delete(PROVIDER);
});

const baseProvider = {
  adapter: "cursor",
  baseUrl: "https://cursor.roster-scope.test",
  authMode: "key",
  liveModels: true,
  models: ["gpt-5.5", "gpt-5.6-sol"],
} as OcxProviderConfig;

describe("cursor live roster account scoping", () => {
  test("a credential change cannot reuse the previous account's plan roster", async () => {
    const calls: string[] = [];
    setFetchCursorUsableModelsForTests(async (opts) => {
      calls.push(opts.apiKey);
      return { ok: true, models: [opts.apiKey === "acct-a-token" ? "gpt-5.5" : "gpt-5.6-sol"] };
    });

    const accountA = await fetchProviderModels(PROVIDER, { ...baseProvider, apiKey: "acct-a-token" }, 60_000);
    const accountB = await fetchProviderModels(PROVIDER, { ...baseProvider, apiKey: "acct-b-token" }, 60_000);

    expect(accountA.map((model) => model.id)).toEqual(["gpt-5.5"]);
    expect(accountB.map((model) => model.id)).toEqual(["gpt-5.6-sol"]);
    // B went live: serving A's fresh cached roster would have skipped the fetch.
    expect(calls).toEqual(["acct-a-token", "acct-b-token"]);
  });

  test("a failed discovery under one credential neither supplies nor suppresses the next", async () => {
    const calls: string[] = [];
    let fail = false;
    setFetchCursorUsableModelsForTests(async (opts) => {
      calls.push(opts.apiKey);
      if (fail) return { ok: false, error: "auth" as const };
      return { ok: true, models: [opts.apiKey === "acct-a-token" ? "gpt-5.5" : "gpt-5.6-sol"] };
    });

    // A caches its roster (ttl 0 keeps the fresh window closed so the failure
    // below actually reaches the network seam).
    await fetchProviderModels(PROVIDER, { ...baseProvider, apiKey: "acct-a-token" }, 0);
    // A's next discovery fails, starting the provider cooldown; A degrades to
    // its own stale roster.
    fail = true;
    const failedA = await fetchProviderModels(PROVIDER, { ...baseProvider, apiKey: "acct-a-token" }, 0);
    expect(failedA.map((model) => model.id)).toEqual(["gpt-5.5"]);
    // B must not read A's stale roster, and A's cooldown must not suppress B's
    // first discovery: with no roster of its own, B goes live.
    fail = false;
    const accountB = await fetchProviderModels(PROVIDER, { ...baseProvider, apiKey: "acct-b-token" }, 0);

    expect(accountB.map((model) => model.id)).toEqual(["gpt-5.6-sol"]);
    expect(calls).toEqual(["acct-a-token", "acct-a-token", "acct-b-token"]);
  });
});
