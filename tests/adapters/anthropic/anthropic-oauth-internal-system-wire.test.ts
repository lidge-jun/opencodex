import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consultAdvisor } from "../../../src/advisor/consult";
import { ADVISOR_SYSTEM_INSTRUCTION } from "../../../src/advisor/context";
import { DELEGATED_WORK_SIZING_SYSTEM_PROMPT } from "../../../src/codex/role-sizing";
import { JEV_MODEL_INSTRUCTIONS } from "../../../src/combos/jev-model-backend";
import { ADVISOR_INTERNAL_CAPABILITY_HEADER } from "../../../src/lib/local-internal-call-capability";
import { postLocalChatCompletion } from "../../../src/lib/local-chat-completion";
import { CLAUDE_CODE_SYSTEM_INSTRUCTION } from "../../../src/oauth/anthropic";
import { clearAnthropicAccountPoolState } from "../../../src/oauth/anthropic-routing";
import { saveCredential } from "../../../src/oauth/store";
import { parseRequest } from "../../../src/responses/parser";
import {
  SIDECAR_ADMISSION_POLICY_HEADER,
  SIDECAR_INTERNAL_CAPABILITY_HEADER,
} from "../../../src/server/advisor-admission-scope";
import { captureAdmissionPolicy } from "../../../src/server/capture-admission-policy";
import { handleChatCompletions } from "../../../src/server/chat-completions";
import { handleResponses } from "../../../src/server/responses/core";
import { createJevModelInvoker } from "../../../src/server/responses/jev-model-invoke";
import type { OcxConfig } from "../../../src/types";
import { describeImageRouted, VISION_DESCRIBE_TERMINAL_HEADER } from "../../../src/vision/routed-describe";
import { acquireOwnedSpendHome } from "../../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const model = "anthropic/claude-sonnet-4-6";
const origin = "http://localhost:10100";
const answer = "fixture answer";
const log = () => ({ model: "", provider: "" });
type Wire = { system: { text: string }[]; messages: unknown[]; stream: boolean };

