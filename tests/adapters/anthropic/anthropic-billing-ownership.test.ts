import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../../src/config";
import { setPersistedConfigMutationBeforeCommitForTests } from "../../../src/config/persisted-mutation";
import { routedProviderConfig } from "../../../src/router";
import { anthropicBillingPhysicalFetch, anthropicBillingResponseOwner } from "../../../src/providers/anthropic-billing-ownership";
import { rotateAnthropicBillingKeyOnResponse } from "../../../src/providers/anthropic-billing-recovery";
import { clearKeyCooldowns, getKeyCooldownUntil, rotateProviderTransportOnAnthropicBilling } from "../../../src/providers/key-failover";
import type { OcxConfig, OcxProviderConfig } from "../../../src/types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";
import { isEgressTransparentExecutor, markEgressTransparentExecutor, providerEgressSendInit } from "../../../src/lib/provider-egress";
import { trackProviderRequestSlotBody } from "../../../src/providers/request-pacing";

let previousHome: string | undefined;
let home = "";
let config: OcxConfig;
const message = "Your credit balance is too low to access the Anthropic API.";
const refusal = () => Response.json({ type: "error", error: { type: "invalid_request_error", message } }, { status: 400 });
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-billing-owner-"));
  process.env.OPENCODEX_HOME = home;
  clearKeyCooldowns();
  config = { port: 0, defaultProvider: "anth", providers: { anth: {
    adapter: "anthropic", authMode: "key", baseUrl: "https://example.test", apiKey: "fixture-key-A",
    apiKeyPool: [{ id: "A", key: "fixture-key-A" }, { id: "B", key: "fixture-key-B" }],
  } } } as OcxConfig;
  saveConfig(config);
});
afterEach(() => {
  setPersistedConfigMutationBeforeCommitForTests(null);
  clearKeyCooldowns();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});
const physical = (response: Response) => (async () => response) as typeof fetch;
const url = "https://example.test/v1/messages";

for (const transport of [undefined, "x-api-key", "bearer"] as const) test(`physical ${transport ?? "default"} key transport owns billing recovery`, async () => {
  config.providers.anth!.apiKeyTransport = transport;
  saveConfig(config);
  const routed = routedProviderConfig("anth", config.providers.anth);
  const headers: Record<string, string> = transport === "bearer" ? { Authorization: "Bearer fixture-key-A" } : { "x-api-key": "fixture-key-A" };
  const response = await anthropicBillingPhysicalFetch(physical(refusal()), "anth", routed)(url, { headers });
  expect(anthropicBillingResponseOwner(response, config, "anth", routed)?.apiKey).toBe("fixture-key-A");
  const replacement = await rotateAnthropicBillingKeyOnResponse(response, config, "anth", routed);
  expect(replacement?.apiKey).toBe("fixture-key-B");
  expect(getKeyCooldownUntil("anth", "A")).not.toBeNull();
});

for (const transport of ["x-api-key", "bearer"] as const) {
  const invalidHeaders: Record<string, string>[] = transport === "bearer"
    ? [{ Authorization: "Bearer fixture-key-C" }, { Authorization: "Bearer fixture-key-A", "x-api-key": "fixture-key-A" },
      { "x-api-key": "fixture-key-A" }]
    : [{ "x-api-key": "fixture-key-C" }, { "x-api-key": "fixture-key-A", Authorization: "Bearer fixture-key-A" },
      { Authorization: "Bearer fixture-key-A" }];
  for (const [index, headers] of invalidHeaders.entries()) test(`physical ${transport} override/conflict/wrong transport ${index} has no authority`, async () => {
    config.providers.anth!.apiKeyTransport = transport;
    saveConfig(config);
    const routed = routedProviderConfig("anth", config.providers.anth);
    const response = await anthropicBillingPhysicalFetch(physical(refusal()), "anth", routed)(url, { headers });
    expect(anthropicBillingResponseOwner(response, config, "anth", routed)).toBeNull();
    expect(await rotateAnthropicBillingKeyOnResponse(response, config, "anth", routed)).toBeNull();
    expect(getKeyCooldownUntil("anth", "A")).toBeNull();
    expect(config.providers.anth!.apiKey).toBe("fixture-key-A");
    expect(await response.text()).toContain(message);
  });
}

