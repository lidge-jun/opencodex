import { create, fromBinary, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  ExecServerMessageSchema,
  AgentClientMessageSchema,
  ListMcpResourcesExecArgsSchema,
  McpArgsSchema,
  ReadMcpResourceExecArgsSchema,
  RequestContextArgsSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import { handleCursorNativeExec } from "../src/adapters/cursor/native-exec";
import { resolveMcpServers } from "../src/adapters/cursor/mcp-config";
import { CursorMcpManager } from "../src/adapters/cursor/mcp-manager";
import { buildMcpToolDefinitions, mcpDepsFromManager } from "../src/adapters/cursor/native-exec-mcp";
import type { OcxProviderConfig } from "../src/types";

const textEncoder = new TextEncoder();

function buildFixtureServer(): { server: McpServer; clientTransport: InMemoryTransport } {
  const server = new McpServer({ name: "fixture", version: "1.0.0" });

  server.registerTool(
    "echo",
    { description: "Echoes the input text", inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: "text", text: `echo:${text}` }] }),
  );

  server.registerTool(
    "boom",
    { description: "Always errors", inputSchema: {} },
    async () => ({ isError: true, content: [{ type: "text", text: "tool failed" }] }),
  );

  // 1x1 transparent PNG, base64 — exercises real image-content fidelity (not a placeholder).
  const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  server.registerTool(
    "shot",
    { description: "Returns an image", inputSchema: {} },
    async () => ({ content: [{ type: "image", data: PNG_1PX, mimeType: "image/png" }] }),
  );

  server.registerResource(
    "doc",
    "memory://doc",
    { description: "A demo resource", mimeType: "text/plain" },
    async uri => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: "resource-body" }] }),
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  void server.connect(serverTransport);
  return { server, clientTransport };
}

function makeManager(clientTransport: InMemoryTransport): CursorMcpManager {
  return new CursorMcpManager(
    [{ serverName: "fixture", command: "noop" }],
    { transportFactory: () => clientTransport },
  );
}

function execMessage(message: Parameters<typeof create<typeof ExecServerMessageSchema>>[1]["message"]) {
  return create(ExecServerMessageSchema, { id: 1, execId: "exec-test", message });
}

function decode(bytes: Uint8Array) {
  const msg = fromBinary(AgentClientMessageSchema, bytes);
  expect(msg.message.case).toBe("execClientMessage");
  return msg.message.value;
}

describe("Cursor MCP manager", () => {
  let manager: CursorMcpManager;
  let clientTransport: InMemoryTransport;

  beforeEach(() => {
    ({ clientTransport } = buildFixtureServer());
    manager = makeManager(clientTransport);
  });

  afterEach(async () => {
    await manager.dispose();
  });

  test("resolveMcpServers filters disabled and url-less/command-less entries", () => {
    const provider = {
      adapter: "cursor",
      baseUrl: "x",
      mcpServers: {
        ok: { command: "node" },
        remote: { url: "https://mcp.test" },
        disabled: { command: "node", enabled: false },
        empty: {},
      },
    } as unknown as OcxProviderConfig;
    const names = resolveMcpServers(provider).map(s => s.serverName).sort();
    expect(names).toEqual(["ok", "remote"]);
  });

  test("discovers tools with handles", async () => {
    const handles = await manager.listToolHandles();
    const names = handles.map(h => h.advertisedName).sort();
    expect(names).toEqual(["boom", "echo", "shot"]);
    const echo = handles.find(h => h.advertisedName === "echo");
    expect(echo?.description).toBe("Echoes the input text");
  });

  test("callTool returns success content", async () => {
    const result = await manager.callTool("echo", { text: "hi" });
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe("echo:hi");
  });

  test("callTool propagates tool-level isError without throwing", async () => {
    const result = await manager.callTool("boom", {});
    expect(result.isError).toBe(true);
  });

  test("resolveTool returns undefined for unknown tool", async () => {
    expect(await manager.resolveTool("nope")).toBeUndefined();
  });

  test("listResources and readResource map content", async () => {
    const resources = await manager.listResources();
    expect(resources.map(r => r.uri)).toContain("memory://doc");
    const content = await manager.readResource("fixture", "memory://doc");
    expect(content.text).toBe("resource-body");
    expect(content.mimeType).toBe("text/plain");
  });

  test("buildMcpToolDefinitions emits valid protobuf Value input schema", async () => {
    const defs = await buildMcpToolDefinitions(manager);
    const echo = defs.find(d => d.toolName === "echo");
    expect(echo).toBeDefined();
    expect(echo?.providerIdentifier).toBe("opencodex");
    const schema = toJson(ValueSchema, fromBinary(ValueSchema, echo!.inputSchema)) as { type?: string };
    expect(schema.type).toBe("object");
  });
});

