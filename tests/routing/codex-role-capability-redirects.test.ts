import { afterEach, expect, test } from "bun:test";
import { fetchArtificialAnalysisTable, loadCapabilityTable } from "../../src/codex/role-capability";
import type { OcxConfig } from "../../src/types";

const nativeFetch = globalThis.fetch;
const analysisUrl = "https://artificialanalysis.ai/api/v2/data/llms/models";
afterEach(() => { globalThis.fetch = nativeFetch; });

for (const status of [302, 307]) {
  test(`Artificial Analysis HTTP ${status} is refused without forwarding the key`, async () => {
    const received: (string | null)[] = [];
    const initial: (string | null)[] = [];
    const sink = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { received.push(request.headers.get("x-api-key")); return new Response(); } });
    const first = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { initial.push(request.headers.get("x-api-key")); return new Response(null, { status, headers: { location: `${sink.url}target` } }); } });
    const requests: string[] = [];
    const transport = Object.assign((input: string | URL | Request, init?: RequestInit) => {
      requests.push(String(input));
      return nativeFetch(`${first.url}models`, init);
    }, { preconnect: nativeFetch.preconnect }) as typeof fetch;
    try {
      await expect(fetchArtificialAnalysisTable("aa-redirect-fixture", transport)).rejects.toThrow();
      globalThis.fetch = transport;
      const result = await loadCapabilityTable({ codexRoleCapability: { artificialAnalysis: { apiKey: `aa-redirect-${status}` } } } as OcxConfig);
      expect(result).toMatchObject({ source: null, domains: {}, fallbackReason: "Artificial Analysis could not be read" });
      expect(requests).toEqual([analysisUrl, analysisUrl]);
      expect(initial).toEqual(["aa-redirect-fixture", `aa-redirect-${status}`]);
      expect(received).toEqual([]);
    } finally { await first.stop(true); await sink.stop(true); }
  });
}
