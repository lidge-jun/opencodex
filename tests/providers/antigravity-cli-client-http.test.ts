import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { createAntigravityCliAdapter } from "../../src/adapters/antigravity-cli/adapter";
import { ANTIGRAVITY_CLI_MODELS } from "../../src/adapters/antigravity-cli/profiles";
import {
  ANTIGRAVITY_BRIDGE_AGENT_NAME,
  ANTIGRAVITY_MCP_TOOL_PREFIX,
} from "../../src/adapters/antigravity-cli/protocol";
import { getAdapterDefinition } from "../../src/adapters/registry";
import { CLAUDE_ALIAS_PREFIX_CURRENT } from "../../src/claude/alias";
import { buildCatalogEntries, catalogModelSlug, gatherRoutedModels } from "../../src/codex/catalog";
import { providerConfigSeed } from "../../src/providers/derive";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { candidateCapabilityEvidence } from "../../src/routing/capability";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { isVisionSidecarConsumer, modelAcceptsImageInput } from "../../src/vision/eligibility";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { handleOwnedResponses as handleResponses } from "../helpers/response-replay-owner";

const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const ONE_BY_ONE_PNG_DATA_URL = `data:image/png;base64,${ONE_BY_ONE_PNG_BASE64}`;

function antigravityConfig(): OcxConfig {
  const entry = PROVIDER_REGISTRY.find(row => row.id === "antigravity-cli")!;
  return {
    port: 0,
    defaultProvider: "antigravity-cli",
    providers: {
      "antigravity-cli": {
        ...providerConfigSeed(entry),
        selectedModels: [...ANTIGRAVITY_CLI_MODELS],
      },
    },
  } as OcxConfig;
}

test("Codex catalog sync exposes only Carbon, Argon, and Hydrogen with exact reasoning ladders and text+image modalities", async () => {
  const config = antigravityConfig();
  for (const modelId of ANTIGRAVITY_CLI_MODELS) {
    expect(modelAcceptsImageInput(config, { provider: "antigravity-cli", id: modelId })).toBe(true);
    expect(isVisionSidecarConsumer(config, "antigravity-cli", modelId)).toBe(false);
    expect(candidateCapabilityEvidence(config, "antigravity-cli", modelId)).toMatchObject({
      image: true,
      tools: true,
    });
  }

  const routedDefault = await gatherRoutedModels(config);
  expect(routedDefault.map(catalogModelSlug)).toEqual([
    "antigravity-cli/gemini-4-argon",
    "antigravity-cli/gemini-4-carbon",
    "antigravity-cli/gemini-4-hydrogen",
  ]);
  const routedBySlug = new Map(routedDefault.map(row => [catalogModelSlug(row), row]));
  expect(routedBySlug.get("antigravity-cli/gemini-4-carbon")?.reasoningEfforts).toEqual(["low", "medium", "high"]);
  expect(routedBySlug.get("antigravity-cli/gemini-4-argon")?.reasoningEfforts).toEqual(["low", "medium", "high"]);
  expect(routedBySlug.get("antigravity-cli/gemini-4-hydrogen")?.reasoningEfforts).toEqual(["low", "medium", "high", "xhigh"]);

  const entriesDefault = buildCatalogEntries(null, [], routedDefault);
  const bySlug = new Map(entriesDefault.map(entry => [entry.slug, entry]));

  const carbon = bySlug.get("antigravity-cli/gemini-4-carbon");
  const argon = bySlug.get("antigravity-cli/gemini-4-argon");
  const hydrogen = bySlug.get("antigravity-cli/gemini-4-hydrogen");
  expect(carbon).toBeDefined();
  expect(argon).toBeDefined();
  expect(hydrogen).toBeDefined();

  expect(carbon?.context_window).toBe(1_048_576);
  expect(carbon?.input_modalities).toEqual(["text", "image"]);
  expect(carbon?.supported_reasoning_levels?.map((lvl: any) => lvl.effort)).toEqual(["low", "medium", "high", "max", "ultra"]);
  expect(carbon?.default_reasoning_level).toBe("medium");

  expect(argon?.input_modalities).toEqual(["text", "image"]);
  expect(argon?.supported_reasoning_levels?.map((lvl: any) => lvl.effort)).toEqual(["low", "medium", "high", "max", "ultra"]);
  expect(argon?.default_reasoning_level).toBe("medium");

  expect(hydrogen?.input_modalities).toEqual(["text", "image"]);
  expect(hydrogen?.supported_reasoning_levels?.map((lvl: any) => lvl.effort)).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  expect(hydrogen?.default_reasoning_level).toBe("high");
});

