import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeCliAdapter } from "../../src/adapters/claude-cli/adapter";
import { getAdapterDefinition } from "../../src/adapters/registry";
import { handleOwnedResponses as handleResponses } from "../helpers/response-replay-owner";
import { rememberResponseState } from "../../src/responses/state";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { buildDshClientConfig } from "../../src/clients/config-export/dsh";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import type { OcxConfig } from "../../src/types";

test("Chat preserves the local Claude image refusal across direct and combo dispatch", async () => {
  const definition = getAdapterDefinition("claude-cli")!;
  const originalCreate = definition.create;
  const releaseSpend = acquireOwnedSpendHome();
  let launches = 0;
  definition.create = provider => createClaudeCliAdapter(provider, {
    usageAdmission: async () => ({ state: "unknown" }),
    which: () => process.execPath,
    spawn: () => { launches++; throw new Error("unexpected CLI launch"); },
  });
  const config = { port: 0, defaultProvider: "claude-cli", providers: {
    "claude-cli": { adapter: "claude-cli", baseUrl: "https://api.anthropic.com", authMode: "key", selectedModels: ["claude-sonnet-5-5"] },
  }, combos: { pair: { strategy: "failover", targets: [{ provider: "claude-cli", model: "claude-sonnet-5-5" }] } } } as OcxConfig;
  try {
    for (const model of ["claude-cli/claude-sonnet-5-5", "pair"]) {
      const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
        method: "POST", body: JSON.stringify({ model, messages: [
          { role: "developer", content: [{ type: "image_url", image_url: { url: "https://fixture.invalid/private-image" } }] },
          { role: "user", content: "hello" },
        ] }),
      }), config, { model: "", provider: "" });
      const body = await response.text();
      expect(response.status).toBe(400);
      expect(body).toContain("Claude Code CLI does not support images in developer instructions.");
      expect(body).not.toContain("private-image");
    }
    expect(launches).toBe(0);
  } finally {
    definition.create = originalCreate;
    releaseSpend();
  }
});

