import { afterEach, describe, expect, test } from "bun:test";
import { clearEconomicState, getEconomicQuotaSnapshot, reserveEconomicSelection, setEconomicQuotaSnapshot } from "../src/combos";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";
import { catalogConvergenceFactory } from "./helpers/catalog-convergence";
import { ManagementRequest } from "./helpers/management-auth";

const NOW = Date.parse("2026-08-09T12:00:00.000Z");

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "included",
    providers: {
      included: { adapter: "openai-chat", baseUrl: "https://included.example", models: ["m"], apiKey: "secret-123" },
      payg: { adapter: "openai-chat", baseUrl: "https://payg.example", models: ["m"], apiKey: "other-secret" },
    },
    economicAllowances: {
      promo: {
        unit: "credits",
        capacity: 10,
        window: { kind: "expiresAt", expiresAt: NOW + 60 * 60_000 },
        rollover: false,
        source: "manual",
        rates: { inputPerMillion: 1 },
        staleAfterMs: 60 * 60 * 1000,
      },
    },
    combos: {
      bulk: {
        strategy: "economy",
        economy: { unknownQuota: "deprioritize" },
        targets: [
          { provider: "included", model: "m", allowances: ["promo"] },
          { provider: "payg", model: "m", pricing: { inputUsdPerMillion: 0.2 } },
        ],
      },
    },
  };
}

