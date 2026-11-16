/**
 * The Antigravity ACP provider refuses turns that combo or fallback machinery routed to it (plan 080).
 * The spawn requests here carry only `x-openai-subagent: collab_spawn`, never
 * `x-codex-parent-thread-id`, so the typed fallback fact recorded where the fallback is selected is
 * the only signal that can refuse them: at the ordinary selection site and at the
 * agent-task-recovery re-selection site. A JEV combo's decision call carries no conversation
 * headers and is not a combo member, so its own internal-decision fact is what refuses it.
 * No CLI is started: the binary path points nowhere, so a spawn would surface a different error.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota, updateAccountQuota } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap, recordCodexUpstreamOutcome } from "../../src/codex/routing";
import {
  DEFAULT_SUBAGENT_MODEL_FALLBACK_POLL_MS,
  noteSubagentModelFailure,
  resetSubagentModelFallbackStateForTests,
} from "../../src/codex/subagent-model-fallback";
import { resetCodexModelEntitlementCacheForTests } from "../../src/codex/model-entitlements";
import { setMainAccountPlan } from "../../src/codex/main-account";
import { handleResponses } from "../../src/server/responses";
import { resetAgentTaskRecoveryState } from "../../src/server/responses/agent-task-recovery";
import { runWithRequestPeer } from "../../src/lib/request-peer-scope";
import type { OcxConfig } from "../../src/types";
import { codexHeaders, encryptedInput, recoverySse } from "../helpers/agent-task-recovery";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

setDefaultTimeout(30_000);

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const ACP_FALLBACK = "antigravity-acp/gemini-3.8-flash";
let testDir = "";
let releaseSpendHome: (() => void) | undefined;
const saved: Record<string, string | undefined> = {};

function reset(): void {
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountQuota();
  resetAgentTaskRecoveryState();
  resetSubagentModelFallbackStateForTests();
  setMainAccountPlan(null);
  resetCodexModelEntitlementCacheForTests();
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-agy-acp-fallback-"));
  for (const key of ["OPENCODEX_HOME", "CODEX_HOME", "OPENCODEX_AGY_BIN"]) saved[key] = process.env[key];
  process.env.OPENCODEX_HOME = testDir;
  process.env.CODEX_HOME = testDir;
  process.env.OPENCODEX_AGY_BIN = join(testDir, "no-such-agy");
  releaseSpendHome = acquireOwnedSpendHome();
  reset();
});

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  reset();
  removeTreeWithRetry(testDir);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 0,
    defaultProvider: "openai",
    activeCodexAccountId: "pool-a",
    autoSwitchThreshold: 80,
    providers: {
      openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool" },
      xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "key", apiKey: "xai-test" },
      "antigravity-acp": { adapter: "agy-acp", baseUrl: "https://antigravity.google/docs/cli/acp", models: ["gemini-3.8-flash"], liveModels: false },
    },
    codexAccounts: [
      { id: "main", email: "main@example.test", isMain: true },
      { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "pool_acc" },
    ],
    subagentModelFallback: [ACP_FALLBACK],
    ...overrides,
  } as OcxConfig;
}

function installPoolCredential(accountId: string, chatgptAccountId: string, now: number): void {
  saveCodexAccountCredential(accountId, {
    accessToken: `${accountId}_token`,
    refreshToken: `${accountId}_refresh`,
    expiresAt: now + 24 * 60 * 60_000,
    chatgptAccountId,
  });
}

function spawn(cfg: OcxConfig, body: Record<string, unknown>, headers: HeadersInit = {}): Promise<Response> {
  const merged = new Headers({ "content-type": "application/json", authorization: "Bearer caller-codex-token", ...Object.fromEntries(new Headers(headers)) });
  merged.set("x-openai-subagent", "collab_spawn");
  expect(merged.has("x-codex-parent-thread-id")).toBe(false);
  return handleResponses(new Request("http://localhost/v1/responses", { method: "POST", headers: merged, body: JSON.stringify(body) }), cfg, { model: "", provider: "" }, {});
}

async function expectInteractiveOnly(response: Response): Promise<void> {
  expect(response.status).toBe(403);
  const body = await response.json() as { error?: { code?: string; type?: string } };
  expect(body.error).toMatchObject({ code: "agy_acp_interactive_only", type: "permission_error" });
}

describe("antigravity-acp chosen by subagent fallback", () => {
  test("the ordinary fallback selection is refused before any upstream call", async () => {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    installPoolCredential("pool-a", "pool_acc", now);
    const cfg = config();
    updateAccountQuota("pool-a", 95, undefined, 20);
    recordCodexUpstreamOutcome(cfg, "pool-a", 429, { resetAt: Math.floor((now + 4 * 24 * 60 * 60_000) / 1000), now });
    const bodies: string[] = [];
    globalThis.fetch = (async (input, init) => {
      if (String(input).endsWith("/models")) return Response.json({ models: [] });
      bodies.push(typeof init?.body === "string" ? init.body : "");
      return new Response("unexpected upstream call", { status: 599 });
    }) as typeof fetch;

    await expectInteractiveOnly(await spawn(cfg, { model: "gpt-5.5", input: [{ type: "agent_message", author: "/root", recipient: "/root/worker", content: [{ type: "input_text", text: "do the work" }] }], stream: false }));
    expect(bodies).toEqual([]);
  });

  test("the agent-task-recovery re-selection is refused before the recovered turn is sent", async () => {
    const now = 1_800_000_000_000;
    let currentNow = now;
    Date.now = () => currentNow;
    installPoolCredential("pool-a", "pool_acc", now);
    const cfg = config({ defaultProvider: "xai", agentTaskRecovery: { enabled: true } });
    for (const model of ["xai/grok-4.5", "grok-4.5"]) {
      noteSubagentModelFailure(model, "429", cfg, undefined, now, 10 * DEFAULT_SUBAGENT_MODEL_FALLBACK_POLL_MS);
    }
    const bodies: string[] = [];
    globalThis.fetch = (async (input, init) => {
      if (String(input).endsWith("/models")) return Response.json({ models: [] });
      const raw = typeof init?.body === "string" ? init.body : "";
      bodies.push(raw);
      if (raw.includes("capture_assignment")) {
        currentNow = now + 1;
        return new Response(recoverySse("Use the recovered assignment."), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response("unexpected upstream call", { status: 599 });
    }) as typeof fetch;

    await expectInteractiveOnly(await spawn(cfg, { model: "xai/grok-4.5", input: encryptedInput(), stream: false }, codexHeaders("caller-account")));
    // Recovery ran (the assignment was captured), and nothing after it went upstream.
    expect(bodies.some(body => body.includes("capture_assignment"))).toBe(true);
    expect(bodies.filter(body => body.length > 0 && !body.includes("capture_assignment"))).toEqual([]);
  });

  test("a selection that keeps the requested model is not a fallback", async () => {
    // A cooled primary with no usable candidate: selection returns the primary itself (from === to).
    const now = 1_800_000_000_000;
    Date.now = () => now;
    const cfg = config({ defaultProvider: "antigravity-acp", subagentModelFallback: ["xai/grok-4.5"] });
    for (const model of ["antigravity-acp/gemini-3.8-flash", "gemini-3.8-flash", "xai/grok-4.5", "grok-4.5"]) {
      noteSubagentModelFailure(model, "429", cfg, undefined, now, 10 * DEFAULT_SUBAGENT_MODEL_FALLBACK_POLL_MS);
    }
    globalThis.fetch = (async () => new Response("unexpected upstream call", { status: 599 })) as typeof fetch;
    const response = await spawn(cfg, { model: "antigravity-acp/gemini-3.8-flash", input: "hello", stream: false });
    expect(response.status).toBe(403);
    // Not refused as fallback-routed; this direct handler call has no recorded local peer.
    expect(((await response.json()) as { error?: { code?: string } }).error?.code).toBe("agy_acp_local_only");
  });
});

describe("antigravity-acp as a combo's decision model", () => {
  test("a local JEV decision call is refused as combo machinery before any spawn", async () => {
    const cfg = config({ defaultProvider: "antigravity-acp", subagentModelFallback: undefined });
    globalThis.fetch = (async () => new Response("unexpected upstream call", { status: 599 })) as typeof fetch;
    // The shape jev-model-invoke.ts sends: no conversation headers, internalDecisionCall set.
    const response = await runWithRequestPeer({ local: true }, () => handleResponses(
      new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "antigravity-acp/gemini-3.8-flash", input: "decide", stream: false }) }),
      cfg, { model: "", provider: "" }, { internalDecisionCall: true },
    ));
    await expectInteractiveOnly(response);
  });
});