test("Codex/DSH Responses and Pi Chat retain host-owned tools, inclusive usage and abort cleanup", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-claude-http-"));
  const fixture = join(home, "fixture.txt");
  writeFileSync(fixture, "PROBE_FILE_CONTENT_42");
  const definition = getAdapterDefinition("claude-cli")! as any;
  const originalCreate = definition.create;
  const releaseSpend = acquireOwnedSpendHome();
  const children: number[] = [];
  const ownedChildren: ReturnType<typeof spawn>[] = [];
  const closed = new Set<number>();
  let hostReads = 0;
  const config = { port: 0, defaultProvider: "claude-cli", providers: {
    "claude-cli": { adapter: "claude-cli", baseUrl: "https://api.anthropic.com", authMode: "key", selectedModels: ["claude-sonnet-5-5"] },
  } } as OcxConfig;
  definition.create = (provider: any) => createClaudeCliAdapter(provider, {
    which: () => process.execPath,
    killGraceMs: 20,
    timeoutMs: 5000,
    spawn: (_command, args, options) => {
      const child = spawn(process.execPath, [join(import.meta.dir, "../fixtures/claude-efficiency-cli.ts"), JSON.stringify(args), fixture, process.env.OCX_EFFICIENCY_NEGATIVE_CONTROL ?? ""], options);
      children.push(child.pid!);
      ownedChildren.push(child);
      child.on("close", () => closed.add(child.pid!));
      return child;
    },
  });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: req => req.url.endsWith("/responses")
    ? handleResponses(req, config, { model: "", provider: "" })
    : handleChatCompletions(req, config, { model: "", provider: "" }) });
  const base = `http://127.0.0.1:${server.port}/v1`;
  const model = "claude-cli/claude-sonnet-5-5";
  const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
  const responseTools = [{ type: "function", name: "read_text", description: "Read the test fixture", parameters: schema }];
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}/${path}`, { method: "POST", headers: { "content-type": "application/json", "thread-id": "claude-cli-client-http" }, body: JSON.stringify(body) });
    const value = await res.json() as any;
    if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${JSON.stringify(value)}`);
    return value;
  };
  try {
    expect(server.port).not.toBe(10100);
    const exported = buildDshClientConfig({ baseUrl: base, models: [{ namespaced: model, provider: "claude-cli", id: "claude-sonnet-5-5", displayName: "Sonnet 5.5", inputModalities: ["text"] }], config });
    expect(exported["llm-pi-ai"].providers.opencodex!.api).toBe("openai-responses");
    expect(exported["llm-pi-ai"].providers.opencodex!.models[0]!.name).toBe("Sonnet 5.5 (claude-cli)");
    const first = await post("responses", { model, stream: false, store: true, input: [{ role: "user", content: "Read the fixture using read_text." }], tools: responseTools });
    const call = first.output.find((item: any) => item.type === "function_call");
    expect(call.name).toBe("read_text");
    expect(JSON.parse(call.arguments).path).toBe(fixture);
    expect(hostReads).toBe(0);
    const content = readFileSync(fixture, "utf8"); hostReads++;
    const second = await post("responses", { model, stream: false, previous_response_id: first.id, input: [{ type: "function_call_output", call_id: call.call_id, output: content }], tools: responseTools });
    expect(JSON.stringify(second.output)).toContain(content);
    expect(second.usage.input_tokens).toBe(112);
    const chatTools = [{ type: "function", function: { name: "read_text", description: "Read the test fixture", parameters: schema } }];
    const messages: any[] = [{ role: "user", content: "Read the fixture using read_text." }];
    const chatFirst = await post("chat/completions", { model, stream: false, messages, tools: chatTools });
    const reply = chatFirst.choices[0].message;
    expect(reply.tool_calls[0].function.name).toBe("read_text");
    expect(JSON.parse(reply.tool_calls[0].function.arguments).path).toBe(fixture);
    messages.push(reply, { role: "tool", tool_call_id: reply.tool_calls[0].id, content: readFileSync(fixture, "utf8") }); hostReads++;
    const chatSecond = await post("chat/completions", { model, stream: false, messages, tools: chatTools });
    expect(chatSecond.choices[0].message.content).toBe(content);
    expect(chatSecond.usage.prompt_tokens).toBe(112);
    const controller = new AbortController();
    const previousChildren = children.length;
    const waiting = fetch(`${base}/responses`, { method: "POST", signal: controller.signal, headers: { "content-type": "application/json", "thread-id": "claude-cli-client-http" }, body: JSON.stringify({ model, stream: true, input: "WAIT_FOR_ABORT", tools: responseTools }) }).then(res => res.text()).catch(() => "aborted");
    const deadline = Date.now() + 2500;
    while (children.length === previousChildren && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(children.length).toBe(previousChildren + 1);
    controller.abort();
    await waiting;
    const cleanupDeadline = Date.now() + 2500;
    while (closed.size < children.length && Date.now() < cleanupDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(closed.size).toBe(children.length);
    for (const pid of children) expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    try {
      await server.stop(true);
      for (const child of ownedChildren) {
        if (child.exitCode === null && child.signalCode === null) {
          const childClosed = new Promise<void>(resolve => child.once("close", () => resolve()));
          child.kill();
          await Promise.race([childClosed, new Promise<void>((_, reject) => setTimeout(() => reject(new Error("Owned fixture cleanup timed out")), 2500))]);
        }
      }
    } finally {
      definition.create = originalCreate;
      releaseSpend();
      rmSync(home, { recursive: true, force: true });
    }
  }
}, 20000);

