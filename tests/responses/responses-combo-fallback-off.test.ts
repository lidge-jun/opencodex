/**
 * OCX-11 at the combo site (src/server/responses/core-combo.ts): with provider or model fallback
 * off, a failed target answers fallback_refused and the next target is never contacted; with the
 * policy absent or on, the ladder hops exactly as before. Also the proactive case, where the first
 * failover target is already cooling down.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearComboSelectionState, clearComboTargetCooldowns, coolComboTarget } from "../../src/combos";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { handleComboResponses, handleResponses } from "../../src/server/responses/core";
import { executeComboResponses } from "../../src/server/responses/core-combo";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { clearFallbackEventsForTests, recentFallbackEvents } from "../../src/routing/fallback-policy";
import type { OcxConfig } from "../../src/types";
import type { OcxFallbackConfig } from "../../src/types/fallback";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { chatSuccess } from "../helpers/combo-failover-upstream";

const originalFetch = globalThis.fetch;
let releaseSpendHome: (() => void) | undefined;
const reset = (): void => {
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
  clearFallbackEventsForTests();
};
beforeEach(() => {
  reset();
  releaseSpendHome = acquireOwnedSpendHome();
});
afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = originalFetch;
  reset();
});

const provider = (name: string) => ({
  adapter: "openai-chat",
  baseUrl: "https://" + name + ".example/v1",
  authMode: "key",
  apiKey: "sk-" + name,
  models: ["model-" + name, "model-" + name + "-mini"],
});

function config(fallback: OcxFallbackConfig | undefined, second = { provider: "backup", model: "model-backup" }): OcxConfig {
  return {
    defaultProvider: "primary",
    providers: { primary: provider("primary"), backup: provider("backup") },
    combos: {
      fan: {
        strategy: "failover",
        targets: [{ provider: "primary", model: "model-primary" }, second],
      },
    },
    ...(fallback ? { fallback } : {}),
  } as unknown as OcxConfig;
}

function upstream(): string[] {
  const hosts: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    hosts.push(url.host);
    const body = init?.body ? JSON.parse(String(init.body)) as { model?: string } : {};
    if (url.host.startsWith("primary") && body.model === "model-primary") {
      return Response.json({ error: { message: "rate limited", type: "rate_limit_error" } }, { status: 429, headers: { "retry-after": "7" } });
    }
    return chatSuccess("ok from " + url.host, body.model ?? "model");
  }) as typeof fetch;
  return hosts;
}

async function run(cfg: OcxConfig, admission?: { kind: "configured"; keyId: string; source: "header" }): Promise<Response> {
  const req = new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "combo/fan", stream: false, input: "hello" }),
  });
  return executeComboResponses(req, await req.clone().json(), "fan", cfg, { model: "", provider: "" }, {
    translatorBudget: createTranslatorBudget(),
    ...(admission ? { admission: admission as never } : {}),
  }, { handleComboResponses, handleResponses });
}

describe("combo fallback off", () => {
  test("absent policy: the ladder hops to the next provider as before", async () => {
    const hosts = upstream();
    const response = await run(config(undefined));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-opencodex-fallback")).toBeNull();
    expect(hosts).toEqual(["primary.example", "backup.example"]);
    expect(recentFallbackEvents()).toMatchObject([{ outcome: "taken", kind: "provider", route: "combo/fan", trigger: "rate_limited" }]);
  });

  test("provider fallback off globally: the 429 is refused and the backup is never contacted", async () => {
    const hosts = upstream();
    const response = await run(config({ provider: false }));
    expect(response.status).toBe(429);
    expect(response.headers.get("x-opencodex-fallback")).toBe("refused");
    expect(response.headers.get("retry-after")).toBe("7");
    const body = await response.json() as { error: { code: string; fallback: Record<string, string> } };
    expect(body.error.code).toBe("fallback_refused");
    expect(body.error.fallback).toMatchObject({ kind: "provider", scope: "global", from: "primary/model-primary", to: "backup/model-backup" });
    expect(hosts).toEqual(["primary.example"]);
  });

  test("route on beats global off; model off does not refuse a provider hop", async () => {
    const hosts = upstream();
    expect((await run(config({ provider: false, routes: { "combo/fan": { provider: true } } }))).status).toBe(200);
    clearComboTargetCooldowns();
    expect((await run(config({ model: false }))).status).toBe(200);
    expect(hosts).toEqual(["primary.example", "backup.example", "primary.example", "backup.example"]);
  });

  test("model fallback off refuses a same-provider model hop", async () => {
    const hosts = upstream();
    const response = await run(config({ model: false }, { provider: "primary", model: "model-primary-mini" }));
    expect(response.status).toBe(429);
    expect(((await response.json()) as { error: { fallback: { kind: string } } }).error.fallback.kind).toBe("model");
    expect(hosts).toEqual(["primary.example"]);
  });

  test("a device set to off refuses even when the route allows it", async () => {
    const hosts = upstream();
    const cfg = config({ routes: { "combo/fan": { provider: true } }, devices: { key_hub: { provider: false } } });
    const response = await run(cfg, { kind: "configured", keyId: "key_hub", source: "header" });
    expect(response.status).toBe(429);
    expect(((await response.json()) as { error: { fallback: { scope: string } } }).error.fallback.scope).toBe("device");
    expect(hosts).toEqual(["primary.example"]);
    // Another device is unaffected.
    expect((await run(cfg, { kind: "configured", keyId: "key_other", source: "header" })).status).toBe(200);
  });

  test("proactive: a cooling first target refuses before any send when provider fallback is off", async () => {
    const hosts = upstream();
    coolComboTarget("fan", { provider: "primary", model: "model-primary" }, { retryAfter: "120", status: 429 });
    const response = await run(config({ provider: false }));
    expect(response.status).toBe(429);
    expect(((await response.json()) as { error: { fallback: { trigger: string } } }).error.fallback.trigger).toBe("cooldown");
    expect(hosts).toEqual([]);
    // Allowed, the same state starts on the backup as before.
    expect((await run(config(undefined))).status).toBe(200);
    expect(hosts).toEqual(["backup.example"]);
  });
});
