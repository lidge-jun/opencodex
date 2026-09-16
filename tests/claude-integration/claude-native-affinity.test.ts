import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { handleResponses } from "../../src/server/responses/core";
import { handleResponsesWithPolicyFallback, rankPolicyFallbackCandidates } from "../../src/server/responses/policy-fallback";
import { tryAdmitTurn } from "../../src/server/lifecycle";
import { providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import type { OcxConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const metadata = "user_test_account__session_conversation-native";
// Independent SHA-256/UUID fixture vectors; no production helper builds the oracle.
const key = "9745d86cd579894abd0ef69a5214cf96";
const expectedSession = "9745d86c-d579-494a-8d0e-f69a5214cf96";
let isolated: IsolatedCodexHome;
let home: string;
let previousHome: string | undefined;
let token: string;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-native-affinity-"));
  process.env.OPENCODEX_HOME = home;
  isolated = installIsolatedCodexHome("ocx-native-affinity-codex-");
  token = fakeChatGptJwt({ exp: Math.floor(Date.now() / 1000) + 86400, chatgpt_account_id: "fixture-native-main" });
  writeFileSync(join(isolated.path, "auth.json"), JSON.stringify({ tokens: { access_token: token, account_id: "fixture-native-main" } }));
  clearComboSelectionState();
  clearComboTargetCooldowns();
});
afterEach(() => {
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
          expect(wire.headers.get("session_id")).toBe(explicit ? explicit === "session_id" ? "caller-conversation" : null : expectedSession);
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
    const cfg = config();
    const trace = { version: 1, decisionId: "native-hop", createdAt: Date.now(), requestedModel: "openai/gpt-5.6-luna",
      routeKind: "policy", profile: { id: "native-hop", revision: "1" }, requirements: [],
      candidates: [
        { provider: "openai", model: "gpt-5.6-luna", eligible: true, exclusions: [], score: { total: 2 } },
        { provider: "other", model: "m", eligible: true, exclusions: [], score: { total: 1 } },
      ], selected: { candidateIndex: 0, provider: "openai", model: "gpt-5.6-luna", reason: "fixture" },
    } as unknown as Parameters<typeof rankPolicyFallbackCandidates>[0];
    const requests: Request[] = [];
    const wires: Headers[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      wires.push(new Headers(init?.headers));
      return String(input).startsWith("https://chatgpt.com/")
        ? Response.json({ error: { message: "model retired", code: "model_not_found" } }, { status: 404 }) : completed();
    }) as typeof fetch;
    const req = new Request("http://localhost/v1/responses", { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "chatgpt-account-id": "fixture-native-main" },
      body: JSON.stringify({ model: "openai/gpt-5.6-luna", input: "ping", stream: false }) });
    const runCore: NonNullable<Parameters<typeof handleResponsesWithPolicyFallback>[4]>["runCore"] = async (request, current, log, options) => {
      requests.push(request);
      const response = await handleResponses(request, current, log, options);
      if (requests.length === 1) log.routeDecision = trace;
      return response;
    };
    const response = await handleResponsesWithPolicyFallback(req, cfg, { model: "", provider: "" },
      { claudeNativeSessionId: expectedSession }, { runCore });
    await response.text();
    expect(response.status).toBe(200);
    expect(requests).toHaveLength(2);
    expect(wires[0]?.get("session_id")).toBe(expectedSession);
    expect(wires.at(-1)?.has("session_id")).toBe(false);
    expect(requests.every(request => !request.headers.has("session_id"))).toBe(true);
  });
});
