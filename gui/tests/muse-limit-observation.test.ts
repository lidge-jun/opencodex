import { expect, test } from "bun:test";
import { formatMuseResetCountdown, museLimitReport, withMuseLimitObservation } from "../src/muse-limit-observation";

const now = Date.parse("2026-10-25T19:08:28Z");
const row = { provider: "meta-muse", accountLogLabel: "o527765", status: 429, errorCode: "rate_limit_exceeded", timestamp: now,
  upstreamError: "Subscription quota exhausted. Your usage window resets at 2026-10-26T00:00:00Z." };

test("the visible countdown decreases and stops at zero", () => {
  expect(formatMuseResetCountdown(now + 3661000, now)).toBe("01:01:01");
  expect(formatMuseResetCountdown(now + 3661000, now + 1000)).toBe("01:01:00");
  expect(formatMuseResetCountdown(now - 1000, now)).toBe("00:00:00");
});

test("an explicit subscription refusal preserves the observed reset without inventing a window type", () => {
  const report = museLimitReport(row, "o527765", now);
  expect(report?.observed).toBe(true);
  expect(report?.updatedAt).toBe(now);
  expect(report?.quota).toEqual({ customWindows: [{ label: "Muse Code", percent: 100, resetAt: Date.parse("2026-10-26T00:00:00Z") }], updatedAt: now });
});

test("expired, malformed, unrelated and cross-account evidence never becomes a quota", () => {
  for (const invalid of [
    { ...row, status: 200 }, { ...row, provider: "xai" }, { ...row, accountLogLabel: "o000000" },
    { ...row, upstreamError: "Too many requests. Try again later." }, { ...row, timestamp: now + 1000 },
    { ...row, upstreamError: "Subscription quota exhausted. Your usage window resets at 2099-10-26T00:00:00Z." },
  ]) expect(museLimitReport(invalid, "o527765", now)).toBeNull();
  expect(museLimitReport(row, "o527765", Date.parse("2026-10-26T00:00:00Z"))).toBeNull();
});

test("an existing measured quota is authoritative and needs no fallback reads", async () => {
  const reports = { "meta-muse": { updatedAt: now, quota: { weeklyPercent: 40 } } };
  const fetcher = (() => { throw Error("unexpected request"); }) as typeof fetch;
  expect(await withMuseLimitObservation(reports, "", new AbortController().signal, fetcher)).toBe(reports);
});

test("fallback reads bind the latest request to the active account and never invoke inference", async () => {
  const paths: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input); paths.push(url);
    if (url === "/api/providers") return Response.json([{ name: "meta-muse", authMode: "oauth", baseUrl: "https://api.meta.ai/v1" }]);
    if (url.startsWith("/api/oauth/accounts?")) return Response.json({ activeAccountId: "fixture-muse-account", accounts: [{ id: "fixture-muse-account" }] });
    if (url === "/api/logs?provider=meta-muse&account=o527765") return Response.json({ logs: [{ ...row, timestamp: Date.now(), upstreamError: `Subscription quota exhausted. Your usage window resets at ${new Date(Date.now() + 3600000).toISOString().replace(/\.\d{3}Z$/, "Z")}.` }] });
    throw Error("unexpected request");
  }) as typeof fetch;
  const result = await withMuseLimitObservation({}, "", new AbortController().signal, fetcher);
  expect(result["meta-muse"]?.observed).toBe(true);
  expect(paths).toHaveLength(3);
  expect(paths.every(url => url.startsWith("/api/"))).toBe(true);
});

test("a newer successful request suppresses an older exhaustion reading", async () => {
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/providers") return Response.json([{ name: "meta-muse", authMode: "oauth", baseUrl: "https://api.meta.ai/v1" }]);
    if (url.startsWith("/api/oauth/accounts?")) return Response.json({ activeAccountId: "fixture-muse-account", accounts: [{ id: "fixture-muse-account" }] });
    return Response.json({ logs: [{ ...row, status: 200 }] });
  }) as typeof fetch;
  expect(await withMuseLimitObservation({}, "", new AbortController().signal, fetcher)).toEqual({});
});

