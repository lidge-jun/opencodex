import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { antigravityCliUserAgent, antigravityUserAgent } from "../../src/adapters/client-fingerprint";
import { probeAntigravityUsageQuota, setAntigravityAccountQuotaTransportForTests } from "../../src/providers/quota/antigravity";

import { PROXY_ENV_KEYS } from "../../src/lib/proxy-env";

const proxyKeys = PROXY_ENV_KEYS.flatMap(key => [key, key.toLowerCase()]);
const originalProxyEnv = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));
beforeEach(() => { for (const key of proxyKeys) delete process.env[key]; });
afterEach(() => {
  for (const key of proxyKeys) {
    if (originalProxyEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalProxyEnv[key];
  }
});

const summaryUrl = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const modelsUrl = "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
const summary = { groups: [{ displayName: "Gemini", buckets: [{ window: "5h", remainingFraction: 0.6 }] }] };
const models = { models: { gemini: { quotaInfo: { remainingFraction: 0.75 } } } };

function transport(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; userAgent: string | null; authorization: string | null; body: string }> = [];
  setAntigravityAccountQuotaTransportForTests({
    resolveAddresses: async () => ({ hostname: "daily-cloudcode-pa.googleapis.com", addresses: [{ address: "142.250.0.1", family: 4 }], privateNetwork: false }),
    pinnedPost: async (url, _address, body, _signal, options) => {
      const headers = new Headers(options?.headers);
      calls.push({ url, userAgent: headers.get("user-agent"), authorization: headers.get("authorization"), body });
      const response = responses.shift();
      if (!response) throw new Error("Unexpected extra quota request");
      if (response instanceof Error) throw response;
      return response;
    },
  });
  return calls;
}

function expectedCall(url: string, userAgent = url === summaryUrl ? antigravityCliUserAgent() : antigravityUserAgent()) {
  return { url, userAgent, authorization: "Bearer test-access", body: JSON.stringify({ project: "test-project" }) };
}

afterEach(() => setAntigravityAccountQuotaTransportForTests(null));

describe("Antigravity quota summary 403 compatibility retry (#5940)", () => {
  for (const cancelFails of [false, true]) {
    test(`retries once with identical bearer and project, even when cancellation ${cancelFails ? "fails" : "succeeds"}`, async () => {
      let cancelled = false;
      const denied = new Response(new ReadableStream({ cancel() {
        cancelled = true;
        if (cancelFails) throw new Error("cancel failed");
      } }), { status: 403 });
      const calls = transport([denied, Response.json(summary)]);
      const result = await probeAntigravityUsageQuota("test-access", "test-project");
      expect(cancelled).toBe(true);
      expect(calls).toEqual([expectedCall(summaryUrl), expectedCall(summaryUrl, "antigravity/1.0")]);
      expect(result).toMatchObject({ kind: "available", source: "google-antigravity:retrieveUserQuotaSummary", quota: { customWindows: [{ label: "Gem", percent: 40 }] } });
    });
  }

  test("successful CLI summary needs no retry", async () => {
    const calls = transport([Response.json(summary)]);
    expect((await probeAntigravityUsageQuota("test-access", "test-project")).kind).toBe("available");
    expect(calls).toEqual([expectedCall(summaryUrl)]);
  });

  test("summary is requested with the CLI fingerprint so the Argon group is reported", async () => {
    // Live CCA shape: the Argon group is present only for the CLI client family.
    const liveSummary = { groups: [
      { displayName: "Gemini Models", buckets: [
        { bucketId: "gemini-weekly", window: "weekly", resetTime: "2026-11-03T05:10:46Z", remainingFraction: 1 },
        { bucketId: "gemini-5h", window: "5h", resetTime: "2026-10-27T10:10:46Z", remainingFraction: 1 },
      ] },
      { displayName: "Claude and GPT models", buckets: [
        { bucketId: "3p-weekly", window: "weekly", resetTime: "2026-11-03T05:10:46Z", remainingFraction: 1 },
        { bucketId: "3p-5h", window: "5h", resetTime: "2026-10-27T10:10:46Z", remainingFraction: 1 },
      ] },
      { displayName: "Gemini 4 Argon", buckets: [
        { bucketId: "gemini-argon-wtu-weekly", displayName: "Gemini 4 Argon Weekly Limit", window: "weekly", resetTime: "2026-11-01T11:46:46Z", remainingFraction: 0.75 },
      ] },
    ] };
    const calls = transport([Response.json(liveSummary)]);
    const result = await probeAntigravityUsageQuota("test-access", "test-project");
    expect(calls[0]?.userAgent).toStartWith("antigravity/cli/");
    expect(result).toMatchObject({ kind: "available", source: "google-antigravity:retrieveUserQuotaSummary" });
    if (result.kind !== "available") {
      throw new Error("expected available quota");
    }
    expect(result.quota.customWindows?.map(window => window.label)).toEqual(["Gem", "Gem (Weekly)", "Cla", "Cla (Weekly)", "Argon (Weekly)"]);
    expect(result.quota.customWindows?.at(-1)).toMatchObject({ label: "Argon (Weekly)", modelId: "gemini-4-argon", percent: 25 });
  });

  test("401 is not retried", async () => {
    const calls = transport([new Response(null, { status: 401 })]);
    expect(await probeAntigravityUsageQuota("test-access", "test-project")).toMatchObject({ kind: "unavailable", failure: "access_denied" });
    expect(calls).toEqual([expectedCall(summaryUrl)]);
  });

  for (const status of [401, 403, 302]) {
    test(`retry status ${status} stops without further requests`, async () => {
      const calls = transport([new Response(null, { status: 403 }), new Response(null, { status, headers: { location: "https://redirect.example/" } })]);
      expect(await probeAntigravityUsageQuota("test-access", "test-project")).toMatchObject({ kind: "unavailable", failure: status === 302 ? "redirect_blocked" : "access_denied" });
      expect(calls).toEqual([expectedCall(summaryUrl), expectedCall(summaryUrl, "antigravity/1.0")]);
    });
  }

  for (const failure of [new Error("transport failed"), new Response(null, { status: 500 }), Response.json({})]) {
    test(`retry failure (${failure instanceof Error ? "transport" : failure.status}) recovers through IDE models probe`, async () => {
      const calls = transport([new Response(null, { status: 403 }), failure, Response.json(models)]);
      expect(await probeAntigravityUsageQuota("test-access", "test-project")).toMatchObject({ kind: "available", source: "google-antigravity:fetchAvailableModels", quota: { customWindows: [{ label: "Gem", percent: 25 }, { label: "gemini", modelId: "gemini", percent: 25 }] } });
      expect(calls).toEqual([expectedCall(summaryUrl), expectedCall(summaryUrl, "antigravity/1.0"), expectedCall(modelsUrl)]);
    });
  }

  for (const [status, failure] of [[302, "redirect_blocked"], [401, "access_denied"], [403, "access_denied"], [429, "rate_limited"], [503, "upstream_error"]] as const) {
    test(`models fallback status ${status} maps to ${failure}`, async () => {
      const calls = transport([new Response(null, { status: 500 }), new Response(null, { status, headers: { location: "https://redirect.example/" } })]);
      expect(await probeAntigravityUsageQuota("test-access", "test-project")).toMatchObject({ kind: "unavailable", failure });
      expect(calls).toEqual([expectedCall(summaryUrl), expectedCall(modelsUrl)]);
    });
  }
});
