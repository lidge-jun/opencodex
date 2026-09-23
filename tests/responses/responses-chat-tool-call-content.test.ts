import { afterEach, expect, test } from "bun:test";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

let releaseSpendHome: (() => void) | undefined;

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
});

test("/v1/responses suppresses OpenAI Chat tool-call markup duplicated by a structured call", async () => {
  const savedFetch = globalThis.fetch;
  const script = "const result = await tools.exec_command({cmd: \"pwd\"});\ntext(result.output);";
  const leaked = `<tool_call><function=exec>${script}\n</parameter></function></tool_call>`;
  const commentary = "I'll run it now.\n";
  const content = commentary + leaked;
  const split = commentary.length + 5;
  const frames = [
    { choices: [{ delta: { content: content.slice(0, split) } }] },
    { choices: [{ delta: { content: content.slice(split) } }] },
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_exec",
            function: { name: "exec", arguments: script + JSON.stringify({ input: script }) },
          }],
        },
      }],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";

  globalThis.fetch = (async () => new Response(frames, {
    headers: { "content-type": "text/event-stream" },
  })) as typeof fetch;

  const config = {
    port: 0,
    defaultProvider: "fixture",
    providers: {
      fixture: {
        adapter: "openai-chat",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "fixture-key",
      },
    },
  } as OcxConfig;

  try {
    releaseSpendHome = acquireOwnedSpendHome();
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "fixture/xiaomi-mimo-v2.6-pro",
        stream: true,
        input: "run pwd",
        tools: [{
          type: "custom",
          name: "exec",
          description: "Run JavaScript",
          format: { type: "grammar", syntax: "lark" },
        }],
      }),
    }), config, { model: "", provider: "" });
    const body = await response.text();
    const payloads = body.split("\n")
      .filter(line => line.startsWith("data: {") && line !== "data: [DONE]")
      .map(line => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
    const inputDone = payloads.find(payload => payload.type === "response.custom_tool_call_input.done");
    const outputText = payloads
      .filter(payload => payload.type === "response.output_text.delta")
      .map(payload => payload.delta)
      .join("");

    expect(response.status).toBe(200);
    expect(body).toContain('"type":"custom_tool_call"');
    expect(inputDone).toMatchObject({ input: script });
    expect(outputText).toBe(commentary);
    expect(body).not.toContain("<tool_call>");
  } finally {
    globalThis.fetch = savedFetch;
  }
});
