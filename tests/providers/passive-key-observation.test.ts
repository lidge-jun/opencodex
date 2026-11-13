import { expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import * as wireModel from "../../src/providers/quota/passive-wire-model";
import { routedProviderConfig } from "../../src/providers/routed-config";
import { markPassiveKeyTransparent } from "../../src/lib/passive-key-fetch-proof";
import * as observations from "../../src/providers/passive-key-observation";
const { getPassiveKeyLimits, listPassiveKeyLimits, passiveKeyPhysicalFetch } = observations;
import type { OcxConfig } from "../../src/types";
import { registerDecisionQuotaSink, type DecisionQuotaSink } from "../../src/lib/decision-quota-sink";
import { loadConfig, saveConfig } from "../../src/config";
import { setProviderApiKeyPaused } from "../../src/providers/api-key-pause";
import { resolveProviderApiKey, resolveProviderApiKeyPassively, resolveProviderApiKeyQuietly, setProviderKeychainEntryFactoryForTests, invalidateResolvedProviderKeyCache } from "../../src/providers/api-key-resolve";
import { addProviderApiKey, apiKeyPoolEntryId, removeProviderApiKey } from "../../src/providers/api-keys";
import * as decision from "../../src/providers/quota-decision-snapshot";
import { storeProviderKeyInKeychain } from "../../src/providers/key-store";
import { providerKeychainEntry } from "../../src/providers/api-key-resolve";
import { MistralBudgetPacer, resolveMistralTransport } from "../../src/providers/mistral-transport";
import { getConfigDir } from "../../src/config/paths";
import { createHash } from "node:crypto";

const quotaId = (name: string, id: string) => createHash("sha256").update(JSON.stringify([getConfigDir(), name, id])).digest("hex");

function fixture(name: string): OcxConfig {
  return { port: 0, defaultProvider: name, providers: { [name]: { adapter: "openai-chat", authMode: "key",
    baseUrl: "https://api.groq.com/openai/v1", apiKey: "synthetic-key", models: ["model"] } } };
}
const init = { method: "POST", headers: { authorization: "Bearer synthetic-key" }, body: JSON.stringify({ model: "model" }) };
const response = () => new Response(null, { headers: { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "5" } });
const trusted = (fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => markPassiveKeyTransparent(fetcher as typeof globalThis.fetch);

test("Mistral pacing does not make an opaque executor trusted for passive limits", async () => {
  const name = "opaque-mistral", config = fixture(name), provider = config.providers[name]!;
  provider.baseUrl = "https://api.mistral.ai/v1";
  const routed = routedProviderConfig(name, provider);
  let sends = 0;
  const opaque = (async () => { sends++; return new Response(null, { headers: { "x-ratelimit-remaining-tokens-minute": "9" } }); }) as typeof fetch;
  const transport = resolveMistralTransport({ ...routed, fetch: opaque });
  try {
    await passiveKeyPhysicalFetch(transport.fetch!, config, name, routed)("https://api.mistral.ai/v1/chat/completions", init);
    expect(sends).toBe(1);
    expect(getPassiveKeyLimits(config, name, "model")).toEqual([]);
  } finally { observations.clearPassiveKeyLimits(); }
});

test.each(["invalidate", "replace", "rewrite", "evict", "abort"] as const)("queued Mistral send respects %s before its physical reservation", async action => {
  const name = `queued-${action}`, config = fixture(name), provider = config.providers[name]!;
  provider.baseUrl = "https://api.mistral.ai/v1";
  provider.apiKeyPool = [{ id: "account", key: "synthetic-key" }];
  let now = 0, wake!: () => void, entered!: () => void, sends = 0;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { wake = resolve; });
  const pacer = new MistralBudgetPacer(() => now, async (_ms, signal) => {
    entered();
    await Promise.race([gate, new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
    now = 1001;
  });
  const base = trusted(async () => {
    sends++;
    return new Response(null, { headers: { "x-ratelimit-remaining-tokens-minute": sends === 1 ? "0" : sends === 2 ? "22" : "11",
      ...(sends === 1 ? { "retry-after": "1" } : {}) } });
  });
  const routed = routedProviderConfig(name, provider);
  const makeSend = (paced: boolean) => passiveKeyPhysicalFetch(resolveMistralTransport({ ...routed, fetch: base,
    requestPacing: { enabled: paced } }, pacer).fetch!, config, name, routed);
  const url = "https://api.mistral.ai/v1/chat/completions";
  const controller = new AbortController();
  try {
    await makeSend(true)(url, init);
    const headers = new Headers(init.headers);
    const queued = makeSend(true)(url, { ...init, headers, signal: controller.signal });
    const outcome = queued.then(() => "sent", () => "aborted");
    await waiting;
    if (action === "abort") {
      controller.abort();
      expect(await outcome).toBe("aborted");
      expect(sends).toBe(1);
      expect(getPassiveKeyLimits(config, name, "model")[1]?.remaining).toBe(0);
    } else {
      if (action === "invalidate") observations.clearPassiveKeyAccount(name, routed._apiKeyAttempt!.entryId ?? apiKeyPoolEntryId("synthetic-key"));
      else if (action === "replace") {
        provider.apiKey = "synthetic-replacement"; provider.apiKeyPool![0]!.key = "synthetic-replacement";
        observations.listPassiveKeyLimits(config);
        provider.apiKey = "synthetic-key"; provider.apiKeyPool![0]!.key = "synthetic-key";
      } else if (action === "rewrite") headers.set("authorization", "Bearer rewritten-key");
      else {
        for (let i = 0; i < 512; i++) {
          const other = `queue-eviction-${i}`;
          config.providers[other] = fixture(other).providers[other]!;
          await passiveKeyPhysicalFetch(trusted(async () => response()), config, other,
            routedProviderConfig(other, config.providers[other]!))("https://api.groq.com/openai/v1/chat/completions", init);
        }
      }
      await makeSend(false)(url, init);
      wake();
      expect(await outcome).toBe("sent");
      expect(sends).toBe(3);
      expect(getPassiveKeyLimits(config, name, "model")[1]?.remaining).toBe(22);
    }
  } finally { wake(); observations.clearPassiveKeyLimits(); }
});

test.each(["remove", "remove-readd", "add", "store"] as const)("unrelated %s preserves verified keychain cached and pending observations", async operation => {
  const name = `scoped-keychain-${operation}`, reference = `keychain:${name}/first`;
  const config = fixture(name), provider = config.providers[name]!;
  const otherKey = "synthetic-other", otherId = apiKeyPoolEntryId(otherKey);
  provider.apiKey = reference;
  provider.apiKeyPool = [{ id: "first", key: reference }, { id: otherId, key: otherKey }];
  config.providers.other = { ...provider, apiKey: "keychain:other/first", apiKeyPool: [{ id: "first", key: "keychain:other/first" }] };
  config.providers.store = { ...provider, apiKey: "synthetic-store", apiKeyPool: undefined };
  saveConfig(config);
  const secrets = new Map([[`${name}/first`, "synthetic-key"], ["other/first", "synthetic-key"]]);
  let reads = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  setProviderKeychainEntryFactoryForTests((_service, account) => ({
    getPassword: () => { reads++; return secrets.get(account) ?? null; },
    setPassword: value => { secrets.set(account, value); }, deletePassword: () => secrets.delete(account),
  }));
  try {
    const send = (owner: string, model: string, pending = false) => passiveKeyPhysicalFetch(
      trusted(async () => { if (pending) await gate; return response(); }), config, owner,
      routedProviderConfig(owner, config.providers[owner]!),
    )("https://api.groq.com/openai/v1/chat/completions", { ...init, body: JSON.stringify({ model }) });
    await Promise.all([send(name, "cached"), send("other", "cached")]);
    const pending = [send(name, "pending", true), send("other", "pending", true)];
    if (operation === "remove" || operation === "remove-readd") {
      expect(removeProviderApiKey(config, name, otherId)).toBe(true);
      if (operation === "remove-readd") expect(addProviderApiKey(config, name, otherKey)).toEqual({ id: otherId });
    } else if (operation === "add") {
      expect(addProviderApiKey(config, name, "synthetic-added")).toEqual({ id: apiKeyPoolEntryId("synthetic-added") });
    } else expect(storeProviderKeyInKeychain(config, "store")).toMatchObject({ ok: true });
    const afterMutation = reads;
    if (operation !== "add") {
      expect(listPassiveKeyLimits(config)).toEqual([]);
      expect(reads).toBe(afterMutation);
      expect(resolveProviderApiKey(reference)).toBe("synthetic-key");
      expect(listPassiveKeyLimits(config).map(row => row.provider)).toEqual([name]);
      expect(resolveProviderApiKey("keychain:other/first")).toBe("synthetic-key");
    }
    const afterRouting = reads;
    expect(listPassiveKeyLimits(config)).toHaveLength(2);
    release();
    await Promise.all(pending);
    expect(listPassiveKeyLimits(config).map(row => `${row.provider}/${row.model}`).sort()).toEqual([
      `${name}/cached`, `${name}/pending`, "other/cached", "other/pending",
    ].sort());
    expect(reads).toBe(afterRouting);
  } finally { release(); setProviderKeychainEntryFactoryForTests(null); observations.clearPassiveKeyLimits(); }
});

test("keychain write ABA fences the affected account but preserves its sibling", async () => {
  const name = "scoped-keychain-aba", config = fixture(name), provider = config.providers[name]!;
  const reference = `keychain:${name}/first`, sibling = `keychain:${name}/sibling`;
  provider.apiKey = reference;
  provider.apiKeyPool = [{ id: "first", key: reference }, { id: "sibling", key: sibling }];
  saveConfig(config);
  const secrets = new Map([[`${name}/first`, "synthetic-key"], [`${name}/sibling`, "synthetic-key"]]);
  let reads = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  setProviderKeychainEntryFactoryForTests((_service, account) => ({
    getPassword: () => { reads++; return secrets.get(account) ?? null; },
    setPassword: value => { secrets.set(account, value); }, deletePassword: () => secrets.delete(account),
  }));
  try {
    const send = (key: string, model: string, pending = false) => passiveKeyPhysicalFetch(
      trusted(async () => { if (pending) await gate; return response(); }), config, name,
      routedProviderConfig(name, { ...provider, apiKey: key }),
    )("https://api.groq.com/openai/v1/chat/completions", { ...init, body: JSON.stringify({ model }) });
    await Promise.all([send(reference, "cached"), send(sibling, "cached")]);
    const pending = [send(reference, "pending", true), send(sibling, "pending", true)];
    providerKeychainEntry(`${name}/first`).setPassword("synthetic-replacement");
    providerKeychainEntry(`${name}/first`).setPassword("synthetic-key");
    expect(removeProviderApiKey(config, name, "first")).toBe(true);
    expect(addProviderApiKey(config, name, reference)).toEqual({ id: apiKeyPoolEntryId(reference) });
    expect(resolveProviderApiKey(reference)).toBe("synthetic-key");
    expect(resolveProviderApiKey(sibling)).toBe("synthetic-key");
    const afterMutation = reads;
    release();
    await Promise.all(pending);
    expect(listPassiveKeyLimits(config).map(row => `${row.keyId}/${row.model}`).sort()).toEqual([`${quotaId(name, "sibling")}/cached`, `${quotaId(name, "sibling")}/pending`]);
    expect(reads).toBe(afterMutation);
  } finally { release(); setProviderKeychainEntryFactoryForTests(null); observations.clearPassiveKeyLimits(); }
});

test("a fresh routing read after an unrelated removal revokes a changed keychain credential", async () => {
  const name = "scoped-keychain-reread", config = fixture(name), provider = config.providers[name]!;
  const reference = `keychain:${name}/first`, other = "synthetic-other", otherId = apiKeyPoolEntryId(other);
  provider.apiKey = reference;
  provider.apiKeyPool = [{ id: "first", key: reference }, { id: otherId, key: other }];
  saveConfig(config);
  let stored = "synthetic-key", reads = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  setProviderKeychainEntryFactoryForTests(() => ({ getPassword: () => { reads++; return stored; }, setPassword: value => { stored = value; }, deletePassword: () => false }));
  try {
    const routed = routedProviderConfig(name, provider);
    const send = passiveKeyPhysicalFetch(trusted(async (_input, request) => { if (JSON.parse(String(request?.body)).model === "pending") await gate; return response(); }), config, name, routed);
    await send("https://api.groq.com/openai/v1/chat/completions", init);
    const pending = send("https://api.groq.com/openai/v1/chat/completions", { ...init, body: JSON.stringify({ model: "pending" }) });
    stored = "synthetic-replacement";
    expect(removeProviderApiKey(config, name, otherId)).toBe(true);
    expect(listPassiveKeyLimits(config)).toEqual([]);
    expect(resolveProviderApiKey(reference)).toBe("synthetic-replacement");
    const afterRouting = reads;
    expect(listPassiveKeyLimits(config)).toEqual([]);
    release();
    await pending;
    expect(listPassiveKeyLimits(config)).toEqual([]);
    expect(reads).toBe(afterRouting);
  } finally { release(); setProviderKeychainEntryFactoryForTests(null); observations.clearPassiveKeyLimits(); }
});

test.each(["same", "different", "missing", "empty", "error", "malformed"] as const)("unrelated removal withholds proof until a %s routing reread", async result => {
  const name = `reread-${result}`, config = fixture(name), provider = config.providers[name]!;
  const reference = `keychain:${name}/first`, other = "synthetic-other", otherId = apiKeyPoolEntryId(other);
  provider.apiKey = reference;
  provider.apiKeyPool = [{ id: "first", key: reference }, { id: otherId, key: other }];
  saveConfig(config);
  let stored: string | null = "synthetic-key", fail = false, reads = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  setProviderKeychainEntryFactoryForTests(() => ({ getPassword: () => { reads++; if (fail) throw new Error("unreadable"); return stored; }, setPassword: () => {}, deletePassword: () => false }));
  try {
    const routed = routedProviderConfig(name, provider);
    const send = passiveKeyPhysicalFetch(trusted(async (_input, request) => { if (JSON.parse(String(request?.body)).model === "pending") await gate; return response(); }), config, name, routed);
    await send("https://api.groq.com/openai/v1/chat/completions", init);
    const pending = send("https://api.groq.com/openai/v1/chat/completions", { ...init, body: JSON.stringify({ model: "pending" }) });
    stored = result === "same" ? "synthetic-key" : result === "different" ? "synthetic-replacement" : result === "empty" ? "  " : result === "malformed" ? '{"type":"service_account","private_key":"synthetic"}' : null;
    fail = result === "error";
    const beforeRemoval = reads;
    expect(resolveProviderApiKey(reference)).toBe("synthetic-key");
    expect(reads).toBe(beforeRemoval);
    expect(removeProviderApiKey(config, name, otherId)).toBe(true);
    expect(loadConfig().providers[name]?.apiKeyPool?.map(entry => entry.id)).toEqual(["first"]);
    const afterRemoval = reads;
    expect(listPassiveKeyLimits(config)).toEqual([]);
    expect(getPassiveKeyLimits(config, name, "model")).toEqual([]);
    release();
    await pending;
    expect(listPassiveKeyLimits(config)).toEqual([]);
    expect(reads).toBe(afterRemoval);
    if (result === "malformed") expect(() => resolveProviderApiKey(reference)).toThrow();
    else expect(resolveProviderApiKey(reference)).toBe(result === "same" ? "synthetic-key" : result === "different" ? "synthetic-replacement" : undefined);
    expect(reads).toBe(afterRemoval + 1);
    expect(listPassiveKeyLimits(config).map(row => row.model)).toEqual(result === "same" ? ["model"] : []);
    expect(reads).toBe(afterRemoval + 1);
  } finally { release(); setProviderKeychainEntryFactoryForTests(null); observations.clearPassiveKeyLimits(); }
});

test("keychain proof eviction fences cached and pending observations", async () => {
  const name = "proof-eviction", config = fixture(name), provider = config.providers[name]!;
  provider.apiKey = `keychain:${name}`;
  let reads = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  setProviderKeychainEntryFactoryForTests(() => ({ getPassword: () => { reads++; return "synthetic-key"; }, setPassword: () => {}, deletePassword: () => false }));
  try {
    const routed = routedProviderConfig(name, provider);
    const send = passiveKeyPhysicalFetch(trusted(async (_input, request) => { if (JSON.parse(String(request?.body)).model === "pending") await gate; return response(); }), config, name, routed);
    await send("https://api.groq.com/openai/v1/chat/completions", init);
    const pending = send("https://api.groq.com/openai/v1/chat/completions", { ...init, body: JSON.stringify({ model: "pending" }) });
    for (let i = 0; i < 512; i++) expect(resolveProviderApiKey(`keychain:evict/${i}`)).toBe("synthetic-key");
    const afterRouting = reads;
    expect(listPassiveKeyLimits(config)).toEqual([]);
    release(); await pending;
    expect(listPassiveKeyLimits(config)).toEqual([]);
    expect(reads).toBe(afterRouting);
  } finally { release(); setProviderKeychainEntryFactoryForTests(null); observations.clearPassiveKeyLimits(); }
});

test.each(["different", "missing", "empty", "error", "malformed"] as const)("a %s routing reread fences an old response across ABA", async result => {
  const name = `reread-aba-${result}`, config = fixture(name), provider = config.providers[name]!;
  const reference = `keychain:${name}/first`, otherId = apiKeyPoolEntryId("synthetic-other");
  provider.apiKey = reference;
  provider.apiKeyPool = [{ id: "first", key: reference }, { id: otherId, key: "synthetic-other" }];
  saveConfig(config);
  let stored: string | null = "synthetic-key", fail = false, reads = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  setProviderKeychainEntryFactoryForTests(() => ({ getPassword: () => { reads++; if (fail) throw new Error("unreadable"); return stored; }, setPassword: () => {}, deletePassword: () => false }));
  try {
    const routed = routedProviderConfig(name, provider);
    const send = passiveKeyPhysicalFetch(trusted(async () => { await gate; return response(); }), config, name, routed);
    const pending = send("https://api.groq.com/openai/v1/chat/completions", init);
    expect(removeProviderApiKey(config, name, otherId)).toBe(true);
    stored = result === "different" ? "synthetic-replacement" : result === "empty" ? "" : result === "malformed" ? '{"type":"service_account","private_key":"synthetic"}' : null;
    fail = result === "error";
    if (result === "malformed") expect(() => resolveProviderApiKey(reference)).toThrow();
    else expect(resolveProviderApiKey(reference)).toBe(result === "different" ? "synthetic-replacement" : undefined);
    stored = "synthetic-key"; fail = false;
    if (result === "different") invalidateResolvedProviderKeyCache({ preservePassiveKeychainProofs: true });
    expect(resolveProviderApiKey(reference)).toBe("synthetic-key");
    const afterRouting = reads;
    release(); await pending;
    expect(listPassiveKeyLimits(config)).toEqual([]);
    expect(reads).toBe(afterRouting);
  } finally { release(); setProviderKeychainEntryFactoryForTests(null); observations.clearPassiveKeyLimits(); }
});

test("an attempted keychain write that mutates then throws revokes only its own proof", async () => {
  const name = "scoped-keychain-write-failure", config = fixture(name), provider = config.providers[name]!;
  const first = `keychain:${name}/first`, sibling = `keychain:${name}/sibling`;
  provider.apiKey = first;
  provider.apiKeyPool = [{ id: "first", key: first }, { id: "sibling", key: sibling }];
  let reads = 0, firstStored = "synthetic-key";
  setProviderKeychainEntryFactoryForTests((_service, account) => ({
    getPassword: () => { reads++; return account.endsWith("/first") ? firstStored : "synthetic-key"; },
    setPassword: value => { if (account.endsWith("/first")) { firstStored = value; throw new Error("write result unknown"); } },
    deletePassword: () => false,
  }));
  try {
    for (const key of [first, sibling]) {
      const send = passiveKeyPhysicalFetch(trusted(async () => response()), config, name, routedProviderConfig(name, { ...provider, apiKey: key }));
      await send("https://api.groq.com/openai/v1/chat/completions", init);
    }
    expect(listPassiveKeyLimits(config)).toHaveLength(2);
    expect(() => providerKeychainEntry(`${name}/first`).setPassword("synthetic-replacement")).toThrow();
    const afterWrite = reads;
    expect(listPassiveKeyLimits(config).map(row => row.keyId)).toEqual([quotaId(name, "sibling")]);
    expect(reads).toBe(afterWrite);
  } finally { setProviderKeychainEntryFactoryForTests(null); observations.clearPassiveKeyLimits(); }
});

test("unobserved keychain accounts do not read the OS store during passive polling", () => {
  const config = fixture("unobserved-many");
  config.providers["unobserved-many"]!.apiKeyPool = Array.from({ length: 100 }, (_, i) => ({ id: `key-${i}`, key: `keychain:unobserved-many/${i}` }));
  let reads = 0;
  setProviderKeychainEntryFactoryForTests(() => ({ getPassword: () => { reads++; return "synthetic-key"; }, setPassword: () => {}, deletePassword: () => false }));
  try {
    expect(listPassiveKeyLimits(config)).toEqual([]);
    expect(reads).toBe(0);
  } finally { setProviderKeychainEntryFactoryForTests(null); observations.clearPassiveKeyLimits(); }
});

test("passive sends and polls do not reread a resolved keychain credential", async () => {
  const config = fixture("keychain-no-extra");
  const provider = config.providers["keychain-no-extra"]!;
  provider.apiKey = "keychain:keychain-no-extra";
  let reads = 0, sends = 0, stored = "synthetic-key", release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  setProviderKeychainEntryFactoryForTests(() => ({ getPassword: () => { reads++; return stored; }, setPassword: value => { stored = value; }, deletePassword: () => false }));
  try {
    const routed = routedProviderConfig("keychain-no-extra", provider);
    expect(reads).toBe(1);
    const send = passiveKeyPhysicalFetch(trusted(async () => { sends++; await wait; return response(); }), config, "keychain-no-extra", routed);
    const pending = send("https://api.groq.com/openai/v1/chat/completions", init);
    stored = "replacement-synthetic-key";
    release();
    await pending;
    expect(listPassiveKeyLimits(config)).toMatchObject([{ provider: "keychain-no-extra", model: "model" }]);
    expect(getPassiveKeyLimits(config, "keychain-no-extra", "model")).toMatchObject([{ remaining: 5 }, { dimension: "tokens" }]);
    expect(reads).toBe(1);
    expect(sends).toBe(1);
  } finally { release(); setProviderKeychainEntryFactoryForTests(null); observations.clearPassiveKeyLimits(); }
});

test("a malformed keychain credential cannot break another account's passive projection", async () => {
  const config = fixture("malformed-passive");
  const provider = config.providers["malformed-passive"]!;
  provider.apiKeyPool = [{ id: "good", key: "synthetic-key" }, { id: "bad", key: "keychain:malformed-passive/bad" }];
  setProviderKeychainEntryFactoryForTests(() => ({ getPassword: () => '{"type":"service_account","private_key":"synthetic"}', setPassword: () => {}, deletePassword: () => false }));
  try {
    const send = passiveKeyPhysicalFetch(trusted(async () => response()), config, "malformed-passive", routedProviderConfig("malformed-passive", provider));
    await send("https://api.groq.com/openai/v1/chat/completions", init);
    expect(listPassiveKeyLimits(config)).toMatchObject([{ keyId: quotaId("malformed-passive", "good"), model: "model" }]);
  } finally { setProviderKeychainEntryFactoryForTests(null); observations.clearPassiveKeyLimits(); }
});

test("a wire key that differs from routing's cached key cannot claim the account", async () => {
  const name = "keychain-wire-mismatch";
  const config = fixture(name);
  const provider = config.providers[name]!;
  provider.apiKey = `keychain:${name}`;
  let reads = 0;
  setProviderKeychainEntryFactoryForTests(() => ({ getPassword: () => { reads++; return "synthetic-key"; }, setPassword: () => {}, deletePassword: () => false }));
  try {
    const routed = routedProviderConfig(name, provider);
    const send = passiveKeyPhysicalFetch(trusted(async () => response()), config, name, { ...routed, apiKey: "different-synthetic-key" });
    await send("https://api.groq.com/openai/v1/chat/completions", { ...init, headers: { authorization: ["Bearer", "different-synthetic-key"].join(" ") } });
    expect(listPassiveKeyLimits(config)).toEqual([]);
    expect(reads).toBe(1);
  } finally { setProviderKeychainEntryFactoryForTests(null); observations.clearPassiveKeyLimits(); }
});

test("keychain cache generation revokes cached and in-flight readings across an ABA replacement", async () => {
  const name = "keychain-generation";
  const config = fixture(name);
  const provider = config.providers[name]!;
  provider.apiKey = `keychain:${name}`;
  let reads = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  setProviderKeychainEntryFactoryForTests(() => ({ getPassword: () => { reads++; return "synthetic-key"; }, setPassword: () => {}, deletePassword: () => false }));
  try {
    const routed = routedProviderConfig(name, provider);
    const send = passiveKeyPhysicalFetch(trusted(async (_input, request) => {
      if (JSON.parse(String(request?.body)).model === "pending") await gate;
      return response();
    }), config, name, routed);
    await send("https://api.groq.com/openai/v1/chat/completions", init);
    expect(listPassiveKeyLimits(config)).toMatchObject([{ model: "model" }]);
    const pending = send("https://api.groq.com/openai/v1/chat/completions", { ...init, body: JSON.stringify({ model: "pending" }) });
    invalidateResolvedProviderKeyCache();
    expect(resolveProviderApiKey(provider.apiKey)).toBe("synthetic-key");
    const readsAfterRouting = reads;
    expect(listPassiveKeyLimits(config)).toEqual([]);
    await send("https://api.groq.com/openai/v1/chat/completions", { ...init, body: JSON.stringify({ model: "new" }) });
    release();
    await pending;
    expect(listPassiveKeyLimits(config)).toMatchObject([{ model: "new" }]);
    expect(reads).toBe(readsAfterRouting);
  } finally { release(); setProviderKeychainEntryFactoryForTests(null); observations.clearPassiveKeyLimits(); }
});

test("a polled env A to B to A transition revokes cached and in-flight observations only for that account", async () => {
  const name = "env-aba";
  const config = fixture(name);
  const provider = config.providers[name]!;
  provider.apiKey = "${OCX_TEST_PASSIVE_ABA}";
  provider.apiKeyPool = [{ id: "first", key: provider.apiKey }, { id: "sibling", key: "synthetic-sibling" }];
  process.env.OCX_TEST_PASSIVE_ABA = "synthetic-key";
  let release!: () => void, sends = 0;
  const wait = new Promise<void>(resolve => { release = resolve; });
  try {
    const send = passiveKeyPhysicalFetch(trusted(async (_input, request) => { sends++; if (JSON.parse(String(request?.body)).model === "pending") await wait; return response(); }), config, name, routedProviderConfig(name, provider));
    const sibling = passiveKeyPhysicalFetch(trusted(async () => { sends++; return response(); }), config, name, routedProviderConfig(name, { ...provider, apiKey: "synthetic-sibling" }));
    await send("https://api.groq.com/openai/v1/chat/completions", init);
    await sibling("https://api.groq.com/openai/v1/chat/completions", { ...init, headers: { authorization: "Bearer synthetic-sibling" } });
    const pending = send("https://api.groq.com/openai/v1/chat/completions", { ...init, body: JSON.stringify({ model: "pending" }) });
    process.env.OCX_TEST_PASSIVE_ABA = "replacement-synthetic-key";
    expect(listPassiveKeyLimits(config).map(row => row.keyId)).toEqual([quotaId(name, "sibling")]);
    process.env.OCX_TEST_PASSIVE_ABA = "synthetic-key";
    expect(listPassiveKeyLimits(config).map(row => row.keyId)).toEqual([quotaId(name, "sibling")]);
    release();
    await pending;
    expect(listPassiveKeyLimits(config).map(row => row.keyId)).toEqual([quotaId(name, "sibling")]);
    expect(sends).toBe(3);
  } finally { release(); delete process.env.OCX_TEST_PASSIVE_ABA; observations.clearPassiveKeyLimits(); }
});

test("incarnation eviction revokes an outstanding response without affecting newer accounts", async () => {
  const config = fixture("bounded-incarnations");
  const provider = config.providers["bounded-incarnations"]!;
  provider.apiKeyPool = Array.from({ length: 513 }, (_, i) => ({ id: `id-${i}`, key: `synthetic-key-${i}` }));
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const send = (i: number, pending = false) => {
    const key = `synthetic-key-${i}`;
    const fetcher = passiveKeyPhysicalFetch(trusted(async () => { if (pending) await wait; return response(); }), config, "bounded-incarnations", routedProviderConfig("bounded-incarnations", { ...provider, apiKey: key }));
    return fetcher("https://api.groq.com/openai/v1/chat/completions", { ...init, headers: { authorization: `Bearer ${key}` } });
  };
  try {
    const pending = send(0, true);
    for (let i = 1; i <= 512; i++) await send(i);
    release();
    await pending;
    const rows = listPassiveKeyLimits(config);
    expect(rows).toHaveLength(512);
    expect(rows.some(row => row.keyId === quotaId("bounded-incarnations", "id-0"))).toBe(false);
    expect(rows.some(row => row.keyId === quotaId("bounded-incarnations", "id-512"))).toBe(true);
  } finally { release(); observations.clearPassiveKeyLimits(); }
});

test("an old env response cannot retire a newer credential's observation", async () => {
  const name = "env-newer";
  const config = fixture(name);
  const provider = config.providers[name]!;
  provider.apiKey = "${OCX_TEST_PASSIVE_NEWER}";
  process.env.OCX_TEST_PASSIVE_NEWER = "synthetic-key";
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  try {
    const older = passiveKeyPhysicalFetch(trusted(async () => { await wait; return response(); }), config, name, routedProviderConfig(name, provider));
    const pending = older("https://api.groq.com/openai/v1/chat/completions", init);
    process.env.OCX_TEST_PASSIVE_NEWER = "replacement-synthetic-key";
    const newer = passiveKeyPhysicalFetch(trusted(async () => response()), config, name, routedProviderConfig(name, provider));
    await newer("https://api.groq.com/openai/v1/chat/completions", { ...init, headers: { authorization: `Bearer ${process.env.OCX_TEST_PASSIVE_NEWER}` } });
    expect(listPassiveKeyLimits(config)).toHaveLength(1);
    release();
    await pending;
    expect(listPassiveKeyLimits(config)).toHaveLength(1);
  } finally { release(); delete process.env.OCX_TEST_PASSIVE_NEWER; observations.clearPassiveKeyLimits(); }
});

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
    expect(getPassiveKeyLimits(config, "parser-gate", "model")).toMatchObject([
      { dimension: "requests", window: "day", remaining: 5 }, { dimension: "tokens", window: "minute" },
    ]);
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
  expect(getPassiveKeyLimits(config, "large-model-last", "model")).toMatchObject([{ remaining: 5 }, { dimension: "tokens", window: "minute" }]);
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
  expect(getPassiveKeyLimits(config, "ordering", "model")).toMatchObject([{ remaining: 10 }, { dimension: "tokens", window: "minute" }]);
});

test("clearing on key management retires old rows and pending responses", async () => {
  const config = fixture("cleared");
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  let count = 0;
  const send = passiveKeyPhysicalFetch(trusted(async () => { if (++count === 2) await wait; return response(); }), config, "cleared", routedProviderConfig("cleared", config.providers.cleared!));
  await send("https://api.groq.com/openai/v1/chat/completions", init);
  expect(getPassiveKeyLimits(config, "cleared", "model")).toHaveLength(2);
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
  expect(getPassiveKeyLimits(b, "provider-b", "model")).toMatchObject([{ remaining: 5 }, { dimension: "tokens", window: "minute" }]);
});

// Two installations can configure the same provider and the same API key. The observed counter
// still belongs to the home that observed it: without that dimension, the second home reads the
// first home's rows and, worse, its own send retires them.
test("the same provider and key in another config home neither reads nor retires this home's rows", async () => {
  const name = "shared-key-home";
  const priorHome = process.env.OPENCODEX_HOME;
  const homeA = mkdtempSync(join(tmpdir(), "ocx-passive-home-a-"));
  const homeB = mkdtempSync(join(tmpdir(), "ocx-passive-home-b-"));
  process.env.OPENCODEX_HOME = homeA;
  try {
    const config = fixture(name);
    // Each home's upstream reports a different remaining count, so a shared cache row would be
    // visible as the wrong number rather than merely as a nonempty answer.
    const send = (remaining: number) => passiveKeyPhysicalFetch(trusted(async () => new Response(null, {
      headers: { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": String(remaining) },
    })), config, name, routedProviderConfig(name, config.providers[name]!))("https://api.groq.com/openai/v1/chat/completions", init);
    await send(5);
    expect(getPassiveKeyLimits(config, name, "model")[0]).toMatchObject({ remaining: 5 });

    process.env.OPENCODEX_HOME = homeB;
    // Home B has configured the identical provider and key, but has observed nothing yet.
    expect(getPassiveKeyLimits(config, name, "model")).toEqual([]);
    expect(listPassiveKeyLimits(config)).toEqual([]);
    // A send in home B publishes only for home B; it neither replaces nor retires home A's row.
    await send(42);
    expect(getPassiveKeyLimits(config, name, "model")[0]).toMatchObject({ remaining: 42 });

    process.env.OPENCODEX_HOME = homeA;
    expect(getPassiveKeyLimits(config, name, "model")[0]).toMatchObject({ remaining: 5 });
    expect(listPassiveKeyLimits(config)).toHaveLength(1);
  } finally {
    if (priorHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = priorHome;
    observations.clearPassiveKeyLimits();
    removeTreeWithRetry(homeA);
    removeTreeWithRetry(homeB);
  }
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
  const expected = [`${name}/${quotaId(name, siblingId)}/cached`, `${name}/${quotaId(name, siblingId)}/pending`, `other/${quotaId("other", firstId)}/cached`, `other/${quotaId("other", firstId)}/pending`];
  if (operation === "add-new") expected.push(`${name}/${quotaId(name, firstId)}/cached`, `${name}/${quotaId(name, firstId)}/pending`);
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
    expect(getPassiveKeyLimits(config, name, "model")).toHaveLength(2);
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

test("keychain ownership follows routing cache invalidation without passive decision side effects", async () => {
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
    const afterRouting = { observed, invalidated };
    const send = passiveKeyPhysicalFetch(trusted(async () => response()), config, "passive-keychain", routed);
    await send("https://api.groq.com/openai/v1/chat/completions", init);
    expect(getPassiveKeyLimits(config, "passive-keychain", "model")).toMatchObject([{ remaining: 5 }, { dimension: "tokens" }]);
    expect({ observed, invalidated }).toEqual(afterRouting);
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
