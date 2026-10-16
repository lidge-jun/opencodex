import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForNativeMainStartupGate } from "../../src/codex/native-profile-startup";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * #4312, end to end: which inbound wire sees an upstream refusal as what.
 *
 * `tests/adapters/bridge-terminal-refusal.test.ts` pins the bridge; this pins the wiring — that
 * only the Responses inbound wire asks the bridge for `response.failed`, through the real server
 * and a real Anthropic-shaped upstream that ends the turn with `stop_reason: "refusal"`.
 */
type Frame = { name?: string; data: Record<string, any> };

const MODEL = "claude-refusal/claude-test";
const RESPONSES_TERMINALS = new Set(["response.completed", "response.incomplete", "response.failed"]);

function anthropicSse(stopReason: string): string {
  const frame = (name: string, data: Record<string, unknown>) =>
    `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;
  return [
    frame("message_start", {
      message: { id: "msg_1", model: "claude-test", usage: { input_tokens: 10, output_tokens: 1 } },
    }),
    frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "I can" } }),
    frame("content_block_stop", { index: 0 }),
    frame("message_delta", { delta: { stop_reason: stopReason }, usage: { output_tokens: 3 } }),
    frame("message_stop", {}),
  ].join("");
}

function frames(text: string): Frame[] {
  return text.split("\n\n").flatMap(block => {
    const lines = block.trim().split("\n");
    const name = lines.find(line => line.startsWith("event: "))?.slice(7);
    const data = lines.find(line => line.startsWith("data: "))?.slice(6);
    if (!data || data === "[DONE]") return [];
    return [{ name, data: JSON.parse(data) as Record<string, any> }];
  });
}

const previousHome = process.env.OPENCODEX_HOME;
let home = "";
let isolated: IsolatedCodexHome | undefined;
let upstream: ReturnType<typeof Bun.serve> | undefined;
let server: ReturnType<typeof startServer> | undefined;
let stopReason = "refusal";
let upstreamRequests = 0;

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      upstreamRequests += 1;
      const body = await request.json() as { stream?: boolean };
      if (body.stream !== true) {
        return Response.json({
          id: "msg_1", type: "message", role: "assistant", model: "claude-test",
          content: [{ type: "text", text: "I can" }],
          stop_reason: stopReason, stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 3 },
        });
      }
      return new Response(anthropicSse(stopReason), { headers: { "content-type": "text/event-stream" } });
    },
  });
  home = mkdtempSync(join(tmpdir(), "ocx-refusal-wiring-"));
  isolated = installIsolatedCodexHome("ocx-refusal-wiring-codex-");
  process.env.OPENCODEX_HOME = home;
  saveConfig({
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "claude-refusal",
    providers: {
      "claude-refusal": {
        adapter: "anthropic",
        baseUrl: `http://127.0.0.1:${upstream.port}`,
        apiKey: "sk-test",
        // The upstream is a loopback fixture, and nothing here may reach a real catalog.
        allowPrivateNetwork: true,
        liveModels: false,
        defaultModel: "claude-test",
        models: ["claude-test"],
      },
    },
  } as OcxConfig);
  server = startServer(0);
  // Requests admitted before the native-main startup gate settles are held, not served.
  await waitForNativeMainStartupGate();
});

afterAll(async () => {
  await server?.stop(true);
  upstream?.stop(true);
  // Assigning `undefined` to an env var stores the string "undefined", which then becomes a
  // directory name under the working tree. Delete the key when there was nothing to restore.
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolated?.restore();
  if (home) removeTreeWithRetry(home);
});

async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(new URL(path, server!.url), {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
}

describe("upstream refusal, per inbound wire", () => {
  test("/v1/responses streaming ends with exactly one response.failed carrying invalid_prompt", async () => {
    stopReason = "refusal";
    const before = upstreamRequests;
    const response = await post("/v1/responses", { model: MODEL, input: "hi", stream: true });
    const all = frames(await response.text());

    expect(response.status).toBe(200);
    expect(all.map(frame => frame.name).filter(name => RESPONSES_TERMINALS.has(name ?? "")))
      .toEqual(["response.failed"]);
    const failed = all.find(frame => frame.name === "response.failed")!.data.response;
    expect(failed.status).toBe("failed");
    expect(failed.error).toEqual(failed.last_error);
    expect(failed.error.type).toBe("invalid_request_error");
    expect(failed.error.code).toBe("invalid_prompt");
    expect(failed.error.message).toContain('stop_reason "refusal"');
    expect(failed.retryable).toBe(false);
    expect(failed.usage.input_tokens).toBe(10);
    // The proxy itself must not replay a refusal either.
    expect(upstreamRequests - before).toBe(1);
  });

  test("/v1/responses streaming still completes an ordinary turn", async () => {
    stopReason = "end_turn";
    const response = await post("/v1/responses", { model: MODEL, input: "hi", stream: true });
    const names = frames(await response.text()).map(frame => frame.name);

    expect(names.filter(name => RESPONSES_TERMINALS.has(name ?? ""))).toEqual(["response.completed"]);
  });

  test("/v1/responses non-streaming keeps the incomplete body", async () => {
    stopReason = "refusal";
    const response = await post("/v1/responses", { model: MODEL, input: "hi", stream: false });
    const body = await response.json() as Record<string, any>;

    expect(response.status).toBe(200);
    expect(body.status).toBe("incomplete");
    expect(body.incomplete_details.reason).toBe("content_filter");
    expect(body.error ?? null).toBeNull();
    expect(JSON.stringify(body)).not.toContain("invalid_prompt");
  });

  test("/v1/chat/completions streaming reports finish_reason content_filter", async () => {
    stopReason = "refusal";
    const response = await post("/v1/chat/completions", {
      model: MODEL, messages: [{ role: "user", content: "hi" }], stream: true,
    });
    const text = await response.text();
    const finishes = frames(text)
      .flatMap(frame => (frame.data.choices ?? []) as Array<{ finish_reason?: string | null }>)
      .map(choice => choice.finish_reason)
      .filter(Boolean);

    expect(response.status).toBe(200);
    expect(finishes).toEqual(["content_filter"]);
    expect(text).not.toContain("invalid_prompt");
  });

  test("/v1/messages streaming reports stop_reason refusal", async () => {
    stopReason = "refusal";
    const response = await post("/v1/messages", {
      model: MODEL, max_tokens: 64, messages: [{ role: "user", content: "hi" }], stream: true,
    });
    const text = await response.text();
    const delta = frames(text).find(frame => frame.name === "message_delta");

    expect(response.status).toBe(200);
    expect(delta?.data.delta.stop_reason).toBe("refusal");
    expect(text).not.toContain("invalid_prompt");
    expect(text).not.toContain("event: error");
  });
});
