import { fromBinary, create } from "@bufbuild/protobuf";
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Real child-process spawns resolve packages through bun's install cache; Windows CI runners
// ("Slow filesystem detected") can take >5s for the first spawn. Explicit headroom.
setDefaultTimeout(30_000);
import {
  AgentClientMessageSchema,
  ExecServerMessageSchema,
  McpArgsSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import { handleCursorNativeExec } from "../src/adapters/cursor/native-exec";
import { CursorMcpManager } from "../src/adapters/cursor/mcp-manager";
import { buildMcpToolDefinitions, mcpDepsFromManager } from "../src/adapters/cursor/native-exec-mcp";

/**
 * Live stdio integration: spawns a REAL MCP server as a child process over actual stdio
 * (no InMemoryTransport, no transportFactory seam). This proves REQ1's stdio path end-to-end —
 * connect, tool discovery, callTool round-trip, image fidelity, and clean disposal.
 */

const textEncoder = new TextEncoder();
const PNG_1PX_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// A minimal real MCP server, run by the current runtime over stdio.
const SERVER_SOURCE = `
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "stdio-fixture", version: "1.0.0" });
server.registerTool(
  "ping",
  { description: "Returns pong with the input", inputSchema: { msg: z.string() } },
  async ({ msg }) => ({ content: [{ type: "text", text: "pong:" + msg }] }),
);
server.registerTool(
  "shot",
  { description: "Returns a 1x1 png", inputSchema: {} },
  async () => ({ content: [{ type: "image", data: ${JSON.stringify(PNG_1PX_B64)}, mimeType: "image/png" }] }),
);
await server.connect(new StdioServerTransport());
`;

function execMessage(message: Parameters<typeof create<typeof ExecServerMessageSchema>>[1]["message"]) {
  return create(ExecServerMessageSchema, { id: 1, execId: "exec-stdio", message });
}

function decode(bytes: Uint8Array) {
  const msg = fromBinary(AgentClientMessageSchema, bytes);
  expect(msg.message.case).toBe("execClientMessage");
  return msg.message.value;
}

describe("Cursor MCP live stdio integration", () => {
  let dir: string;
  let scriptPath: string;
  let manager: CursorMcpManager;

  beforeEach(() => {
    dir = mkdtempSync(join(import.meta.dir, ".tmp-mcp-stdio-"));
    scriptPath = join(dir, "server.mjs");
    writeFileSync(scriptPath, SERVER_SOURCE, "utf8");
    // No transportFactory => real StdioClientTransport spawns this script via the current runtime.
    manager = new CursorMcpManager(
      [{ serverName: "stdio-fixture", command: process.execPath, args: [scriptPath], cwd: process.cwd() }],
      { connectTimeoutMs: 20_000 },
    );
  });

  afterEach(async () => {
    await manager.dispose();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  });

  test("connects over real stdio and discovers tools", async () => {
    const defs = await buildMcpToolDefinitions(manager);
    const names = defs.map(d => d.toolName).sort();
    expect(names).toEqual(["ping", "shot"]);
  });

  test("callTool round-trips a real result over the child-process pipe", async () => {
    const deps = mcpDepsFromManager(manager);
    const args = create(McpArgsSchema, { name: "ping", toolName: "ping", providerIdentifier: "opencodex" });
    args.args = { msg: textEncoder.encode(JSON.stringify("hi")) };

    const reply = decode((await handleCursorNativeExec(execMessage({ case: "mcpArgs", value: args }), deps))[0]);
    expect(reply.message.case).toBe("mcpResult");
    expect(reply.message.value.result.case).toBe("success");
    if (reply.message.value.result.case === "success") {
      const content = reply.message.value.result.value.content[0];
      expect(content?.content.case).toBe("text");
      if (content?.content.case === "text") expect(content.content.value.text).toBe("pong:hi");
    }
  });

  test("image tool round-trips real bytes over stdio", async () => {
    const deps = mcpDepsFromManager(manager);
    const args = create(McpArgsSchema, { name: "shot", toolName: "shot", providerIdentifier: "opencodex" });

    const reply = decode((await handleCursorNativeExec(execMessage({ case: "mcpArgs", value: args }), deps))[0]);
    expect(reply.message.value.result.case).toBe("success");
    if (reply.message.value.result.case === "success") {
      const content = reply.message.value.result.value.content[0];
      expect(content?.content.case).toBe("image");
      if (content?.content.case === "image") {
        expect(content.content.value.mimeType).toBe("image/png");
        expect(Array.from(content.content.value.data.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
      }
    }
  });
});