test("instruction images are refused at both HTTP routes before CLI launch", async () => {
  const definition = getAdapterDefinition("claude-cli")!;
  const originalCreate = definition.create;
  const otherDefinition = getAdapterDefinition("codebuddy")!;
  const originalOtherCreate = otherDefinition.create;
  let otherCalls = 0;
  otherDefinition.create = provider => ({ ...originalOtherCreate(provider), name: "codebuddy",
    async runTurn(_parsed, _incoming, emit) {
      otherCalls++;
      emit({ type: "text_delta", text: "other provider answered" });
      emit({ type: "done" });
    },
  });
  const releaseSpend = acquireOwnedSpendHome();
  let launches = 0;
  definition.create = provider => createClaudeCliAdapter(provider, {
    usageAdmission: async () => ({ state: "unknown" }),
    which: () => process.execPath,
    spawn: (_command, args, options) => {
      launches++;
      return spawn(process.execPath, [join(import.meta.dir, "../fixtures/claude-efficiency-cli.ts"), JSON.stringify(args), "", "image-replay"], options);
    },
  });
  const model = "claude-cli/claude-sonnet-5-5";
  const config = { port: 0, defaultProvider: "claude-cli", providers: {
    "claude-cli": { adapter: "claude-cli", baseUrl: "https://api.anthropic.com", authMode: "key", selectedModels: ["claude-sonnet-5-5"] },
  } } as OcxConfig;
  const post = async (path: "responses" | "chat/completions", body: unknown, direct = false) => {
    const request = new Request(`http://localhost/v1/${path}`, { method: "POST", body: JSON.stringify(body) });
    const cfg = direct ? { ...config, protocols: { rollout: { directEncoders: true } } } as OcxConfig : config;
    return path === "responses" ? handleResponses(request, cfg, { model: "", provider: "" })
      : handleChatCompletions(request, cfg, { model: "", provider: "" });
  };
  const chatImage = { type: "image_url", image_url: { url: "https://fixture.invalid/private-image" } };
  const responseImage = { type: "input_image", image_url: "https://fixture.invalid/private-image" };
  try {
    for (const role of ["developer", "system"]) {
      for (const leading of [true, false]) for (const direct of [false, true]) for (const stream of [false, true]) {
        const instruction = { role, content: [{ type: "text", text: "policy" }, chatImage] };
        const user = { role: "user", content: "hello" };
        const response = await post("chat/completions", { model, stream, messages: leading ? [instruction, user] : [user, instruction, user] }, direct);
        const body = await response.text();
        expect(response.status).toBe(400);
        expect(body).toContain("does not support images in developer instructions");
        expect(body).not.toContain("private-image");
      }
      for (const leading of [true, false]) for (const stream of [false, true]) {
        const instruction = { role, content: [{ type: "input_text", text: "policy" }, responseImage] };
        const user = { role: "user", content: "hello" };
        const response = await post("responses", { model, stream, input: leading ? [instruction, user] : [user, instruction, user] });
        const body = await response.text();
        expect(response.status).toBe(400);
        expect(body).toContain("unsupported_input_modality");
        expect(body).not.toContain("private-image");
      }
    }
    expect(launches).toBe(0);
    for (const image of [
      { type: "image", data: "QUFB", mimeType: "image/png" },
      { type: "image", source: { type: "url", url: "https://fixture.invalid/private-image" } },
      { type: "image_url", image_url: {} },
    ]) {
      const response = await post("chat/completions", { model, messages: [
        { role: "user", content: "hello" }, { role: "developer", content: [image] },
      ] });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("does not support images in developer instructions");
    }
    const comboConfig = { ...config, combos: { pair: { strategy: "failover", targets: [
      { provider: "claude-cli", model: "claude-sonnet-5-5" },
    ] } } } as OcxConfig;
    const comboResponse = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
      method: "POST", body: JSON.stringify({ model: "pair", messages: [
        { role: "developer", content: [chatImage] }, { role: "user", content: "hello" },
      ] }),
    }), comboConfig, { model: "", provider: "" });
    expect(comboResponse.status).toBe(400);
    expect(await comboResponse.text()).toContain("does not support images in developer instructions");
    expect(launches).toBe(0);
    // Text-only Claude rows rewrite the raw body during vision preprocessing.
    const textOnlyConfig = { ...comboConfig, visionSidecar: { enabled: false }, providers: {
      "claude-cli": { ...config.providers["claude-cli"], noVisionModels: ["claude-sonnet-5-5"] },
    } } as OcxConfig;
    for (const target of [model, "pair"]) {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", body: JSON.stringify({ model: target, input: [
          { role: "developer", content: [responseImage] }, { role: "user", content: "hello" },
        ] }),
      }), textOnlyConfig, { model: "", provider: "" });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("unsupported_input_modality");
    }
    expect(launches).toBe(0);
    let descriptions = 0;
    const vision = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => {
      descriptions++;
      return Response.json({ choices: [{ message: { content: "fixture description" } }] });
    } });
    try {
      const visionConfig = { ...textOnlyConfig, port: vision.port, hostname: "127.0.0.1",
        providers: { ...textOnlyConfig.providers, helper: { adapter: "openai-chat", baseUrl: "https://fixture.invalid",
          apiKey: "fixture-key", modelInputModalities: { vision: ["text", "image"] } } },
        visionSidecar: { enabled: true, backend: "routed", model: "helper/vision" },
      } as OcxConfig;
      for (const target of [model, "pair"]) {
        const response = await handleResponses(new Request("http://localhost/v1/responses", {
          method: "POST", body: JSON.stringify({ model: target, input: [
            { role: "developer", content: [{ type: "input_image", image_url: "data:image/png;base64,QUFB" }] },
            { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,QkJC" }] },
          ] }),
        }), visionConfig, { model: "", provider: "" });
        expect(response.status).toBe(400);
        expect(await response.text()).toContain("unsupported_input_modality");
        const fileResponse = await handleResponses(new Request("http://localhost/v1/responses", {
          method: "POST", body: JSON.stringify({ model: target, input: [
            { type: "agent_message", content: [{ type: "input_image", file_id: "file-private-fixture" }] },
            { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,QkJC" }] },
          ] }),
        }), visionConfig, { model: "", provider: "" });
        expect(fileResponse.status).toBe(400);
        expect(await fileResponse.text()).toContain("unsupported_input_modality");
      }
      expect(descriptions).toBe(0);
      expect(launches).toBe(0);
    } finally {
      await vision.stop(true);
    }
    const otherConfig = { port: 0, defaultProvider: "other", providers: {
      other: { adapter: "codebuddy", baseUrl: "https://fixture.invalid", authMode: "key", apiKey: "fixture-key", selectedModels: ["fixture-model"] },
    } } as OcxConfig;
    const otherResponse = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
      method: "POST", body: JSON.stringify({ model: "other/fixture-model", messages: [
        { role: "developer", content: [{ type: "text", text: "policy" }, chatImage] }, { role: "user", content: "hello" },
      ] }),
    }), otherConfig, { model: "", provider: "" });
    expect(otherResponse.status).toBe(200);
    expect(await otherResponse.text()).toContain("other provider answered");
    expect(otherCalls).toBe(1);
    const otherResponses = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", body: JSON.stringify({ model: "other/fixture-model", input: [
        { role: "developer", content: [{ type: "input_text", text: "policy" }, responseImage] },
        { role: "user", content: "hello" },
      ] }),
    }), otherConfig, { model: "", provider: "" });
    expect(otherResponses.status).toBe(200);
    expect(await otherResponses.text()).toContain("other provider answered");
    expect(otherCalls).toBe(2);
    const otherFileImage = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", body: JSON.stringify({ model: "other/fixture-model", input: [
        { role: "user", content: [{ type: "input_image", file_id: "file-fixture" }] },
      ] }),
    }), otherConfig, { model: "", provider: "" });
    expect(otherFileImage.status).toBe(200);
    const otherFileBody = await otherFileImage.text();
    expect(otherFileBody).toContain("OpenCodex cannot translate file input on this route");
    expect(otherFileBody).not.toContain("Claude Code CLI");
    expect(otherCalls).toBe(2);
    const otherAgentImage = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", body: JSON.stringify({ model: "other/fixture-model", input: [
        { type: "agent_message", content: [{ type: "input_image", file_id: "file-private-fixture" }] },
      ] }),
    }), otherConfig, { model: "", provider: "" });
    expect(otherAgentImage.status).toBe(200);
    const otherAgentBody = await otherAgentImage.text();
    expect(otherAgentBody).not.toContain("Claude Code CLI");
    expect(otherAgentBody).toContain("other provider answered");
    expect(otherCalls).toBe(3);
    const valid = await post("chat/completions", { model, messages: [
      { role: "developer", content: "text policy" },
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,QUFB" } }] },
    ] });
    expect(valid.status).toBe(200);
    expect(launches).toBe(1);
  } finally {
    definition.create = originalCreate;
    otherDefinition.create = originalOtherCreate;
    releaseSpend();
  }
}, 20000);

