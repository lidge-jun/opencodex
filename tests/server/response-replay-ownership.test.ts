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
for (const combo of [false, true]) for (const mode of ["v2-plaintext", "v1"] as const) {
  const label = `${combo ? "combo" : "direct"} ${mode}`;
  for (const [scenario, secondKey, parent] of [
    ["different callers without parent headers", "synthetic-b", undefined],
    ["sibling own threads under a shared parent", "synthetic-a", "shared-parent"],
    ["different callers supplying the same parent", "synthetic-b", "shared-parent"],
  ] as const) {
    test(`${label}: refuses retained replay across ${scenario} before dispatch`, async () => {
      const cfg = config(mode, combo);
      const sent = upstream();
      expect((await send(cfg, "own-a", "synthetic-a", parent)).status).toBe(200);
      const second = await send(cfg, "own-b", secondKey, parent, "resp-owner-a");
      expect(second.status).toBe(400);
      expect(sent).toHaveLength(1);
      expect(sent[1] ?? "").not.toContain("SYNTHETIC_PRIVATE_TASK");
    });
  }
  test(`${label}: caller ownership is required even when the own thread matches`, async () => {
    const cfg = config(mode, combo);
    const sent = upstream();
    expect((await send(cfg, "own-a", "synthetic-a", "shared-parent")).status).toBe(200);
    expect((await send(cfg, "own-a", "synthetic-b", "shared-parent", "resp-owner-a")).status).toBe(400);
    expect(sent).toHaveLength(1);
  });
  test(`${label}: same caller and own thread can replay without a parent header`, async () => {
    const cfg = config(mode, combo);
    const sent = upstream();
    expect((await send(cfg, "own-a", "synthetic-a")).status).toBe(200);
    expect((await send(cfg, "own-a", "synthetic-a", undefined, "resp-owner-a")).status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("SYNTHETIC_PRIVATE_TASK");
    expect(sent.join("")).not.toContain("synthetic-a");
  });
  for (const missing of ["principal", "own thread"] as const) {
    test(`${label}: missing ${missing} cannot authorize a retained continuation`, async () => {
      const cfg = config(mode, combo);
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
