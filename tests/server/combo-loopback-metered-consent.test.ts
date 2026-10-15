import { afterEach, beforeEach, expect, test } from "bun:test";
import type { OcxConfig, OcxComboStrategy } from "../../src/types";
import { handleResponses } from "../../src/server/responses";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { handleResponsesCompact } from "../../src/server/responses/compact";
import { admissionMayUseMeteredComboTargets } from "../../src/server/admission-model-scope";
import { resolveApiAuth, type DataPlaneAdmission } from "../../src/server/auth-cors";
import { clearComboTargetCooldowns, coolComboTarget } from "../../src/combos/failover";
import { clearComboSelectionState } from "../../src/combos/resolve";
import { noteSubagentModelFailure, resetSubagentModelFallbackStateForTests } from "../../src/codex/subagent-model-fallback";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createWebsocketHandler } from "../../src/server/index/websocket-handler";
import { tryReserveCodexWebSocket } from "../../src/codex/websocket-registry";
import { buildResponsesWsData, type WsData } from "../../src/server/ws-bridge";

const issued = { id: "issued", name: "issued", key: "ocx_data_" + "a".repeat(40), createdAt: "2026-10-15T00:00:00Z" };
const keyed: DataPlaneAdmission = { kind: "configured", keyId: issued.id, source: "bearer" };
const local: DataPlaneAdmission = { kind: "loopback", source: "loopback" };
const originalRandom = Math.random;
let sent: string[];
let release: () => void;
beforeEach(() => { sent = []; release = acquireOwnedSpendHome(); clearComboSelectionState(); clearComboTargetCooldowns(); });
afterEach(() => { Math.random = originalRandom; release(); clearComboSelectionState(); clearComboTargetCooldowns(); resetSubagentModelFallbackStateForTests(); });
function config(flag?: boolean, strategy: OcxComboStrategy = "failover"): OcxConfig {
  const provider = (name: string) => ({ adapter: "openai-chat" as const, baseUrl: `https://${name}.test/v1`, apiKey: "fixture", models: ["m"],
    fetch: (async () => { sent.push(name); return Response.json({ error: { message: "fixture refusal", type: "invalid_request_error" } }, { status: 400 }); }) as typeof fetch });
  return { port: 16389, defaultProvider: "paid", providers: { paid: provider("paid"), subscription: provider("subscription"), primary: provider("primary") },
    apiKeys: [issued], combos: { chain: { strategy, ...(flag === undefined ? {} : { allowMeteredTargets: flag }), targets: [{ provider: "paid", model: "m", metered: true }] } } };
}
const spoof = { "x-ocx-allow-metered-targets": "true", "x-opencodex-allow-metered-combo-targets": "true", "allowMeteredTargets": "true" };
function request(wire: string, model = "combo/chain", headers: Record<string, string> = {}) {
  const body = wire === "chat" || wire === "messages"
    ? { model, stream: false, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }
    : { model, input: "hi", stream: false };
  return new Request(`http://localhost:16389/v1/${wire}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
async function post(wire: string, cfg: OcxConfig, admission: DataPlaneAdmission, headers = {}) {
  const req = request(wire, "combo/chain", headers);
  const ctx = { model: "", provider: "" };
  const ids = { requestId: "consent-test", start: Date.now(), admission };
  const response = wire === "chat" ? await handleChatCompletions(req, cfg, ctx, ids)
    : wire === "messages" ? await handleClaudeMessages(req, cfg, ctx, ids)
    : wire === "compact" ? await handleResponsesCompact(req, cfg, ctx, undefined, admission)
    : await handleResponses(req, cfg, ctx, { admission });
  await response.text();
  return response.status;
}
for (const wire of ["responses", "chat", "messages", "compact"]) {
  test(`${wire}: local operator opt-in permits metered targets, default and spoofed consent deny`, async () => {
    expect(await post(wire, config(), local, spoof)).toBe(wire === "messages" ? 529 : 503);
    expect(sent).toEqual([]);
    expect(await post(wire, config(false), local)).toBe(wire === "messages" ? 529 : 503);
    expect(sent).toEqual([]);
    await post(wire, config(true), local);
    expect(sent).toEqual(["paid"]);
  });
  test(`${wire}: public listener ignores combo opt-in, including secondary loopback; opted-in key still works`, async () => {
    const cfg = { ...config(true), hostname: "0.0.0.0" };
    for (const admission of [local, keyed, { kind: "environment", source: "bearer" } as const]) {
      expect(await post(wire, cfg, admission, spoof)).toBe(wire === "messages" ? 529 : 503);
      expect(sent).toEqual([]);
    }
    cfg.apiKeys![0] = { ...issued, allowMeteredComboTargets: true };
    await post(wire, cfg, keyed);
    expect(sent).toEqual(["paid"]);
  });
}
test("consent uses the auth listener predicate and never overrides a configured or environment admission", () => {
  for (const hostname of [undefined, "127.0.0.1", "localhost.", "::1", "[::1]", "0.0.0.0", "::", "192.0.2.1"]) {
    const cfg = { ...config(true), hostname };
    const auth = resolveApiAuth(request("responses"), cfg);
    expect(admissionMayUseMeteredComboTargets(cfg, local, cfg.combos!.chain)).toBe(auth?.kind === "loopback");
    expect(admissionMayUseMeteredComboTargets(cfg, undefined, cfg.combos!.chain)).toBe(auth?.kind === "loopback");
    expect(admissionMayUseMeteredComboTargets(cfg, keyed, cfg.combos!.chain)).toBe(false);
    expect(admissionMayUseMeteredComboTargets(cfg, { kind: "environment", source: "bearer" }, cfg.combos!.chain)).toBe(false);
    cfg.apiKeys![0] = { ...issued, allowMeteredComboTargets: true };
    expect(admissionMayUseMeteredComboTargets(cfg, keyed, cfg.combos!.chain)).toBe(true);
    expect(admissionMayUseMeteredComboTargets(cfg, { ...keyed, keyId: "missing" }, cfg.combos!.chain)).toBe(false);
  }
});
for (const strategy of ["failover", "round-robin", "random", "least-used", "reset-window", "jev"] as const) {
  test(`${strategy}: the loop's first pick honors local consent`, async () => {
    await post("responses", config(true, strategy), local);
    expect(sent).toEqual(["paid"]);
  });
}
for (const strategy of ["failover", "round-robin", "random"] as const) {
  test(`${strategy}: collapsed subagent fallback honors operator consent and prefers usable unmetered targets`, async () => {
    const cfg = config(true, strategy);
    cfg.defaultProvider = "primary";
    cfg.combos!.chain!.alias = "chain-model";
    cfg.subagentModelFallback = ["chain-model"];
    const postFallback = (admission = local) => {
      resetSubagentModelFallbackStateForTests();
      noteSubagentModelFailure("primary/m", "429", cfg);
      return handleResponses(request("responses", "primary/m", { "x-openai-subagent": "collab_spawn" }), cfg, { model: "", provider: "" }, { admission });
    };
    await (await postFallback()).text();
    expect(sent).toEqual(["paid"]);
    sent.length = 0;
    cfg.combos!.chain!.allowMeteredTargets = false;
    expect((await postFallback()).status).toBe(503);
    expect(sent).toEqual([]);
    // Force the paid first choice in random too; it must be re-picked rather than refused.
    if (strategy === "random") Math.random = () => 0;
    cfg.combos!.chain!.targets = [{ provider: "paid", model: "m", metered: true, weight: 10000 }, { provider: "subscription", model: "m", weight: 1 }];
    for (let i = 0; i < 8; i++) {
      clearComboSelectionState();
      await (await postFallback()).text();
    }
    expect(sent).toEqual(Array(8).fill("subscription"));
    sent.length = 0;
    cfg.apiKeys![0] = { ...issued, allowedProviders: ["paid"] };
    expect((await postFallback(keyed)).status).toBe(403);
    expect(sent).toEqual([]);
    coolComboTarget("chain", { provider: "subscription", model: "m" }, { cooldownMs: 600000 });
    expect((await postFallback()).status).toBe(503);
  });
}

