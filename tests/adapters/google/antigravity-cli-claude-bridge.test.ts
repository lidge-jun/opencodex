import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { createAntigravityCliAdapter } from "../../../src/adapters/antigravity-cli/adapter";
import {
  ANTIGRAVITY_CLI_MODELS,
  ANTIGRAVITY_CLI_PROFILE,
  clearAntigravityCliBinaryCache,
} from "../../../src/adapters/antigravity-cli/profiles";
import {
  ANTIGRAVITY_BRIDGE_AGENT_NAME,
  ANTIGRAVITY_MCP_TOOL_PREFIX,
  buildAntigravityCliToolBridge,
} from "../../../src/adapters/antigravity-cli/protocol";
import {
  ANTIGRAVITY_TOOL_LIMITS,
  CODEBUDDY_TOOL_LIMITS,
  buildCodeBuddyToolBridge,
  type CodeBuddyToolLimits,
} from "../../../src/adapters/codebuddy/tool-bridge";
import { getAdapterDefinition } from "../../../src/adapters/registry";
import { CLAUDE_ALIAS_PREFIX_CURRENT } from "../../../src/claude/alias";
import { providerConfigSeed } from "../../../src/providers/derive";
import { PROVIDER_REGISTRY } from "../../../src/providers/registry";
import { handleClaudeMessages } from "../../../src/server/claude-messages";
import type { AdapterEvent, OcxConfig, OcxParsedRequest, OcxProviderConfig, OcxTool } from "../../../src/types";
import { acquireOwnedSpendHome } from "../../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../../helpers/remove-tree";
import { handleOwnedResponses as handleResponses } from "../../helpers/response-replay-owner";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";

const MCP_SERVER_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "src",
  "adapters",
  "codebuddy",
  "mcp-server.ts",
);

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function antigravityProvider(): OcxProviderConfig {
  return {
    adapter: "antigravity-cli",
    baseUrl: ANTIGRAVITY_CLI_PROFILE.canonicalBaseUrl,
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
  } as OcxProviderConfig;
}

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

function makeParsedRequest(tools: OcxTool[], modelId = "gemini-4-carbon"): OcxParsedRequest {
  return {
    modelId,
    stream: true,
    options: {},
    context: {
      messages: [{ role: "user", content: "Inspect workspace", timestamp: 1 }],
      tools,
    },
  };
}

/**
 * Build N Claude/MCP-style tools including >64-char wire names and all `schemaprobe`
 * JSON Schema 2020-12 constructs (`prefixItems`, negative lookahead `pattern`,
 * `additionalProperties: {}`, `propertyNames`, `$defs`/`$ref`, nullable `anyOf`).
 */
function buildSchemaprobeMcpCatalog(count: number): Array<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}> {
  const longPrimaryName =
    "mcp__workspace_filesystem_extended_server__inspect_project_configuration_with_schema_metadata_000";
  expect(longPrimaryName.length).toBeGreaterThan(64);

  return Array.from({ length: count }, (_, index) => {
    if (index === 0) {
      return {
        name: longPrimaryName,
        description: "Inspect configuration with schemaprobe JSON Schema 2020-12 features.",
        input_schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          $defs: {
            filterSpec: {
              type: "object",
              properties: {
                field: { anyOf: [{ type: "string" }, { type: "null" }] },
              },
            },
          },
          properties: {
            path: { type: "string" },
            coll: {
              type: "string",
              pattern: "^(?!\\.\\.?(?:\\/|$))[A-Za-z0-9_\\-.~:@+]{1,200}$",
            },
            where: {
              type: "array",
              items: {
                type: "array",
                prefixItems: [{ type: "string" }, { type: "string", enum: ["eq", "ne"] }, {}],
              },
            },
            data: {
              type: "object",
              additionalProperties: {},
              propertyNames: { type: "string" },
            },
            filter: { $ref: "#/$defs/filterSpec" },
          },
          required: ["path"],
        },
      };
    }

    if (index === 1) {
      return {
        name: "Read",
        description: "Read a file from the client workspace.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
        },
      };
    }

    return {
      name: `mcp__enterprise_service_cluster_${index % 16}__execute_remote_diagnostic_operation_identifier_${index}`,
      description: `Diagnostic MCP operation ${index}.`,
      input_schema: {
        type: "object",
        properties: {
          target: { anyOf: [{ type: "string" }, { type: "null" }] },
          mode: { type: "string", pattern: "^(?!internal_)[a-z0-9_-]{1,64}$" },
        },
        additionalProperties: {},
      },
    };
  });
}

