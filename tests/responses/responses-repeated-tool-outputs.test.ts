/**
 * One call, several recorded outputs.
 *
 * Codex code mode records a yield marker for a running cell, then each late `notify()`/wait
 * output as a further result for the same call id. Tolerant upstreams accept that history; strict
 * ones do not, and the failure blocks every later turn of the thread:
 * - OpenGateway's Responses parser: "Messages with role 'tool' must be a response to a preceding
 *   message with 'tool_calls'" (wrong item set for the assistant turn).
 * - DeepSeek Chat: "Duplicate tool output for call_id".
 *
 * The repair joins those outputs in arrival order, so no content is dropped and no call is
 * fabricated, and only the unambiguous shape (one call, all its outputs after it) is touched.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mergeRepeatedResponsesToolOutputs } from "../../src/adapters/openai-responses/tool-output-recovery";
import { providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { handleResponses } from "../../src/server/responses/core";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const PLACEHOLDER = JSON.stringify({ type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: " " }] });
let releaseSpendHome: (() => void) | undefined;

const exec = { type: "custom_tool_call", call_id: "toolu_exec", name: "exec", input: "await longJob()" };
const marker = { type: "custom_tool_call_output", call_id: "toolu_exec", output: "Script running with cell ID 108\n" };
const late1 = { type: "custom_tool_call_output", call_id: "toolu_exec", output: "row 1" };
const late2 = { type: "custom_tool_call_output", call_id: "toolu_exec", output: "row 2" };
const user = { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] };

describe("repeated outputs for one tool call", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    releaseSpendHome?.();
    releaseSpendHome = undefined;
    globalThis.fetch = originalFetch;
  });

  async function sentInput(providerId: string, model: string, input: unknown[]): Promise<Array<Record<string, unknown>>> {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return Response.json({ id: "resp_repeat", object: "response", status: "completed", output: [] });
    }) as typeof fetch;
    const provider = { ...providerConfigSeed(getProviderRegistryEntry(providerId)!), apiKey: "sk-test" };
    releaseSpendHome = acquireOwnedSpendHome();
    await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input, stream: true }),
      }),
      { providers: { [providerId]: provider } } as unknown as OcxConfig,
      { model: "", provider: "" },
    );
    const sent = (bodies[0]?.input ?? []) as Array<Record<string, unknown>>;
    return sent.filter(item => JSON.stringify(item) !== PLACEHOLDER);
  }

  test("OpenGateway's Responses wire sends one joined output per call", async () => {
    const input = await sentInput(
      "opengateway",
      "deepseek/deepseek-v4.1-flash-ultrafast",
      [user, exec, marker, late1, late2],
    );
    const execOutputs = input.filter(item => item.call_id === "toolu_exec"
      && String(item.type).endsWith("_output"));
    expect(execOutputs).toHaveLength(1);
    expect(execOutputs[0]!.output).toBe("Script running with cell ID 108\n\n\nrow 1\n\nrow 2");
  });

  test("DeepSeek's own Responses wire also sends one output per call", async () => {
    const input = await sentInput("deepseek", "deepseek-v4-flash", [
      user,
      { type: "function_call", call_id: "call_exec", name: "exec", arguments: "{}" },
      { type: "function_call_output", call_id: "call_exec", output: "first" },
      { type: "function_call_output", call_id: "call_exec", output: "second" },
    ]);
    const answers = input.filter(item => item.call_id === "call_exec" && String(item.type).endsWith("_output"));
    expect(answers).toHaveLength(1);
    expect(answers[0]!.output).toBe("first\n\nsecond");
  });
});

describe("mergeRepeatedResponsesToolOutputs", () => {
  test("mixed text and content-part outputs become one content-part list", () => {
    const image = { type: "input_image", image_url: "data:image/png;base64,AA==" };
    const merged = mergeRepeatedResponsesToolOutputs({
      input: [exec, marker, { ...late1, output: [image] }],
    }) as { input: Array<Record<string, unknown>> };
    expect(merged.input).toEqual([
      exec,
      { ...marker, output: [{ type: "input_text", text: "Script running with cell ID 108\n" }, image] },
    ]);
  });

  test("a single output, an output without its call, or an output before its call is unchanged", () => {
    for (const body of [
      { input: [exec, marker] },
      { input: [marker, late1] },
      { input: [marker, exec, late1] },
      { input: [exec, { ...exec, id: "ctc_reused" }, marker, late1] },
    ]) {
      expect(mergeRepeatedResponsesToolOutputs(body)).toBe(body);
    }
  });
});
