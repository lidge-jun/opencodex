import { afterEach, beforeEach, expect, test } from "bun:test";
import { clearComboSelectionState, clearComboTargetCooldowns, coolComboTarget, comboUnavailableDiagnostics } from "../../src/combos";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { clearCachedProviderQuotas, setCachedProviderQuotaForTests } from "../../src/providers/quota-routing-cache";
import type { ProviderQuota } from "../../src/providers/quota-types";
import { handleResponses } from "../../src/server/responses/core";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

// #7965: combo_unavailable keeps its public code and carries a machine-readable cause class and
// target counts, never a new error code, combo id, provider name or upstream text.
const originalFetch = globalThis.fetch;
let releaseSpendHome: (() => void) | undefined;
const reset = (): void => {
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
  clearCachedProviderQuotas();
};
beforeEach(() => { reset(); releaseSpendHome = acquireOwnedSpendHome(); });
afterEach(() => { releaseSpendHome?.(); releaseSpendHome = undefined; globalThis.fetch = originalFetch; reset(); });

const provider = (name: string) => ({
  adapter: "openai-chat", baseUrl: `https://${name}.example/v1`, authMode: "key", apiKey: `sk-${name}`, models: [`model-${name}`],
});
const comboConfig = (names: string[], extra: Record<string, unknown> = {}) => ({
  defaultProvider: names[0],
  providers: Object.fromEntries(names.map(name => [name, provider(name)])),
  combos: { pair: { strategy: "failover", targets: names.map(name => ({ provider: name, model: `model-${name}` })) } },
  ...extra,
}) as unknown as OcxConfig;

async function unavailable(cfg: OcxConfig): Promise<{ status: number; error: Record<string, unknown> }> {
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "combo/pair", stream: false, input: "hello" }),
  }), cfg, { model: "", provider: "" } as RequestLogContext);
  const { error } = await response.json() as { error: Record<string, unknown> };
  return { status: response.status, error };
}

test("diagnostics fold one shared class, mixed classes and none", () => {
  expect(comboUnavailableDiagnostics(2, 0, ["quota", "quota"])).toEqual({ cause: "quota", targets: 2, attempted: 0, causes: { quota: 2 } });
  expect(comboUnavailableDiagnostics(3, 1, ["quota", "permission"]))
    .toEqual({ cause: "mixed", targets: 3, attempted: 1, causes: { quota: 1, permission: 1 } });
  expect(comboUnavailableDiagnostics(1, 0, [])).toEqual({ cause: "unknown", targets: 1, attempted: 0, causes: {} });
});

test("every target cooled by a quota refusal reports quota, with no send", async () => {
  coolComboTarget("pair", { provider: "a", model: "model-a" }, { retryAfter: "60", status: 429 });
  coolComboTarget("pair", { provider: "b", model: "model-b" }, { retryAfter: "60", status: 402 });
  globalThis.fetch = (async () => { throw new Error("no target may be dispatched"); }) as unknown as typeof fetch;
  const { status, error } = await unavailable(comboConfig(["a", "b"]));
  expect(status).toBe(503);
  expect(error.code).toBe("combo_unavailable");
  expect(error.combo).toEqual({ cause: "quota", targets: 2, attempted: 0, causes: { quota: 2 } });
});

test("targets cooled by access refusals report permission", async () => {
  coolComboTarget("pair", { provider: "a", model: "model-a" }, { retryAfter: "60", status: 401 });
  coolComboTarget("pair", { provider: "b", model: "model-b" }, { retryAfter: "60", status: 403 });
  globalThis.fetch = (async () => { throw new Error("no target may be dispatched"); }) as unknown as typeof fetch;
  const { error } = await unavailable(comboConfig(["a", "b"]));
  expect(error.combo).toEqual({ cause: "permission", targets: 2, attempted: 0, causes: { permission: 2 } });
});

test("different exclusions report mixed with per-class counts", async () => {
  setCachedProviderQuotaForTests("spent", { updatedAt: Date.now(), weeklyPercent: 100 } as ProviderQuota);
  coolComboTarget("pair", { provider: "busy", model: "model-busy" }, { retryAfter: "60", status: 503 });
  const cfg = comboConfig(["spent", "busy", "off", "metered"]);
  (cfg.providers.off as { disabled?: boolean }).disabled = true;
  (cfg.combos!.pair!.targets[3] as { metered?: boolean }).metered = true;
  globalThis.fetch = (async () => { throw new Error("no target may be dispatched"); }) as unknown as typeof fetch;
  const { error } = await unavailable(cfg);
  expect(error.code).toBe("combo_unavailable");
  expect(error.combo).toEqual({ cause: "mixed", targets: 4, attempted: 0,
    causes: { quota: 1, transient: 1, unavailable: 1, unsupported: 1 } });
  // The readable message is unchanged; the fields carry no provider, model or combo name.
  expect(String(error.message)).toContain("target 1 (spent): quota exhausted");
  expect(JSON.stringify(error.combo)).not.toMatch(/spent|busy|model-|pair/);
});

test("an exhausted ladder answered from a pre-cooled quota target reports quota and the attempts it made", async () => {
  coolComboTarget("pair", { provider: "a", model: "model-a" }, { retryAfter: "120", status: 429 });
  globalThis.fetch = (async () => Response.json({ error: { message: "invalid api key", type: "invalid_request_error" } },
    { status: 401 })) as unknown as typeof fetch;
  const { status, error } = await unavailable(comboConfig(["a", "b"]));
  expect(status).toBe(503);
  expect(error.combo).toEqual({ cause: "quota", targets: 2, attempted: 1, causes: { quota: 1 } });
});
