import { expect, test } from "bun:test";
import { routedProviderConfig } from "../../src/providers/routed-config";
import { markPassiveKeyTransparent } from "../../src/lib/passive-key-fetch-proof";
import * as observations from "../../src/providers/passive-key-observation";
const { getPassiveKeyLimits, listPassiveKeyLimits, passiveKeyPhysicalFetch } = observations;
import type { OcxConfig } from "../../src/types";

function fixture(name: string): OcxConfig {
  return { port: 0, defaultProvider: name, providers: { [name]: { adapter: "openai-chat", authMode: "key",
    baseUrl: "https://api.groq.com/openai/v1", apiKey: "synthetic-key", models: ["model"] } } };
}
const init = { method: "POST", headers: { authorization: "Bearer synthetic-key" }, body: JSON.stringify({ model: "model" }) };
const response = () => new Response(null, { headers: { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "5" } });
const trusted = (fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => markPassiveKeyTransparent(fetcher as typeof globalThis.fetch);

test("a same-origin non-inference target cannot publish passive limits", async () => {
  const config = fixture("wrong-path");
  const send = passiveKeyPhysicalFetch(trusted(async () => response()), config, "wrong-path", routedProviderConfig("wrong-path", config.providers["wrong-path"]!));
  await send("https://api.groq.com/openai/v1/models", init);
  expect(getPassiveKeyLimits(config, "wrong-path", "model")).toEqual([]);
});

test("an opaque custom executor cannot assign its response to the configured key", async () => {
  const config = fixture("opaque-executor");
  const send = passiveKeyPhysicalFetch(async (_input, _init) => response(), config, "opaque-executor", routedProviderConfig("opaque-executor", config.providers["opaque-executor"]!));
  await send("https://api.groq.com/openai/v1/chat/completions", init);
  expect(getPassiveKeyLimits(config, "opaque-executor", "model")).toEqual([]);
});

test("changed wire auth and rewritten destinations cannot claim an account's reading", async () => {
  const config = fixture("rewritten");
  const send = passiveKeyPhysicalFetch(trusted(async () => response()), config, "rewritten", routedProviderConfig("rewritten", config.providers.rewritten!));
  await send("https://api.groq.com/openai/v1/chat/completions", { ...init, headers: { authorization: "Bearer other-key" } });
  await send("https://api.x.ai/v1/chat/completions", init);
  expect(listPassiveKeyLimits(config)).toEqual([]);
});

test("a key removed before the response cannot publish its observation", async () => {
  const config = fixture("removed");
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const send = passiveKeyPhysicalFetch(trusted(async () => { await wait; return response(); }), config, "removed", routedProviderConfig("removed", config.providers.removed!));
  const pending = send("https://api.groq.com/openai/v1/chat/completions", init);
  config.providers.removed!.apiKey = "replacement-synthetic-key";
  release();
  await pending;
  expect(listPassiveKeyLimits(config)).toEqual([]);
});

test("a later send cannot be overwritten by an older response", async () => {
  const config = fixture("ordering");
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const send = passiveKeyPhysicalFetch(trusted(async () => {
    calls++;
    if (calls === 1) { await wait; return new Response(null, { headers: { "x-ratelimit-remaining-requests": "80" } }); }
    return new Response(null, { headers: { "x-ratelimit-remaining-requests": "10" } });
  }), config, "ordering", routedProviderConfig("ordering", config.providers.ordering!));
  const older = send("https://api.groq.com/openai/v1/chat/completions", init);
  await send("https://api.groq.com/openai/v1/chat/completions", init);
  release();
  await older;
  expect(getPassiveKeyLimits(config, "ordering", "model")).toMatchObject([{ remaining: 10 }]);
});

test("clearing on key management retires old rows and pending responses", async () => {
  const config = fixture("cleared");
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  let count = 0;
  const send = passiveKeyPhysicalFetch(trusted(async () => { if (++count === 2) await wait; return response(); }), config, "cleared", routedProviderConfig("cleared", config.providers.cleared!));
  await send("https://api.groq.com/openai/v1/chat/completions", init);
  expect(getPassiveKeyLimits(config, "cleared", "model")).toHaveLength(1);
  const pending = send("https://api.groq.com/openai/v1/chat/completions", init);
  observations.clearPassiveKeyLimits();
  release();
  await pending;
  expect(getPassiveKeyLimits(config, "cleared", "model")).toEqual([]);
});

test("retiring one provider does not clear another provider's observation", async () => {
  const a = fixture("provider-a"), b = fixture("provider-b");
  for (const [name, config] of [["provider-a", a], ["provider-b", b]] as const) {
    const send = passiveKeyPhysicalFetch(trusted(async () => response()), config, name, routedProviderConfig(name, config.providers[name]!));
    await send("https://api.groq.com/openai/v1/chat/completions", init);
  }
  observations.clearPassiveKeyLimits("provider-a");
  expect(getPassiveKeyLimits(a, "provider-a", "model")).toEqual([]);
  expect(getPassiveKeyLimits(b, "provider-b", "model")).toMatchObject([{ remaining: 5 }]);
});