test("Responses file-backed images are refused before Claude CLI launch", async () => {
  const definition = getAdapterDefinition("claude-cli")!;
  const originalCreate = definition.create;
  const releaseSpend = acquireOwnedSpendHome();
  let launches = 0;
  definition.create = provider => createClaudeCliAdapter(provider, {
    usageAdmission: async () => ({ state: "unknown" }),
    which: () => process.execPath,
    spawn: (_command, args, options) => {
      launches++;
      return spawn(process.execPath, [join(import.meta.dir, "../fixtures/claude-efficiency-cli.ts"), JSON.stringify(args), "", "image-replay"], options);
    },
  });
  const config = { port: 0, defaultProvider: "claude-cli", providers: {
    "claude-cli": { adapter: "claude-cli", baseUrl: "https://api.anthropic.com", authMode: "key", selectedModels: ["claude-sonnet-5-5"] },
  }, combos: { pair: { strategy: "failover", targets: [{ provider: "claude-cli", model: "claude-sonnet-5-5" }] } } } as OcxConfig;
  const image = { type: "input_image", file_id: "file-private-fixture" };
  try {
    for (const model of ["claude-cli/claude-sonnet-5-5", "pair"]) for (const input of [
      [{ type: "agent_message", content: [{ type: "input_text", text: "before" }, image] }],
      [{ role: "user", content: [{ type: "input_text", text: "before" }, image] }],
      [{ type: "function_call", call_id: "call_1", name: "view", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: [{ type: "input_text", text: "before" }, image] }],
      [{ type: "custom_tool_call", call_id: "call_2", name: "view", input: "" },
        { type: "custom_tool_call_output", call_id: "call_2", output: [image] }],
    ]) {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", body: JSON.stringify({ model, input }),
      }), config, { model: "", provider: "" });
      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toContain("unsupported");
      expect(body).not.toContain("file-private-fixture");
    }
    expect(launches).toBe(0);
    rememberResponseState({ input: [{ type: "agent_message", content: [image] }] },
      { id: "resp_agent_file_fixture", status: "completed", output: [] });
    for (const model of ["claude-cli/claude-sonnet-5-5", "pair"]) {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", body: JSON.stringify({ model, previous_response_id: "resp_agent_file_fixture", input: "continue" }),
      }), config, { model: "", provider: "" });
      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toContain("unsupported_input_modality");
      expect(body).not.toContain("file-private-fixture");
    }
    expect(launches).toBe(0);
    let decisions = 0;
    const decisionConfig = { ...config, providers: { ...config.providers,
      "claude-cli": { ...config.providers["claude-cli"], selectedModels: ["claude-sonnet-5-5", "claude-opus-5-5"] }, jev: {
      adapter: "jev-decision", baseUrl: "https://api.typesafe.ai/v1/systemone", apiKey: "fixture-key",
      fetch: async () => { decisions++; return Response.json({ error: {} }, { status: 500 }); },
    } }, combos: { routed: { strategy: "jev", targets: [
      { provider: "claude-cli", model: "claude-sonnet-5-5" }, { provider: "claude-cli", model: "claude-opus-5-5" },
    ] } } } as OcxConfig;
    const decisionResponse = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", body: JSON.stringify({ model: "combo/routed", input: [
        { type: "agent_message", content: [image] }, { role: "user", content: "Inspect the message" },
      ] }),
    }), decisionConfig, { model: "", provider: "" });
    expect(decisions).toBe(1);
    expect(decisionResponse.status).toBe(400);
    expect(await decisionResponse.text()).toContain("unsupported_input_modality");
    expect(launches).toBe(0);
    const valid = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", body: JSON.stringify({ model: "claude-cli/claude-sonnet-5-5", input: [
        { role: "user", content: [{ ...image, image_url: "data:image/png;base64,QUFB" }] },
      ] }),
    }), config, { model: "", provider: "" });
    expect(valid.status).toBe(200);
    await valid.text();
    expect(launches).toBe(1);
    const validAgent = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", body: JSON.stringify({ model: "claude-cli/claude-sonnet-5-5", input: [
        { type: "agent_message", content: [{ ...image, image_url: "data:image/png;base64,QUFB" }] },
      ] }),
    }), config, { model: "", provider: "" });
    expect(validAgent.status).toBe(200);
    await validAgent.text();
    expect(launches).toBe(2);
  } finally {
    definition.create = originalCreate;
    releaseSpend();
  }
}, 20000);