for (const scope of ["current", "attempted"] as const) for (const transport of ["x-api-key", "bearer"] as const)
  test(`late ${scope} ${transport} transport change revokes billing ownership`, async () => {
    config.providers.anth!.apiKeyTransport = transport;
    saveConfig(config);
    const routed = routedProviderConfig("anth", config.providers.anth);
    const headers: Record<string, string> = transport === "bearer" ? { Authorization: "Bearer fixture-key-A" } : { "x-api-key": "fixture-key-A" };
    const response = await anthropicBillingPhysicalFetch(physical(refusal()), "anth", routed)(url, { headers });
    (scope === "current" ? config.providers.anth! : routed).apiKeyTransport = transport === "bearer" ? "x-api-key" : "bearer";
    expect(await rotateAnthropicBillingKeyOnResponse(response, config, "anth", routed)).toBeNull();
    expect(getKeyCooldownUntil("anth", "A")).toBeNull();
    expect(config.providers.anth!.apiKey).toBe("fixture-key-A");
    expect(await response.text()).toContain(message);
  });

test("default and explicit x-api-key transport remain equivalent to the sent snapshot", async () => {
  const routed = routedProviderConfig("anth", config.providers.anth);
  const response = await anthropicBillingPhysicalFetch(physical(refusal()), "anth", routed)(url,
    { headers: { "x-api-key": "fixture-key-A" } });
  config.providers.anth!.apiKeyTransport = "x-api-key";
  routed.apiKeyTransport = "x-api-key";
  expect(anthropicBillingResponseOwner(response, config, "anth", routed)?.apiKey).toBe("fixture-key-A");
});

test("an unmarked response has no cooldown or rotation authority", async () => {
  const routed = routedProviderConfig("anth", config.providers.anth);
  const response = refusal();
  expect(await rotateAnthropicBillingKeyOnResponse(response, config, "anth", routed)).toBeNull();
  expect(getKeyCooldownUntil("anth", "A")).toBeNull();
  expect(await response.text()).toContain(message);
});

test("pacing rewraps never mint ownership for an unmarked response", async () => {
  const routed = routedProviderConfig("anth", config.providers.anth);
  let releases = 0;
  const response = trackProviderRequestSlotBody({ leased: true, bodyTracked: false, released: false,
    release() { releases++; } }, refusal());
  expect(await rotateAnthropicBillingKeyOnResponse(response, config, "anth", routed)).toBeNull();
  expect(await response.text()).toContain(message);
  expect(releases).toBe(1);
  expect(getKeyCooldownUntil("anth", "A")).toBeNull();
});

test("a cancelled response keeps its terminal body and cannot mutate selection", async () => {
  const routed = routedProviderConfig("anth", config.providers.anth);
  const response = await anthropicBillingPhysicalFetch(physical(refusal()), "anth", routed)(url, { headers: { "x-api-key": routed.apiKey! } });
  const abort = new AbortController();
  abort.abort();
  expect(await rotateAnthropicBillingKeyOnResponse(response, config, "anth", routed, { signal: abort.signal })).toBeNull();
  expect(await response.text()).toContain(message);
  expect(getKeyCooldownUntil("anth", "A")).toBeNull();
});

test("conflicting physical owners, provider names, and actual targets fail closed", async () => {
  const routed = routedProviderConfig("anth", config.providers.anth);
  for (const kind of ["conflict", "provider", "target"]) {
    const response = refusal();
    const fetch = anthropicBillingPhysicalFetch(physical(response), kind === "provider" ? "other" : "anth", routed);
    await fetch(kind === "target" ? "https://other.test/v1/messages" : url, { headers: { "x-api-key": routed.apiKey! } });
    if (kind === "conflict") await fetch(url, { headers: { "x-api-key": "fixture-key-C" } });
    expect(await rotateAnthropicBillingKeyOnResponse(response, config, "anth", routed)).toBeNull();
    expect(getKeyCooldownUntil("anth", "A")).toBeNull();
  }
});

test("response ownership is frozen before awaiting the physical fetch", async () => {
  const routed = routedProviderConfig("anth", config.providers.anth);
  const completed = Promise.withResolvers<Response>();
  const sending = anthropicBillingPhysicalFetch((() => completed.promise) as typeof fetch, "anth", routed)(url,
    { headers: { "x-api-key": "fixture-key-A" } });
  routed.apiKey = "fixture-key-C";
  completed.resolve(refusal());
  const response = await sending;
  expect(await rotateAnthropicBillingKeyOnResponse(response, config, "anth", routed)).toBeNull();
  expect(getKeyCooldownUntil("anth", "A")).toBeNull();
});

