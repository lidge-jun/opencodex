import { afterEach, describe, expect, test } from "bun:test";
import { fetchArtificialAnalysisTable, fetchCapabilityTable, loadCapabilityTable } from "../../src/codex/role-capability";
import type { OcxConfig } from "../../src/types";

const nativeFetch = globalThis.fetch;
const analysisUrl = "https://artificialanalysis.ai/api/v2/data/llms/models";
afterEach(() => { globalThis.fetch = nativeFetch; });

function redirectServers(status: number) {
  const receivedKeys: (string | null)[] = [];
  const initialKeys: (string | null)[] = [];
  const sink = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      receivedKeys.push(request.headers.get("x-api-key"));
      return Response.json({ data: [] });
    },
  });
  const first = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      initialKeys.push(request.headers.get("x-api-key"));
      return new Response(null, { status, headers: { location: `${sink.url}redirect-target` } });
    },
  });
  const pending: Promise<Response>[] = [];
  return {
    receivedKeys, initialKeys,
    settle: () => Promise.allSettled(pending),
    send(init?: RequestInit) {
      // Replace only the fixed first endpoint; Bun handles the actual redirect and DUT options.
      const request = nativeFetch(`${first.url}models`, init);
      pending.push(request);
      return request;
    },
    async stop() {
      await Promise.allSettled(pending);
      await first.stop(true);
      await sink.stop(true);
    },
  };
}

describe("role capability redirect boundaries", () => {
  for (const status of [302, 307]) {
    test(`Artificial Analysis refuses HTTP ${status} before sending its key to another origin`, async () => {
      const servers = redirectServers(status);
      const key = `redirect-fixture-${status}`;
      const transport = Object.assign((input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe(analysisUrl);
        return servers.send(init);
      }, { preconnect: nativeFetch.preconnect }) as typeof fetch;
      try {
        const outcome = await fetchArtificialAnalysisTable(key, transport).then(() => "accepted", () => "refused");
        expect(servers.initialKeys).toEqual([key]);
        expect(servers.receivedKeys).toEqual([]);
        expect(outcome).toBe("refused");
      } finally { await servers.stop(); }
    });

    for (const enabled of [undefined, false, true]) {
      test(`HTTP ${status} fallback honors Hugging Face consent ${String(enabled)}`, async () => {
        const servers = redirectServers(status);
        const key = `redirect-consent-fixture-${status}-${String(enabled)}`;
        const requests: string[] = [];
        globalThis.fetch = Object.assign((input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          requests.push(url);
          if (url === analysisUrl) return servers.send(init);
          return Promise.resolve(new Response("fixture unavailable", { status: 503 }));
        }, { preconnect: nativeFetch.preconnect }) as typeof fetch;
        try {
          const config = { codexRoleCapability: {
            artificialAnalysis: { apiKey: key },
            ...(enabled === undefined ? {} : { huggingFace: { enabled } }),
          } } as OcxConfig;
          const outcome = await loadCapabilityTable(config).then(
            table => ({ table, error: null }), error => ({ table: null, error }),
          );
          expect(servers.initialKeys).toEqual([key]);
          expect(servers.receivedKeys).toEqual([]);
          expect(requests).toEqual(enabled ? [analysisUrl,
            "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset/resolve/main/text/latest-00000-of-00001.parquet",
            "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset/resolve/main/agent/latest-00000-of-00001.parquet",
          ] : [analysisUrl]);
          if (enabled) {
            expect(outcome.error).toBeInstanceOf(Error);
            expect(outcome.error.message).toBe("HTTP 503");
          } else {
            expect(outcome.error).toBeNull();
            expect(outcome.table?.domains).toEqual({});
            expect(outcome.table?.fallbackReason).toContain("Artificial Analysis could not be read");
            expect(outcome.table?.fallbackReason).toContain("Hugging Face downloads are disabled");
            expect(JSON.stringify(outcome.table)).not.toContain(key);
          }
        } finally { await servers.stop(); }
      });
    }

    test(`Hugging Face refuses HTTP ${status} instead of downloading from an arbitrary origin`, async () => {
      const servers = redirectServers(status);
      const requests: string[] = [];
      const transport = Object.assign((input: string | URL | Request, init?: RequestInit) => {
        requests.push(String(input));
        return servers.send(init);
      }, { preconnect: nativeFetch.preconnect }) as typeof fetch;
      try {
        const outcome = await fetchCapabilityTable(transport).then(() => "accepted", () => "refused");
        await servers.settle();
        expect(requests).toHaveLength(2);
        expect(requests.every(url => url.startsWith("https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset/resolve/main/"))).toBe(true);
        expect(servers.initialKeys).toEqual([null, null]);
        expect(servers.receivedKeys).toEqual([]);
        expect(outcome).toBe("refused");
      } finally { await servers.stop(); }
    });
  }
});