test("Codex /v1/responses, Claude Code /v1/messages, and /v1/chat/completions round-trip tools, custom apply_patch, staged base64 images, efforts, and billing-header stripping", async () => {
  const work = mkdtempSync(join(tmpdir(), "ocx-antigravity-http-"));
  const fixturePath = join(work, "note.txt");
  writeFileSync(fixturePath, "ANTIGRAVITY_PROBE_77");

  const definition = getAdapterDefinition("antigravity-cli")! as any;
  const originalCreate = definition.create;
  const releaseSpend = acquireOwnedSpendHome();

  const seenModelFlags: string[] = [];
  const seenAgentFiles: string[] = [];

  definition.create = (prov: any) => createAntigravityCliAdapter(prov, {
    which: () => process.execPath,
    toolBatchCoalesceMs: 8,
    spawn: (_cmd, args, options) => {
      const modelIdx = args.indexOf("--model");
      if (modelIdx >= 0) seenModelFlags.push(args[modelIdx + 1] ?? "");
      const cwd = String(options.cwd ?? "");
      seenAgentFiles.push(
        readFileSync(join(cwd, ".agents", "agents", ANTIGRAVITY_BRIDGE_AGENT_NAME, "agent.md"), "utf8"),
      );
      const stagedImgPath = join(cwd, ".ocx-images", "img-0.png");
      const hasStagedImage = existsSync(stagedImgPath);

      const child = new EventEmitter() as any;
      const stdout = new PassThrough();
      child.pid = 60606;
      child.stdout = stdout;
      child.stderr = Readable.from([]);
      child.killed = false;
      child.exitCode = null;
      const stdinChunks: string[] = [];
      child.kill = () => {
        child.killed = true;
        stdout.end();
        if (child.exitCode === null) {
          child.exitCode = 0;
          queueMicrotask(() => child.emit("close", 0));
        }
        return true;
      };
      child.stdin = new Writable({
        write(chunk, _enc, cb) {
          stdinChunks.push(String(chunk));
          cb();
        },
        final(cb) {
          const payload = stdinChunks.join("");
          let mcpTools: string[] = [];
          try {
            const catalog = JSON.parse(readFileSync(join(cwd, "catalog.json"), "utf8")) as Array<{ name: string }>;
            mcpTools = catalog.map(item => `${ANTIGRAVITY_MCP_TOOL_PREFIX}${item.name}`);
          } catch {
            mcpTools = [];
          }
          stdout.write(`${JSON.stringify({
            event: "init",
            init: {
              agent: ANTIGRAVITY_BRIDGE_AGENT_NAME,
              tools: [...(hasStagedImage ? ["view_file"] : []), ...mcpTools],
            },
          })}\n`);

          if (hasStagedImage) {
            stdout.write(`${JSON.stringify({
              event: "step_update",
              step_update: {
                step_index: 1,
                state: "ACTIVE",
                step_type: "tool",
                tool_name: "read_file",
                tool_info: { name: "read_file", parameters: { Path: stagedImgPath } },
              },
            })}\n`);
            stdout.write(`${JSON.stringify({
              event: "step_update",
              step_update: {
                step_index: 1,
                state: "DONE",
                step_type: "tool",
                tool_name: "read_file",
                tool_info: { name: "read_file", parameters: { Path: stagedImgPath } },
              },
            })}\n`);
            stdout.write(`${JSON.stringify({
              event: "step_update",
              step_update: {
                step_index: 2,
                state: "DONE",
                step_type: "agent_response",
                text_delta: "Image hydrated: 1x1 PNG",
                usage: { input_tokens: 320, output_tokens: 12, thinking_tokens: 4, cache_read_tokens: 0 },
              },
            })}\n`);
            stdout.write(`${JSON.stringify({
              event: "result",
              result: {
                status: "SUCCESS",
                response: "Image hydrated: 1x1 PNG",
                usage: { input_tokens: 320, output_tokens: 12, thinking_tokens: 4, cache_read_tokens: 0 },
              },
            })}\n`);
            stdout.end();
            child.exitCode = 0;
            queueMicrotask(() => child.emit("close", 0));
          } else if (payload.includes("TOOL RESULT")) {
            stdout.write(`${JSON.stringify({
              event: "step_update",
              step_update: {
                step_index: 1,
                state: "DONE",
                step_type: "agent_response",
                text_delta: "Verified: ANTIGRAVITY_PROBE_77",
                usage: { input_tokens: 170, output_tokens: 14, thinking_tokens: 6, cache_read_tokens: 40 },
              },
            })}\n`);
            stdout.write(`${JSON.stringify({
              event: "result",
              result: {
                status: "SUCCESS",
                response: "Verified: ANTIGRAVITY_PROBE_77",
                usage: { input_tokens: 170, output_tokens: 14, thinking_tokens: 6, cache_read_tokens: 40 },
              },
            })}\n`);
            stdout.end();
            child.exitCode = 0;
            queueMicrotask(() => child.emit("close", 0));
          } else if (payload.includes("USE_APPLY_PATCH")) {
            const patchTool = mcpTools.find(name => name.endsWith("apply_patch"))!;
            stdout.write(`${JSON.stringify({
              event: "step_update",
              step_update: {
                step_index: 1,
                state: "DONE",
                step_type: "agent_response",
                usage: { input_tokens: 150, output_tokens: 22, thinking_tokens: 8, cache_read_tokens: 0 },
              },
            })}\n`);
            stdout.write(`${JSON.stringify({
              event: "step_update",
              step_update: {
                step_index: 2,
                state: "ACTIVE",
                step_type: "tool",
                tool_name: patchTool,
                tool_info: { name: patchTool, parameters: { input: "*** Begin Patch\n*** End Patch" } },
              },
            })}\n`);
          } else {
            const readTool = mcpTools.find(name => name.endsWith("read_text"))!;
            stdout.write(`${JSON.stringify({
              event: "step_update",
              step_update: {
                step_index: 1,
                state: "DONE",
                step_type: "agent_response",
                usage: { input_tokens: 140, output_tokens: 20, thinking_tokens: 5, cache_read_tokens: 10 },
              },
            })}\n`);
            stdout.write(`${JSON.stringify({
              event: "step_update",
              step_update: {
                step_index: 2,
                state: "ACTIVE",
                step_type: "tool",
                tool_name: readTool,
                tool_info: { name: readTool, parameters: { path: fixturePath } },
              },
            })}\n`);
          }
          cb();
        },
      });
      return child as unknown as ChildProcess;
    },
  });

  const config = antigravityConfig();
  const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };

  try {
    // 1. Codex /v1/responses: function tool capture + previous_response_id continuation on Hydrogen xhigh
    const resp1 = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", "thread-id": "agy-codex-1" },
        body: JSON.stringify({
          model: "antigravity-cli/gemini-4-hydrogen",
          reasoning: { effort: "xhigh" },
          stream: false,
          store: true,
          input: [{ role: "user", content: "Read note.txt" }],
          tools: [{ type: "function", name: "read_text", description: "Read file", parameters: schema }],
        }),
      }),
      config,
      { model: "", provider: "" },
    );
    expect(resp1.status).toBe(200);
    const body1 = await resp1.json() as any;
    const fnCall = body1.output.find((item: any) => item.type === "function_call");
    expect(fnCall.name).toBe("read_text");
    expect(JSON.parse(fnCall.arguments)).toEqual({ path: fixturePath });

    const resp2 = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", "thread-id": "agy-codex-1" },
        body: JSON.stringify({
          model: "antigravity-cli/gemini-4-hydrogen",
          reasoning: { effort: "xhigh" },
          stream: false,
          previous_response_id: body1.id,
          input: [{ type: "function_call_output", call_id: fnCall.call_id, output: readFileSync(fixturePath, "utf8") }],
          tools: [{ type: "function", name: "read_text", description: "Read file", parameters: schema }],
        }),
      }),
      config,
      { model: "", provider: "" },
    );
    expect(resp2.status).toBe(200);
    const body2 = await resp2.json() as any;
    expect(JSON.stringify(body2.output)).toContain("ANTIGRAVITY_PROBE_77");
    expect(body2.usage.input_tokens).toBe(210);

    // 2. Codex /v1/responses: custom freeform `apply_patch` tool unwraps cleanly to custom_tool_call
    const patchResp = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "antigravity-cli/gemini-4-carbon",
          reasoning: { effort: "high" },
          stream: false,
          input: [{ role: "user", content: "USE_APPLY_PATCH" }],
          tools: [{ type: "custom", name: "apply_patch", description: "Patch files" }],
        }),
      }),
      config,
      { model: "", provider: "" },
    );
    expect(patchResp.status).toBe(200);
    const patchBody = await patchResp.json() as any;
    const customCall = patchBody.output.find((item: any) => item.type === "custom_tool_call");
    expect(customCall).toBeDefined();
    expect(customCall.name).toBe("apply_patch");
    expect(customCall.input).toBe("*** Begin Patch\n*** End Patch");

    // 3. Claude Code /v1/messages: ocx-claude-* alias + billing header strip + Anthropic tool_use & tool_result
    const claudeModel = `${CLAUDE_ALIAS_PREFIX_CURRENT}antigravity-cli--gemini-4-argon`;
    const msg1 = await handleClaudeMessages(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: claudeModel,
          max_tokens: 4096,
          stream: false,
          system: "x-anthropic-billing-header: cc_version=2.1.88; cc_entrypoint=cli;\nYou are inside Claude Code.",
          messages: [{ role: "user", content: "Read note.txt via read_text" }],
          tools: [{ name: "read_text", description: "Read file", input_schema: schema }],
        }),
      }),
      config,
      { model: "", provider: "" },
    );
    expect(msg1.status).toBe(200);
    const msgBody1 = await msg1.json() as any;
    expect(msgBody1.stop_reason).toBe("tool_use");
    const toolUse = msgBody1.content.find((block: any) => block.type === "tool_use");
    expect(toolUse.name).toBe("read_text");
    expect(toolUse.input).toEqual({ path: fixturePath });

    const msg2 = await handleClaudeMessages(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: claudeModel,
          max_tokens: 4096,
          stream: true,
          system: "x-anthropic-billing-header: cc_version=2.1.88;\nYou are inside Claude Code.",
          messages: [
            { role: "user", content: "Read note.txt via read_text" },
            { role: "assistant", content: msgBody1.content },
            {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: toolUse.id, content: readFileSync(fixturePath, "utf8") }],
            },
          ],
          tools: [{ name: "read_text", description: "Read file", input_schema: schema }],
        }),
      }),
      config,
      { model: "", provider: "" },
    );
    expect(msg2.status).toBe(200);
    const sseText = await msg2.text();
    expect(sseText).toContain("ANTIGRAVITY_PROBE_77");
    expect(sseText).toContain("message_stop");

    // 4. Inline base64 PNG attachments succeed across /v1/responses and /v1/messages without leaking internal read_file steps
    const imgResponses = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "antigravity-cli/gemini-4-carbon",
          stream: false,
          input: [{
            role: "user",
            content: [
              { type: "input_text", text: "describe this" },
              { type: "input_image", image_url: ONE_BY_ONE_PNG_DATA_URL },
            ],
          }],
        }),
      }),
      config,
      { model: "", provider: "" },
    );
    expect(imgResponses.status).toBe(200);
    const imgResponsesBody = await imgResponses.json() as any;
    expect(JSON.stringify(imgResponsesBody.output)).toContain("Image hydrated: 1x1 PNG");
    expect(imgResponsesBody.output.some((item: any) => item.type === "function_call")).toBe(false);

    const imgClaude = await handleClaudeMessages(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: claudeModel,
          max_tokens: 128,
          stream: false,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: "describe" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: ONE_BY_ONE_PNG_BASE64 } },
            ],
          }],
        }),
      }),
      config,
      { model: "", provider: "" },
    );
    expect(imgClaude.status).toBe(200);
    const imgClaudeBody = await imgClaude.json() as any;
    expect(JSON.stringify(imgClaudeBody.content)).toContain("Image hydrated: 1x1 PNG");
    expect(imgClaudeBody.content.some((block: any) => block.type === "tool_use")).toBe(false);

    // 5. Rejects developer images, remote image URLs, and raw tier slugs across endpoints without launching CLI
    const launchesBeforeRefusal = seenModelFlags.length;
    const chatImgRefusal = await handleChatCompletions(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "antigravity-cli/gemini-4-carbon",
          messages: [
            { role: "developer", content: [{ type: "image_url", image_url: { url: "https://fixture.invalid/secret.png" } }] },
            { role: "user", content: "hi" },
          ],
        }),
      }),
      config,
      { model: "", provider: "" },
    );
    expect(chatImgRefusal.status).toBe(400);
    expect(await chatImgRefusal.text()).toContain("Antigravity CLI does not support images in developer instructions.");

    const remoteImgResponsesRefusal = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "antigravity-cli/gemini-4-carbon",
          input: [{
            role: "user",
            content: [
              { type: "input_text", text: "describe this" },
              { type: "input_image", image_url: "https://fixture.invalid/remote.png" },
            ],
          }],
        }),
      }),
      config,
      { model: "", provider: "" },
    );
    expect(remoteImgResponsesRefusal.status).toBe(400);
    expect(await remoteImgResponsesRefusal.text()).toContain("unsupported_input_modality");

    const remoteImgClaudeRefusal = await handleClaudeMessages(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: claudeModel,
          max_tokens: 128,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: "describe" },
              { type: "image", source: { type: "url", url: "https://fixture.invalid/remote.png" } },
            ],
          }],
        }),
      }),
      config,
      { model: "", provider: "" },
    );
    expect(remoteImgClaudeRefusal.status).toBe(400);
    expect(await remoteImgClaudeRefusal.text()).toContain("inline base64 raster images");

    const rawTierRefusal = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "antigravity-cli/gemini-4-carbon-high",
          input: "hello",
        }),
      }),
      config,
      { model: "", provider: "" },
    );
    expect(rawTierRefusal.status).toBe(400);
    expect(await rawTierRefusal.text()).toContain("model_not_found");
    expect(seenModelFlags.length).toBe(launchesBeforeRefusal);

    // Verify exact CLI --model flags and billing-header sanitization across all turns
    expect(seenModelFlags).toEqual([
      "gemini-4-hydrogen-xhigh",
      "gemini-4-hydrogen-xhigh",
      "gemini-4-carbon-high",
      "gemini-4-argon-medium",
      "gemini-4-argon-medium",
      "gemini-4-carbon-medium",
      "gemini-4-argon-medium",
    ]);
    for (const agentMd of seenAgentFiles) {
      expect(agentMd).toContain("inheritMcp: false");
      expect(agentMd).not.toContain("x-anthropic-billing-header");
    }
  } finally {
    definition.create = originalCreate;
    releaseSpend();
    rmSync(work, { recursive: true, force: true });
  }
});