function toOcxTools(
  anthropicTools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>,
): OcxTool[] {
  return anthropicTools.map(item => ({
    name: item.name,
    description: item.description,
    parameters: item.input_schema,
  }));
}

function parseSseFrames(body: string): Array<{ event: string; data: any }> {
  const frames: Array<{ event: string; data: any }> = [];
  for (const rawBlock of body.split(/\r?\n\r?\n/)) {
    const block = rawBlock.trim();
    if (!block) continue;
    let event = "";
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) continue;
    const rawData = dataLines.join("\n");
    try {
      frames.push({ event, data: JSON.parse(rawData) });
    } catch {
      frames.push({ event, data: rawData });
    }
  }
  return frames;
}

beforeEach(() => clearAntigravityCliBinaryCache());

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    removeTreeWithRetry(dir);
  }
});

describe("Stage 3 tool-bridge limits passthrough", () => {
  test("propagates custom limits through normalizeInputSchema, cloneBoundedJson, validateSchema, and validatePattern while keeping CODEBUDDY_TOOL_LIMITS default intact", () => {
    // 1. Default CODEBUDDY_TOOL_LIMITS remains strictly 128 tools.
    const tools129 = toOcxTools(buildSchemaprobeMcpCatalog(129));
    expect(() => buildCodeBuddyToolBridge(makeParsedRequest(tools129))).toThrow("128-tool limit");

    // 2. Depth check respects passed limits (reject tighter limit, accept higher than default 32).
    let depth35: Record<string, unknown> = { type: "object", properties: {} };
    for (let i = 0; i < 34; i++) {
      depth35 = { type: "object", properties: { child: depth35 } };
    }
    let depth3: Record<string, unknown> = { type: "object", properties: {} };
    for (let i = 0; i < 2; i++) {
      depth3 = { type: "object", properties: { child: depth3 } };
    }

    const tightDepth: CodeBuddyToolLimits = { ...CODEBUDDY_TOOL_LIMITS, maxSchemaDepth: 2 };
    const highDepth: CodeBuddyToolLimits = { ...CODEBUDDY_TOOL_LIMITS, maxSchemaDepth: 80 };
    expect(() => buildCodeBuddyToolBridge(
      makeParsedRequest([{ name: "deep3", description: "d", parameters: depth3 }]),
      tightDepth,
    )).toThrow("nesting is too deep");
    expect(() => buildCodeBuddyToolBridge(
      makeParsedRequest([{ name: "deep35", description: "d", parameters: depth35 }]),
    )).toThrow("nesting is too deep");
    expect(buildCodeBuddyToolBridge(
      makeParsedRequest([{ name: "deep35", description: "d", parameters: depth35 }]),
      highDepth,
    ).tools).toHaveLength(1);

    // 3. Node-count check respects passed limits.
    const manyProps: Record<string, unknown> = {};
    for (let i = 0; i < 2500; i++) manyProps[`k${i}`] = { type: "string" };
    const overDefaultNodesSchema = { type: "object", properties: manyProps };
    const smallSchema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" }, c: { type: "string" } },
    };

    const tightNodes: CodeBuddyToolLimits = { ...CODEBUDDY_TOOL_LIMITS, maxSchemaNodes: 5 };
    const highNodes: CodeBuddyToolLimits = { ...CODEBUDDY_TOOL_LIMITS, maxSchemaNodes: 10_000 };
    expect(() => buildCodeBuddyToolBridge(
      makeParsedRequest([{ name: "small", description: "s", parameters: smallSchema }]),
      tightNodes,
    )).toThrow("node count is too large");
    expect(() => buildCodeBuddyToolBridge(
      makeParsedRequest([{ name: "big_nodes", description: "b", parameters: overDefaultNodesSchema }]),
    )).toThrow("node count is too large");
    expect(buildCodeBuddyToolBridge(
      makeParsedRequest([{ name: "big_nodes", description: "b", parameters: overDefaultNodesSchema }]),
      highNodes,
    ).tools).toHaveLength(1);

    // 4. Pattern-bytes check respects passed limits.
    const longPattern = `^${"a".repeat(CODEBUDDY_TOOL_LIMITS.maxPatternBytes + 16)}$`;
    const patternSchema24 = {
      type: "object",
      properties: { code: { type: "string", pattern: "^[a-z0-9_-]{1,24}$" } },
    };
    const tightPattern: CodeBuddyToolLimits = { ...CODEBUDDY_TOOL_LIMITS, maxPatternBytes: 10 };
    const highPattern: CodeBuddyToolLimits = { ...CODEBUDDY_TOOL_LIMITS, maxPatternBytes: 16 * 1024 };
    expect(() => buildCodeBuddyToolBridge(
      makeParsedRequest([{ name: "pat24", description: "p", parameters: patternSchema24 }]),
      tightPattern,
    )).toThrow("bounded regular-expression string");
    expect(() => buildCodeBuddyToolBridge(
      makeParsedRequest([{
        name: "pat_long",
        description: "p",
        parameters: { type: "object", properties: { code: { type: "string", pattern: longPattern } } },
      }]),
    )).toThrow("bounded regular-expression string");
    expect(buildCodeBuddyToolBridge(
      makeParsedRequest([{
        name: "pat_long",
        description: "p",
        parameters: { type: "object", properties: { code: { type: "string", pattern: longPattern } } },
      }]),
      highPattern,
    ).tools).toHaveLength(1);

    // 5. Schema-bytes check respects passed limits.
    const mediumSchema = {
      type: "object",
      properties: { payload: { type: "string", description: "x".repeat(400) } },
    };
    const oversizedDefaultSchema = {
      type: "object",
      properties: {
        payload: { type: "string", description: "x".repeat(CODEBUDDY_TOOL_LIMITS.maxSchemaBytes + 64) },
      },
    };
    const tightBytes: CodeBuddyToolLimits = { ...CODEBUDDY_TOOL_LIMITS, maxSchemaBytes: 256 };
    const highBytes: CodeBuddyToolLimits = {
      ...CODEBUDDY_TOOL_LIMITS,
      maxSchemaBytes: 256 * 1024,
      maxToolBytes: 300 * 1024,
    };
    expect(() => buildCodeBuddyToolBridge(
      makeParsedRequest([{ name: "med", description: "m", parameters: mediumSchema }]),
      tightBytes,
    )).toThrow("schema exceeds 256 bytes");
    expect(() => buildCodeBuddyToolBridge(
      makeParsedRequest([{ name: "oversized", description: "o", parameters: oversizedDefaultSchema }]),
    )).toThrow(`schema exceeds ${CODEBUDDY_TOOL_LIMITS.maxSchemaBytes} bytes`);
    expect(buildCodeBuddyToolBridge(
      makeParsedRequest([{ name: "oversized", description: "o", parameters: oversizedDefaultSchema }]),
      highBytes,
    ).tools).toHaveLength(1);
  });
});

