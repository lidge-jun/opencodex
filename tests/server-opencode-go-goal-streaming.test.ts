import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const CHAT_ENDPOINT = "https://opencode.ai/zen/go/v1/chat/completions";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-opencode-go-goal-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-opencode-go-goal-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

function config(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "opencode-go",
    providers: {
      "opencode-go": {
        adapter: "openai-chat",
        baseUrl: "https://opencode.ai/zen/go/v1",
        apiKey: "test-key",
        models: ["deepseek-v4-flash"],
      },
    },
  } as OcxConfig;
}

function goalRequestBody(): Record<string, unknown> {
  return {
    model: "opencode-go/deepseek-v4-flash",
    input: "Create a goal",
    stream: true,
    store: false,
    tools: [{
      type: "namespace",
      name: "functions",
      description: "Client functions",
      tools: [{
        type: "function",
        name: "update_plan",
        description: "Update the current goal plan",
        parameters: {
          type: "object",
          properties: {
            explanation: { type: "string" },
            plan: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  step: { type: "string" },
                  status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                },
                required: ["step", "status"],
                additionalProperties: false,
              },
            },
          },
          required: ["plan"],
          additionalProperties: false,
        },
        strict: false,
      }],
    }],
  };
}

function toolCallFrame(argumentsDelta: string): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl_goal",
    object: "chat.completion.chunk",
    model: "deepseek-v4-flash",
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_update_plan",
          type: "function",
          function: { name: "update_plan", arguments: argumentsDelta },
        }],
      },
      finish_reason: null,
    }],
  })}\n\n`;
}

async function runGoal(upstreamBody: string): Promise<{
  responseText: string;
  outboundBody: Record<string, unknown>;
}> {
  let outboundBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== CHAT_ENDPOINT) return originalFetch(input, init);
    outboundBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(upstreamBody, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;

  saveConfig(config());
  const server = startServer(0);
  try {
    const response = await originalFetch(new URL("/v1/responses", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(goalRequestBody()),
    });
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(outboundBody).toBeDefined();
    return { responseText, outboundBody: outboundBody! };
  } finally {
    await server.stop(true);
  }
}

function outboundToolNames(body: Record<string, unknown>): string[] {
  const tools = body.tools as Array<{ function?: { name?: string } }> | undefined;
  return tools?.flatMap(tool => tool.function?.name ? [tool.function.name] : []) ?? [];
}

describe("opencode-go /goal streaming (#2260)", () => {
  test("Codex 0.147 functions namespace authorizes a returned update_plan call", async () => {
    const args = JSON.stringify({
      explanation: "Start the goal",
      plan: [{ step: "Inspect", status: "in_progress" }],
    });
    const terminal = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    })}\n\ndata: [DONE]\n\n`;

    const { responseText, outboundBody } = await runGoal(toolCallFrame(args) + terminal);

    expect(outboundToolNames(outboundBody)).toContain("update_plan");
    expect(responseText).toContain('"type":"function_call"');
    expect(responseText).toContain('"name":"update_plan"');
    expect(responseText).toContain("event: response.completed");
    expect(responseText).not.toContain("undeclared client tool");
  });

  test("EOF after a complete update_plan call synthesizes a clean tool-call terminal", async () => {
    const args = JSON.stringify({
      explanation: "Start the goal",
      plan: [{ step: "Inspect", status: "in_progress" }],
    });

    const { responseText } = await runGoal(toolCallFrame(args));

    expect(responseText).toContain('"type":"function_call"');
    expect(responseText).toContain('"name":"update_plan"');
    expect(responseText).toContain("response.function_call_arguments.done");
    expect(responseText).toContain("event: response.completed");
    expect(responseText).not.toContain("possible truncation");
  });

  test("EOF with incomplete update_plan arguments still fails closed", async () => {
    const { responseText } = await runGoal(toolCallFrame('{"plan":['));

    expect(responseText).toContain("event: response.failed");
    expect(responseText).toContain("possible truncation");
    expect(responseText).not.toContain("response.function_call_arguments.done");
    expect(responseText).not.toContain("event: response.completed");
  });
});
