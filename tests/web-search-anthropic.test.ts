import { afterEach, describe, expect, mock, test } from "bun:test";
import * as oauthModule from "../src/oauth";

// Stub the stored-OAuth token fetch so the anthropic executor request-shape test is deterministic
// and never touches the real credential store or network (mirrors tests/destination-policy-resolved).
mock.module("../src/oauth", () => ({ ...oauthModule, getValidAccessToken: async () => "test-token-xyz" }));

import { parseRequest } from "../src/responses/parser";
import {
  findAnthropicSidecarProvider,
  planWebSearch,
  resolveSidecarBackend,
} from "../src/web-search";
import { parseAnthropicSidecarSSE, runAnthropicWebSearch } from "../src/web-search/anthropic-executor";
import { CLAUDE_CODE_SYSTEM_INSTRUCTION } from "../src/oauth/anthropic";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const routedProvider: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://routed.test/v1", apiKey: "routed-key" };
const forwardProvider: OcxProviderConfig = { adapter: "openai-responses", baseUrl: "https://chatgpt.test/v1", authMode: "forward" };
const anthropicProvider: OcxProviderConfig = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" };

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return { port: 10100, defaultProvider: "routed", providers: { routed: routedProvider, chatgpt: forwardProvider }, ...overrides };
}

function parsedWithWebSearch() {
  return parseRequest({ model: "routed/model", input: "Search current docs", stream: true, tools: [{ type: "web_search" }] });
}

/** Build an Anthropic-style SSE stream Response from frame objects. */
function sseResponse(frames: Record<string, unknown>[], opts: { crlf?: boolean; unterminated?: boolean; chunkSize?: number } = {}): Response {
  const nl = opts.crlf ? "\r\n" : "\n";
  let body = frames.map(f => `event: ${f.type}${nl}data: ${JSON.stringify(f)}${nl}${nl}`).join("");
  if (opts.unterminated) body = body.replace(/(\r\n\r\n|\n\n)$/, ""); // drop the final frame terminator
  return new Response(new ReadableStream({
    start(c) {
      const bytes = new TextEncoder().encode(body);
      if (opts.chunkSize && opts.chunkSize > 0) {
        for (let i = 0; i < bytes.length; i += opts.chunkSize) c.enqueue(bytes.slice(i, i + opts.chunkSize));
      } else {
        c.enqueue(bytes);
      }
      c.close();
    },
  }), { status: 200 });
}

describe("web-search anthropic backend resolution", () => {
  test("resolveSidecarBackend: explicit wins, unset defaults to openai", () => {
    expect(resolveSidecarBackend("anthropic")).toBe("anthropic");
    expect(resolveSidecarBackend("openai")).toBe("openai");
    expect(resolveSidecarBackend(undefined)).toBe("openai");
  });

  test("findAnthropicSidecarProvider ignores providers with no usable stored credential", () => {
    // "anthropicx" has no account in the real store → not selectable.
    const cfg = config({ providers: { routed: routedProvider, chatgpt: forwardProvider, anthropicx: anthropicProvider } });
    expect(findAnthropicSidecarProvider(cfg)).toBeUndefined();
  });

  test("planWebSearch defaults to the openai backend when no anthropic credential exists", () => {
    const sidecar = {
      providerName: "openai" as const,
      provider: forwardProvider,
      accountMode: "direct" as const,
      authContext: { kind: "main" as const, accountId: null },
      headers: new Headers({ authorization: "Bearer chatgpt" }),
    };
    const plan = planWebSearch(config(), parsedWithWebSearch(), false, routedProvider, "model", sidecar);
    expect(plan?.backend).toBe("openai");
    expect(plan?.forwardSidecar).toBe(sidecar);
    expect(plan?.anthropicSidecar).toBeUndefined();
  });

  test("planWebSearch FAILS CLOSED when anthropic is explicitly configured but no credential is usable", () => {
    const cfg = config({ webSearchSidecar: { backend: "anthropic" } });
    // No usable anthropic credential → must return no plan (never silently borrow ChatGPT creds).
    expect(planWebSearch(cfg, parsedWithWebSearch(), false, routedProvider, "model")).toBeUndefined();
  });
});

