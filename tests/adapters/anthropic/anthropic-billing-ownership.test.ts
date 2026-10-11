import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../../src/config";
import { routedProviderConfig } from "../../../src/router";
import { anthropicBillingPhysicalFetch } from "../../../src/providers/anthropic-billing-ownership";
import { rotateAnthropicBillingKeyOnResponse } from "../../../src/providers/anthropic-billing-recovery";
import { clearKeyCooldowns, getKeyCooldownUntil, rotateProviderTransportOnAnthropicBilling } from "../../../src/providers/key-failover";
import type { OcxConfig } from "../../../src/types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";
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
  clearKeyCooldowns();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});
const physical = (response: Response) => (async () => response) as typeof fetch;
const url = "https://example.test/v1/messages";

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
