import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// A combo route declines the native Messages lane, so the anthropic adapter places its own
// breakpoints. Their TTL must follow the caller's own `ttl: "1h"` unless the operator set one.
const MODEL = "claude-opus-5-5";
let previousHome: string | undefined;
let home = "";
let releaseSpend: (() => void) | undefined;

beforeAll(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-cache-ttl-"));
  process.env.OPENCODEX_HOME = home;
  releaseSpend = acquireOwnedSpendHome();
});
afterAll(() => {
  releaseSpend?.();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

async function wireTtls(callerTtl: "1h" | undefined, cacheRetention?: "short" | "long"): Promise<unknown[]> {
  const wires: string[] = [];
  const fetch = (async (_input: unknown, init?: RequestInit) => {
    wires.push(String(init?.body));
    const frames = [
      { type: "message_start", message: { id: "msg_x", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    return new Response(frames.map(f => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } });
  }) as typeof globalThis.fetch;
  const config = {
    port: 0, defaultProvider: "anth",
    ...(cacheRetention ? { cacheRetention } : {}),
    claudeCode: { nativePassthrough: false },
    providers: {
      anth: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "key", apiKey: "sk-ant-fixture", models: [MODEL], fetch },
      gpt: { adapter: "openai-chat", baseUrl: "https://gpt.invalid/v1", authMode: "key", apiKey: "sk-fixture", models: ["g"], fetch },
    },
    combos: { waterfall: { strategy: "failover", targets: [{ provider: "anth", model: MODEL }, { provider: "gpt", model: "g" }] } },
  } as unknown as OcxConfig;
  const cc = { type: "ephemeral", ...(callerTtl ? { ttl: callerTtl } : {}) };
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "combo/waterfall", max_tokens: 64,
      system: [{ type: "text", text: "You are a careful assistant.", cache_control: cc }],
      tools: [{ name: "Read", description: "read", input_schema: { type: "object", properties: {} } }],
      messages: [
        { role: "user", content: "First." },
        { role: "assistant", content: "Done." },
        { role: "user", content: [{ type: "text", text: "Continue.", cache_control: cc }] },
      ],
    }),
  }), config, { model: "", provider: "" });
  expect(response.status).toBe(200);
  await response.text();
  expect(wires).toHaveLength(1);
  const ttls: unknown[] = [];
  JSON.parse(wires[0]!, (key, value) => {
    if (key === "cache_control") ttls.push(value.ttl);
    return value;
  });
  expect(ttls.length).toBeGreaterThan(0);
  return ttls;
}

describe("translated Claude lane cache TTL", () => {
  test("caller ttl 1h keeps every adapter breakpoint at 1h", async () => {
    expect(new Set(await wireTtls("1h"))).toEqual(new Set(["1h"]));
  });

  test("caller without ttl keeps the 5m default", async () => {
    expect(new Set(await wireTtls(undefined))).toEqual(new Set([undefined]));
  });

  test("explicit operator cacheRetention wins over the caller hint", async () => {
    expect(new Set(await wireTtls("1h", "short"))).toEqual(new Set([undefined]));
  });
});
