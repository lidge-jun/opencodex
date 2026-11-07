import { expect, spyOn, test } from "bun:test";
import * as wireModel from "../../src/providers/quota/passive-wire-model";
import { routedProviderConfig } from "../../src/providers/routed-config";
import { markPassiveKeyTransparent } from "../../src/lib/passive-key-fetch-proof";
import * as observations from "../../src/providers/passive-key-observation";
const { getPassiveKeyLimits, listPassiveKeyLimits, passiveKeyPhysicalFetch } = observations;
import type { OcxConfig } from "../../src/types";
import { registerDecisionQuotaSink, type DecisionQuotaSink } from "../../src/lib/decision-quota-sink";
import { saveConfig } from "../../src/config";
import { setProviderApiKeyPaused } from "../../src/providers/api-key-pause";
import { resolveProviderApiKey, resolveProviderApiKeyPassively, resolveProviderApiKeyQuietly, setProviderKeychainEntryFactoryForTests, invalidateResolvedProviderKeyCache } from "../../src/providers/api-key-resolve";
import { addProviderApiKey, apiKeyPoolEntryId, removeProviderApiKey } from "../../src/providers/api-keys";
import * as decision from "../../src/providers/quota-decision-snapshot";

function fixture(name: string): OcxConfig {
  return { port: 0, defaultProvider: name, providers: { [name]: { adapter: "openai-chat", authMode: "key",
    baseUrl: "https://api.groq.com/openai/v1", apiKey: "synthetic-key", models: ["model"] } } };
}
const init = { method: "POST", headers: { authorization: "Bearer synthetic-key" }, body: JSON.stringify({ model: "model" }) };
const response = () => new Response(null, { headers: { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "5" } });
const trusted = (fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => markPassiveKeyTransparent(fetcher as typeof globalThis.fetch);

test("ineligible destinations and credentials never invoke the wire model parser", async () => {
  const config = fixture("parser-gate");
  let sends = 0;
  const send = passiveKeyPhysicalFetch(trusted(async (_input, request) => {
    sends++;
    expect(request?.body).toBe(init.body);
    return response();
  }), config, "parser-gate", routedProviderConfig("parser-gate", config.providers["parser-gate"]!));
  const parser = spyOn(wireModel, "extractPassiveWireModel");
  try {
    const target = "https://api.groq.com/openai/v1/chat/completions";
    const withUserInfo = new URL(target);
    withUserInfo.username = "fixture";
    for (const [url, headers] of [
      ["https://unsupported.example/v1/chat/completions", init.headers],
      ["https://api.x.ai/v1/chat/completions", init.headers],
      ["http://api.groq.com/openai/v1/chat/completions", init.headers],
      ["https://api.groq.com:8443/openai/v1/chat/completions", init.headers],
      [withUserInfo.href, init.headers],
      ["https://api.groq.com/openai/v1/models", init.headers],
      [`${target}?query=1`, init.headers],
      [`${target}#fragment`, init.headers],
      [target, { authorization: "Bearer wrong-key" }],
      [target, { ...init.headers, "api-key": "other" }],
      [target, { ...init.headers, "x-api-key": "other" }],
    ] as const) {
      await send(url, { ...init, headers });
      expect(parser).not.toHaveBeenCalled();
    }
    await send(target, init);
    expect(parser).toHaveBeenCalledTimes(1);
    expect(sends).toBe(12);
    expect(getPassiveKeyLimits(config, "parser-gate", "model")).toMatchObject([{ remaining: 5 }]);
  } finally { parser.mockRestore(); observations.clearPassiveKeyLimits("parser-gate"); }
});

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

test("a large request with model after its input still retains the wire identity", async () => {
  const config = fixture("large-model-last");
  const send = passiveKeyPhysicalFetch(trusted(async () => response()), config, "large-model-last", routedProviderConfig("large-model-last", config.providers["large-model-last"]!));
  await send("https://api.groq.com/openai/v1/chat/completions", { ...init, body: JSON.stringify({ messages: [{ content: "x".repeat(128000) }], model: "model" }) });
  expect(getPassiveKeyLimits(config, "large-model-last", "model")).toMatchObject([{ remaining: 5 }]);
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

test("pause and unpause retire the prior key incarnation, including its in-flight send", async () => {
  const config = fixture("pause-incarnation");
  config.providers["pause-incarnation"]!.apiKeyPool = [{ id: "one", key: "synthetic-key" }];
  saveConfig(config);
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  let count = 0;
  const send = passiveKeyPhysicalFetch(trusted(async () => { if (++count === 2) await wait; return response(); }), config, "pause-incarnation", routedProviderConfig("pause-incarnation", config.providers["pause-incarnation"]!));
  await send("https://api.groq.com/openai/v1/chat/completions", init);
  const pending = send("https://api.groq.com/openai/v1/chat/completions", init);
  expect(setProviderApiKeyPaused(config, "pause-incarnation", "one", true)).toBe(true);
  expect(setProviderApiKeyPaused(config, "pause-incarnation", "one", false)).toBe(true);
  release();
  await pending;
  expect(listPassiveKeyLimits(config)).toEqual([]);
});

test.each(["pause", "add", "add-new", "remove-readd"] as const)("%s retires only the affected key's cached and pending observations", async operation => {
  observations.clearPassiveKeyLimits();
  const name = `key-scope-${operation}`;
  const config = fixture(name);
  const first = "synthetic-key", sibling = "synthetic-sibling";
  const firstId = apiKeyPoolEntryId(first), siblingId = apiKeyPoolEntryId(sibling);
  config.providers[name]!.apiKeyPool = [{ id: firstId, key: first }, { id: siblingId, key: sibling }];
  config.providers.other = { ...config.providers[name]!, apiKey: first, apiKeyPool: [{ id: firstId, key: first }] };
  saveConfig(config);
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const makeSend = (providerName: string, key: string, pending: boolean) => {
    const provider = { ...config.providers[providerName]!, apiKey: key };
    return passiveKeyPhysicalFetch(trusted(async () => { if (pending) await wait; return response(); }), config, providerName, routedProviderConfig(providerName, provider));
  };
  const send = (providerName: string, key: string, model: string, pending = false) => makeSend(providerName, key, pending)(
    "https://api.groq.com/openai/v1/chat/completions",
    { ...init, headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ model }) },
  );
  await Promise.all([send(name, first, "cached"), send(name, sibling, "cached"), send("other", first, "cached")]);
  expect(listPassiveKeyLimits(config)).toHaveLength(3);
  const pending = [send(name, first, "pending", true), send(name, sibling, "pending", true), send("other", first, "pending", true)];
  if (operation === "pause") {
    expect(setProviderApiKeyPaused(config, name, firstId, true)).toBe(true);
    expect(setProviderApiKeyPaused(config, name, firstId, false)).toBe(true);
  } else if (operation === "add") {
    expect(addProviderApiKey(config, name, first)).toEqual({ id: firstId });
  } else if (operation === "add-new") {
    expect(addProviderApiKey(config, name, "synthetic-new")).toEqual({ id: apiKeyPoolEntryId("synthetic-new") });
  } else {
    expect(removeProviderApiKey(config, name, firstId)).toBe(true);
    expect(addProviderApiKey(config, name, first)).toEqual({ id: firstId });
  }
  release();
  await Promise.all(pending);
  const rows = listPassiveKeyLimits(config).map(({ provider, keyId, model }) => `${provider}/${keyId}/${model}`).sort();
  const expected = [`${name}/${siblingId}/cached`, `${name}/${siblingId}/pending`, `other/${firstId}/cached`, `other/${firstId}/pending`];
  if (operation === "add-new") expected.push(`${name}/${firstId}/cached`, `${name}/${firstId}/pending`);
  expect(rows).toEqual(expected.sort());
  observations.clearPassiveKeyLimits();
});

test.each(["get", "list", "send"] as const)("passive %s does not observe or invalidate decision credentials after an env replacement", async operation => {
  const name = `passive-env-${operation}`;
  const config = fixture(name);
  const provider = config.providers[name]!;
  provider.apiKey = "${OCX_TEST_PASSIVE_KEY}";
  process.env.OCX_TEST_PASSIVE_KEY = "synthetic-key";
  let observed = 0, invalidated = 0;
  const detach = registerDecisionQuotaSink({
    observeKeyCredential: (reference, value) => { observed++; decision.observeDecisionKeyCredential(reference, value); },
    invalidateKeyQuotas: () => { invalidated++; decision.invalidateDecisionKeyQuotas(); },
  } as DecisionQuotaSink);
  try {
    const routed = routedProviderConfig(name, provider);
    const send = passiveKeyPhysicalFetch(trusted(async () => response()), config, name, routed);
    await send("https://api.groq.com/openai/v1/chat/completions", init);
    expect(getPassiveKeyLimits(config, name, "model")).toHaveLength(1);
    expect(listPassiveKeyLimits(config)).toHaveLength(1);
    const windows = [{ window: "5h" as const, percent: 25, observedAt: Date.now() }];
    decision.publishDecisionKeyQuota(name, provider, windows);
    expect(decision.readLoadedDecisionKeyQuota(name, provider)).toEqual(windows);
    const before = { observed, invalidated };
    process.env.OCX_TEST_PASSIVE_KEY = "replacement-synthetic-key";
    if (operation === "get") expect(getPassiveKeyLimits(config, name, "model")).toEqual([]);
    if (operation === "list") expect(listPassiveKeyLimits(config)).toEqual([]);
    if (operation === "send") {
      await send("https://api.groq.com/openai/v1/chat/completions", init);
      expect(listPassiveKeyLimits(config)).toEqual([]);
    }
    expect({ observed, invalidated }).toEqual(before);
    expect(decision.readLoadedDecisionKeyQuota(name, provider)).toEqual(windows);
    resolveProviderApiKey(provider.apiKey);
    expect(observed).toBe(before.observed + 1);
    expect(decision.readLoadedDecisionKeyQuota(name, provider)).toBeUndefined();
  } finally {
    detach();
    delete process.env.OCX_TEST_PASSIVE_KEY;
    observations.clearPassiveKeyLimits();
  }
});

test("keychain replacement retires passive ownership while normal credential reads retain decision invalidation", async () => {
  const config = fixture("passive-keychain");
  const provider = config.providers["passive-keychain"]!;
  provider.apiKey = "keychain:passive-keychain";
  let stored = "synthetic-key";
  setProviderKeychainEntryFactoryForTests(() => ({ getPassword: () => stored, setPassword: value => { stored = value; }, deletePassword: () => false }));
  let observed = 0, invalidated = 0;
  const detach = registerDecisionQuotaSink({
    observeKeyCredential: (reference, value) => { observed++; decision.observeDecisionKeyCredential(reference, value); },
    invalidateKeyQuotas: () => { invalidated++; decision.invalidateDecisionKeyQuotas(); },
  } as DecisionQuotaSink);
  try {
    const routed = routedProviderConfig("passive-keychain", provider);
    const send = passiveKeyPhysicalFetch(trusted(async () => response()), config, "passive-keychain", routed);
    await send("https://api.groq.com/openai/v1/chat/completions", init);
    expect(getPassiveKeyLimits(config, "passive-keychain", "model")).toHaveLength(1);
    stored = "replacement-synthetic-key";
    invalidateResolvedProviderKeyCache();
    const windows = [{ window: "5h" as const, percent: 25, observedAt: Date.now() }];
    decision.publishDecisionKeyQuota("passive-keychain", provider, windows);
    const before = { observed, invalidated };
    expect(getPassiveKeyLimits(config, "passive-keychain", "model")).toEqual([]);
    expect(listPassiveKeyLimits(config)).toEqual([]);
    await send("https://api.groq.com/openai/v1/chat/completions", init);
    expect({ observed, invalidated }).toEqual(before);
    expect(decision.readLoadedDecisionKeyQuota("passive-keychain", provider)).toEqual(windows);
    resolveProviderApiKey(provider.apiKey);
    expect(decision.readLoadedDecisionKeyQuota("passive-keychain", provider)).toBeUndefined();
  } finally {
    detach();
    setProviderKeychainEntryFactoryForTests(null);
    observations.clearPassiveKeyLimits();
  }
});

test("a passive projection cannot seed routing's keychain cache", () => {
  const config = fixture("unseen-keychain");
  const provider = config.providers["unseen-keychain"]!;
  provider.apiKey = "keychain:unseen-keychain";
  let stored: string | null = "first-synthetic-key";
  setProviderKeychainEntryFactoryForTests(() => ({ getPassword: () => stored, setPassword: value => { stored = value; }, deletePassword: () => { stored = null; return true; } }));
  let observed = 0, invalidated = 0;
  const detach = registerDecisionQuotaSink({
    observeKeyCredential: () => { observed++; }, invalidateKeyQuotas: () => { invalidated++; },
  } as DecisionQuotaSink);
  try {
    expect(listPassiveKeyLimits(config)).toEqual([]);
    expect({ observed, invalidated }).toEqual({ observed: 0, invalidated: 0 });
    stored = "second-synthetic-key";
    expect(routedProviderConfig("unseen-keychain", provider).apiKey).toBe("second-synthetic-key");
    expect({ observed, invalidated }).toEqual({ observed: 1, invalidated: 0 });
    stored = null;
    expect(resolveProviderApiKeyPassively(provider.apiKey)).toBeUndefined();
    expect({ observed, invalidated }).toEqual({ observed: 1, invalidated: 0 });
    expect(resolveProviderApiKey(provider.apiKey)).toBe("second-synthetic-key");
  } finally {
    detach();
    setProviderKeychainEntryFactoryForTests(null);
    observations.clearPassiveKeyLimits();
  }
});

test("passive keychain reads leave an existing normal or quiet resolver cache intact", () => {
  let stored: string | null = "cached-synthetic-key";
  setProviderKeychainEntryFactoryForTests(() => ({ getPassword: () => stored, setPassword: value => { stored = value; }, deletePassword: () => { stored = null; return true; } }));
  try {
    expect(resolveProviderApiKeyQuietly("keychain:quiet-cache")).toBe("cached-synthetic-key");
    stored = "current-synthetic-key";
    expect(resolveProviderApiKeyPassively("keychain:quiet-cache")).toBe("current-synthetic-key");
    expect(resolveProviderApiKey("keychain:quiet-cache")).toBe("cached-synthetic-key");
    expect(resolveProviderApiKeyQuietly("keychain:quiet-cache")).toBe("cached-synthetic-key");
    invalidateResolvedProviderKeyCache();
    expect(resolveProviderApiKey("keychain:quiet-cache")).toBe("current-synthetic-key");
  } finally {
    setProviderKeychainEntryFactoryForTests(null);
  }
});

test("an env key replaced during a send cannot publish passive limits or change decision evidence", async () => {
  const name = "passive-env-in-flight";
  const config = fixture(name);
  const provider = config.providers[name]!;
  provider.apiKey = "${OCX_TEST_PASSIVE_IN_FLIGHT}";
  process.env.OCX_TEST_PASSIVE_IN_FLIGHT = "synthetic-key";
  let observed = 0;
  const detach = registerDecisionQuotaSink({
    observeKeyCredential: (reference, value) => { observed++; decision.observeDecisionKeyCredential(reference, value); },
    invalidateKeyQuotas: decision.invalidateDecisionKeyQuotas,
  } as DecisionQuotaSink);
  try {
    const routed = routedProviderConfig(name, provider);
    const windows = [{ window: "5h" as const, percent: 25, observedAt: Date.now() }];
    decision.publishDecisionKeyQuota(name, provider, windows);
    const before = observed;
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const send = passiveKeyPhysicalFetch(trusted(async () => { await wait; return response(); }), config, name, routed);
    const pending = send("https://api.groq.com/openai/v1/chat/completions", init);
    delete process.env.OCX_TEST_PASSIVE_IN_FLIGHT;
    release();
    await pending;
    expect(listPassiveKeyLimits(config)).toEqual([]);
    expect(observed).toBe(before);
    expect(decision.readLoadedDecisionKeyQuota(name, provider)).toEqual(windows);
    resolveProviderApiKey(provider.apiKey);
    expect(decision.readLoadedDecisionKeyQuota(name, provider)).toBeUndefined();
  } finally {
    detach();
    delete process.env.OCX_TEST_PASSIVE_IN_FLIGHT;
    observations.clearPassiveKeyLimits();
  }
});