async function websocket(cfg: OcxConfig, admission: DataPlaneAdmission) {
  const handler = createWebsocketHandler({ config: cfg, deps: {} } as Parameters<typeof createWebsocketHandler>[0]);
  const server = Bun.serve<WsData>({ hostname: "127.0.0.1", port: 0, websocket: handler,
    fetch(req, server) { return server.upgrade(req, { data: buildResponsesWsData(new Headers(spoof), admission, tryReserveCodexWebSocket() ?? undefined) }) ? undefined : new Response("upgrade failed", { status: 400 }); },
  });
  const ws = new WebSocket(String(server.url).replace("http:", "ws:"));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("websocket consent deadline")), 4000);
      ws.onopen = () => ws.send(JSON.stringify({ type: "response.create", model: "combo/chain", input: "hi" }));
      ws.onerror = () => { clearTimeout(timer); reject(new Error("websocket failed")); };
      ws.onmessage = () => { clearTimeout(timer); resolve(); };
    });
  } finally { ws.close(); await server.stop(true); }
}
test("WebSocket frames retain local or keyed consent and reject spoofed consent", async () => {
  await websocket(config(), local);
  expect(sent).toEqual([]);
  await websocket(config(true), local);
  expect(sent).toEqual(["paid"]);
  sent.length = 0;
  const cfg = { ...config(true), hostname: "0.0.0.0" };
  await websocket(cfg, local);
  await websocket(cfg, keyed);
  expect(sent).toEqual([]);
  cfg.apiKeys![0] = { ...issued, allowMeteredComboTargets: true };
  await websocket(cfg, keyed);
  expect(sent).toEqual(["paid"]);
});