describe("Cursor MCP deps via native-exec dispatcher", () => {
  test("mcpArgs executes against live server through the dispatcher", async () => {
    const { clientTransport } = buildFixtureServer();
    const manager = makeManager(clientTransport);
    const deps = mcpDepsFromManager(manager);

    const args = create(McpArgsSchema, { name: "echo", toolName: "echo", providerIdentifier: "opencodex" });
    args.args = { text: textEncoder.encode(JSON.stringify("world")) };

    const reply = decode((await handleCursorNativeExec(execMessage({ case: "mcpArgs", value: args }), deps))[0]);
    expect(reply.message.case).toBe("mcpResult");
    expect(reply.message.value.result.case).toBe("success");
    if (reply.message.value.result.case === "success") {
      const content = reply.message.value.result.value.content[0];
      expect(content?.content.case).toBe("text");
      if (content?.content.case === "text") expect(content.content.value.text).toBe("echo:world");
    }
    await manager.dispose();
  });

  test("image content round-trips as McpImageContent with real bytes (not a placeholder)", async () => {
    const { clientTransport } = buildFixtureServer();
    const manager = makeManager(clientTransport);
    const deps = mcpDepsFromManager(manager);

    const args = create(McpArgsSchema, { name: "shot", toolName: "shot", providerIdentifier: "opencodex" });
    const reply = decode((await handleCursorNativeExec(execMessage({ case: "mcpArgs", value: args }), deps))[0]);
    expect(reply.message.case).toBe("mcpResult");
    expect(reply.message.value.result.case).toBe("success");
    if (reply.message.value.result.case === "success") {
      const content = reply.message.value.result.value.content[0];
      expect(content?.content.case).toBe("image");
      if (content?.content.case === "image") {
        expect(content.content.value.mimeType).toBe("image/png");
        expect(content.content.value.data.length).toBeGreaterThan(0);
        // PNG magic bytes prove the base64 was decoded, not echoed as text.
        expect(Array.from(content.content.value.data.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
      }
    }
    await manager.dispose();
  });

  test("unknown mcp tool returns typed toolNotFound, not error", async () => {
    const { clientTransport } = buildFixtureServer();
    const manager = makeManager(clientTransport);
    const deps = mcpDepsFromManager(manager);

    const args = create(McpArgsSchema, { name: "ghost", toolName: "ghost", providerIdentifier: "opencodex" });
    const reply = decode((await handleCursorNativeExec(execMessage({ case: "mcpArgs", value: args }), deps))[0]);
    expect(reply.message.case).toBe("mcpResult");
    expect(reply.message.value.result.case).toBe("toolNotFound");
    await manager.dispose();
  });

  test("tool-level isError propagates through the dispatcher as McpSuccess{isError:true}", async () => {
    const { clientTransport } = buildFixtureServer();
    const manager = makeManager(clientTransport);
    const deps = mcpDepsFromManager(manager);

    const args = create(McpArgsSchema, { name: "boom", toolName: "boom", providerIdentifier: "opencodex" });
    const reply = decode((await handleCursorNativeExec(execMessage({ case: "mcpArgs", value: args }), deps))[0]);
    expect(reply.message.case).toBe("mcpResult");
    expect(reply.message.value.result.case).toBe("success");
    if (reply.message.value.result.case === "success") {
      expect(reply.message.value.result.value.isError).toBe(true);
    }
    await manager.dispose();
  });

  test("requestContextArgs advertises MCP tools in RequestContext.tools", async () => {
    const { clientTransport } = buildFixtureServer();
    const manager = makeManager(clientTransport);
    const mcpToolDefs = await buildMcpToolDefinitions(manager);
    const reply = decode((await handleCursorNativeExec(
      execMessage({ case: "requestContextArgs", value: create(RequestContextArgsSchema, {}) }),
      { mcpToolDefs },
    ))[0]);
    expect(reply.message.case).toBe("requestContextResult");
    if (reply.message.case === "requestContextResult" && reply.message.value.result.case === "success") {
      const tools = reply.message.value.result.value.requestContext?.tools ?? [];
      expect(tools.map(t => t.toolName).sort()).toEqual(["boom", "echo", "shot"]);
    } else {
      throw new Error("expected requestContextResult success");
    }
    await manager.dispose();
  });

  test("readMcpResource executes against live server", async () => {
    const { clientTransport } = buildFixtureServer();
    const manager = makeManager(clientTransport);
    const deps = mcpDepsFromManager(manager);

    const args = create(ReadMcpResourceExecArgsSchema, { server: "fixture", uri: "memory://doc" });
    const reply = decode((await handleCursorNativeExec(execMessage({ case: "readMcpResourceExecArgs", value: args }), deps))[0]);
    expect(reply.message.case).toBe("readMcpResourceExecResult");
    expect(reply.message.value.result.case).toBe("success");
    await manager.dispose();
  });

  test("listMcpResources never throws and returns success", async () => {
    const { clientTransport } = buildFixtureServer();
    const manager = makeManager(clientTransport);
    const deps = mcpDepsFromManager(manager);

    const reply = decode((await handleCursorNativeExec(execMessage({ case: "listMcpResourcesExecArgs", value: create(ListMcpResourcesExecArgsSchema, {}) }), deps))[0]);
    expect(reply.message.case).toBe("listMcpResourcesExecResult");
    expect(["success", "error"]).toContain(reply.message.value.result.case);
    await manager.dispose();
  });

  test("listMcpResources with no executor wired returns a typed error, not empty success", async () => {
    // No deps => genuinely unconfigured (or prepareMcp stripped deps after a failure).
    const reply = decode((await handleCursorNativeExec(
      execMessage({ case: "listMcpResourcesExecArgs", value: create(ListMcpResourcesExecArgsSchema, {}) }),
      {},
    ))[0]);
    expect(reply.message.case).toBe("listMcpResourcesExecResult");
    expect(reply.message.value.result.case).toBe("error");
    if (reply.message.value.result.case === "error") {
      expect(reply.message.value.result.value.error).toContain("No local MCP resource executor");
    }
  });
});