test("late refusal cannot cool a replaced selection revision", async () => {
  const routed = routedProviderConfig("anth", config.providers.anth);
  const response = await anthropicBillingPhysicalFetch(physical(refusal()), "anth", routed)(url, { headers: { "x-api-key": routed.apiKey! } });
  config.providers.anth!.apiKeySelectionRevision = "operator-revision";
  saveConfig(config);
  expect(await rotateAnthropicBillingKeyOnResponse(response, config, "anth", routed)).toBeNull();
  expect(getKeyCooldownUntil("anth", "A")).toBeNull();
});

test("billing wrapper is key/Anthropic/multi-key only", () => {
  const routed = routedProviderConfig("anth", config.providers.anth);
  for (const provider of [{ ...routed, adapter: "openai-chat" }, { ...routed, authMode: "oauth" },
    { ...routed, authMode: "forward" }, { ...routed, authMode: "local" }, { ...routed, apiKeyPool: [routed.apiKeyPool![0]!] }]) {
    expect(rotateProviderTransportOnAnthropicBilling(config, "anth", provider)).toBeNull();
  }
  expect(getKeyCooldownUntil("anth", "A")).toBeNull();
});

for (const mutation of ["adapter", "authMode", "pool", "headers"] as const) test(`late ${mutation} changes revoke billing ownership`, async () => {
  const routed = routedProviderConfig("anth", config.providers.anth);
  const response = await anthropicBillingPhysicalFetch(physical(refusal()), "anth", routed)(url, { headers: { "x-api-key": routed.apiKey! } });
  if (mutation === "adapter") config.providers.anth!.adapter = "openai-chat";
  if (mutation === "authMode") config.providers.anth!.authMode = "oauth";
  if (mutation === "pool") config.providers.anth!.apiKeyPool = config.providers.anth!.apiKeyPool!.slice(0, 1);
  if (mutation === "headers") config.providers.anth!.headers = { "x-api-key": "fixture-key-C" };
  expect(await rotateAnthropicBillingKeyOnResponse(response, config, "anth", routed)).toBeNull();
  expect(getKeyCooldownUntil("anth", "A")).toBeNull();
  expect(config.providers.anth!.apiKey).toBe("fixture-key-A");
  expect(await response.text()).toContain(message);
});

const persistedAuthorityChanges: { name: string; mutate: (provider: OcxProviderConfig) => void }[] = [
  { name: "adapter", mutate: provider => { provider.adapter = "openai-chat"; } },
  { name: "transport", mutate: provider => { provider.apiKeyTransport = "bearer"; } },
  { name: "account headers", mutate: provider => { provider.headers = { "x-org-account": "fixture-other-org" }; } },
  { name: "base URL", mutate: provider => { provider.baseUrl = "https://other.test"; } },
  { name: "OAuth auth", mutate: provider => { provider.authMode = "oauth"; } },
  { name: "local auth", mutate: provider => { provider.authMode = "local"; } },
  { name: "disabled provider", mutate: provider => { provider.disabled = true; } },
  { name: "selection revision", mutate: provider => { provider.apiKeySelectionRevision = "operator-revision"; } },
  { name: "single-key pool", mutate: provider => { provider.apiKeyPool = provider.apiKeyPool!.slice(0, 1); } },
  { name: "replaced A key", mutate: provider => {
    provider.apiKey = "fixture-key-A-replaced";
    provider.apiKeyPool![0]!.key = "fixture-key-A-replaced";
  } },
  { name: "operator selected B", mutate: provider => {
    provider.apiKey = "fixture-key-B";
    provider.apiKeySelectionRevision = "operator-selected-B";
  } },
];

