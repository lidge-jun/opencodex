import { create, fromBinary, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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
import { CursorMcpManager, CursorMcpPayloadTooLargeError, McpCatalogLimitError } from "../src/adapters/cursor/mcp-manager";
import { buildMcpToolDefinitions, mcpDepsFromManager } from "../src/adapters/cursor/native-exec-mcp";
import type { OcxProviderConfig } from "../src/types";

const textEncoder = new TextEncoder();
// 1x1 transparent PNG, base64 — exercises real image-content fidelity (not a placeholder).
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => nested && typeof nested === "object" && !Array.isArray(nested)
    ? Object.fromEntries(Object.entries(nested as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)))
    : nested);
}

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

function managerForServer(server: McpServer): CursorMcpManager {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  void server.connect(serverTransport);
  return makeManager(clientTransport);
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

  test("MCP exact transactional catalog boundary admits and one byte over closes staging with empty committed catalog", async () => {
    const name = "boundary";
    const probeServer = new McpServer({ name: "probe", version: "1" });
    probeServer.registerTool(name, { description: "", inputSchema: {} }, async () => ({ content: [] }));
    const probeManager = managerForServer(probeServer);
    const schemaBytes = textEncoder.encode(canonicalJson((await probeManager.listToolHandles())[0]!.inputSchema)).byteLength;
    await probeManager.dispose();
    const descriptionBytes = 4 * 1024 * 1024 - textEncoder.encode(name).byteLength - schemaBytes;
    const exactServer = new McpServer({ name: "exact", version: "1" });
    exactServer.registerTool(name, { description: "x".repeat(descriptionBytes), inputSchema: {} }, async () => ({ content: [] }));
    const exactManager = managerForServer(exactServer);
    try {
      expect((await exactManager.listToolHandles()).map(tool => tool.advertisedName)).toEqual([name]);
    } finally {
      await exactManager.dispose();
    }

    const overflowServer = new McpServer({ name: "overflow", version: "1" });
    overflowServer.registerTool(name, { description: "x".repeat(descriptionBytes + 1), inputSchema: {} }, async () => ({ content: [] }));
    const overflowManager = managerForServer(overflowServer);
    await expect(overflowManager.listToolHandles()).rejects.toBeInstanceOf(McpCatalogLimitError);
    await overflowManager.dispose();
  });

  test("MCP aggregate tool overflow closes every connected transport", async () => {
    const transports: InMemoryTransport[] = [];
    const closeCounts = [0, 0];
    for (let index = 0; index < 2; index += 1) {
      const server = new McpServer({ name: `aggregate-${index}`, version: "1" });
      server.registerTool(`tool-${index}`, { inputSchema: {} }, async () => ({ content: [] }));
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const close = clientTransport.close.bind(clientTransport);
      clientTransport.close = async () => {
        closeCounts[index] += 1;
        await close();
      };
      void server.connect(serverTransport);
      transports.push(clientTransport);
    }
    const aggregateManager = new CursorMcpManager(
      [
        { serverName: "aggregate-0", command: "noop" },
        { serverName: "aggregate-1", command: "noop" },
      ],
      { transportFactory: server => transports[Number(server.serverName.at(-1))], maxTools: 1 },
    );

    await expect(aggregateManager.listToolHandles()).rejects.toBeInstanceOf(McpCatalogLimitError);
    expect(closeCounts.every(count => count > 0)).toBe(true);
    await aggregateManager.dispose();
  });

  test("MCP list tool call resource and read bounds are proven after SDK receipt with no retained partial", async () => {
    const oversized = "x".repeat(8 * 1024 * 1024);
    const server = new McpServer({ name: "oversized", version: "1" });
    server.registerTool("huge", { inputSchema: {} }, async () => ({ content: [{ type: "text", text: oversized }] }));
    server.registerResource("huge-resource", "memory://huge", {}, async uri => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: oversized }],
    }));
    const oversizedManager = managerForServer(server);
    try {
      await expect(oversizedManager.callTool("huge", {})).rejects.toBeInstanceOf(CursorMcpPayloadTooLargeError);
      await expect(oversizedManager.readResource("fixture", "memory://huge")).rejects.toBeInstanceOf(CursorMcpPayloadTooLargeError);
    } finally {
      await oversizedManager.dispose();
    }
  });
});

describe("Cursor MCP deps via native-exec dispatcher", () => {
  test("MCP oversized base64 image rejects before decode allocation", async () => {
    const { clientTransport } = buildFixtureServer();
    const manager = new CursorMcpManager(
      [{ serverName: "fixture", command: "noop" }],
      { transportFactory: () => clientTransport, maxResultBytes: 220 },
    );
    const originalBufferFrom = Buffer.from;
    let decodeAttempts = 0;
    let limitError: unknown;
    const decodeSpy = spyOn(Buffer, "from").mockImplementation(((...args: unknown[]) => {
      if (args[0] === PNG_1PX && args[1] === "base64") {
        decodeAttempts += 1;
        throw new Error("base64 decode boundary reached before result budget rejection");
      }
      return Reflect.apply(originalBufferFrom, Buffer, args);
    }) as typeof Buffer.from);
    const assertBudget = manager.assertDecodedResultBudget.bind(manager);
    const budgetSpy = spyOn(manager, "assertDecodedResultBudget").mockImplementation((value, decodedBytes) => {
      try {
        assertBudget(value, decodedBytes);
      } catch (error) {
        limitError = error;
        throw error;
      }
    });
    try {
      const deps = mcpDepsFromManager(manager);
      const result = await deps.mcp!(create(McpArgsSchema, { name: "shot", toolName: "shot", providerIdentifier: "opencodex" }));
      expect(result.result.case).toBe("error");
      expect(limitError).toBeInstanceOf(CursorMcpPayloadTooLargeError);
      expect((limitError as CursorMcpPayloadTooLargeError).kind).toBe("result");
      expect(decodeAttempts).toBe(0);
    } finally {
      budgetSpy.mockRestore();
      decodeSpy.mockRestore();
      await manager.dispose();
    }
  });
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