test("disabled, redirected, paused and reauthentication accounts cannot create a countdown", async () => {
  for (const state of ["disabled", "redirected", "paused", "reauth"]) {
    const paths: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input); paths.push(url);
      if (url === "/api/providers") return Response.json([{ name: "meta-muse", authMode: "oauth", disabled: state === "disabled", baseUrl: state === "redirected" ? "https://example.com/v1" : "https://api.meta.ai/v1" }]);
      if (url.startsWith("/api/oauth/accounts?")) return Response.json({ activeAccountId: "fixture-muse-account", accounts: [{ id: "fixture-muse-account", paused: state === "paused", needsReauth: state === "reauth" }] });
      throw Error("the log must not be read for an unavailable provider/account");
    }) as typeof fetch;
    expect(await withMuseLimitObservation({}, "", new AbortController().signal, fetcher)).toEqual({});
    expect(paths.some(path => path.startsWith("/api/logs"))).toBe(false);
  }
});

test("a local evidence failure preserves other provider reports", async () => {
  const reports = { openai: { updatedAt: now, quota: { weeklyPercent: 20 } } };
  const failed = (async () => new Response(null, { status: 503 })) as typeof fetch;
  expect(await withMuseLimitObservation(reports, "", new AbortController().signal, failed)).toBe(reports);
});

async function observeFinalizedRows(logs: unknown[]) {
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "https://dashboard.example");
    if (url.pathname === "/api/providers") return Response.json([{ name: "meta-muse", authMode: "oauth", baseUrl: "https://api.meta.ai/v1" }]);
    if (url.pathname === "/api/oauth/accounts") return Response.json({ activeAccountId: "fixture-muse-account", accounts: [{ id: "fixture-muse-account" }] });
    if (url.pathname === "/api/logs") {
      expect(url.searchParams.get("provider")).toBe("meta-muse");
      expect(url.searchParams.get("account")).toBe("o527765");
      const limit = Number(url.searchParams.get("limit") ?? logs.length);
      // Match queryRequestLogs: limits select the tail of finalization-ordered retained rows.
      return Response.json({ logs: logs.slice(-limit) });
    }
    throw Error("unexpected request");
  }) as typeof fetch;
  return withMuseLimitObservation({}, "", new AbortController().signal, fetcher);
}

function overlappingRows() {
  const started = Date.now() - 2000;
  const refusal = { ...row, timestamp: started,
    upstreamError: `Subscription quota exhausted. Your usage window resets at ${new Date(started + 3600000).toISOString().replace(/\.\d{3}Z$/, "Z")}.` };
  return { refusal, success: { ...refusal, status: 200, timestamp: started + 1000 } };
}

test("a later-started success wins when an older refusal finalizes last", async () => {
  const { refusal, success } = overlappingRows();
  expect(await observeFinalizedRows([success, refusal])).toEqual({});
});

test("a later-started refusal remains visible when an older success finalizes last", async () => {
  const { refusal, success } = overlappingRows();
  const latest = { ...refusal, timestamp: success.timestamp };
  const reports = await observeFinalizedRows([latest, { ...success, timestamp: refusal.timestamp }]);
  expect(reports["meta-muse"]?.observed).toBe(true);
  expect(reports["meta-muse"]?.updatedAt).toBe(latest.timestamp);
});

test("a later-started success is retained beyond fifty older finalizations", async () => {
  const { refusal, success } = overlappingRows();
  const older = Array.from({ length: 51 }, (_, index) => ({ ...refusal, timestamp: refusal.timestamp - index }));
  expect(await observeFinalizedRows([success, ...older])).toEqual({});
});

test("latest-start selection ignores malformed timestamps and other final provider/account identities", async () => {
  const { refusal, success } = overlappingRows();
  const reports = await observeFinalizedRows([
    refusal, { ...success, provider: "xai" }, { ...success, accountLogLabel: "o000000" },
    { ...success, timestamp: "later" }, { ...success, timestamp: null }, {}, [], null,
  ]);
  expect(reports["meta-muse"]?.observed).toBe(true);
  expect(reports["meta-muse"]?.updatedAt).toBe(refusal.timestamp);
});