for (const phase of ["persisted row", "mutation rebase"] as const) {
  for (const { name, mutate } of persistedAuthorityChanges) {
    test(`${phase} ${name} change revokes billing recovery authority`, async () => {
      const routed = routedProviderConfig("anth", config.providers.anth);
      const response = await anthropicBillingPhysicalFetch(physical(refusal()), "anth", routed)(url,
        { headers: { "x-api-key": "fixture-key-A" } });
      const competing = loadConfig();
      mutate(competing.providers.anth!);
      const competingKey = competing.providers.anth!.apiKey;
      const path = join(home, "config.json");
      let authoritativeBytes = "";
      let rebases = 0;
      if (phase === "persisted row") {
        saveConfig(competing);
        authoritativeBytes = readFileSync(path, "utf8");
      } else {
        setPersistedConfigMutationBeforeCommitForTests(() => {
          rebases++;
          config.providers.anth = structuredClone(competing.providers.anth!);
          authoritativeBytes = JSON.stringify(competing, null, 2);
          // Direct bytes model a competing writer; saveConfig would acquire the active lock.
          writeFileSync(path, authoritativeBytes);
        });
      }
      // The physically sent selection is still owned before the persisted transaction starts.
      expect(anthropicBillingResponseOwner(response, config, "anth", routed)?.apiKey).toBe("fixture-key-A");
      let replacement: OcxProviderConfig | null;
      try {
        replacement = await rotateAnthropicBillingKeyOnResponse(response, config, "anth", routed);
      } finally {
        setPersistedConfigMutationBeforeCommitForTests(null);
      }
      expect(rebases).toBe(phase === "mutation rebase" ? 1 : 0);
      expect({ replacement, cooldown: getKeyCooldownUntil("anth", "A"),
        persistedKey: loadConfig().providers.anth!.apiKey, bytes: readFileSync(path, "utf8") })
        .toEqual({ replacement: null, cooldown: null, persistedKey: competingKey, bytes: authoritativeBytes });
      expect(await response.json()).toEqual({ type: "error", error: { type: "invalid_request_error", message } });
    });
  }
}

for (const explicitTransport of [false, true]) test(`unchanged billing authority permits a real rebase (explicit transport: ${explicitTransport})`, async () => {
  const routed = routedProviderConfig("anth", config.providers.anth);
  const response = await anthropicBillingPhysicalFetch(physical(refusal()), "anth", routed)(url,
    { headers: { "x-api-key": "fixture-key-A" } });
  let rebases = 0;
  setPersistedConfigMutationBeforeCommitForTests(() => {
    rebases++;
    const competing = loadConfig();
    competing.defaultModel = "fixture-unrelated-model";
    if (explicitTransport) competing.providers.anth!.apiKeyTransport = "x-api-key";
    config.providers.anth = structuredClone(competing.providers.anth!);
    writeFileSync(join(home, "config.json"), JSON.stringify(competing, null, 2));
  });
  let replacement: OcxProviderConfig | null;
  try {
    replacement = await rotateAnthropicBillingKeyOnResponse(response, config, "anth", routed);
  } finally {
    setPersistedConfigMutationBeforeCommitForTests(null);
  }
  expect(rebases).toBe(1);
  expect(replacement?.apiKey).toBe("fixture-key-B");
  expect(getKeyCooldownUntil("anth", "A")).not.toBeNull();
  expect(getKeyCooldownUntil("anth", "B")).toBeNull();
  expect(loadConfig().providers.anth!.apiKey).toBe("fixture-key-B");
  expect(loadConfig().defaultModel).toBe("fixture-unrelated-model");
  expect(await response.json()).toEqual({ type: "error", error: { type: "invalid_request_error", message } });
});

for (const egress of ["proxy", "direct", "noProxy"] as const) test(`billing wrapper preserves transparent ${egress} admission`, () => {
  const transparent = markEgressTransparentExecutor(physical(refusal()));
  const provider = { ...config.providers.anth!, ...(egress === "proxy" ? { proxy: "http://proxy.example.test:8080" }
    : egress === "direct" ? { proxy: "direct" } : { proxy: "http://proxy.example.test:8080", noProxy: "example.test" }) };
  const wrapped = anthropicBillingPhysicalFetch(transparent, "anth", provider);
  expect(isEgressTransparentExecutor(wrapped)).toBe(true);
  expect(providerEgressSendInit({ providerName: "anth", provider }, wrapped, url))
    .toEqual(providerEgressSendInit({ providerName: "anth", provider }, transparent, url));
  const opaque = anthropicBillingPhysicalFetch(physical(refusal()), "anth", provider);
  expect(isEgressTransparentExecutor(opaque)).toBe(false);
  expect(() => providerEgressSendInit({ providerName: "anth", provider }, opaque, url)).toThrow();
});
