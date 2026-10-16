import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { antigravityCliUserAgent, antigravityUserAgent } from "../../src/adapters/client-fingerprint";
import { PROXY_ENV_KEYS } from "../../src/lib/proxy-env";
import { accountResetTimestamp, rankAccountsByHeadroom, rankAccountsByResetFirst } from "../../src/oauth/account-quota-rank";
import { cachedProviderQuotaIsExhausted } from "../../src/combos/resolve";
import { getCachedProviderAccountQuota, setCachedProviderAccountQuotaForTests } from "../../src/providers/quota";
import { sweepExpiredProviderAccountQuotaRows } from "../../src/providers/quota/account-cache";
import { ACCOUNT_QUOTA_TTL_MS } from "../../src/providers/quota-wire";
import { providerWindowObservations } from "../../src/quota/window-mapping";
import {
  probeAntigravityUsageQuota,
  setAntigravityAccountQuotaTransportForTests,
} from "../../src/providers/quota/antigravity";

const proxyEnv = PROXY_ENV_KEYS.flatMap(key => [key, key.toLowerCase()]);
const originalProxyEnv = Object.fromEntries(proxyEnv.map(key => [key, process.env[key]]));

beforeEach(() => {
  for (const key of proxyEnv) delete process.env[key];
});

afterEach(() => {
  setAntigravityAccountQuotaTransportForTests(null);
  setCachedProviderAccountQuotaForTests("google-antigravity", "first", null);
  setCachedProviderAccountQuotaForTests("google-antigravity", "second", null);
  for (const key of proxyEnv) {
    if (originalProxyEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalProxyEnv[key];
  }
});

function setModelsResponse(models: unknown): void {
  setAntigravityAccountQuotaTransportForTests({
    resolveAddresses: async () => ({
      hostname: "daily-cloudcode-pa.googleapis.com",
      addresses: [{ address: "142.250.0.1", family: 4 }],
      privateNetwork: false,
    }),
    pinnedPost: async url => url.endsWith("retrieveUserQuotaSummary")
      ? new Response(null, { status: 404 })
      : new Response(JSON.stringify({ models }), { status: 200, headers: { "content-type": "application/json" } }),
  });
}

describe("Antigravity model quota evidence", () => {
  function argonTransport(summary: Response, cliModels: () => Response | Promise<Response>, ideModels?: unknown) {
    const calls: Array<{ url: string; userAgent: string | null; authorization: string | null; project: unknown }> = [];
    setAntigravityAccountQuotaTransportForTests({
      resolveAddresses: async () => ({ hostname: "daily-cloudcode-pa.googleapis.com", addresses: [{ address: "142.250.0.1", family: 4 }], privateNetwork: false }),
      pinnedPost: async (url, _address, body, _signal, options) => {
        const headers = new Headers(options?.headers);
        calls.push({ url, userAgent: headers.get("user-agent"), authorization: headers.get("authorization"), project: JSON.parse(body).project });
        if (url.endsWith("retrieveUserQuotaSummary")) return summary;
        return headers.get("user-agent") === antigravityCliUserAgent() ? await cliModels() : Response.json({ models: ideModels });
      },
    });
    return calls;
  }

  const quotaSummary = () => Response.json({ groups: [
    { displayName: "Gemini", buckets: [{ window: "5h", remainingFraction: 0.75 }, { window: "weekly", remainingFraction: 0.5 }] },
    { displayName: "Claude", buckets: [{ window: "5h", remainingFraction: 0.9 }, { window: "weekly", remainingFraction: 0.8 }] },
  ] });

  test("a usable summary supplements exact CLI-only Argon measurements without replacing family windows", async () => {
    const resetTime = "2026-11-01T12:00:00Z";
    const calls = argonTransport(quotaSummary(), () => Response.json({ models: Object.fromEntries([
      ...Array.from({ length: 300 }, (_, i) => [`aux-${i}`, { quotaInfo: { remainingFraction: 0 } }]),
      ...["low", "medium", "high"].map(effort => [`gemini-4-argon-${effort}`, { quotaInfo: { remainingFraction: 0.2, resetTime } }]),
      ["gemini-4-argonaut", { quotaInfo: { remainingFraction: 0 } }],
    ]) }));
    const result = await probeAntigravityUsageQuota("synthetic-token", "synthetic-project");
    expect(result.kind).toBe("available");
    if (result.kind !== "available") return;
    expect(result.source).toBe("google-antigravity:retrieveUserQuotaSummary");
    expect(result.quota.customWindows?.filter(window => window.modelId === undefined)).toEqual([
      { label: "Gem", percent: 25 }, { label: "Gem (Weekly)", percent: 50 },
      { label: "Cla", percent: 10 }, { label: "Cla (Weekly)", percent: 20 },
    ]);
    expect(result.quota.customWindows?.filter(window => window.modelId !== undefined)).toEqual([
      { label: "gemini-4-argon", modelId: "gemini-4-argon-low", percent: 80, resetAt: Date.parse(resetTime) },
    ]);
    expect(calls.map(call => call.userAgent)).toEqual([antigravityUserAgent(), antigravityCliUserAgent()]);
    expect(calls.every(call => call.authorization === "Bearer synthetic-token" && call.project === "synthetic-project")).toBe(true);
    expect(providerWindowObservations(result.quota).map(observation => observation.window)).toEqual(["custom:Gem", "custom:Gem (Weekly)", "custom:Cla", "custom:Cla (Weekly)"]);
    expect(cachedProviderQuotaIsExhausted(result.quota, Date.now(), "gemini-4-argon")).toBe(false);
    setCachedProviderAccountQuotaForTests("google-antigravity", "first", result.quota);
    setCachedProviderAccountQuotaForTests("google-antigravity", "second", { updatedAt: Date.now(), customWindows: [{ label: "Gem", percent: 60 }] });
    expect(rankAccountsByHeadroom("google-antigravity", ["second", "first"], "gemini-4-argon")).toEqual(["first", "second"]);
  });

  test.each(["percent", "reset", "missing-reset", "invalid-reset", "window", "bucket"])("Argon %s differences retain separate measurements", async difference => {
    const resetTime = "2026-11-01T12:00:00Z";
    const models = Object.fromEntries(["low", "medium", "high"].map(effort => {
      const different = effort === "high";
      return [`gemini-4-argon-${effort}`, { quotaInfo: {
        remainingFraction: different && difference === "percent" ? 0.4 : 0.2,
        ...(different && difference === "missing-reset" ? {} : { resetTime: difference === "invalid-reset" ? `invalid-${different ? "high" : "low"}` : different && difference === "reset" ? "2026-11-02T12:00:00Z" : resetTime }),
        ...(difference === "window" ? { tier: different ? "weekly" : "5h" } : {}),
        ...(difference === "bucket" ? { bucketId: different ? "weekly-bucket" : "short-bucket" } : {}),
      } }];
    }));
    const calls = argonTransport(quotaSummary(), () => Response.json({ models }));
    const result = await probeAntigravityUsageQuota("synthetic-token", "synthetic-project");
    expect(result.kind).toBe("available");
    if (result.kind !== "available") return;
    const rows = result.quota.customWindows!.filter(window => window.modelId !== undefined);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.label).toBe(`gemini-4-argon${difference === "window" ? " · 5h" : ""}`);
    expect(rows[0]!.percent).toBe(80);
    expect(rows[1]!.modelId).toBe("gemini-4-argon-high");
    expect(rows[1]!.percent).toBe(difference === "percent" ? 60 : 80);
    expect(rows[1]!.resetAt).toBe(difference === "missing-reset" || difference === "invalid-reset" ? undefined : Date.parse(difference === "reset" ? "2026-11-02T12:00:00Z" : resetTime));
    expect(calls).toHaveLength(2);
  });

  test("same-wire repeated Argon windows keep their multiplicity when effort aliases collapse", async () => {
    const calls = argonTransport(quotaSummary(), () => Response.json({ models: Object.fromEntries(
      ["low", "medium", "high"].map(effort => [`gemini-4-argon-${effort}`, { quotaInfos: [
        { remainingFraction: 0.2 }, { remainingFraction: 0.2 },
      ] }]),
    ) }));
    const result = await probeAntigravityUsageQuota("synthetic-token", "synthetic-project");
    expect(result.kind).toBe("available");
    if (result.kind !== "available") return;
    expect(result.quota.customWindows!.filter(window => window.modelId !== undefined)).toEqual([
      { label: "gemini-4-argon", modelId: "gemini-4-argon-low", percent: 80 },
      { label: "gemini-4-argon #2", modelId: "gemini-4-argon-low", percent: 80 },
    ]);
    expect(calls).toHaveLength(2);
  });

  test("an IDE Argon ladder is also collapsed without an extra metadata request", async () => {
    const calls = argonTransport(new Response(null, { status: 404 }), () => { throw new Error("unexpected CLI probe"); }, Object.fromEntries(
      ["low", "medium", "high"].map(effort => [`gemini-4-argon-${effort}`, { quotaInfo: { remainingFraction: 0.2 } }]),
    ));
    const result = await probeAntigravityUsageQuota("synthetic-token", "synthetic-project");
    expect(result.kind).toBe("available");
    if (result.kind !== "available") return;
    expect(result.quota.customWindows).toEqual([
      { label: "Gem", percent: 80 }, { label: "gemini-4-argon", modelId: "gemini-4-argon-low", percent: 80 },
    ]);
    expect(calls).toHaveLength(2);
  });

  test("identical nested Argon window metadata ignores object key order", async () => {
    argonTransport(quotaSummary(), () => Response.json({ models: {
      "gemini-4-argon-low": { quotaInfo: { remaining: { remainingFraction: 0.2 }, window: { id: "short", kind: "5h" } } },
      "gemini-4-argon-high": { quotaInfo: { window: { kind: "5h", id: "short" }, remaining: { remainingFraction: 0.2 } } },
    } }));
    const result = await probeAntigravityUsageQuota("synthetic-token", "synthetic-project");
    expect(result.kind).toBe("available");
    if (result.kind !== "available") return;
    expect(result.quota.customWindows!.filter(window => window.modelId !== undefined)).toEqual([
      { label: "gemini-4-argon", modelId: "gemini-4-argon-low", percent: 80 },
    ]);
  });

  test("equivalent nested Argon counter formats collapse but keep other remaining metadata", async () => {
    argonTransport(quotaSummary(), () => Response.json({ models: {
      "gemini-4-argon-low": { quotaInfo: { remaining: { remainingFraction: 0.2, bucket: "short" } } },
      "gemini-4-argon-medium": { quotaInfo: { remaining: { remainingPercentage: 0.2, bucket: "short" } } },
      "gemini-4-argon-high": { quotaInfo: { remaining: { remainingFraction: 0.2, bucket: "weekly" } } },
    } }));
    const result = await probeAntigravityUsageQuota("synthetic-token", "synthetic-project");
    expect(result.kind).toBe("available");
    if (result.kind !== "available") return;
    expect(result.quota.customWindows!.filter(window => window.modelId !== undefined).map(window => window.label)).toEqual([
      "gemini-4-argon", "gemini-4-argon-high",
    ]);
  });

  test("Argon aliases can complete an existing shared display row at the diagnostic ceiling", async () => {
    setModelsResponse(Object.fromEntries([
      ...Array.from({ length: 255 }, (_, i) => [`aux-${i}`, { quotaInfo: { remainingFraction: 0.2 } }]),
      ...["low", "medium", "high"].map(effort => [`gemini-4-argon-${effort}`, { quotaInfo: { remainingFraction: 0.2 } }]),
    ]));
    const result = await probeAntigravityUsageQuota("synthetic-token", "synthetic-project");
    expect(result.kind).toBe("available");
    if (result.kind !== "available") return;
    expect(result.quota.customWindows!.filter(window => window.modelId !== undefined)).toHaveLength(256);
    expect(result.quota.customWindows).toContainEqual({ label: "gemini-4-argon", modelId: "gemini-4-argon-low", percent: 80 });
  });

  test.each(["empty", "denied", "redirect", "malformed", "transport"])("optional Argon %s keeps the usable summary unchanged", async failure => {
    const calls = argonTransport(quotaSummary(), () => {
      if (failure === "transport") throw new Error("synthetic transport failure");
      if (failure === "denied") return new Response(null, { status: 403 });
      if (failure === "redirect") return new Response(null, { status: 302, headers: { location: "https://redirect.example/" } });
      if (failure === "malformed") return new Response("invalid JSON");
      return Response.json({ models: { "gemini-4-argon-high": { quotaInfo: {} } } });
    });
    const result = await probeAntigravityUsageQuota("synthetic-token", "synthetic-project");
    expect(result.kind).toBe("available");
    if (result.kind !== "available") return;
    expect(result.quota.customWindows).toHaveLength(4);
    expect(result.quota.customWindows?.every(window => window.modelId === undefined)).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test("IDE fallback retains its family counters while CLI adds only Argon diagnostics", async () => {
    const calls = argonTransport(new Response(null, { status: 404 }), () => Response.json({ models: {
      "gemini-4-argon-high": { quotaInfo: { remainingFraction: 0 } },
      "gemini-3.8-flash-high": { quotaInfo: { remainingFraction: 0 } },
    } }), { "gemini-3.8-flash-high": { quotaInfo: { remainingFraction: 0.75 } } });
    const result = await probeAntigravityUsageQuota("synthetic-token", "synthetic-project");
    expect(result.kind).toBe("available");
    if (result.kind !== "available") return;
    expect(result.quota.customWindows).toEqual([
      { label: "Gem", percent: 25 },
      { label: "gemini-3.8-flash-high", modelId: "gemini-3.8-flash-high", percent: 25 },
      { label: "gemini-4-argon-high", modelId: "gemini-4-argon-high", percent: 100 },
    ]);
    expect(calls.map(call => call.userAgent)).toEqual([antigravityUserAgent(), antigravityUserAgent(), antigravityCliUserAgent()]);
    expect(cachedProviderQuotaIsExhausted(result.quota, Date.now(), "gemini-4-argon")).toBe(false);
  });

  test("an IDE model response already containing Argon avoids a duplicate display probe", async () => {
    const calls = argonTransport(new Response(null, { status: 404 }), () => { throw new Error("unexpected duplicate probe"); }, {
      "gemini-4-argon-high": { quotaInfo: { remainingFraction: 0.8 } },
    });
    const result = await probeAntigravityUsageQuota("synthetic-token", "synthetic-project");
    expect(result.kind).toBe("available");
    expect(calls).toHaveLength(2);
  });

  test.each([false, true])("an optional denial releases its body even when cancellation fails: %s", async cancelFails => {
    let cancelled = false;
    argonTransport(quotaSummary(), () => new Response(new ReadableStream({ cancel() {
      cancelled = true;
      if (cancelFails) throw new Error("synthetic cancellation failure");
    } }), { status: 403 }));
    const result = await probeAntigravityUsageQuota("synthetic-token", "synthetic-project");
    expect(result.kind).toBe("available");
    expect(cancelled).toBe(true);
  });

  test("Argon supplementation keeps the shared diagnostic ceiling and all family windows", async () => {
    argonTransport(new Response(null, { status: 404 }), () => Response.json({ models: {
      "gemini-4-argon-high": { quotaInfo: { remainingFraction: 0.2 } },
    } }), Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`gemini-aux-${i}`, { quotaInfo: { remainingFraction: 0.75 } }])));
    const result = await probeAntigravityUsageQuota("synthetic-token", "synthetic-project");
    expect(result.kind).toBe("available");
    if (result.kind !== "available") return;
    expect(result.quota.customWindows?.filter(window => window.modelId !== undefined)).toHaveLength(256);
    expect(result.quota.customWindows?.filter(window => window.modelId === undefined)).toEqual([{ label: "Gem", percent: 25 }]);
    expect(result.quota.customWindows).toContainEqual({ label: "gemini-4-argon-high", modelId: "gemini-4-argon-high", percent: 80 });
  });

  test.each([undefined, "unknown-model", "gemini-4-argon"])("Argon tier labels never affect reset-first ordering (%s)", async requestedModel => {
    const resetTime = new Date(Date.now() + 3600_000).toISOString();
    argonTransport(quotaSummary(), () => Response.json({ models: {
      "gemini-4-argon-high": { quotaInfoByTier: { weekly: { remainingFraction: 0.2, resetTime } } },
    } }));
    const result = await probeAntigravityUsageQuota("synthetic-token", "synthetic-project");
    expect(result.kind).toBe("available");
    if (result.kind !== "available") return;
    setCachedProviderAccountQuotaForTests("google-antigravity", "first", { ...result.quota, customWindows: result.quota.customWindows?.filter(window => window.modelId === undefined) });
    setCachedProviderAccountQuotaForTests("google-antigravity", "second", result.quota);
    expect(accountResetTimestamp("google-antigravity", "second", requestedModel)).toBeNull();
    expect(rankAccountsByResetFirst("google-antigravity", ["first", "second"], requestedModel)).toEqual(["first", "second"]);
  });

  test("keeps bounded exact wire-model readings alongside unchanged first-seen family bars", async () => {
    setModelsResponse({
      "gemini-3.8-flash-high": {
        displayName: "Gemini Flash High",
        quotaInfo: { remainingFraction: 0.64, resetTime: "2026-11-01T12:00:00Z" },
      },
      "claude-sonnet-4-6": {
        quotaInfoByTier: { sonnet: { remainingFraction: 0.21, resetTime: "2026-11-02T12:00:00Z" } },
      },
      autocomplete: { quotaInfo: { remainingFraction: 0.01 } },
      malformed: { quotaInfo: { remainingFraction: "unknown" } },
      ["x".repeat(129)]: { quotaInfo: { remainingFraction: 0 } },
    });

    const result = await probeAntigravityUsageQuota("synthetic-token", "synthetic-project");
    expect(result.kind).toBe("available");
    if (result.kind !== "available") return;

    expect(result.quota.customWindows?.slice(0, 2)).toEqual([
      { label: "Gem", percent: 36, resetAt: Date.parse("2026-11-01T12:00:00Z") },
      { label: "Cla", percent: 79, resetAt: Date.parse("2026-11-02T12:00:00Z") },
    ]);
    expect(result.quota.customWindows).toContainEqual({
      label: "gemini-3.8-flash-high", modelId: "gemini-3.8-flash-high", percent: 36,
      resetAt: Date.parse("2026-11-01T12:00:00Z"),
    });
    expect(result.quota.customWindows).toContainEqual({
      label: "claude-sonnet-4-6 · sonnet", modelId: "claude-sonnet-4-6", percent: 79,
      resetAt: Date.parse("2026-11-02T12:00:00Z"),
    });
    expect(result.quota.customWindows).toContainEqual({
      label: "autocomplete", modelId: "autocomplete", percent: 99,
    });
    expect(result.quota.customWindows?.some(window => window.modelId === "malformed" || window.label.length > 128)).toBe(false);
  });

  test("multiple readings retain distinct bounded labels even when tiers truncate", async () => {
    const longModel = "gemini-" + "x".repeat(115);
    setModelsResponse({
      autocomplete: { quotaInfos: [{ remainingFraction: 0.8 }, { remainingFraction: 0.2 }] },
      [longModel]: { quotaInfoByTier: {
        "shared-prefix-one": { remainingFraction: 0.7 },
        "shared-prefix-two": { remainingFraction: 0.1 },
      } },
    });
    const result = await probeAntigravityUsageQuota("synthetic-token", "synthetic-project");
    expect(result.kind).toBe("available");
    if (result.kind !== "available") return;
    const rows = result.quota.customWindows!.filter(window => window.modelId !== undefined);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map(window => window.label)).size).toBe(4);
    expect(rows.every(window => window.label.length <= 128)).toBe(true);
    expect(rows.map(window => window.percent)).toEqual([20, 80, 30, 90]);
    expect(rows.map(window => window.modelId)).toEqual(["autocomplete", "autocomplete", longModel, longModel]);
  });

  test("bounds diagnostic rows without truncating later family evidence", async () => {
    setModelsResponse(Object.fromEntries([
      ...Array.from({ length: 300 }, (_, i) => [`aux-${i}`, { quotaInfo: { remainingFraction: 0.5 } }]),
      ["gemini-" + "x".repeat(129), { quotaInfo: { remainingFraction: 0.8 } }],
      ["claude-final", { quotaInfo: { remainingFraction: 0.6 } }],
    ]));
    const result = await probeAntigravityUsageQuota("synthetic-token", "synthetic-project");
    expect(result.kind).toBe("available");
    if (result.kind !== "available") return;
    expect(result.quota.customWindows?.filter(window => window.modelId !== undefined)).toHaveLength(256);
    expect(result.quota.customWindows?.filter(window => window.modelId === undefined)).toEqual([
      { label: "Gem", percent: 20 }, { label: "Cla", percent: 40 },
    ]);
  });

  test("a missing model listing remains unavailable rather than producing zero-usage evidence", async () => {
    setModelsResponse(null);
    expect(await probeAntigravityUsageQuota("synthetic-token", "synthetic-project"))
      .toMatchObject({ kind: "unavailable", failure: "response_unusable" });
  });

  test("a summary 403 remains an account-probe failure and does not fall through to model discovery", async () => {
    let modelRequests = 0;
    setAntigravityAccountQuotaTransportForTests({
      resolveAddresses: async () => ({
        hostname: "daily-cloudcode-pa.googleapis.com",
        addresses: [{ address: "142.250.0.1", family: 4 }],
        privateNetwork: false,
      }),
      pinnedPost: async url => {
        if (url.endsWith("fetchAvailableModels")) modelRequests += 1;
        return new Response(null, { status: 403 });
      },
    });
    expect(await probeAntigravityUsageQuota("synthetic-token", "synthetic-project"))
      .toMatchObject({ kind: "unavailable", failure: "access_denied" });
    expect(modelRequests).toBe(0);
  });

  test.each([undefined, "gemini-3.8-flash-high"])("model-specific rows do not alter quota account ranking (%s)", requestedModel => {
    setCachedProviderAccountQuotaForTests("google-antigravity", "first", {
      updatedAt: Date.now(),
      customWindows: [
        { label: "Gem", percent: 20 },
        { label: "gemini-3.8-flash-high", modelId: "gemini-3.8-flash-high", percent: 100 },
      ],
    });
    setCachedProviderAccountQuotaForTests("google-antigravity", "second", {
      updatedAt: Date.now(),
      customWindows: [
        { label: "Gem", percent: 40 },
        { label: "gemini-3.8-flash-high", modelId: "gemini-3.8-flash-high", percent: 0 },
      ],
    });
    expect(rankAccountsByHeadroom("google-antigravity", ["first", "second"], requestedModel))
      .toEqual(["first", "second"]);
  });

  test("model quota cache rows expire at the existing account quota TTL", () => {
    setCachedProviderAccountQuotaForTests("google-antigravity", "first", {
      updatedAt: Date.now(),
      customWindows: [{ label: "gemini-3.8-flash-high", modelId: "gemini-3.8-flash-high", percent: 24 }],
    });
    expect(sweepExpiredProviderAccountQuotaRows(Date.now() + ACCOUNT_QUOTA_TTL_MS)).toBeGreaterThan(0);
    expect(getCachedProviderAccountQuota("google-antigravity", "first")).toBeNull();
    expect(sweepExpiredProviderAccountQuotaRows(Date.now() + ACCOUNT_QUOTA_TTL_MS)).toBe(0);
  });

  test("model-specific diagnostic rows never prove combo target exhaustion", () => {
    expect(cachedProviderQuotaIsExhausted({
      updatedAt: Date.now(),
      customWindows: [{ label: "gemini-3.8-flash-high", modelId: "gemini-3.8-flash-high", percent: 100 }],
    }, Date.now(), "gemini-3.8-flash-high")).toBe(false);
  });

  test("model-specific diagnostic rows are not observed as quota-reset windows", async () => {
    const resetTime = "2026-11-01T12:00:00Z";
    setModelsResponse(Object.fromEntries([
      ["gemini-3.8-flash-high", { quotaInfo: { remainingFraction: 0.5, resetTime } }],
      ...Array.from({ length: 300 }, (_, i) => [`gemini-aux-${i}`, { quotaInfo: { remainingFraction: 0.5, resetTime } }]),
    ]));
    const result = await probeAntigravityUsageQuota("synthetic-token", "synthetic-project");
    expect(result.kind).toBe("available");
    if (result.kind !== "available") return;
    expect(result.quota.customWindows?.filter(window => window.modelId !== undefined)).toHaveLength(256);
    // One pool reset must notify once for its family, not once per diagnostic model row.
    expect(providerWindowObservations(result.quota).map(observation => observation.window)).toEqual(["custom:Gem"]);
  });
});
