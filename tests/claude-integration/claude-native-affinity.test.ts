import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";
import { clearMainAccountInfoCache } from "../../src/codex/auth-api";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { handleResponses } from "../../src/server/responses/core";
import { handleResponsesWithPolicyFallback } from "../../src/server/responses/policy-fallback";
import { tryAdmitTurn } from "../../src/server/lifecycle";
import { providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import { historyIndexPath } from "../../src/routing/history/schema";
import { clearHealthHistoryCacheForTests } from "../../src/routing/health";
import type { OcxConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const originalFetch = globalThis.fetch;
const metadata = "user_test_account__session_conversation-native";
// Independent SHA-256/UUID fixture vectors; no production helper builds the oracle.
const key = "9745d86cd579894abd0ef69a5214cf96";
const expectedSession = "9745d86c-d579-494a-8d0e-f69a5214cf96";
let isolated: IsolatedCodexHome;
let home: string;
let previousHome: string | undefined;
let token: string;
let releaseSpendHome: (() => void) | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-native-affinity-"));
  process.env.OPENCODEX_HOME = home;
  isolated = installIsolatedCodexHome("ocx-native-affinity-codex-");
  token = fakeChatGptJwt({ exp: Math.floor(Date.now() / 1000) + 86400, chatgpt_account_id: "fixture-native-main" });
  writeFileSync(join(isolated.path, "auth.json"), JSON.stringify({ tokens: { access_token: token, account_id: "fixture-native-main" } }));
  clearComboSelectionState();
  clearComboTargetCooldowns();
  // Dispatches without starting a server, so the spend-journal lease is taken here.
  releaseSpendHome = acquireOwnedSpendHome();
});
afterEach(() => {
  // Policy candidate health opens a separate SQLite index under this home.
  closeRequestHistoryIndex();
  clearHealthHistoryCacheForTests();
  // Released before the directory is removed, so no live database sits inside it.
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = originalFetch;
  clearComboSelectionState();
  clearComboTargetCooldowns();
  isolated.restore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function config(): OcxConfig {
  return { openaiProviderTierVersion: 2, providers: {
    openai: { adapter: "openai-responses", authMode: "forward", codexAccountMode: "direct", baseUrl: "https://chatgpt.com/backend-api/codex", models: ["gpt-5.6-luna"] },
    go: { ...providerConfigSeed(getProviderRegistryEntry("opencode-go")!), apiKey: "test-go-key" },
    other: { adapter: "openai-responses", authMode: "key", baseUrl: "https://affinity.example/v1", apiKey: "test-other-key", models: ["m"] },
  } } as OcxConfig;
}
function completed(): Response {
  return Response.json({ id: "resp_affinity", object: "response", status: "completed", output: [],
    usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } });
}

describe("Claude final canonical native affinity after a Go preliminary pick", () => {
  for (const strategy of ["random", "failover"] as const) {
    for (const explicit of [undefined, "session_id", "session-id", "thread-id"] as const) {
      test(`${strategy} preserves ${explicit ?? "metadata native identity"}`, async () => {
        const cfg = config();
        cfg.combos = { reverse: { strategy, targets: [
          { provider: "go", model: "glm-5.2" }, { provider: "openai", model: "gpt-5.6-luna" },
        ] } };
        const seen: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          seen.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
          return url.startsWith("https://opencode.ai/")
            ? Response.json({ error: { message: "model retired", code: "model_not_found" } }, { status: 404 }) : completed();
        }) as typeof fetch;
        const entropy = spyOn(Math, "random").mockReturnValue(0.9).mockReturnValueOnce(0);
        const lease = tryAdmitTurn();
        expect(lease).not.toBeNull();
        try {
          const req = new Request("http://localhost/v1/messages", { method: "POST",
            headers: { "content-type": "application/json", ...(explicit ? { [explicit]: "caller-conversation" } : {}) },
            body: JSON.stringify({ model: "combo/reverse", max_tokens: 32, stream: false,
              metadata: { user_id: metadata }, messages: [{ role: "user", content: "ping" }] }) });
          const response = await handleClaudeMessages(req, cfg, { model: "", provider: "" },
            { requestId: `affinity-${strategy}-${explicit ?? "metadata"}`, start: Date.now(), turnAdmissionLease: lease! });
          await response.text();
          expect(response.status).toBe(200);
          const wire = seen.at(-1)!;
          expect(wire.url).toBe("https://chatgpt.com/backend-api/codex/responses");
          expect(wire.headers.get("session_id")).toBe(explicit ? "caller-conversation" : expectedSession);
          if (explicit) expect(wire.headers.get(explicit)).toBe("caller-conversation");
          expect(wire.headers.has("x-opencode-session")).toBe(false);
          expect(wire.body.prompt_cache_key).toBe(key);
          expect(req.headers.get("session_id")).toBe(explicit === "session_id" ? "caller-conversation" : null);
        } finally { entropy.mockRestore(); lease?.release(); }
      });
    }
  }

  test("shared-system cache key never becomes native session identity", async () => {
    let captured: Headers | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Headers(init?.headers); return completed();
    }) as typeof fetch;
    const lease = tryAdmitTurn();
    try {
      const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          model: "openai/gpt-5.6-luna", system: "Shared prefix", messages: [{ role: "user", content: "ping" }], max_tokens: 32,
        }),
      }), config(), { model: "", provider: "" }, { requestId: "shared-prefix", start: Date.now(), turnAdmissionLease: lease! });
      await response.text();
      expect(response.status).toBe(200);
      expect(captured?.has("session_id")).toBe(false);
    } finally { lease?.release(); }
  });

  test("native failure leaves policy-hop request headers free of synthesized identity", async () => {
    clearHealthHistoryCacheForTests();
    const cfg = config();
    // Both physical routes belong to the original evaluation; a diagnostic trace cannot add one.
    cfg.routingProfiles = { "native-hop": { candidates: [
      { provider: "openai", model: "gpt-5.6-luna" }, { provider: "other", model: "m" },
    ] } };
    const requests: Request[] = [];
    const wires: Headers[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      wires.push(new Headers(init?.headers));
      return String(input).startsWith("https://chatgpt.com/")
        ? Response.json({ error: { message: "model retired", code: "model_not_found" } }, { status: 404 }) : completed();
    }) as typeof fetch;
    const req = new Request("http://localhost/v1/responses", { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "chatgpt-account-id": "fixture-native-main" },
      body: JSON.stringify({ model: "policy/native-hop", input: "ping", stream: false }) });
    const runCore: NonNullable<Parameters<typeof handleResponsesWithPolicyFallback>[4]>["runCore"] = async (request, current, log, options) => {
      requests.push(request);
      return handleResponses(request, current, log, options);
    };
    const response = await handleResponsesWithPolicyFallback(req, cfg, { model: "", provider: "" },
      { claudeNativeSessionId: expectedSession }, { runCore });
    await response.text();
    expect(existsSync(historyIndexPath(home))).toBe(true);
    expect(response.status).toBe(200);
    expect(requests).toHaveLength(2);
    expect(wires[0]?.get("session_id")).toBe(expectedSession);
    expect(wires.at(-1)?.has("session_id")).toBe(false);
    expect(requests.every(request => !request.headers.has("session_id"))).toBe(true);
  });
});