test("image requests retain Responses history and Chat tool results through CLI stdin", async () => {
  const definition = getAdapterDefinition("claude-cli")!;
  const originalCreate = definition.create;
  const releaseSpend = acquireOwnedSpendHome();
  const model = "claude-cli/claude-opus-5-5";
  const config = { port: 0, defaultProvider: "claude-cli", providers: {
    "claude-cli": { adapter: "claude-cli", baseUrl: "https://api.anthropic.com", authMode: "key", selectedModels: ["claude-opus-5-5"] },
  } } as OcxConfig;
  definition.create = provider => createClaudeCliAdapter(provider, {
    which: () => process.execPath,
    timeoutMs: 5000,
    spawn: (_command, args, options) => spawn(process.execPath,
      [join(import.meta.dir, "../fixtures/claude-efficiency-cli.ts"), JSON.stringify(args), "", "image-replay"], options),
  });
  // Exercise the real request handlers and owned CLI child without needing a listener or credentials.
  const post = async (path: string, body: unknown) => {
    const request = new Request(`http://127.0.0.1/v1/${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const response = path === "responses"
      ? await handleResponses(request, config, { model: "", provider: "" })
      : await handleChatCompletions(request, config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    return await response.json() as any;
  };
  const replay = (response: any) => JSON.parse(response.output
    ? response.output.flatMap((item: any) => item.content ?? []).filter((part: any) => part.type === "output_text").map((part: any) => part.text).join("")
    : response.choices[0].message.content);
  const image = (data: string) => ({ type: "input_image", image_url: `data:image/png;base64,${data}` });
  const native = (data: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });
  try {
    // No explicit context override: real routing must inherit Opus's 1M registry window.
    const history = Array.from({ length: 30 }, (_, index) => [
      { role: "user", content: `EARLY_RECORD_${index}:` + "x".repeat(5000) },
      { role: "assistant", content: `RESULT_${index}:` + "y".repeat(5000) },
    ]).flat();
    const longReplay = replay(await post("responses", { model, stream: false,
      input: [...history, { role: "user", content: "Current request after the long history" }],
    }));
    expect(longReplay).toHaveLength(61);
    expect(longReplay[0].text).toStartWith("USER:\nEARLY_RECORD_0:");
    expect(longReplay.at(-1).text).toBe("USER:\nCurrent request after the long history");
    const first = await post("responses", { model, stream: false, store: true, input: [
      { role: "user", content: [{ type: "input_text", text: "First" }, image("QUFB"), { type: "input_text", text: "Second" }, image("QkJC")] },
    ] });
    const initial = replay(first);
    expect(initial).toEqual([{ type: "text", text: "USER:\nFirst" }, native("QUFB"), { type: "text", text: "Second" }, native("QkJC")]);
    const second = await post("responses", { model, stream: false, previous_response_id: first.id, input: [
      { role: "user", content: [{ type: "input_text", text: "Next" }, image("Q0ND")] },
    ] });
    const continued = replay(second);
    expect(continued.slice(0, initial.length)).toEqual(initial);
    expect(continued.filter((part: any) => part.type === "image")).toEqual([native("QUFB"), native("QkJC"), native("Q0ND")]);
    const tools = [{ type: "function", name: "screenshot", description: "Return a screenshot", parameters: { type: "object", properties: {} } }];
    const call = { type: "function_call", name: "screenshot", call_id: "shot_1", arguments: "{}" };
    const tool = await post("responses", { model, stream: false, tools, input: [
      { role: "user", content: "Inspect" }, call,
      { type: "function_call_output", call_id: "shot_1", output: [{ type: "input_text", text: "Before" }, image("RERERQ=="), { type: "input_text", text: "After" }] },
    ] });
    const toolReplay = replay(tool);
    expect(toolReplay.slice(-3)).toEqual([{ type: "text", text: "TOOL RESULT (call_id: shot_1):\nBefore" }, native("RERERQ=="), { type: "text", text: "After" }]);
    const chat = await post("chat/completions", { model, stream: false,
      tools: [{ type: "function", function: { name: "screenshot", description: "Return a screenshot", parameters: { type: "object", properties: {} } } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "Inspect" }, { type: "image_url", image_url: { url: "data:image/png;base64,QUFB" } }] },
        { role: "assistant", content: null, tool_calls: [{ id: "shot_1", type: "function", function: { name: "screenshot", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "shot_1", content: [{ type: "image_url", image_url: { url: "https://example.test/shot.png" } }] },
        { role: "user", content: "Continue" },
      ],
    });
    const chatReplay = replay(chat);
    expect(chatReplay.filter((part: any) => part.type === "image")).toEqual([native("QUFB"), { type: "image", source: { type: "url", url: "https://example.test/shot.png" } }]);
    expect(chatReplay.find((part: any) => part.type === "text" && part.text.startsWith("TOOL RESULT"))?.text).toContain("call_id: shot_1");
    expect(chatReplay.at(-1)).toEqual({ type: "text", text: "USER:\nContinue" });
  } finally {
    definition.create = originalCreate;
    releaseSpend();
  }
}, 20000);
