// End to end for the experimental Anthropic perMessageEffort option (#6895): two Codex turns through
// handleResponses with fetch replaced. Turn metadata is read in request preparation, the adapter
// decides, and the delivery commits from the completed response and the raw usage.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PER_MESSAGE_EFFORT_BETA, perMessageEffortStoreForTests, resetPerMessageEffortStoreForTests } from "../../src/adapters/anthropic/per-message-effort";
import { handleResponses } from "../../src/server/responses/core";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const MODEL = "claude-sonnet-5-5";
const NEW_META = JSON.stringify({ history_initialization: "New" });
const userMsg = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const frame = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

function upstreamSse(text: string, usage: { read: number; write: number }): string {
  return [
    frame("message_start", { message: { id: "msg_up", usage: { input_tokens: 3, cache_read_input_tokens: usage.read, cache_creation_input_tokens: usage.write } } }),
    frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    frame("content_block_delta", { index: 0, delta: { type: "text_delta", text } }),
    frame("content_block_stop", { index: 0 }),
    frame("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
    frame("message_stop", {}),
  ].join("");
}

function outputItemsOf(sse: string): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const json = JSON.parse(line.slice(6)) as { type?: string; item?: Record<string, unknown> };
      if (json.type === "response.output_item.done" && json.item) items.push(json.item);
    } catch { /* not JSON */ }
  }
  return items;
}

describe("perMessageEffort through handleResponses", () => {
  const originalFetch = globalThis.fetch;
  let releaseSpendHome: (() => void) | undefined;
  let sent: Array<{ body: Record<string, any>; headers: Headers }>;
  let replies: string[];

  beforeEach(() => {
    resetPerMessageEffortStoreForTests();
    releaseSpendHome = acquireOwnedSpendHome();
    sent = [];
    replies = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ body: JSON.parse(String(init?.body ?? "{}")), headers: new Headers(init?.headers) });
      const reply = replies.shift();
      if (reply === undefined) throw new Error("unexpected upstream send");
      return new Response(reply, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
  });
  afterEach(() => {
    releaseSpendHome?.();
    releaseSpendHome = undefined;
    globalThis.fetch = originalFetch;
  });

  async function turn(config: OcxConfig, input: unknown[], effort: string, headers: Record<string, string> = {}): Promise<string> {
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model: `anthropic-key/${MODEL}`, input, stream: true, reasoning: { effort }, prompt_cache_key: "thread-e2e" }),
    }), config, { model: "", provider: "" }, {});
    return await response.text();
  }

  const provider = (perMessageEffort: boolean): OcxProviderConfig & { fetch: typeof fetch } => ({
    adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-test", defaultMaxOutputTokens: 64000, perMessageEffort,
    fetch: globalThis.fetch,
  });

  test.each([400, 503])("replay veto: rejected per-message effort clears pending state (%i)", async status => {
    let sends = 0;
    const configured = provider(true);
    configured.fetch = (async () => {
      sends++;
      expect(perMessageEffortStoreForTests().pending.size).toBe(1);
      return Response.json({ type: "error", error: { type: "invalid_request_error",
        message: status === 400 ? "output_config.effort requires a model that supports per-turn effort; this model does not" : "fixture service failure",
      } }, { status, headers: { "x-should-retry": "false" } });
    }) as typeof fetch;
    const config = { providers: { "anthropic-key": configured } } as unknown as OcxConfig;
    await turn(config, [userMsg("fixture question")], "high", { "x-codex-turn-metadata": NEW_META });
    expect(sends).toBe(1);
    expect(perMessageEffortStoreForTests().pending.size).toBe(0);
    expect(perMessageEffortStoreForTests().capability.size).toBe(status === 400 ? 1 : 0);
  });

  test("an effort change keeps the first turn's top-level effort and sends an effort message instead", async () => {
    const config = { providers: { "anthropic-key": provider(true) } } as unknown as OcxConfig;
    replies.push(upstreamSse("first", { read: 0, write: 1000 }), upstreamSse("second", { read: 1000, write: 200 }));
    const input1 = [userMsg("fix the bug")];
    const sse1 = await turn(config, input1, "high", { "x-codex-turn-metadata": NEW_META });
    const input2 = [...input1, ...outputItemsOf(sse1), userMsg("now the tests")];
    await turn(config, input2, "low", { "x-codex-turn-metadata": NEW_META });

    expect(sent).toHaveLength(2);
    expect(sent[0].headers.get("anthropic-beta") ?? "").toContain(PER_MESSAGE_EFFORT_BETA);
    expect(sent[1].headers.get("anthropic-beta") ?? "").toContain(PER_MESSAGE_EFFORT_BETA);
    expect(sent[0].body.output_config).toEqual({ effort: "high" });
    expect(sent[1].body.output_config).toEqual({ effort: "high" });
    const messages = sent[1].body.messages as Record<string, unknown>[];
    expect(messages.at(-2)).toEqual({ role: "system", content: [], output_config: { effort: "low" } });
    expect(JSON.stringify(messages.at(-1))).toContain("now the tests");
    expect(sent[1].body.max_tokens).toBe(sent[0].body.max_tokens);
  });

  test("with the option off the same conversation changes the top-level effort as today", async () => {
    const config = { providers: { "anthropic-key": provider(false) } } as unknown as OcxConfig;
    replies.push(upstreamSse("first", { read: 0, write: 1000 }), upstreamSse("second", { read: 1000, write: 200 }));
    const input1 = [userMsg("fix the bug")];
    const sse1 = await turn(config, input1, "high", { "x-codex-turn-metadata": NEW_META });
    await turn(config, [...input1, ...outputItemsOf(sse1), userMsg("now the tests")], "low", { "x-codex-turn-metadata": NEW_META });
    expect(sent[1].body.output_config).toEqual({ effort: "low" });
    expect((sent[1].body.messages as Record<string, unknown>[]).some(m => m.role === "system")).toBe(false);
    expect(sent.every(s => !(s.headers.get("anthropic-beta") ?? "").includes(PER_MESSAGE_EFFORT_BETA))).toBe(true);
  });

  test("without Codex's New turn metadata the conversation is never tracked", async () => {
    const config = { providers: { "anthropic-key": provider(true) } } as unknown as OcxConfig;
    replies.push(upstreamSse("first", { read: 0, write: 1000 }), upstreamSse("second", { read: 1000, write: 200 }));
    const input1 = [userMsg("fix the bug")];
    const sse1 = await turn(config, input1, "high");
    await turn(config, [...input1, ...outputItemsOf(sse1), userMsg("now the tests")], "low");
    expect(sent[1].body.output_config).toEqual({ effort: "low" });
    expect(sent.every(s => !(s.headers.get("anthropic-beta") ?? "").includes(PER_MESSAGE_EFFORT_BETA))).toBe(true);
  });
});

