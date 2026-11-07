import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { flushConfigDirHardeningAndReaps } from "../../src/config/paths";
import { buildDesktop3pRegistry, desktop3pAlias } from "../../src/claude/desktop-3p";
import { clearClaudeInboundDebug, getClaudeInboundDebugEntries } from "../../src/claude/inbound-debug";
import { seedCodexModelEntitlementsForTests, resetCodexModelEntitlementCacheForTests } from "../../src/codex/model-entitlements";
import { waitForNativeMainStartupGate } from "../../src/codex/native-profile-startup";
import { resetDebugSettingsForTests, setDebugSettings } from "../../src/lib/debug-settings";
import { startServer } from "../../src/server";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { managementFetch as fetch } from "../helpers/management-auth";
import { ownedServiceHomeInspection } from "../helpers/owned-service-home-inspection";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";

const originalFetch = globalThis.fetch;
let testDir: string;
let previousHome: string | undefined;
let previousDesktopConfigDir: string | undefined;
let isolatedCodexHome: IsolatedCodexHome;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousDesktopConfigDir = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  testDir = mkdtempSync(join(tmpdir(), "ocx-native-fast-1m-"));
  process.env.OPENCODEX_HOME = testDir;
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(testDir, "claude-desktop");
  isolatedCodexHome = installIsolatedCodexHome("ocx-native-fast-1m-codex-");
  writeFileSync(join(isolatedCodexHome.path, "auth.json"), JSON.stringify({
    tokens: { access_token: "native-fast-1m-fixture", account_id: "native-fast-1m-account" },
  }), "utf8");
  seedCodexModelEntitlementsForTests("main", ["gpt-6.1-sol"]);
  buildDesktop3pRegistry([], []);
  clearClaudeInboundDebug();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  resetDebugSettingsForTests();
  clearClaudeInboundDebug();
  buildDesktop3pRegistry([], []);
  resetCodexModelEntitlementCacheForTests();
  await flushConfigDirHardeningAndReaps(testDir);
  await flushConfigDirHardeningAndReaps(isolatedCodexHome.path);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousDesktopConfigDir === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = previousDesktopConfigDir;
  isolatedCodexHome.restore();
  removeTreeWithRetry(testDir);
});

for (const style of ["readable", "desktop3p"] as const) {
  test(`combined native Fast + 1M selector reaches Responses with priority (${style})`, async () => {
    const captured: Array<Record<string, unknown>> = [];
    const upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        expect(new URL(req.url).pathname).toBe("/responses");
        captured.push(await req.json() as Record<string, unknown>);
        return new Response([
          'event: response.created\ndata: {"response":{"id":"resp_fast_1m","status":"in_progress"}}\n\n',
          'event: response.output_text.delta\ndata: {"delta":"Hello"}\n\n',
          'event: response.completed\ndata: {"response":{"status":"completed","usage":{"input_tokens":10,"output_tokens":2}}}\n\n',
        ].join(""), { headers: { "content-type": "text/event-stream" } });
      },
    });
    // Exercise the canonical native transport against a loopback fixture, without live credentials.
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.origin === "https://chatgpt.com") {
        expect(url.pathname).toBe("/backend-api/codex/responses");
        return originalFetch(new URL("/responses", upstream.url), init);
      }
      return originalFetch(input, init);
    }) as typeof globalThis.fetch;
    saveConfig({
      port: 0,
      defaultProvider: "openai",
      fastRows: true,
      providers: {
        openai: {
          adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward", codexAccountMode: "direct",
        },
      },
      claudeCode: { autoContext: true },
    });
    const server = startServer(0, {
      inspectNativeCodexOwnership: ownedServiceHomeInspection("native Fast + 1M ingress fixture"),
    });
    try {
      expect((await waitForNativeMainStartupGate()).status).toBe("ready");
      buildDesktop3pRegistry(["gpt-6.1-sol"], []);
      setDebugSettings({ claude: true });
      const base = style === "readable"
        ? "ocx-claude-native--gpt-6.1-sol"
        : desktop3pAlias("native", "gpt-6.1-sol");
      if (style === "desktop3p") expect(base).toMatch(/^claude-opus-4-8-[a-z][0-9a-z]{2}$/);
      const response = await fetch(new URL("/v1/messages", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "context-1m-2025-08-07",
        },
        body: JSON.stringify({
          model: `${base}--fast[1m]`,
          max_tokens: 128,
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("message_stop");
      expect(captured).toHaveLength(1);
      expect(captured[0]!.model).toBe("gpt-6.1-sol");
      expect(captured[0]!.service_tier).toBe("priority");
      // [1m] is stripped before Fast decode. The context signal is the caller's beta header,
      // observed at ingress; OpenAI Responses has no Anthropic context-beta wire field.
      expect(getClaudeInboundDebugEntries()).toEqual([
        expect.objectContaining({
          endpoint: "messages", model: "gpt-6.1-sol", resolvedModel: "gpt-6.1-sol",
          anthropicBeta: "context-1m-2025-08-07",
        }),
      ]);
    } finally {
      await server.stop(true);
      await upstream.stop(true);
    }
  }, { timeout: SERVER_BUDGET_MS });
}