describe("Stage 3 200-tool catalog, 512-tool ceiling, and codebuddy/mcp-server.ts E2E", () => {
  test("bridges 200 schemaprobe MCP tools through /v1/messages and loads + captures >64-char wireName via real mcp-server.ts subprocess", async () => {
    const anthropicTools = buildSchemaprobeMcpCatalog(200);
    const longWireName = anthropicTools[0]!.name;
    expect(longWireName.length).toBeGreaterThan(64);

    // Verify bridge constructs all 200 tools with <=40-char aliases and strips Cloud Code Assist unsupported keywords.
    const bridge = buildAntigravityCliToolBridge(makeParsedRequest(toOcxTools(anthropicTools)));
    expect(bridge).toBeDefined();
    expect(bridge!.tools).toHaveLength(200);
    expect(bridge!.emittedNameMap.size).toBe(200);
    for (const def of bridge!.tools) {
      expect(def.name).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
    }
    const primaryEmitted = [...bridge!.emittedNameMap.entries()]
      .find(([, wire]) => wire === longWireName)?.[0];
    expect(primaryEmitted).toBeDefined();
    const primaryAlias = primaryEmitted!.slice(ANTIGRAVITY_MCP_TOOL_PREFIX.length);
    const primaryDef = bridge!.tools.find(t => t.name === primaryAlias)!;
    expect(primaryDef).toBeDefined();
    expect(JSON.stringify(primaryDef.inputSchema)).not.toContain('"$defs"');
    expect(JSON.stringify(primaryDef.inputSchema)).not.toContain('"$ref"');
    expect(JSON.stringify(primaryDef.inputSchema)).not.toContain('"prefixItems"');

    // E2E real subprocess test for src/adapters/codebuddy/mcp-server.ts with capturePath.
    const mcpDir = createTempDir("ocx-stage3-mcp-200-");
    const catalogPath = join(mcpDir, "catalog.json");
    const capturePath = join(mcpDir, "captured-calls.jsonl");
    writeFileSync(catalogPath, JSON.stringify(bridge!.tools), { mode: 0o600 });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_SERVER_PATH, catalogPath, capturePath],
      stderr: "pipe",
    });
    const client = new Client({ name: "stage3-mcp-e2e", version: "1.0.0" });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(200);
      expect(listed.tools.some(item => item.name === primaryAlias)).toBe(true);

      const abort = new AbortController();
      const pendingCall = client.callTool(
        {
          name: primaryAlias,
          arguments: { path: "C:/repo/app.ts", coll: "valid-coll_1" },
        },
        undefined,
        { signal: abort.signal },
      );
      void pendingCall.catch(() => {});

      const deadline = Date.now() + 2_500;
      let capturedRaw = "";
      while (Date.now() < deadline) {
        try {
          capturedRaw = readFileSync(capturePath, "utf8");
          if (capturedRaw.trim().length > 0) break;
        } catch {
          // Wait until capture line is flushed.
        }
        await Bun.sleep(10);
      }
      abort.abort();

      const capturedLines = capturedRaw.trim().split(/\r?\n/).filter(Boolean);
      expect(capturedLines).toHaveLength(1);
      const captured = JSON.parse(capturedLines[0]!) as {
        seq: number;
        name: string;
        arguments: Record<string, unknown>;
      };
      expect(captured.seq).toBe(1);
      expect(captured.name).toBe(primaryAlias);
      expect(captured.arguments).toEqual({ path: "C:/repo/app.ts", coll: "valid-coll_1" });
      expect(bridge!.emittedNameMap.get(`${ANTIGRAVITY_MCP_TOOL_PREFIX}${captured.name}`)).toBe(longWireName);
    } finally {
      await client.close();
    }

    // Full HTTP /v1/messages route with 200 schemaprobe tools + mock spawn.
    const definition = getAdapterDefinition("antigravity-cli")! as any;
    const originalCreate = definition.create;
    const releaseSpend = acquireOwnedSpendHome();
    let seenCatalogCount = 0;

    definition.create = (prov: any) => createAntigravityCliAdapter(prov, {
      which: () => process.execPath,
      toolBatchCoalesceMs: 8,
      spawn: (_cmd, _args, options) => {
        const cwd = String(options.cwd ?? "");
        const stagedCatalog = JSON.parse(readFileSync(join(cwd, "catalog.json"), "utf8")) as Array<{ name: string }>;
        seenCatalogCount = stagedCatalog.length;

        const child = new EventEmitter() as any;
        const stdout = new PassThrough();
        child.pid = 70701;
        child.stdout = stdout;
        child.stderr = Readable.from([]);
        child.killed = false;
        child.exitCode = null;
        child.kill = () => {
          child.killed = true;
          stdout.end();
          if (child.exitCode === null) {
            child.exitCode = 0;
            queueMicrotask(() => child.emit("close", 0));
          }
          return true;
        };
        const stdinChunks: string[] = [];
        child.stdin = new Writable({
          write(chunk, _enc, cb) {
            stdinChunks.push(String(chunk));
            cb();
          },
          final(cb) {
            const payload = stdinChunks.join("");
            stdout.write(`${JSON.stringify({
              event: "init",
              init: {
                agent: ANTIGRAVITY_BRIDGE_AGENT_NAME,
                tools: stagedCatalog.map(t => `${ANTIGRAVITY_MCP_TOOL_PREFIX}${t.name}`),
              },
            })}\n`);
            if (payload.includes("TOOL RESULT")) {
              stdout.write(`${JSON.stringify({
                event: "step_update",
                step_update: {
                  step_index: 1,
                  state: "DONE",
                  step_type: "agent_response",
                  text_delta: "200-tool roundtrip complete",
                  usage: { input_tokens: 410, output_tokens: 18, thinking_tokens: 5, cache_read_tokens: 120 },
                },
              })}\n`);
              stdout.write(`${JSON.stringify({
                event: "result",
                result: {
                  status: "SUCCESS",
                  response: "200-tool roundtrip complete",
                  usage: { input_tokens: 410, output_tokens: 18, thinking_tokens: 5, cache_read_tokens: 120 },
                },
              })}\n`);
              stdout.end();
              child.exitCode = 0;
              queueMicrotask(() => child.emit("close", 0));
            } else {
              writeFileSync(
                join(cwd, "captured-calls.jsonl"),
                `${JSON.stringify({
                  seq: 1,
                  name: primaryAlias,
                  arguments: { path: "C:/repo/app.ts", coll: "valid-coll_1" },
                })}\n`,
              );
              stdout.write(`${JSON.stringify({
                event: "step_update",
                step_update: {
                  step_index: 1,
                  state: "ACTIVE",
                  step_type: "tool",
                  tool_name: primaryEmitted,
                  tool_info: {
                    name: primaryEmitted,
                    parameters: { path: "C:/repo/app.ts", coll: "valid-coll_1" },
                  },
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
    try {
      const resp1 = await handleClaudeMessages(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: "antigravity-cli/gemini-4-carbon",
            max_tokens: 1024,
            stream: false,
            tools: anthropicTools,
            messages: [{ role: "user", content: "Inspect C:/repo/app.ts using the metadata tool." }],
          }),
        }),
        config,
        { model: "", provider: "" },
      );
      expect(resp1.status).toBe(200);
      expect(seenCatalogCount).toBe(200);
      const body1 = await resp1.json() as any;
      expect(body1.stop_reason).toBe("tool_use");
      const toolUse = body1.content.find((b: any) => b.type === "tool_use");
      expect(toolUse).toBeDefined();
      expect(toolUse.name).toBe(longWireName);
      expect(toolUse.input).toEqual({ path: "C:/repo/app.ts", coll: "valid-coll_1" });

      const resp2 = await handleClaudeMessages(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: "antigravity-cli/gemini-4-carbon",
            max_tokens: 1024,
            stream: false,
            tools: anthropicTools,
            messages: [
              { role: "user", content: "Inspect C:/repo/app.ts using the metadata tool." },
              { role: "assistant", content: body1.content },
              {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: toolUse.id, content: [{ type: "text", text: "{\"ok\":true}" }] }],
              },
            ],
          }),
        }),
        config,
        { model: "", provider: "" },
      );
      expect(resp2.status).toBe(200);
      const body2 = await resp2.json() as any;
      expect(body2.stop_reason).toBe("end_turn");
      expect(body2.content.map((b: any) => b.text ?? "").join("")).toContain("200-tool roundtrip complete");
    } finally {
      definition.create = originalCreate;
      releaseSpend();
    }
  });

  test("accepts 512 tools through bridge, mcp-server.ts, and /v1/messages while rejecting 513 tools with 400 512-tool limit without spawning agy", async () => {
    const tools512 = buildSchemaprobeMcpCatalog(512);
    const bridge512 = buildAntigravityCliToolBridge(makeParsedRequest(toOcxTools(tools512)));
    expect(bridge512).toBeDefined();
    expect(bridge512!.tools).toHaveLength(512);
    expect(bridge512!.emittedNameMap.size).toBe(512);

    // Verify mcp-server.ts with capturePath loads all 512 tools cleanly.
    const mcpDir = createTempDir("ocx-stage3-mcp-512-");
    const catalog512Path = join(mcpDir, "catalog-512.json");
    const capture512Path = join(mcpDir, "capture-512.jsonl");
    writeFileSync(catalog512Path, JSON.stringify(bridge512!.tools), { mode: 0o600 });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_SERVER_PATH, catalog512Path, capture512Path],
      stderr: "pipe",
    });
    const client = new Client({ name: "stage3-mcp-512", version: "1.0.0" });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(512);
    } finally {
      await client.close();
    }

    // 512 tools via /v1/messages -> 200 OK; 513 tools -> immediate 400 non-retryable without spawn.
    const definition = getAdapterDefinition("antigravity-cli")! as any;
    const originalCreate = definition.create;
    const releaseSpend = acquireOwnedSpendHome();
    let spawnCount = 0;

    definition.create = (prov: any) => createAntigravityCliAdapter(prov, {
      which: () => process.execPath,
      spawn: (_cmd, _args, options) => {
        spawnCount++;
        const cwd = String(options.cwd ?? "");
        const stagedCatalog = JSON.parse(readFileSync(join(cwd, "catalog.json"), "utf8")) as Array<{ name: string }>;
        expect(stagedCatalog).toHaveLength(512);

        const child = new EventEmitter() as any;
        const stdout = new PassThrough();
        child.pid = 70702;
        child.stdout = stdout;
        child.stderr = Readable.from([]);
        child.killed = false;
        child.exitCode = null;
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
          write(_chunk, _enc, cb) { cb(); },
          final(cb) {
            stdout.write(`${JSON.stringify({
              event: "init",
              init: { agent: ANTIGRAVITY_BRIDGE_AGENT_NAME, tools: stagedCatalog.map(t => `${ANTIGRAVITY_MCP_TOOL_PREFIX}${t.name}`) },
            })}\n`);
            stdout.write(`${JSON.stringify({
              event: "step_update",
              step_update: {
                step_index: 1,
                state: "DONE",
                step_type: "agent_response",
                text_delta: "512 tools accepted",
                usage: { input_tokens: 512, output_tokens: 8, thinking_tokens: 0, cache_read_tokens: 0 },
              },
            })}\n`);
            stdout.write(`${JSON.stringify({
              event: "result",
              result: {
                status: "SUCCESS",
                response: "512 tools accepted",
                usage: { input_tokens: 512, output_tokens: 8, thinking_tokens: 0, cache_read_tokens: 0 },
              },
            })}\n`);
            stdout.end();
            child.exitCode = 0;
            queueMicrotask(() => child.emit("close", 0));
            cb();
          },
        });
        return child as unknown as ChildProcess;
      },
    });

    const config = antigravityConfig();
    try {
      const okResp = await handleClaudeMessages(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: "antigravity-cli/gemini-4-hydrogen",
            max_tokens: 256,
            stream: false,
            tools: tools512,
            messages: [{ role: "user", content: "Reply ok." }],
          }),
        }),
        config,
        { model: "", provider: "" },
      );
      expect(okResp.status).toBe(200);
      expect(spawnCount).toBe(1);

      const tools513 = buildSchemaprobeMcpCatalog(513);

      // Direct adapter check: 400 non-retryable terminal refusal containing `512-tool limit`, zero spawn.
      const adapter = createAntigravityCliAdapter(antigravityProvider(), {
        which: () => "/bin/agy",
        platform: "linux",
        spawn: () => {
          throw new Error("spawn must not be called for 513 tools");
        },
      });
      const events: AdapterEvent[] = [];
      await adapter.runTurn!(
        makeParsedRequest(toOcxTools(tools513)),
        { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
        event => events.push(event),
      );
      const errEvent = events.find(e => e.type === "error") as Extract<AdapterEvent, { type: "error" }> | undefined;
      expect(errEvent).toBeDefined();
      expect(errEvent!.status).toBe(400);
      expect(errEvent!.errorType).toBe("invalid_request_error");
      expect(errEvent!.code).toBe("tool_catalog_invalid");
      expect(errEvent!.retryable).toBe(false);
      expect(errEvent!.terminalRefusal).toBe(true);
      expect(errEvent!.message).toContain("exceeds the 512-tool limit");

      // /v1/messages JSON check: immediate 400 client error, zero spawn.
      const spawnsBefore513 = spawnCount;
      const errResp = await handleClaudeMessages(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: "antigravity-cli/gemini-4-carbon",
            max_tokens: 256,
            stream: false,
            tools: tools513,
            messages: [{ role: "user", content: "Reply ok." }],
          }),
        }),
        config,
        { model: "", provider: "" },
      );
      expect(errResp.status).toBe(400);
      expect(spawnCount).toBe(spawnsBefore513);
      const errJson = await errResp.json() as any;
      expect(errJson.type).toBe("error");
      expect(errJson.error?.type).toBe("invalid_request_error");

      // /v1/responses SSE check: terminal non-retryable failure carrying exact `512-tool limit` detail, zero spawn.
      const sseResp = await handleResponses(
        new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "antigravity-cli/gemini-4-carbon",
            stream: true,
            input: [{ role: "user", content: "Reply ok." }],
            tools: tools513.map(t => ({
              type: "function",
              name: t.name,
              description: t.description,
              parameters: t.input_schema,
            })),
          }),
        }),
        config,
        { model: "", provider: "" },
      );
      expect(spawnCount).toBe(spawnsBefore513);
      const frames = parseSseFrames(await sseResp.text());
      const failed = frames.find(f => f.event === "response.failed")?.data?.response;
      expect(failed).toBeDefined();
      expect(failed.error?.type).toBe("invalid_request_error");
      expect(failed.error?.code).toBe("invalid_prompt");
      expect(failed.error?.message).toContain("512-tool limit");
      expect(failed.retryable).toBe(false);
    } finally {
      definition.create = originalCreate;
      releaseSpend();
    }
  });
});

describe("Stage 3 Claude Code / Claude Desktop /v1/messages full-feature bridge (F18 anti-regression)", () => {
  test("round-trips segmented cache_control system arrays, thinking, multi-turn tool_use + tool_result arrays, and 200 tools on Hydrogen & Carbon with billing-header cch stability", async () => {
    const anthropicTools = buildSchemaprobeMcpCatalog(200);
    const readToolName = "Read";
    const definition = getAdapterDefinition("antigravity-cli")! as any;
    const originalCreate = definition.create;
    const releaseSpend = acquireOwnedSpendHome();

    const capturedAgentMarkdowns: Array<{ model: string; agentMd: string }> = [];
    const seenCliModels: string[] = [];

    definition.create = (prov: any) => createAntigravityCliAdapter(prov, {
      which: () => process.execPath,
      toolBatchCoalesceMs: 8,
      spawn: (_cmd, args, options) => {
        const cwd = String(options.cwd ?? "");
        const modelIdx = args.indexOf("--model");
        const cliModel = modelIdx >= 0 ? (args[modelIdx + 1] ?? "") : "";
        seenCliModels.push(cliModel);

        const agentMd = readFileSync(
          join(cwd, ".agents", "agents", ANTIGRAVITY_BRIDGE_AGENT_NAME, "agent.md"),
          "utf8",
        );
        capturedAgentMarkdowns.push({ model: cliModel, agentMd });

        const stagedCatalog = JSON.parse(readFileSync(join(cwd, "catalog.json"), "utf8")) as Array<{ name: string }>;
        expect(stagedCatalog).toHaveLength(200);
        const readAlias = stagedCatalog.find(item => item.name === readToolName)?.name ?? readToolName;
        const emittedRead = `${ANTIGRAVITY_MCP_TOOL_PREFIX}${readAlias}`;

        const child = new EventEmitter() as any;
        const stdout = new PassThrough();
        child.pid = 70703;
        child.stdout = stdout;
        child.stderr = Readable.from([]);
        child.killed = false;
        child.exitCode = null;
        child.kill = () => {
          child.killed = true;
          stdout.end();
          if (child.exitCode === null) {
            child.exitCode = 0;
            queueMicrotask(() => child.emit("close", 0));
          }
          return true;
        };
        const stdinChunks: string[] = [];
        child.stdin = new Writable({
          write(chunk, _enc, cb) {
            stdinChunks.push(String(chunk));
            cb();
          },
          final(cb) {
            const payload = stdinChunks.join("");
            stdout.write(`${JSON.stringify({
              event: "init",
              init: {
                agent: ANTIGRAVITY_BRIDGE_AGENT_NAME,
                tools: stagedCatalog.map(t => `${ANTIGRAVITY_MCP_TOOL_PREFIX}${t.name}`),
              },
            })}\n`);

            if (payload.includes("FINAL_CHECK_SIGNAL")) {
              stdout.write(`${JSON.stringify({
                event: "step_update",
                step_update: {
                  step_index: 1,
                  state: "DONE",
                  step_type: "thinking",
                  thinking_delta: "Synthesizing final answer from tool output.",
                },
              })}\n`);
              stdout.write(`${JSON.stringify({
                event: "step_update",
                step_update: {
                  step_index: 2,
                  state: "DONE",
                  step_type: "agent_response",
                  text_delta: `Verified ${cliModel} response`,
                  usage: { input_tokens: 620, output_tokens: 20, thinking_tokens: 15, cache_read_tokens: 300 },
                },
              })}\n`);
              stdout.write(`${JSON.stringify({
                event: "result",
                result: {
                  status: "SUCCESS",
                  response: `Verified ${cliModel} response`,
                  usage: { input_tokens: 620, output_tokens: 20, thinking_tokens: 15, cache_read_tokens: 300 },
                },
              })}\n`);
              stdout.end();
              child.exitCode = 0;
              queueMicrotask(() => child.emit("close", 0));
            } else {
              writeFileSync(
                join(cwd, "captured-calls.jsonl"),
                `${JSON.stringify({ seq: 1, name: readAlias, arguments: { path: "C:/repo/README.md" } })}\n`,
              );
              stdout.write(`${JSON.stringify({
                event: "step_update",
                step_update: {
                  step_index: 1,
                  state: "ACTIVE",
                  step_type: "tool",
                  tool_name: emittedRead,
                  tool_info: { name: emittedRead, parameters: { path: "C:/repo/README.md" } },
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
    const buildClaudeDesktopPayload = (model: string, cchValue: string, extraUserPrompt?: string) => ({
      model,
      max_tokens: 2048,
      stream: false,
      thinking: { type: "enabled", budget_tokens: 16000 },
      system: [
        {
          type: "text",
          text: `x-anthropic-billing-header: cc_version=2.1.286; cc_entrypoint=claude-desktop; cch=${cchValue};\n`,
          cache_control: { type: "ephemeral" },
        },
        {
          type: "text",
          text: "You are Claude Code, Anthropic's official CLI for Claude.\nAlways verify workspace paths before answering.",
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: anthropicTools,
      messages: [
        { role: "user", content: "Inspect C:/repo/package.json first." },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Need to inspect package.json", signature: "sig_prev_1" },
            { type: "tool_use", id: "toolu_hist_1", name: readToolName, input: { path: "C:/repo/package.json" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_hist_1",
              content: [{ type: "text", text: "{\"name\":\"opencodex\"}" }],
            },
            ...(extraUserPrompt ? [{ type: "text", text: extraUserPrompt }] : []),
          ],
        },
      ],
    });

    try {
      // 1. Hydrogen: turn 1 (tool_use) + turn 2 (tool_result array + FINAL_CHECK_SIGNAL -> end_turn).
      const hTurn1 = await handleClaudeMessages(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
          body: JSON.stringify(buildClaudeDesktopPayload("antigravity-cli/gemini-4-hydrogen", "cch_alpha_111")),
        }),
        config,
        { model: "", provider: "" },
      );
      expect(hTurn1.status).toBe(200);
      const hBody1 = await hTurn1.json() as any;
      expect(hBody1.stop_reason).toBe("tool_use");
      const hToolUse = hBody1.content.find((b: any) => b.type === "tool_use");
      expect(hToolUse.name).toBe(readToolName);
      expect(hToolUse.input).toEqual({ path: "C:/repo/README.md" });

      const hTurn2Payload = buildClaudeDesktopPayload("antigravity-cli/gemini-4-hydrogen", "cch_beta_222");
      hTurn2Payload.messages.push(
        { role: "assistant", content: hBody1.content },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: hToolUse.id,
            content: [{ type: "text", text: "FINAL_CHECK_SIGNAL: README contents" }],
          }],
        },
      );
      const hTurn2 = await handleClaudeMessages(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
          body: JSON.stringify(hTurn2Payload),
        }),
        config,
        { model: "", provider: "" },
      );
      expect(hTurn2.status).toBe(200);
      const hBody2 = await hTurn2.json() as any;
      expect(hBody2.stop_reason).toBe("end_turn");
      expect(hBody2.content.map((b: any) => b.text ?? "").join("")).toContain("Verified gemini-4-hydrogen");

      // 2. Carbon (via Claude gateway alias): turn 1 + turn 2.
      const carbonAlias = `${CLAUDE_ALIAS_PREFIX_CURRENT}antigravity-cli--gemini-4-carbon`;
      const cTurn1 = await handleClaudeMessages(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
          body: JSON.stringify(buildClaudeDesktopPayload(carbonAlias, "cch_gamma_333")),
        }),
        config,
        { model: "", provider: "" },
      );
      expect(cTurn1.status).toBe(200);
      const cBody1 = await cTurn1.json() as any;
      expect(cBody1.stop_reason).toBe("tool_use");
      const cToolUse = cBody1.content.find((b: any) => b.type === "tool_use");

      const cTurn2Payload = buildClaudeDesktopPayload(carbonAlias, "cch_delta_444");
      cTurn2Payload.messages.push(
        { role: "assistant", content: cBody1.content },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: cToolUse.id,
            content: [{ type: "text", text: "FINAL_CHECK_SIGNAL: README contents" }],
          }],
        },
      );
      const cTurn2 = await handleClaudeMessages(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
          body: JSON.stringify(cTurn2Payload),
        }),
        config,
        { model: "", provider: "" },
      );
      expect(cTurn2.status).toBe(200);
      const cBody2 = await cTurn2.json() as any;
      expect(cBody2.stop_reason).toBe("end_turn");
      expect(cBody2.content.map((b: any) => b.text ?? "").join("")).toContain("Verified gemini-4-carbon");

      // 3. Verify billing-header stripping & byte-level agent.md system-rules stability across dynamic cch changes.
      const extractAgentBody = (markdown: string): string => {
        const endFence = markdown.indexOf("\n---\n");
        expect(endFence).toBeGreaterThan(0);
        return markdown.slice(endFence + "\n---\n".length);
      };
      expect(capturedAgentMarkdowns).toHaveLength(4);
      for (const { agentMd } of capturedAgentMarkdowns) {
        expect(agentMd).not.toContain("x-anthropic-billing-header");
        expect(agentMd).not.toContain("cch_");
        expect(agentMd).toContain("Always verify workspace paths before answering.");
      }
      expect(extractAgentBody(capturedAgentMarkdowns[0]!.agentMd)).toBe(
        extractAgentBody(capturedAgentMarkdowns[1]!.agentMd),
      );
      expect(extractAgentBody(capturedAgentMarkdowns[2]!.agentMd)).toBe(
        extractAgentBody(capturedAgentMarkdowns[3]!.agentMd),
      );
      expect(seenCliModels).toEqual([
        "gemini-4-hydrogen-medium",
        "gemini-4-hydrogen-medium",
        "gemini-4-carbon-medium",
        "gemini-4-carbon-medium",
      ]);

      // 4. Verify CodeBuddy default 128-tool cap remains untouched.
      expect(() => buildCodeBuddyToolBridge(makeParsedRequest(toOcxTools(anthropicTools).slice(0, 129))))
        .toThrow("128-tool limit");
    } finally {
      definition.create = originalCreate;
      releaseSpend();
    }
  });
});