describe("native alias identity survives 401 auth replay", () => {
  test.each([
    { session_id: "", "session-id": "caller-conversation" },
    { "session-id": "", "thread-id": "caller-conversation" },
    { "session-id": "caller-conversation", "thread-id": "weaker-conversation" },
  ])("keeps the same wire identity before and after stored-main refresh: %j", async identity => {
    const cfg = config();
    cfg.activeCodexAccountId = MAIN_CODEX_ACCOUNT_ID;
    cfg.autoSwitchThreshold = 0;
    cfg.codexAccounts = [];
    cfg.providers.openai!.codexAccountMode = "pool";
    clearMainAccountInfoCache();
    writeFileSync(join(isolated.path, "auth.json"), JSON.stringify({ tokens: {
      access_token: token, refresh_token: "fixture-refresh-grant", account_id: "fixture-native-main",
    } }));
    const refreshed = fakeChatGptJwt({ exp: Math.floor(Date.now() / 1000) + 172800, chatgpt_account_id: "fixture-native-main" });
    const wires: Headers[] = [];
    let refreshes = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "auth.openai.com") {
        refreshes++;
        return Response.json({ access_token: refreshed, refresh_token: "fixture-rotated-grant", expires_in: 3600 });
      }
      if (!url.pathname.endsWith("/responses")) return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } });
      wires.push(new Headers(init?.headers));
      return wires.length === 1
        ? Response.json({ error: { message: "expired bearer" } }, { status: 401 }) : completed();
    }) as typeof fetch;
    const req = new Request("http://localhost/v1/responses", { method: "POST",
      headers: { "content-type": "application/json", originator: "example-agent", ...identity },
      body: JSON.stringify({ model: "openai/gpt-5.6-luna", input: "ping", stream: false }),
    });
    const originalHeaders = [...req.headers];
    const lease = tryAdmitTurn();
    expect(lease).not.toBeNull();
    try {
      const response = await handleResponses(req, cfg, { model: "", provider: "" }, { turnAdmissionLease: lease! });
      await response.text();
      expect(response.status).toBe(200);
      expect(refreshes).toBe(1);
      expect(wires).toHaveLength(2);
      expect(wires.map(headers => headers.get("session_id"))).toEqual(["caller-conversation", "caller-conversation"]);
      expect(wires.map(headers => headers.get("originator"))).toEqual(["example-agent", "example-agent"]);
      expect(wires.map(headers => headers.get("authorization"))).toEqual([`Bearer ${token}`, `Bearer ${refreshed}`]);
      expect([...req.headers]).toEqual(originalHeaders);
    } finally { lease?.release(); clearMainAccountInfoCache(); }
  });
});
