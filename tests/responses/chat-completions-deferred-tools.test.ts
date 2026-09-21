import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";

/**
 * #4735: an OpenAI-compatible harness may declare part of its tool catalog and discover the rest
 * at runtime. Enforcing declared-tool membership against that partial catalog ended the stream
 * mid-turn with a 502 and cost the caller the whole turn. The chat and Anthropic wires now relay
 * the call and leave execution or refusal to the client's own runner; `responses` still fails
 * closed (#1700), which tests/adapters/bridge.test.ts pins at the bridge.
 *
 * Lives beside chat-completions-endpoint.test.ts rather than inside it: that file sits against its
 * cap in tests/fixtures/file-size-baseline.json, and the ratchet only lowers.
 */

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-chat-deferred-tools-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-chat-deferred-tools-"));
  process.env.OPENCODEX_HOME = testDir;
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  resetProviderRequestPacingForTest();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  globalThis.fetch = originalFetch;
  if (testDir) removeTreeWithRetry(testDir);
});

function mockConfig(baseUrl: string, providerOverrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  return {
    port: 0,
    defaultProvider: "mock",
    providers: {
      mock: {
        adapter: "openai-chat",
        baseUrl,
        apiKey: "k",
        allowPrivateNetwork: true,
        ...providerOverrides,
      },
    },
  } as OcxConfig;
}

describe("chat-completions deferred tool pass-through", () => {
  function mockChatUpstreamWithToolCall(toolName = "todo_write") {
    return Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (!url.pathname.endsWith("/chat/completions")) {
          return Response.json({ error: { message: `unexpected path ${url.pathname}` } }, { status: 404 });
        }
        let isStreaming = true;
        try {
          const body = (await req.json()) as Record<string, unknown>;
          if (body.stream === false) isStreaming = false;
        } catch { /* keep default */ }

        if (!isStreaming) {
          return Response.json({
            id: "chatcmpl-test",
            object: "chat.completion",
            created: Date.now(),
            model: "mock/test-model",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_undeclared_1",
                      type: "function",
                      function: {
                        name: toolName,
                        arguments: "{\"path\":\"todo.md\"}",
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 },
          });
        }

        const frames = [
          `data: ${JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_undeclared_1",
                      type: "function",
                      function: { name: toolName, arguments: "" },
                    },
                  ],
                },
              },
            ],
          })}\n\n`,
          `data: ${JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: { arguments: "{\"path\":\"todo.md\"}" },
                    },
                  ],
                },
              },
            ],
          })}\n\n`,
          `data: ${JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 10, completion_tokens: 15 },
          })}\n\n`,
          "data: [DONE]\n\n",
        ];
        return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
      },
    });
  }

  test("relays undeclared function call when client streams with partial tools declared", async () => {
    const upstream = mockChatUpstreamWithToolCall("todo_write");
    saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/chat/completions", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "mock/test-model",
          stream: true,
          messages: [{ role: "user", content: "write to todo" }],
          tools: [
            {
              type: "function",
              function: {
                name: "lookup",
                description: "lookup symbol",
                parameters: { type: "object", properties: { q: { type: "string" } } },
              },
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("text/event-stream");
      const text = await response.text();
      expect(text).toContain("todo_write");
      expect(text).toContain("call_undeclared_1");
      /*
       * Terminal shape, not a substring search for "502".
       *
       * The old assertion searched the whole stream, and the relay stamps each chunk with a
       * random `chatcmpl-<hex>` id. Windows shard 4/9 of run 35180376537 drew
       * `chatcmpl-05021785ecf5440c96ca31be` and went red on a turn that had succeeded
       * perfectly. `tests/images/loop.test.ts` already retired the identical assertion for
       * "504" and measured it at roughly one run in 69.
       *
       * It could not see a real 502 either: this relay's failure carries an error frame and
       * ends the turn, and the number never appears in the body. So assert that instead - the
       * stream completed and carried no error.
       */
      expect(text).toContain("data: [DONE]");
      expect(text).not.toContain("\"error\"");
      expect(text).not.toContain("undeclared client tool");
    } finally {
      await server.stop(true);
      upstream.stop(true);
    }
  });

  test("relays undeclared function call in buffered non-streaming mode with partial tools declared", async () => {
    const upstream = mockChatUpstreamWithToolCall("todo_write");
    saveConfig(mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/chat/completions", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "mock/test-model",
          stream: false,
          messages: [{ role: "user", content: "write to todo" }],
          tools: [
            {
              type: "function",
              function: {
                name: "lookup",
                description: "lookup symbol",
                parameters: { type: "object", properties: { q: { type: "string" } } },
              },
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      const json = (await response.json()) as {
        choices?: Array<{
          message?: {
            tool_calls?: Array<{
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
      };
      expect(json.choices?.[0]?.message?.tool_calls?.[0]?.function?.name).toBe("todo_write");
    } finally {
      await server.stop(true);
      upstream.stop(true);
    }
  });
});