test("Aborting an in-flight /v1/responses request reaps the spawned Antigravity CLI subprocess", async () => {
  const definition = getAdapterDefinition("antigravity-cli")! as any;
  const originalCreate = definition.create;
  const releaseSpend = acquireOwnedSpendHome();
  const spawnedPids: number[] = [];
  const closedPids = new Set<number>();

  definition.create = (prov: any) => createAntigravityCliAdapter(prov, {
    which: () => process.execPath,
    killGraceMs: 25,
    timeoutMs: 5_000,
    spawn: (_cmd, _args, options) => {
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { ...options, stdio: ["pipe", "pipe", "pipe"] },
      );
      spawnedPids.push(child.pid!);
      child.on("close", () => closedPids.add(child.pid!));
      return child;
    },
  });

  const config = antigravityConfig();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: req => handleResponses(req, config, { model: "", provider: "" }),
  });

  try {
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "antigravity-cli/gemini-4-carbon",
        stream: true,
        input: "wait forever",
      }),
    }).then(r => r.text()).catch(() => "aborted");

    const startDeadline = Date.now() + 2_500;
    while (spawnedPids.length === 0 && Date.now() < startDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(spawnedPids).toHaveLength(1);

    controller.abort();
    await pending;

    const reapDeadline = Date.now() + 2_500;
    while (closedPids.size < spawnedPids.length && Date.now() < reapDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(closedPids.size).toBe(1);
    expect(() => process.kill(spawnedPids[0]!, 0)).toThrow();
  } finally {
    await server.stop(true);
    definition.create = originalCreate;
    releaseSpend();
  }
}, 15_000);