async function request(
  cfg: OcxConfig,
  method: string,
  path: string,
  body?: unknown,
  rawBody?: string,
): Promise<Response | null> {
  const init: RequestInit = { method, headers: {} };
  if (rawBody !== undefined) {
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    init.body = rawBody;
  } else if (body !== undefined) {
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const req = new ManagementRequest(`http://localhost${path}`, init);
  return handleManagementAPI(req, new URL(req.url), cfg, {
    createManagementConvergeCodex: catalogConvergenceFactory(),
  });
}

afterEach(() => clearEconomicState());

describe("manual economic snapshot API", () => {
  test("PUT stores normalized snapshot and GET returns it", async () => {
    const cfg = config();
    const put = await request(cfg, "PUT", "/api/economic-allowances/promo/snapshot", {
      remaining: 7.5,
      updatedAt: NOW,
      windowStart: NOW - 1000,
      resetAt: NOW + 60 * 60_000,
      expiresAt: NOW + 60 * 60_000,
      source: "manual",
      confidence: "authoritative",
    });
    expect(put?.status).toBe(200);
    const putBody = await put!.json() as Record<string, unknown>;
    expect(putBody.allowanceId).toBe("promo");
    expect((putBody.snapshot as Record<string, unknown>).remaining).toBe(7.5);
    expect((putBody.snapshot as Record<string, unknown>).source).toBe("manual");
    expect((putBody.snapshot as Record<string, unknown>).confidence).toBe("authoritative");
    const dump = JSON.stringify(putBody);
    expect(dump).not.toContain("secret-123");
    expect(dump).not.toContain("apiKey");

    const get = await request(cfg, "GET", "/api/economic-allowances/promo/snapshot");
    expect(get?.status).toBe(200);
    const getBody = await get!.json() as Record<string, unknown>;
    expect(getBody.state).toBe("present");
    expect((getBody.snapshot as Record<string, unknown>).remaining).toBe(7.5);
    expect(JSON.stringify(getBody)).not.toContain("secret-123");
  });

  test("GET returns unknown state when no snapshot exists", async () => {
    const cfg = config();
    const res = await request(cfg, "GET", "/api/economic-allowances/promo/snapshot");
    expect(res?.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.allowanceId).toBe("promo");
    expect(body.snapshot).toBeNull();
    expect(body.state).toBe("unknown");
  });

  test("unknown allowance id returns 404", async () => {
    const cfg = config();
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const res = await request(cfg, method, "/api/economic-allowances/missing/snapshot", method === "PUT" ? { remaining: 1, updatedAt: NOW, source: "manual", confidence: "authoritative" } : undefined);
      expect(res?.status).toBe(404);
      const body = await res!.json() as Record<string, unknown>;
      expect(String(body.error)).toContain("unknown");
    }
  });

  test("PUT rejects non-object body", async () => {
    const cfg = config();
    const res = await request(cfg, "PUT", "/api/economic-allowances/promo/snapshot", undefined, "[]");
    expect(res?.status).toBe(400);
  });

  test("PUT validates remaining finite non-negative", async () => {
    const cfg = config();
    for (const remaining of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, "1"]) {
      const res = await request(cfg, "PUT", "/api/economic-allowances/promo/snapshot", {
        remaining,
        updatedAt: NOW,
        source: "manual",
        confidence: "authoritative",
      });
      expect(res?.status).toBe(400);
      const body = await res!.json() as Record<string, unknown>;
      expect(String(body.error)).toContain("remaining");
    }
  });

  test("PUT validates updatedAt finite non-negative", async () => {
    const cfg = config();
    for (const updatedAt of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const res = await request(cfg, "PUT", "/api/economic-allowances/promo/snapshot", {
        remaining: 5,
        updatedAt,
        source: "manual",
        confidence: "authoritative",
      });
      expect(res?.status).toBe(400);
    }
  });

  test("PUT validates timestamp fields", async () => {
    const cfg = config();
    for (const field of ["windowStart", "resetAt", "expiresAt"] as const) {
      const res = await request(cfg, "PUT", "/api/economic-allowances/promo/snapshot", {
        remaining: 5,
        updatedAt: NOW,
        source: "manual",
        confidence: "authoritative",
        [field]: -1,
      });
      expect(res?.status).toBe(400);
      const body = await res!.json() as Record<string, unknown>;
      expect(String(body.error)).toContain(field);
      const nanRes = await request(cfg, "PUT", "/api/economic-allowances/promo/snapshot", {
        remaining: 5,
        updatedAt: NOW,
        source: "manual",
        confidence: "authoritative",
        [field]: Number.NaN,
      });
      expect(nanRes?.status).toBe(400);
    }
  });

  test("PUT validates source and confidence enums", async () => {
    const cfg = config();
    const badSource = await request(cfg, "PUT", "/api/economic-allowances/promo/snapshot", {
      remaining: 5,
      updatedAt: NOW,
      source: "bad",
      confidence: "authoritative",
    });
    expect(badSource?.status).toBe(400);
    expect(String((await badSource!.json() as Record<string, unknown>).error)).toContain("source");

    const badConfidence = await request(cfg, "PUT", "/api/economic-allowances/promo/snapshot", {
      remaining: 5,
      updatedAt: NOW,
      source: "manual",
      confidence: "bad",
    });
    expect(badConfidence?.status).toBe(400);
    expect(String((await badConfidence!.json() as Record<string, unknown>).error)).toContain("confidence");
  });

  test("DELETE clears one snapshot without clearing others", async () => {
    const cfg = config();
    (cfg.economicAllowances as Record<string, unknown>)["other"] = {
      unit: "credits",
      capacity: 10,
      window: { kind: "balance" },
      source: "manual",
    };
    await request(cfg, "PUT", "/api/economic-allowances/promo/snapshot", {
      remaining: 5,
      updatedAt: NOW,
      source: "manual",
      confidence: "authoritative",
    });
    await request(cfg, "PUT", "/api/economic-allowances/other/snapshot", {
      remaining: 9,
      updatedAt: NOW,
      source: "manual",
      confidence: "authoritative",
    });
    const del = await request(cfg, "DELETE", "/api/economic-allowances/promo/snapshot");
    expect(del?.status).toBe(200);
    const delBody = await del!.json() as Record<string, unknown>;
    expect(delBody.cleared).toBe(true);

    const getPromo = await request(cfg, "GET", "/api/economic-allowances/promo/snapshot");
    expect((await getPromo!.json() as Record<string, unknown>).state).toBe("unknown");

    const getOther = await request(cfg, "GET", "/api/economic-allowances/other/snapshot");
    const otherBody = await getOther!.json() as Record<string, unknown>;
    expect(otherBody.state).toBe("present");
    expect((otherBody.snapshot as Record<string, unknown>).remaining).toBe(9);
    expect(getEconomicQuotaSnapshot("other")?.remaining).toBe(9);
    expect(getEconomicQuotaSnapshot("promo")).toBeUndefined();
  });

  test("PUT rejects invalid method and never persists snapshot into config", async () => {
    const cfg = config();
    const put = await request(cfg, "PUT", "/api/economic-allowances/promo/snapshot", {
      remaining: 3,
      updatedAt: NOW,
      source: "manual",
      confidence: "authoritative",
    });
    expect(put?.status).toBe(200);
    expect((cfg.economicAllowances as Record<string, unknown>).promo).not.toHaveProperty("remaining");
    expect((cfg as Record<string, unknown>).snapshots).toBeUndefined();
    expect(getEconomicQuotaSnapshot("promo")?.remaining).toBe(3);

    const patch = await request(cfg, "PATCH", "/api/economic-allowances/promo/snapshot", {
      remaining: 1,
      updatedAt: NOW,
      source: "manual",
      confidence: "authoritative",
    });
    expect(patch?.status).toBe(405);
  });

  test("PUT never exposes credentials in output and preserves existing combos", async () => {
    const cfg = config();
    const res = await request(cfg, "PUT", "/api/economic-allowances/promo/snapshot", {
      remaining: 2,
      updatedAt: NOW,
      source: "manual",
      confidence: "authoritative",
    });
    const text = JSON.stringify(await res!.clone().json());
    expect(text).not.toContain("secret");
    expect(text).not.toContain("apiKey");

    const combosRes = await request(cfg, "GET", "/api/combos");
    expect(combosRes?.status).toBe(200);
    const combosBody = await combosRes!.json() as { combos: Array<Record<string, unknown>> };
    expect(combosBody.combos.some(c => c.id === "bulk")).toBe(true);
  });

  test("malformed JSON is rejected", async () => {
    const cfg = config();
    const res = await request(cfg, "PUT", "/api/economic-allowances/promo/snapshot", undefined, "{");
    expect(res?.status).toBe(400);
  });

  test("PUT ignores and never echoes secret-looking unknown fields", async () => {
    const cfg = config();
    const res = await request(cfg, "PUT", "/api/economic-allowances/promo/snapshot", {
      remaining: 4,
      updatedAt: NOW,
      source: "manual",
      confidence: "authoritative",
      apiKey: "secret-xyz-123",
      authorization: "Bearer secret-token",
    });
    expect(res?.status).toBe(200);
    const text = JSON.stringify(await res!.clone().json());
    expect(text).not.toContain("secret-xyz-123");
    expect(text).not.toContain("secret-token");
    expect(getEconomicQuotaSnapshot("promo")).not.toHaveProperty("apiKey");
  });

  test("PUT rejects precision-lossy timestamps", async () => {
    const cfg = config();
    const res = await request(cfg, "PUT", "/api/economic-allowances/promo/snapshot", {
      remaining: 4,
      updatedAt: Number.MAX_SAFE_INTEGER + 1,
      source: "manual",
      confidence: "authoritative",
    });
    expect(res?.status).toBe(400);
  });

  test("malformed percent-encoding in allowance id returns 400", async () => {
    const cfg = config();
    const res = await request(cfg, "GET", "/api/economic-allowances/%zz/snapshot");
    expect(res?.status).toBe(400);
  });

  test("PUT without clearReservations returns 409 when reservations are in flight", async () => {
    const now = Date.now();
    const cfg = config();
    cfg.economicAllowances!.promo = {
      ...cfg.economicAllowances!.promo!,
      window: { kind: "expiresAt", expiresAt: now + 60 * 60_000 },
    };
    const snapshot = { remaining: 1, updatedAt: now, expiresAt: now + 60 * 60_000, source: "manual" as const, confidence: "authoritative" as const };
    setEconomicQuotaSnapshot("promo", snapshot);
    const first = reserveEconomicSelection(cfg, "bulk", { inputTokens: 1_000_000, outputTokens: 0, kind: "configured" }, now);
    expect(first.target?.provider).toBe("included");
    expect(first.reservationId).toBeDefined();

    const put = await request(cfg, "PUT", "/api/economic-allowances/promo/snapshot", snapshot);
    expect(put?.status).toBe(409);
    const body = await put!.json() as { activeReservations?: number };
    expect(body.activeReservations).toBeGreaterThan(0);
    const second = reserveEconomicSelection(cfg, "bulk", { inputTokens: 1_000_000, outputTokens: 0, kind: "configured" }, now);
    expect(second.target?.provider).toBe("payg");
  });

  test("PUT snapshot clears in-flight reservations when clearReservations:true", async () => {
    const now = Date.now();
    const cfg = config();
    cfg.economicAllowances!.promo = {
      ...cfg.economicAllowances!.promo!,
      window: { kind: "expiresAt", expiresAt: now + 60 * 60_000 },
    };
    const snapshot = { remaining: 1, updatedAt: now, expiresAt: now + 60 * 60_000, source: "manual" as const, confidence: "authoritative" as const };
    setEconomicQuotaSnapshot("promo", snapshot);
    const first = reserveEconomicSelection(cfg, "bulk", { inputTokens: 1_000_000, outputTokens: 0, kind: "configured" }, now);
    expect(first.target?.provider).toBe("included");
    expect(first.reservationId).toBeDefined();
    const second = reserveEconomicSelection(cfg, "bulk", { inputTokens: 1_000_000, outputTokens: 0, kind: "configured" }, now);
    expect(second.target?.provider).toBe("payg");

    const put = await request(cfg, "PUT", "/api/economic-allowances/promo/snapshot", { ...snapshot, clearReservations: true });
    expect(put?.status).toBe(200);
    const third = reserveEconomicSelection(cfg, "bulk", { inputTokens: 1_000_000, outputTokens: 0, kind: "configured" }, now);
    expect(third.target?.provider).toBe("included");
    expect(third.reservationId).toBeDefined();
  });

  test("DELETE without clearReservations returns 409 when reservations are in flight", async () => {
    const now = Date.now();
    const cfg = config();
    cfg.economicAllowances!.promo = {
      ...cfg.economicAllowances!.promo!,
      window: { kind: "expiresAt", expiresAt: now + 60 * 60_000 },
    };
    const snapshot = { remaining: 1, updatedAt: now, expiresAt: now + 60 * 60_000, source: "manual" as const, confidence: "authoritative" as const };
    setEconomicQuotaSnapshot("promo", snapshot);
    const first = reserveEconomicSelection(cfg, "bulk", { inputTokens: 1_000_000, outputTokens: 0, kind: "configured" }, now);
    expect(first.target?.provider).toBe("included");
    expect(first.reservationId).toBeDefined();

    const del = await request(cfg, "DELETE", "/api/economic-allowances/promo/snapshot");
    expect(del?.status).toBe(409);
  });

  test("DELETE snapshot clears in-flight reservations when clearReservations=true", async () => {
    const now = Date.now();
    const cfg = config();
    cfg.economicAllowances!.promo = {
      ...cfg.economicAllowances!.promo!,
      window: { kind: "expiresAt", expiresAt: now + 60 * 60_000 },
    };
    const snapshot = { remaining: 1, updatedAt: now, expiresAt: now + 60 * 60_000, source: "manual" as const, confidence: "authoritative" as const };
    setEconomicQuotaSnapshot("promo", snapshot);
    const first = reserveEconomicSelection(cfg, "bulk", { inputTokens: 1_000_000, outputTokens: 0, kind: "configured" }, now);
    expect(first.target?.provider).toBe("included");
    expect(first.reservationId).toBeDefined();

    const del = await request(cfg, "DELETE", "/api/economic-allowances/promo/snapshot?clearReservations=true");
    expect(del?.status).toBe(200);
    setEconomicQuotaSnapshot("promo", snapshot);
    const second = reserveEconomicSelection(cfg, "bulk", { inputTokens: 1_000_000, outputTokens: 0, kind: "configured" }, now);
    expect(second.target?.provider).toBe("included");
    expect(second.reservationId).toBeDefined();
  });

  test("GET /api/economic-allowances lists configured allowances and snapshot state", async () => {
    const cfg = config();
    setEconomicQuotaSnapshot("promo", { remaining: 3, updatedAt: NOW, source: "manual", confidence: "authoritative" });
    const res = await request(cfg, "GET", "/api/economic-allowances");
    expect(res?.status).toBe(200);
    const body = await res!.json() as { allowances: Array<{ id: string; state: string; snapshot: { remaining: number } | null }> };
    expect(body.allowances.some(a => a.id === "promo" && a.state === "present" && a.snapshot?.remaining === 3)).toBe(true);
  });
});
