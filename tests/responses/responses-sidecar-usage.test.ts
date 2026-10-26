import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KIRO_COMPLETION_TOOL_NAME } from "../../src/adapters/kiro-constants";
import { encodeMessage } from "../../src/lib/eventstream-decoder";
import { saveCredential } from "../../src/oauth/store";
import { handleResponses } from "../../src/server/responses/core";
import { responseWithDeferredRequestLog } from "../../src/server/relay";
import type { RequestLogContext } from "../../src/server/request-log";
import { readUsageEntries, resetUsageReadCacheForTests } from "../../src/usage/log";
import { summarizeUsage } from "../../src/usage/summary";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const originalHome = process.env.OPENCODEX_HOME;
let home: string;
let isolated: IsolatedCodexHome;
let release: (() => void) | undefined;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ocx-sidecar-usage-"));
  isolated = installIsolatedCodexHome("ocx-sidecar-usage-codex-");
  process.env.OPENCODEX_HOME = home;
  release = acquireOwnedSpendHome();
  resetUsageReadCacheForTests();
  await saveCredential("kiro", {
    access: "synthetic-kiro-access", refresh: "synthetic-kiro-refresh",
    expires: Date.now() + 3_600_000, source: "oauth",
    kiro: { apiRegion: "us-east-1" },
  });
});

afterEach(() => {
  release?.();
  release = undefined;
  globalThis.fetch = originalFetch;
  resetUsageReadCacheForTests();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  isolated.restore();
  removeTreeWithRetry(home);
});

/** Build the synthetic Kiro completion frames consumed by all three dispatch fixtures. */
function completedAnswer(): Response {
  const frame = (type: string, value: Record<string, unknown>) => encodeMessage(
    { ":message-type": "event", ":event-type": type },
    new TextEncoder().encode(JSON.stringify(value)),
  );
  const tool = { name: KIRO_COMPLETION_TOOL_NAME, toolUseId: "synthetic-completion" };
  return new Response(Buffer.concat([
    frame("toolUseEvent", tool),
    frame("toolUseEvent", { ...tool, input: JSON.stringify({ answer: "Completed fixture answer." }) }),
    frame("toolUseEvent", { ...tool, stop: true }),
  ]), { headers: { "content-type": "application/vnd.amazon.eventstream" } });
}

describe("sidecar prompt usage accounting", () => {
  for (const sidecar of ["none", "web-search", "images"] as const) {
    test(`${sidecar}: persists the full Kiro prompt estimate into daily activity`, async () => {
      let sends = 0;
      globalThis.fetch = (async input => {
        const url = input instanceof Request ? input.url : String(input);
        if (!/^https:\/\/runtime\.[a-z0-9-]+\.kiro\.dev\/$/.test(url)) {
          throw new Error("Unexpected network target blocked by sidecar usage fixture");
        }
        sends++;
        return completedAnswer();
      }) as typeof fetch;
      const config = {
        defaultProvider: "kiro", emptyCompletionRetry: false,
        webSearchSidecar: { backend: "exa", exaApiKey: "synthetic-search-key" },
        images: { bridgeEnabled: true },
        providers: {
          kiro: { adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev",
            authMode: "oauth", models: ["claude-opus-5.5"] },
          xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1",
            authMode: "key", apiKey: "synthetic-image-key", models: ["fixture"] },
        },
      } as OcxConfig;
      const request = new Request("http://127.0.0.1/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "kiro/claude-opus-5.5", stream: true, store: false,
          input: [
            { role: "user", content: "Earlier fixture context. ".repeat(4096) },
            { role: "assistant", content: "Earlier fixture answer." },
            { role: "user", content: "Continue." },
          ],
          tools: [
            { type: "function", name: "fixture_lookup", parameters: { type: "object", properties: {} } },
            ...(sidecar === "none" ? [] : [{ type: sidecar === "web-search" ? "web_search" : "image_generation" }]),
          ],
        }),
      });
      const log: RequestLogContext = { model: "", provider: "" };
      const started = Date.now();
      const response = await handleResponses(request, config, log);
      const logged = responseWithDeferredRequestLog(response, `sidecar-usage-${sidecar}`, started, log);
      expect(response.status).toBe(200);
      expect(await logged.text()).toContain("Completed fixture answer.");
      expect(sends).toBe(1);

      const entries = readUsageEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.usageStatus).toBe("estimated");
      // The newest user message is tiny; the persisted request and physical attempt must
      // still include the replayed prompt, just as the ordinary dispatch path does.
      expect(entries[0]!.usage!.inputTokens).toBeGreaterThan(20_000);
      expect(entries[0]!.attempts![0]!.usage!.inputTokens).toBeGreaterThan(20_000);
      const summary = summarizeUsage(entries, "today", Date.now());
      expect(summary.summary.requests).toBe(1);
      expect(summary.summary.totalTokens).toBe(entries[0]!.totalTokens!);
      expect(summary.days[0]!.totalTokens).toBeGreaterThan(20_000);
      expect(summary.models[0]!.inputTokens).toBeGreaterThan(20_000);
    });
  }
});
