import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, loadConfig, saveConfig } from "../../src/config";
import { captureAccountAutoPauseAttempt, wasAccountAutoPaused } from "../../src/oauth/account-auto-pause";
import { providerApiKeySelectionIsCurrent, resolveCurrentProviderApiKeyTransport } from "../../src/providers/api-key-selection";
import { clearKeyCooldowns, forgetApiKeyRotationCursor, selectProactiveApiKeyTransport } from "../../src/providers/key-failover";
import { routedProviderConfig } from "../../src/router";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home: string;
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-pause-distribution-"));
  process.env.OPENCODEX_HOME = home;
  clearKeyCooldowns(); forgetApiKeyRotationCursor();
});
afterEach(() => {
  clearKeyCooldowns(); forgetApiKeyRotationCursor();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});
function fixture() {
  const config = getDefaultConfig();
  config.providers = { fixture: { adapter: "openai-chat", authMode: "key", baseUrl: "https://example.test/v1",
    apiKey: "synthetic-A", apiKeySelectionRevision: "saved-revision",
    apiKeyPool: [{ id: "A", key: "synthetic-A" }, { id: "B", key: "synthetic-B" }],
    requestPacing: { enabled: true, keySelection: "round-robin", keys: { maxConcurrentRequests: 1 } },
    accountAutoPause: { enabled: true, consecutiveFailures: 1 },
  } };
  saveConfig(config);
  const provider = config.providers.fixture!;
  const route = routedProviderConfig("fixture", { ...provider, apiKey: "synthetic-B", _apiKeyAttempt: {
    entryId: "B", reference: "synthetic-B", revision: provider.apiKeySelectionRevision, distributed: true,
  } });
  return { config, route };
}
const refusal = () => Response.json({ error: { type: "permission_error", message: "Your subscription has expired." } }, { status: 403 });

test("a non-active distributed key pauses durably without changing the active key", async () => {
  const { config, route } = fixture();
  const observe = captureAccountAutoPauseAttempt("fixture", route, { config }, new Headers({ authorization: `Bearer ${route.apiKey}` }))!;
  const response = await observe(refusal());
  expect(wasAccountAutoPaused(response)).toBe(true);
  for (const provider of [config.providers.fixture!, loadConfig().providers.fixture!]) {
    expect(provider.apiKey).toBe("synthetic-A");
    expect(provider.apiKeyPool![0]!.disabled).not.toBe(true);
    expect(provider.apiKeyPool![1]).toMatchObject({ disabled: true, pauseDetails: { reason: "subscription_expired" } });
  }
  expect(providerApiKeySelectionIsCurrent(config, "fixture", route)).toBe(false);
  const fresh = resolveCurrentProviderApiKeyTransport(config, "fixture", { ...route, _apiKeyAttempt: undefined })!;
  for (let n = 0; n < 3; n++) expect(selectProactiveApiKeyTransport(config, "fixture", fresh)?.apiKey).toBe("synthetic-A");
});

for (const change of ["revision", "disabled", "headers"] as const) test(`distributed pause rejects stale or unowned ${change}`, async () => {
  const { config, route } = fixture();
  const headers = new Headers({ authorization: `Bearer ${change === "headers" ? "synthetic-override" : route.apiKey}` });
  const observe = captureAccountAutoPauseAttempt("fixture", route, { config }, headers);
  if (change === "revision") config.providers.fixture!.apiKeySelectionRevision = "replacement";
  if (change === "disabled") config.providers.fixture!.accountAutoPause = { enabled: false };
  saveConfig(config);
  const response = refusal();
  if (observe) await observe(response);
  expect(wasAccountAutoPaused(response)).toBe(false);
  expect(loadConfig().providers.fixture!.apiKeyPool![1]!.disabled).not.toBe(true);
});

test("a disabled distributed selection cannot dispatch even if its revision is unchanged", () => {
  const { config, route } = fixture();
  config.providers.fixture!.apiKeyPool![1]!.disabled = true;
  expect(providerApiKeySelectionIsCurrent(config, "fixture", route)).toBe(false);
  expect(resolveCurrentProviderApiKeyTransport(config, "fixture", route)).toBeNull();
  const fresh = routedProviderConfig("fixture", config.providers.fixture!);
  for (let n = 0; n < 3; n++) expect(selectProactiveApiKeyTransport(config, "fixture", fresh)?.apiKey).toBe("synthetic-A");
});
