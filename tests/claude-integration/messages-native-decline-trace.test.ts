/**
 * With `protocols.rollout.managedMessagesNative` on, a Messages route that declines the native
 * lane stays on the bridge and its trace names the rule that declined it. With the switch off
 * the trace is unchanged: no decline reason is recorded.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { getRequestLogEntries } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let upstream: ReturnType<typeof Bun.serve> | undefined;
let bodies: Record<string, unknown>[] = [];
let releaseSpendHome: (() => void) | undefined;
let testDir = "";
let previousHome: string | undefined;

const SSE = [
  { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: "claude-x", content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fixture" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
].map(data => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`).join("");

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-messages-decline-trace-"));
  process.env.OPENCODEX_HOME = testDir;
  bodies = [];
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    bodies.push(await req.json() as Record<string, unknown>);
    return new Response(SSE, { headers: { "content-type": "text/event-stream" } });
  } });
});

afterEach(async () => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  await upstream?.stop(true);
  upstream = undefined;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) removeTreeWithRetry(testDir);
});

function fixtureConfig(on: boolean): OcxConfig {
  releaseSpendHome ??= acquireOwnedSpendHome();
  const config = {
    port: 0,
    defaultProvider: "anth",
    providers: { anth: {
      adapter: "anthropic", baseUrl: `http://127.0.0.1:${upstream!.port}`, authMode: "key", apiKey: "fixture-key",
      allowPrivateNetwork: true, models: ["claude-x"],
      // Operator policy only the bridge applies.
      pinnedReasoningEffort: "high",
    } },
    ...(on ? { protocols: { rollout: { managedMessagesNative: true } } } : {}),
  } as OcxConfig;
  saveConfig(config);
  return config;
}

async function send(config: OcxConfig) {
  const requestId = `pf08-decline-${crypto.randomUUID()}`;
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "anth/claude-x", max_tokens: 32, top_k: 4, stream: false,
      messages: [{ role: "user", content: "fixture" }] }),
  }), config, { model: "", provider: "" }, { requestId, start: Date.now() });
  await response.text();
  const rows = getRequestLogEntries().filter(entry => entry.requestId === requestId);
  expect(rows).toHaveLength(1);
  return { response, row: rows[0]! };
}

describe("native Messages decline in the trace", () => {
  test("switch on: a pinned effort keeps the bridge and the trace says why", async () => {
    const { response, row } = await send(fixtureConfig(true));
    expect(response.status).toBe(200);
    expect(bodies).toHaveLength(1);
    // The bridge rebuilt the request through the adapter: no top_k, internal streaming.
    expect(bodies[0]).not.toHaveProperty("top_k");
    expect(row.protocolTrace).toMatchObject({ inbound: "messages", mode: "legacy-bridge" });
    expect(row.protocolTrace?.reasonCodes).toContain("bridge-only-policy");
  });

  test("switch off: no decline reason is recorded", async () => {
    const { row } = await send(fixtureConfig(false));
    expect(row.protocolTrace).toMatchObject({ inbound: "messages", mode: "legacy-bridge" });
    expect(row.protocolTrace?.reasonCodes).not.toContain("bridge-only-policy");
    expect(row.protocolTrace?.reasonCodes).not.toContain("rollout-disabled");
  });
});
