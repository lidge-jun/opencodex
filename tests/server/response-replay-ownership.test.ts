import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses } from "../../src/server/responses";
import { clearResponseStateForTests } from "../../src/responses/state";
import { resolveDataPlaneAdmissionSecret } from "../../src/server/auth-cors";
import { CODEX_FORWARD_BASE_URL } from "../../src/providers/openai-tiers";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";
import { resetSubagentModelFallbackStateForTests, setSubagentQuotaPrimeForTests } from "../../src/codex/subagent-model-fallback";

const originalFetch = globalThis.fetch;
const originalCatalog = process.env.OPENCODEX_APP_SERVER_CATALOG_STATE_OVERRIDE;
let release: () => void;
let home: string;
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-replay-handler-"));
  process.env.OPENCODEX_HOME = home;
  release = acquireOwnedSpendHome();
  process.env.OPENCODEX_APP_SERVER_CATALOG_STATE_OVERRIDE = "fresh";
  clearResponseStateForTests();
});
afterEach(() => {
  resetSubagentModelFallbackStateForTests();
  globalThis.fetch = originalFetch;
  if (originalCatalog === undefined) delete process.env.OPENCODEX_APP_SERVER_CATALOG_STATE_OVERRIDE;
  else process.env.OPENCODEX_APP_SERVER_CATALOG_STATE_OVERRIDE = originalCatalog;
  release();
  try { clearResponseStateForTests(); } finally {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  }
});

