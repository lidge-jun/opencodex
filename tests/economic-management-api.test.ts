import { afterEach, describe, expect, test } from "bun:test";
import { clearEconomicState, setEconomicQuotaSnapshot } from "../src/combos";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";
import { catalogConvergenceFactory } from "./helpers/catalog-convergence";

const NOW = Date.parse("2026-08-09T12:00:00.000Z");

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "included",
    providers: {
      included: { adapter: "openai-chat", baseUrl: "https://included.example", models: ["m"] },
      payg: { adapter: "openai-chat", baseUrl: "https://payg.example", models: ["m"] },
    },
    economicAllowances: {
      promo: {
        unit: "credits",
        capacity: 10,
        window: { kind: "expiresAt", expiresAt: Date.now() + 60 * 60_000 },
        rollover: false,
        source: "manual",
        rates: { inputPerMillion: 1 },
        staleAfterMs: 60 * 60 * 1000,
      },
    },
    combos: {},
  };
}

afterEach(() => clearEconomicState());

describe("economic combo management API", () => {
  test("PUT and GET preserve normalized economy fields", async () => {
    const cfg = config();
    const request = new Request("http://localhost/api/combos", {
      method: "PUT",
      headers: { "content-type": "application/json", host: "localhost" },
      body: JSON.stringify({
        id: "bulk-code",
        combo: {
          strategy: "economy",
          economy: { unknownQuota: "deprioritize", maxMarginalUsd: 0.1 },
          targets: [
            { provider: "included", model: "m", allowances: ["promo"] },
            { provider: "payg", model: "m", pricing: { inputUsdPerMillion: 0.2, outputUsdPerMillion: 0.8 } },
          ],
        },
      }),
    });
    const response = await handleManagementAPI(request, new URL(request.url), cfg, {
      createManagementConvergeCodex: catalogConvergenceFactory(),
    });
    expect(response?.status).toBe(200);
    expect(cfg.combos!["bulk-code"]?.strategy).toBe("economy");
    expect(cfg.combos!["bulk-code"]?.targets[0]?.allowances).toEqual(["promo"]);

    const get = new Request("http://localhost/api/combos", { headers: { host: "localhost" } });
    const getResponse = await handleManagementAPI(get, new URL(get.url), cfg, {
      createManagementConvergeCodex: catalogConvergenceFactory(),
    });
    const body = await getResponse!.json() as { combos: Array<Record<string, unknown>> };
    expect(body.combos[0]?.strategy).toBe("economy");
    expect(body.combos[0]?.economy).toEqual({ unknownQuota: "deprioritize", maxMarginalUsd: 0.1 });
  });

  test("explain endpoint returns a safe structured decision", async () => {
    const cfg = config();
    cfg.combos = {
      bulk: {
        strategy: "economy",
        economy: { unknownQuota: "deprioritize", maxMarginalUsd: 1 },
        targets: [
          { provider: "included", model: "m", allowances: ["promo"] },
          { provider: "payg", model: "m", pricing: { inputUsdPerMillion: 0.2 } },
        ],
      },
    };
    setEconomicQuotaSnapshot("promo", {
      remaining: 8,
      updatedAt: Date.now(),
      expiresAt: Date.now() + 60 * 60_000,
      source: "manual",
      confidence: "authoritative",
    });
    const request = new Request("http://localhost/api/combos/bulk/explain?inputTokens=1000000&outputTokens=10", { headers: { host: "localhost" } });
    const response = await handleManagementAPI(request, new URL(request.url), cfg, {
      createManagementConvergeCodex: catalogConvergenceFactory(),
    });
    const body = await response!.json() as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body.selectedTarget).toBe("included/m");
    expect(body.strategy).toBe("economy");
    expect(JSON.stringify(body)).not.toContain("apiKey");
  });

  test("explain rejects malformed percent-encoding with 400", async () => {
    const cfg = config();
    const request = new Request("http://localhost/api/combos/%zz/explain", { headers: { host: "localhost" } });
    const response = await handleManagementAPI(request, new URL(request.url), cfg, {
      createManagementConvergeCodex: catalogConvergenceFactory(),
    });
    expect(response?.status).toBe(400);
  });

  test("snapshot endpoint drives explain decisions end to end", async () => {
    const cfg = config();
    const api = async (path: string, init?: RequestInit) => {
      const request = new Request(`http://localhost${path}`, {
        ...init,
        headers: { ...(init?.headers ?? {}), host: "localhost" },
      });
      return handleManagementAPI(request, new URL(request.url), cfg, {
        createManagementConvergeCodex: catalogConvergenceFactory(),
      });
    };
    const explain = async (): Promise<{ selectedTarget: string }> => {
      const response = await api("/api/combos/bulk-code/explain?inputTokens=1000000&outputTokens=10");
      return response!.json() as Promise<{ selectedTarget: string }>;
    };

    const putCombo = await api("/api/combos", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "bulk-code",
        combo: {
          strategy: "economy",
          economy: { unknownQuota: "deprioritize", maxMarginalUsd: 1 },
          targets: [
            { provider: "included", model: "m", allowances: ["promo"] },
            { provider: "payg", model: "m", pricing: { inputUsdPerMillion: 0.2, outputUsdPerMillion: 0.8 } },
          ],
        },
      }),
    });
    expect(putCombo?.status).toBe(200);

    // Unknown promo quota → deprioritize → metered target wins.
    expect((await explain()).selectedTarget).toBe("payg/m");

    // Authoritative snapshot via the management endpoint flips the decision.
    const putSnapshot = await api("/api/economic-allowances/promo/snapshot", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        remaining: 8,
        updatedAt: Date.now(),
        source: "manual",
        confidence: "authoritative",
      }),
    });
    expect(putSnapshot?.status).toBe(200);
    expect((await explain()).selectedTarget).toBe("included/m");

    // Clearing the snapshot restores the unknown-quota policy.
    const delSnapshot = await api("/api/economic-allowances/promo/snapshot", { method: "DELETE" });
    expect(delSnapshot?.status).toBe(200);
    expect((await explain()).selectedTarget).toBe("payg/m");
  });
});
