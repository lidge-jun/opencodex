import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../helpers/repo-root";

const root = repoRoot();
const originalFetch = globalThis.fetch;
const saved = Object.fromEntries(["OPENCODEX_HOME", "CODEX_HOME", "OPENCODEX_CACHE_DEBUG"]
  .map(key => [key, process.env[key]]));
const home = mkdtempSync(join(tmpdir(), "ocx-hook-compat-"));
process.env.OPENCODEX_HOME = home;
process.env.CODEX_HOME = join(home, "codex");
mkdirSync(process.env.CODEX_HOME);
let networkCalls = 0;
let coreCalls = 0;
const rejectNetwork = () => {
  networkCalls++;
  throw new Error("Network forbidden in hook compatibility regression");
};
globalThis.fetch = Object.assign(async () => rejectNetwork(), { preconnect: rejectNetwork });

const fixtureResponse = async () => {
  coreCalls++;
  return Response.json({
    id: "resp_hook_fixture", object: "response", created_at: 1, status: "completed",
    model: "fixture/model", error: null, incomplete_details: null,
    output: [{ id: "msg_hook_fixture", type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "hook fixture answer", annotations: [] }] }],
    usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
  });
};
// Stop after the real ingress routing/eligibility checks; no provider, auth or inference runs.
mock.module(join(root, "src/server/responses/policy-fallback.ts"), () => ({
  handleResponses: fixtureResponse,
  handleResponsesWithPolicyFallback: fixtureResponse,
  rankPolicyFallbackCandidates: () => { throw new Error("Unexpected policy fallback"); },
}));

let observing: () => boolean;
let chat: typeof import("../../src/server/chat-completions").handleChatCompletions;
let messages: typeof import("../../src/server/claude-messages").handleClaudeMessages;
let messagesDirectRouteHolds: typeof import("../../src/server/messages-antigravity-direct").messagesDirectRouteHolds;
let chatDecline: typeof import("../../src/server/antigravity-direct-eligibility").antigravityDirectDeclineReason;

beforeAll(async () => {
  await import(join(root, "src/usage/cache-diagnostic.ts"));
  observing = (await import(join(root, "src/server/request-log.ts"))).cacheDiagnosticsObserving;
  chat = (await import(join(root, "src/server/chat-completions.ts"))).handleChatCompletions;
  messages = (await import(join(root, "src/server/claude-messages.ts"))).handleClaudeMessages;
  messagesDirectRouteHolds = (await import(join(root, "src/server/messages-antigravity-direct.ts"))).messagesDirectRouteHolds;
  chatDecline = (await import(join(root, "src/server/antigravity-direct-eligibility.ts"))).antigravityDirectDeclineReason;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

function debug(value: string | undefined) {
  if (value === undefined) delete process.env.OPENCODEX_CACHE_DEBUG;
  else process.env.OPENCODEX_CACHE_DEBUG = value;
}

function config() {
  return {
    port: 0, defaultProvider: "fixture",
    providers: { fixture: { adapter: "openai-responses", baseUrl: "https://fixture.invalid/v1",
      apiKey: "synthetic-test-key", models: ["model"] } },
    claudeCode: { enabled: true },
  } as unknown as import("../../src/types").OcxConfig;
}

describe("registered cache diagnostic hook compatibility", () => {
  for (const value of [undefined, "0", "1"]) {
    test(`enabled follows environment ${String(value)} after module registration`, () => {
      debug(value);
      expect(observing()).toBe(value === "1");
    });
    for (const ingress of ["chat", "messages"] as const) {
      test(`${ingress} ingress remains usable with diagnostic ${String(value)}`, async () => {
        debug(value);
        const before = coreCalls;
        const body = { model: "fixture/model", stream: false, max_tokens: 16,
          messages: [{ role: "user", content: "synthetic hook fixture" }] };
        const req = new Request(`http://localhost/v1/${ingress === "chat" ? "chat/completions" : "messages"}`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        const response = await (ingress === "chat" ? chat : messages)(req, config(), { model: "", provider: "" });
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("hook fixture answer");
        expect(coreCalls).toBe(before + 1);
        expect(networkCalls).toBe(0);
      });
    }
  }

  test("debug toggles preserve direct-lane eligibility for Chat and Messages", () => {
    const model = "google-antigravity/gemini-3.8-flash";
    const route = { providerName: "google-antigravity", modelId: "gemini-3.8-flash",
      provider: { adapter: "google", googleMode: "cloud-code-assist", baseUrl: "https://fixture.invalid" } } as never;
    const cfg = { port: 0, providers: {}, protocols: { rollout: { antigravityDirect: true } } } as never;
    const body = { model, messages: [{ role: "user", content: "synthetic fixture" }] };
    debug("0");
    expect(chatDecline(route, body, cfg, { cacheDiagnostics: observing() })).toBeUndefined();
    expect(messagesDirectRouteHolds(route, body, model, cfg)).toBe(true);
    debug("1");
    expect(chatDecline(route, body, cfg, { cacheDiagnostics: observing() })).toBe("bridge-only-policy");
    expect(messagesDirectRouteHolds(route, body, model, cfg)).toBe(false);
    debug("0");
    expect(messagesDirectRouteHolds(route, body, model, cfg)).toBe(true);
    expect(networkCalls).toBe(0);
  });
});