function config(mode: "v1" | "v2-plaintext", combo = false): OcxConfig {
  return {
    defaultProvider: "native", multiAgentMode: mode,
    providers: { native: { adapter: "openai-responses", baseUrl: CODEX_FORWARD_BASE_URL, authMode: "forward", upstreamWebsocket: false } },
    apiKeys: [{ id: "a", key: "synthetic-a" }, { id: "b", key: "synthetic-b" }],
    ...(combo ? { combos: { owned: { strategy: "failover", targets: [{ provider: "native", model: "gpt-5.6-sol" }] } } } : {}),
  };
}
for (const combo of [false, true]) for (const initiallyEnabled of [false, true]) {
  test(`${combo ? "combo" : "direct"}: request mode remains bounded across quota wait`, async () => {
    const cfg = config(initiallyEnabled ? "v2-plaintext" : "v1", combo);
    const sent = upstream();
    let resume!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    setSubagentQuotaPrimeForTests(async () => { entered(); await gate; });
    const req = request("own-a", "synthetic-a", "shared-parent", undefined, combo);
    req.headers.set("x-openai-subagent", "collab_spawn");
    const pending = handleResponses(req, cfg, { model: "", provider: "" }, {
      admission: resolveDataPlaneAdmissionSecret("synthetic-a", cfg)!, inboundWire: "responses",
    });
    await waiting;
    cfg.multiAgentMode = initiallyEnabled ? "v1" : "v2-plaintext";
    resume();
    const response = await pending;
    await response.text();
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0]!) as { tools: Array<{ name: string }> };
    expect(body.tools[0]?.name).not.toBe("collaboration-optimize");
    if (initiallyEnabled) {
      expect((await send(cfg, "own-a", "synthetic-b", "shared-parent", "resp-owner-a")).status).toBe(400);
      expect(sent).toHaveLength(1);
      expect((await send(cfg, "own-a", "synthetic-a", "shared-parent", "resp-owner-a")).status).toBe(400);
      expect(sent).toHaveLength(1);
      cfg.multiAgentMode = "v2-plaintext";
      expect((await send(cfg, "own-a", "synthetic-a", "shared-parent", "resp-owner-a")).status).toBe(200);
      expect(sent).toHaveLength(2);
    }
  });
}
function request(own: string | undefined, key: string, parent?: string, previous?: string, combo = false): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json",
      ...(own ? { "thread-id": own } : {}), "x-opencodex-api-key": key,
      ...(parent ? { "x-codex-parent-thread-id": parent } : {}) },
    body: JSON.stringify({ model: combo ? "combo/owned" : "native/gpt-5.6-sol", store: false, stream: true,
      ...(previous ? { previous_response_id: previous } : {}),
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "synthetic public request" }] }],
      tools: [{ type: "namespace", name: "collaboration", tools: [{ type: "function", name: "spawn_agent",
        parameters: { type: "object", properties: { message: { type: "string", encrypted: true } } } }] }],
    }),
  });
}
function upstream(): string[] {
  const sent: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    sent.push(String(init?.body));
    if (sent.length > 2) throw new Error("unexpected third upstream request");
    return Response.json({ id: sent.length === 1 ? "resp-owner-a" : "resp-owner-b", status: "completed",
      output: sent.length === 1 ? [{ type: "function_call", call_id: "synthetic-call", namespace: "collaboration-optimize",
        name: "start_delegated_task", arguments: JSON.stringify({ message: "SYNTHETIC_PRIVATE_TASK" }), encrypted_function_args: [] }] : [] });
  }) as typeof fetch;
  return sent;
}
async function send(cfg: OcxConfig, own: string | undefined, key: string, parent?: string, previous?: string): Promise<Response> {
  const admission = resolveDataPlaneAdmissionSecret(key, cfg);
  expect(admission?.kind).toBe(key === "synthetic-unadmitted" ? undefined : "configured");
  const response = await handleResponses(request(own, key, parent, previous, !!cfg.combos), cfg, { model: "", provider: "" }, {
    ...(admission ? { admission } : {}), inboundWire: "responses",
  });
  await response.text();
  return response;
}
for (const combo of [false, true]) for (const mode of ["v2-plaintext", "flag"] as const) {
  const label = `${combo ? "combo" : "direct"} ${mode}`;
  const strictConfig = () => mode === "flag"
    ? { ...config("v1", combo), plaintextV2AgentMessages: true }
    : config("v2-plaintext", combo);
  for (const [scenario, secondKey, parent] of [
    ["different callers without parent headers", "synthetic-b", undefined],
    ["sibling own threads under a shared parent", "synthetic-a", "shared-parent"],
    ["different callers supplying the same parent", "synthetic-b", "shared-parent"],
  ] as const) {
    test(`${label}: refuses retained replay across ${scenario} before dispatch`, async () => {
      const cfg = strictConfig();
      const sent = upstream();
      expect((await send(cfg, "own-a", "synthetic-a", parent)).status).toBe(200);
      const second = await send(cfg, "own-b", secondKey, parent, "resp-owner-a");
      expect(second.status).toBe(400);
      expect(sent).toHaveLength(1);
      expect(sent[1] ?? "").not.toContain("SYNTHETIC_PRIVATE_TASK");
    });
  }
  test(`${label}: caller ownership is required even when the own thread matches`, async () => {
    const cfg = strictConfig();
    const sent = upstream();
    expect((await send(cfg, "own-a", "synthetic-a", "shared-parent")).status).toBe(200);
    expect((await send(cfg, "own-a", "synthetic-b", "shared-parent", "resp-owner-a")).status).toBe(400);
    expect(sent).toHaveLength(1);
  });
  test(`${label}: same caller and own thread can replay without a parent header`, async () => {
    const cfg = strictConfig();
    const sent = upstream();
    expect((await send(cfg, "own-a", "synthetic-a")).status).toBe(200);
    expect((await send(cfg, "own-a", "synthetic-a", undefined, "resp-owner-a")).status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("SYNTHETIC_PRIVATE_TASK");
    expect(sent.join("")).not.toContain("synthetic-a");
  });
  for (const missing of ["principal", "own thread"] as const) {
    test(`${label}: missing ${missing} cannot authorize a retained continuation`, async () => {
      const cfg = strictConfig();
      const sent = upstream();
      const own = missing === "own thread" ? undefined : "own-a";
      const key = missing === "principal" ? "synthetic-unadmitted" : "synthetic-a";
      expect((await send(cfg, own, key, "shared-parent")).status).toBe(200);
      expect((await send(cfg, own, key, "shared-parent", "resp-owner-a")).status).toBe(400);
      expect(sent).toHaveLength(1);
      expect(sent[1] ?? "").not.toContain("SYNTHETIC_PRIVATE_TASK");
    });
  }
}

for (const combo of [false, true]) {
  for (const strict of ["mode", "flag"] as const) test(`${combo ? "combo" : "direct"}: ${strict} transitions cannot cross replay ownership boundaries`, async () => {
    const enabled = () => strict === "flag"
      ? { ...config("v1", combo), plaintextV2AgentMessages: true }
      : config("v2-plaintext", combo);
    const sent = upstream();
    expect((await send(enabled(), "own-a", "synthetic-a", "shared-parent")).status).toBe(200);
    expect((await send(config("v1", combo), "own-a", "synthetic-a", "shared-parent", "resp-owner-a")).status).toBe(400);
    expect(sent).toHaveLength(1);
    clearResponseStateForTests();
    expect((await send(config("v1", combo), "own-a", "synthetic-a", "shared-parent")).status).toBe(200);
    expect((await send(enabled(), "own-a", "synthetic-a", "shared-parent", "resp-owner-b")).status).toBe(400);
    expect(sent).toHaveLength(2);
  });
  test(`${combo ? "combo" : "direct"} v1: parent scope follows legacy behavior`, async () => {
    const sent = upstream();
    expect((await send(config("v1", combo), "own-a", "synthetic-a", "shared-parent")).status).toBe(200);
    expect((await send(config("v1", combo), "own-b", "synthetic-b", "different-parent", "resp-owner-a")).status).toBe(400);
    expect((await send(config("v1", combo), "own-b", "synthetic-b", "shared-parent", "resp-owner-a")).status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("SYNTHETIC_PRIVATE_TASK");
  });
  test(`${combo ? "combo" : "direct"} v1: default loopback expands a continuation without caller identity`, async () => {
    const cfg = { ...config("v1", combo), apiKeys: undefined };
    const sent: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      sent.push(String(init?.body));
      return Response.json({ id: `resp-default-${sent.length}`, status: "completed", output: [{
        type: "message", role: "assistant", content: [{ type: "output_text", text: "previous reply" }],
      }] });
    }) as typeof fetch;
    const sendLoopback = async (previous?: string) => {
      const req = request(undefined, "", undefined, previous, combo);
      req.headers.delete("x-opencodex-api-key");
      const response = await handleResponses(req, cfg, { model: "", provider: "" }, { inboundWire: "responses" });
      await response.text();
      return response;
    };
    expect((await sendLoopback()).status).toBe(200);
    expect((await sendLoopback("resp-default-1")).status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("previous reply");
    expect(sent[1]).not.toContain("previous_response_id");
  });
}