test("Failover combo serves base64 images directly on antigravity-cli and hops past disallowed model IDs without spawning CLI", async () => {
  const definition = getAdapterDefinition("antigravity-cli")! as any;
  const originalCreate = definition.create;
  const releaseSpend = acquireOwnedSpendHome();
  let agySpawns = 0;
  let fallbackCalls = 0;

  definition.create = (prov: any) => createAntigravityCliAdapter(prov, {
    which: () => process.execPath,
    platform: "linux",
    spawn: () => {
      agySpawns++;
      const child = new EventEmitter() as any;
      child.pid = 70707;
      child.stdout = Readable.from([
        Buffer.from(`${JSON.stringify({ event: "init", init: { agent: ANTIGRAVITY_BRIDGE_AGENT_NAME, tools: ["view_file"] } })}\n`),
        Buffer.from(`${JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "antigravity vision answered" } })}\n`),
      ]);
      child.stderr = Readable.from([]);
      child.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
      child.killed = false;
      child.exitCode = null;
      child.kill = () => {
        child.killed = true;
        return true;
      };
      setTimeout(() => {
        child.exitCode = 0;
        child.emit("close", 0);
      }, 3);
      return child as unknown as ChildProcess;
    },
  });

  const base = antigravityConfig();
  const config: OcxConfig = {
    ...base,
    providers: {
      ...base.providers,
      fallback: {
        adapter: "anthropic",
        baseUrl: "https://fallback.test",
        authMode: "key",
        apiKey: "fixture-fallback-key",
        models: ["claude-sonnet-4-6"],
        fetch: (async () => {
          fallbackCalls++;
          return Response.json({
            id: "msg_combo_fallback",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "fallback answered" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 12, output_tokens: 4 },
          });
        }) as unknown as typeof fetch,
      } as OcxProviderConfig,
    },
    combos: {
      "agy-image-direct": {
        alias: "combo/agy-image-direct",
        strategy: "failover",
        targets: [
          { provider: "antigravity-cli", model: "gemini-4-carbon" },
          { provider: "fallback", model: "claude-sonnet-4-6" },
        ],
      },
      "agy-model-hop": {
        alias: "combo/agy-model-hop",
        strategy: "failover",
        targets: [
          { provider: "antigravity-cli", model: "gemini-4-carbon-high" },
          { provider: "fallback", model: "claude-sonnet-4-6" },
        ],
      },
      "agy-remote-image-hop": {
        alias: "combo/agy-remote-image-hop",
        strategy: "failover",
        targets: [
          { provider: "antigravity-cli", model: "gemini-4-carbon" },
          { provider: "fallback", model: "claude-sonnet-4-6" },
        ],
      },
    },
  };

  let lastAgentMd = "";
  const baseCreate = definition.create;
  definition.create = (prov: any) => createAntigravityCliAdapter(prov, {
    which: () => process.execPath,
    platform: "linux",
    spawn: (_cmd, _args, options) => {
      const cwd = String(options.cwd ?? "");
      lastAgentMd = readFileSync(join(cwd, ".agents", "agents", ANTIGRAVITY_BRIDGE_AGENT_NAME, "agent.md"), "utf8");
      agySpawns++;
      const child = new EventEmitter() as any;
      child.pid = 70707;
      child.stdout = Readable.from([
        Buffer.from(`${JSON.stringify({ event: "init", init: { agent: ANTIGRAVITY_BRIDGE_AGENT_NAME, tools: ["view_file"] } })}\n`),
        Buffer.from(`${JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "antigravity vision answered" } })}\n`),
      ]);
      child.stderr = Readable.from([]);
      child.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
      child.killed = false;
      child.exitCode = null;
      child.kill = () => {
        child.killed = true;
        return true;
      };
      setTimeout(() => {
        child.exitCode = 0;
        child.emit("close", 0);
      }, 3);
      return child as unknown as ChildProcess;
    },
  });
  void baseCreate;

  try {
    const imageDirect = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "combo/agy-image-direct",
          stream: false,
          input: [{
            role: "user",
            content: [
              { type: "input_text", text: "describe this screenshot" },
              { type: "input_image", image_url: ONE_BY_ONE_PNG_DATA_URL },
            ],
          }],
        }),
      }),
      config,
      { model: "", provider: "" },
    );
    expect(imageDirect.status).toBe(200);
    expect(await imageDirect.text()).toContain("antigravity vision answered");
    expect(agySpawns).toBe(1);
    expect(fallbackCalls).toBe(0);

    const modelHop = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "combo/agy-model-hop",
          stream: false,
          input: "hello",
        }),
      }),
      config,
      { model: "", provider: "" },
    );
    expect(modelHop.status).toBe(200);
    expect(await modelHop.text()).toContain("fallback answered");
    expect(agySpawns).toBe(1);
    expect(fallbackCalls).toBe(1);

    // Unsupported remote image URL in failover combo hops to fallback without spawning agy or consuming SendBudget
    const remoteImageHop = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "combo/agy-remote-image-hop",
          stream: false,
          input: [{
            role: "user",
            content: [
              { type: "input_text", text: "describe remote image" },
              { type: "input_image", image_url: "https://fixture.invalid/remote.png" },
            ],
          }],
        }),
      }),
      config,
      { model: "", provider: "" },
    );
    expect(remoteImageHop.status).toBe(200);
    expect(await remoteImageHop.text()).toContain("fallback answered");
    expect(agySpawns).toBe(1);
    expect(fallbackCalls).toBe(2);

    // Claude Code Task subagent (#2899) prompt with single-\n SDK identity + ocx-route + [1m] alias strips cleanly
    const subagentResp = await handleClaudeMessages(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: `${CLAUDE_ALIAS_PREFIX_CURRENT}antigravity-cli--gemini-4-carbon[1m]`,
          max_tokens: 256,
          stream: false,
          system: [
            { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.220; cc_entrypoint=sdk-ts;" },
            {
              type: "text",
              text: "<!-- generated-by: opencodex -->\n<!-- ocx-route: antigravity-cli/gemini-4-carbon -->\nYou are a Claude agent, built on Anthropic's Claude Agent SDK.\nThe exact model ID is ocx-claude-antigravity-cli--gemini-4-carbon[1m].\nYou are a specialized Explorer subagent.",
            },
          ],
          messages: [{ role: "user", content: "Summarize repository layout" }],
        }),
      }),
      config,
      { model: "", provider: "" },
    );
    expect(subagentResp.status).toBe(200);
    expect(lastAgentMd).not.toContain("Claude Agent SDK");
    expect(lastAgentMd).not.toMatch(/opencodex|ocx-claude-|ocx-route/i);
    expect(lastAgentMd).toContain("The exact model ID is gemini-4-carbon.");
    expect(lastAgentMd).toContain("You are a specialized Explorer subagent.");
  } finally {
    definition.create = originalCreate;
    releaseSpend();
  }
});