describe("parseAnthropicSidecarSSE", () => {
  test("folds web_search_tool_result + text + citations into {text, sources} and dedups by url", async () => {
    const res = sseResponse([
      { type: "message_start" },
      { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"query\":\"bun\"}" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [
        { type: "web_search_result", url: "https://bun.sh", title: "Bun" },
        { type: "web_search_result", url: "https://bun.sh", title: "Bun dup" },
        { type: "web_search_result", url: "https://github.com/oven-sh/bun" },
      ] } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Bun 1.3 " } },
      { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "is out." } },
      { type: "content_block_delta", index: 2, delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: "https://bun.sh/blog", title: "Blog" } } },
      { type: "content_block_stop", index: 2 },
      { type: "message_stop" },
    ]);
    const out = await parseAnthropicSidecarSSE(res);
    expect(out.error).toBeUndefined();
    expect(out.text).toBe("Bun 1.3 is out.");
    expect(out.sources).toEqual([
      { url: "https://bun.sh", title: "Bun" },
      { url: "https://github.com/oven-sh/bun" },
      { url: "https://bun.sh/blog", title: "Blog" },
    ]);
  });

  test("web_search_tool_result_error with no answer text surfaces an error", async () => {
    const res = sseResponse([
      { type: "content_block_start", index: 0, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_2", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } } },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ]);
    const out = await parseAnthropicSidecarSSE(res);
    expect(out.text).toBe("");
    expect(out.sources).toEqual([]);
    expect(out.error).toBeDefined();
  });

  test("empty results (content:[]) with answer text is a success, not an error", async () => {
    const res = sseResponse([
      { type: "content_block_start", index: 0, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_3", content: [] } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "No relevant results." } },
      { type: "content_block_stop", index: 1 },
      { type: "message_stop" },
    ]);
    const out = await parseAnthropicSidecarSSE(res);
    expect(out.error).toBeUndefined();
    expect(out.text).toBe("No relevant results.");
    expect(out.sources).toEqual([]);
  });

  test("handles CRLF framing and an unterminated final frame", async () => {
    const res = sseResponse([
      { type: "content_block_start", index: 0, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_4", content: [{ type: "web_search_result", url: "https://example.com", title: "Ex" }] } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer via CRLF." } },
    ], { crlf: true, unterminated: true });
    const out = await parseAnthropicSidecarSSE(res);
    expect(out.text).toBe("Answer via CRLF.");
    expect(out.sources).toEqual([{ url: "https://example.com", title: "Ex" }]);
  });

  test("handles a CRLF frame terminator split across chunk boundaries (byte-by-byte)", async () => {
    const res = sseResponse([
      { type: "content_block_start", index: 0, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_5", content: [{ type: "web_search_result", url: "https://split.example", title: "Split" }] } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Chunked CRLF answer." } },
      { type: "content_block_stop", index: 1 },
      { type: "message_stop" },
    ], { crlf: true, chunkSize: 1 });
    const out = await parseAnthropicSidecarSSE(res);
    expect(out.text).toBe("Chunked CRLF answer.");
    expect(out.sources).toEqual([{ url: "https://split.example", title: "Split" }]);
  });
});

describe("runAnthropicWebSearch request shape", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("POSTs /v1/messages with the OAuth fingerprint, disabled thinking, and the web_search tool", async () => {
    let captured: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null = null;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
      captured = { url: String(url), headers, body: JSON.parse(String(init?.body)) };
      const ok = sseResponse([
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_stop" },
      ]);
      return ok;
    }) as unknown as typeof fetch;

    const out = await runAnthropicWebSearch(
      "latest bun release",
      "anthropic",
      anthropicProvider,
      { model: "claude-sonnet-5", reasoning: "low", timeoutMs: 5000, describeImages: false },
    );
    expect(out.error).toBeUndefined();
    expect(out.text).toBe("ok");

    const c = captured!;
    expect(c.url).toBe("https://api.anthropic.com/v1/messages");
    expect(c.headers["authorization"]).toBe("Bearer test-token-xyz");
    expect(c.headers["anthropic-beta"]).toContain("oauth");
    expect(c.headers["anthropic-version"]).toBe("2023-06-01");
    expect(c.headers["x-app"]).toBe("cli");
    expect(c.headers["x-claude-code-session-id"]).toBeDefined();
    expect(c.body.model).toBe("claude-sonnet-5");
    expect(c.body.max_tokens).toBe(8192);
    expect(c.body.thinking).toEqual({ type: "disabled" });
    const system = c.body.system as { type: string; text: string }[];
    expect(system[0]).toEqual({ type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION });
    const tools = c.body.tools as { type: string; name: string; max_uses: number }[];
    expect(tools[0]).toEqual({ type: "web_search_20250305", name: "web_search", max_uses: 3 });
  });
});