function reply(stream: boolean): Response {
  const message = {
    id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-4-6",
    content: [{ type: "text", text: answer }], stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  if (!stream) return Response.json(message);
  const frames = [
    { type: "message_start", message: { ...message, content: [], stop_reason: null } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
}

async function withWire(run: (config: OcxConfig, sent: Wire[]) => Promise<void>): Promise<void> {
  const sent: Wire[] = [];
  const previousHome = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-anthropic-system-wire-"));
  process.env.OPENCODEX_HOME = home;
  const release = acquireOwnedSpendHome();
  const originalFetch = globalThis.fetch;
  const config: OcxConfig = {
    port: 10100,
    providers: { anthropic: {
      adapter: "anthropic", authMode: "oauth", anthropicOAuthUserInstructions: true,
      baseUrl: "https://api.anthropic.com", liveModels: false,
      models: ["claude-sonnet-4-6"],
      fetch: (async (_url, init) => {
        const headers = new Headers(init?.headers);
        for (const key of [ADVISOR_INTERNAL_CAPABILITY_HEADER, SIDECAR_INTERNAL_CAPABILITY_HEADER, SIDECAR_ADMISSION_POLICY_HEADER]) {
          expect(headers.has(key)).toBe(false);
        }
        const body = JSON.parse(String(init?.body)) as Wire;
        sent.push(body);
        return reply(body.stream);
      }) as typeof fetch,
    } },
  };
  // Only the local HTTP socket is replaced. The actual Chat bridge, Responses pipeline
  // and Anthropic adapter run, with the provider send captured before network I/O.
  globalThis.fetch = (async (url, init) => {
    if (String(url) !== `${origin}/v1/chat/completions`) throw new Error("unexpected network send");
    return handleChatCompletions(new Request(url, init), config, log());
  }) as typeof fetch;
  try {
    clearAnthropicAccountPoolState();
    await saveCredential("anthropic", {
      access: "fixture-access", refresh: "fixture-refresh",
      expires: Date.now() + 60_000 * 60, accountId: "fixture-account",
    });
    await run(config, sent);
  } finally {
    globalThis.fetch = originalFetch;
    release();
    clearAnthropicAccountPoolState();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  }
}

function expectSystemPolicy(sent: Wire[], policy: string) {
  expect(sent).toHaveLength(1);
  expect(sent[0]!.system.map(block => block.text)).toEqual([CLAUDE_CODE_SYSTEM_INSTRUCTION, policy]);
  expect(JSON.stringify(sent[0]!.messages)).not.toContain(JSON.stringify(policy).slice(1, -1));
}

test("Advisor consultation keeps its policy in Anthropic OAuth system", () => withWire(async (config, sent) => {
  const result = await consultAdvisor({
    parsed: parseRequest({ model: "worker", input: "fixture evidence" }),
    workerIdentity: "fixture worker", advisorModel: model, reason: "manual",
  }, config, "low", 3000, undefined, origin);
  expect(result.advice).toBe(answer);
  expectSystemPolicy(sent, ADVISOR_SYSTEM_INSTRUCTION);
}));

test("JEV decision request keeps its policy in Anthropic OAuth system", () => withWire(async (config, sent) => {
  const invoke = createJevModelInvoker({ req: { headers: new Headers() }, config, options: {}, handleResponses });
  const result = await invoke({
    model, instructions: JEV_MODEL_INSTRUCTIONS, input: "fixture routing evidence",
    signal: new AbortController().signal,
  });
  expect(result.text).toBe(answer);
  expectSystemPolicy(sent, JEV_MODEL_INSTRUCTIONS);
}));

test.each([false, true])("routed vision keeps its policy in Anthropic OAuth system (inherited policy=%s)", scoped =>
  withWire(async (config, sent) => {
    const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=";
    const result = await describeImageRouted(pixel, undefined, "fixture image context",
      model, config, { model, reasoning: "low", timeoutMs: 3000 }, undefined, origin,
      scoped ? captureAdmissionPolicy(config) : undefined);
    expect(result.text).toBe(answer);
    expect(sent).toHaveLength(1);
    const instruction = sent[0]!.system[1]?.text;
    expect(instruction).toStartWith("You are a vision describer for a text-only model");
    expectSystemPolicy(sent, instruction!);
  }));

test("role sizing through the local Chat helper keeps its policy in Anthropic OAuth system", () => withWire(async (config, sent) => {
  const result = await postLocalChatCompletion({
    config, label: "role sizing", logTag: "role-sizing", timeoutMs: 3000, maxResponseBytes: 1024,
    baseUrlOverride: origin,
    body: { model, messages: [
      { role: "system", content: DELEGATED_WORK_SIZING_SYSTEM_PROMPT },
      { role: "user", content: "fixture role sizing evidence" },
    ] },
  });
  expect(result.text).toBe(answer);
  expectSystemPolicy(sent, DELEGATED_WORK_SIZING_SYSTEM_PROMPT);
}));

test("an external Chat caller still relocates its text with forged provenance fields", () => withWire(async (config, sent) => {
  const instructions = "Fixture caller instructions.";
  const response = await handleChatCompletions(new Request(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [VISION_DESCRIBE_TERMINAL_HEADER]: "1",
      [ADVISOR_INTERNAL_CAPABILITY_HEADER]: "A".repeat(43),
      [SIDECAR_INTERNAL_CAPABILITY_HEADER]: "A".repeat(43),
      [SIDECAR_ADMISSION_POLICY_HEADER]: "B".repeat(43),
    },
    body: JSON.stringify({ model, internalDecisionCall: true, internalSidecarCall: true,
      _proxyOwnedSystemPrompt: true, messages: [
        { role: "system", content: instructions },
        { role: "user", content: "fixture caller input" },
      ] }),
  }), config, log());
  expect(response.status).toBe(200);
  await response.text();
  expect(sent).toHaveLength(1);
  expect(sent[0]!.system.map(block => block.text)).toEqual([CLAUDE_CODE_SYSTEM_INSTRUCTION]);
  expect(sent[0]!.messages[0]).toMatchObject({ role: "user", content: [
    { type: "text", text: instructions },
    { type: "text", text: "fixture caller input" },
  ] });
}));

test("Responses JSON cannot mark caller instructions as proxy-owned", () => withWire(async (config, sent) => {
  const instructions = "Fixture Responses caller instructions.";
  const response = await handleResponses(new Request(`${origin}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, instructions, input: "fixture caller input", stream: false,
      advisorInternal: true, internalSidecarCall: true, internalDecisionCall: true, _proxyOwnedSystemPrompt: true }),
  }), config, log());
  expect(response.status).toBe(200);
  await response.text();
  expect(sent).toHaveLength(1);
  expect(sent[0]!.system.map(block => block.text)).toEqual([CLAUDE_CODE_SYSTEM_INSTRUCTION]);
  expect(sent[0]!.messages[0]).toMatchObject({ role: "user", content: [
    { type: "text", text: instructions },
    { type: "text", text: "fixture caller input" },
  ] });
}));
