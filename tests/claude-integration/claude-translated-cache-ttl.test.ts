import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { callerCacheRetention } from "../../src/claude/inbound";
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

async function wireTtls(
  callerTtl: "1h" | undefined,
  cacheRetention?: "short" | "long",
  messageTtl: "1h" | "5m" | "unset" = callerTtl ?? "unset",
  topLevelTtl?: "1h" | "5m" | "unset",
  nestedToolResultTtl?: "1h" | "5m",
): Promise<unknown[]> {
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
  const messageCc = { type: "ephemeral", ...(messageTtl === "unset" ? {} : { ttl: messageTtl }) };
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "combo/waterfall", max_tokens: 64,
      ...(topLevelTtl ? { cache_control: { type: "ephemeral", ...(topLevelTtl === "unset" ? {} : { ttl: topLevelTtl }) } } : {}),
      system: [{ type: "text", text: "You are a careful assistant.", cache_control: cc }],
      tools: [{ name: "Read", description: "read", input_schema: { type: "object", properties: {} } }],
      messages: [
        { role: "user", content: "First." },
        ...(nestedToolResultTtl
          ? [
            { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }] },
            { role: "user", content: [
              { type: "tool_result", tool_use_id: "toolu_1", content: [
                { type: "text", text: "file body", cache_control: { type: "ephemeral", ttl: nestedToolResultTtl } },
              ] },
              { type: "text", text: "Continue.", cache_control: messageCc },
            ] },
          ]
          : [
            { role: "assistant", content: "Done." },
            { role: "user", content: [{ type: "text", text: "Continue.", cache_control: messageCc }] },
          ]),
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

  test("a caller mixing a 1h prefix with a 5m tail is not upgraded to 1h everywhere", async () => {
    expect(new Set(await wireTtls("1h", undefined, "5m"))).toEqual(new Set([undefined]));
    expect(new Set(await wireTtls("1h", undefined, "unset"))).toEqual(new Set([undefined]));
    // Top-level automatic caching counts as a caller breakpoint.
    expect(new Set(await wireTtls("1h", undefined, "1h", "unset"))).toEqual(new Set([undefined]));
    expect(new Set(await wireTtls("1h", undefined, "1h", "5m"))).toEqual(new Set([undefined]));
    expect(new Set(await wireTtls("1h", undefined, "1h", "1h"))).toEqual(new Set(["1h"]));
    // Breakpoints nested in a tool_result's content count too.
    expect(new Set(await wireTtls("1h", undefined, "1h", undefined, "5m"))).toEqual(new Set([undefined]));
    expect(new Set(await wireTtls("1h", undefined, "1h", undefined, "1h"))).toEqual(new Set(["1h"]));
  });
});

describe("callerCacheRetention walks every block container", () => {
  const h1 = { type: "ephemeral", ttl: "1h" };
  const m5 = { type: "ephemeral", ttl: "5m" };
  const body = (nested: unknown) => ({
    system: [{ type: "text", text: "s", cache_control: h1 }],
    messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [nested] }] }],
  });

  test("a 5m breakpoint deep inside search_result or document content keeps the default", () => {
    expect(callerCacheRetention(body({ type: "search_result", source: "s", title: "t",
      content: [{ type: "text", text: "x", cache_control: m5 }] }))).toBeUndefined();
    expect(callerCacheRetention(body({ type: "document",
      source: { type: "content", content: [{ type: "text", text: "x", cache_control: m5 }] } }))).toBeUndefined();
    expect(callerCacheRetention(body({ type: "search_result", source: "s", title: "t",
      content: [{ type: "text", text: "x", cache_control: h1 }] }))).toBe("long");
  });

  test("a cache_control key inside tool input or schema is caller data, not a breakpoint", () => {
    expect(callerCacheRetention({
      tools: [{ name: "T", input_schema: { type: "object", properties: { cache_control: h1 } } }],
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "T", input: { cache_control: h1 } }] }],
    })).toBeUndefined();
  });
});
