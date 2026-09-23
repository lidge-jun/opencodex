/**
 * Isolated MCP catalog used by the CodeBuddy adapter.
 *
 * This process advertises the current Codex tool schemas but deliberately never
 * executes a call. The parent adapter captures CodeBuddy's completed `tool_use`
 * frame, terminates this process tree, and returns the call to the Codex host,
 * where the normal approval and sandbox boundary remains authoritative.
 */

import { open } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CODEBUDDY_TOOL_LIMITS } from "./tool-bridge";

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const MCP_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const INVALID_DESCRIPTION_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const textEncoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

async function readCatalogBounded(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("tool catalog must be a regular file");
    if (before.size > CODEBUDDY_TOOL_LIMITS.maxCatalogBytes) {
      throw new Error("tool catalog is too large");
    }

    // Read at most limit + 1 from the already-open descriptor. The extra byte
    // distinguishes an exact-limit file from a file that grew after fstat,
    // without ever allocating or retaining an attacker-sized input.
    const bytes = Buffer.allocUnsafe(CODEBUDDY_TOOL_LIMITS.maxCatalogBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > CODEBUDDY_TOOL_LIMITS.maxCatalogBytes) {
      throw new Error("tool catalog is too large");
    }

    const after = await handle.stat();
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || after.size !== offset
    ) {
      throw new Error("tool catalog changed while being read");
    }
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function assertBoundedSchema(schema: Record<string, unknown>): void {
  if (schema.type !== "object") throw new Error("tool input schema must have object type");
  if (utf8Bytes(JSON.stringify(schema)) > CODEBUDDY_TOOL_LIMITS.maxSchemaBytes) {
    throw new Error("tool input schema is too large");
  }

  let nodes = 0;
  const pending: Array<{ depth: number; value: unknown }> = [{ depth: 0, value: schema }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > CODEBUDDY_TOOL_LIMITS.maxSchemaNodes) {
      throw new Error("tool input schema has too many nodes");
    }
    if (current.depth > CODEBUDDY_TOOL_LIMITS.maxSchemaDepth) {
      throw new Error("tool input schema is too deeply nested");
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) pending.push({ depth: current.depth + 1, value: child });
    } else if (isRecord(current.value)) {
      for (const child of Object.values(current.value)) {
        pending.push({ depth: current.depth + 1, value: child });
      }
    }
  }
}

async function loadTools(path: string): Promise<ToolDefinition[]> {
  const bytes = await readCatalogBounded(path);
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(parsed)) throw new Error("tool catalog must be an array");
  if (parsed.length > CODEBUDDY_TOOL_LIMITS.maxTools) {
    throw new Error("tool catalog contains too many definitions");
  }

  const names = new Set<string>();
  return parsed.map((value): ToolDefinition => {
    if (
      !isRecord(value)
      || typeof value.name !== "string"
      || !MCP_TOOL_NAME_PATTERN.test(value.name)
      || utf8Bytes(value.name) > CODEBUDDY_TOOL_LIMITS.maxNameBytes
      || typeof value.description !== "string"
      || value.description.length < 1
      || hasUnpairedSurrogate(value.description)
      || INVALID_DESCRIPTION_CONTROL_PATTERN.test(value.description)
      || utf8Bytes(value.description) > CODEBUDDY_TOOL_LIMITS.maxDescriptionBytes
      || !isRecord(value.inputSchema)
    ) {
      throw new Error("tool catalog contains an invalid definition");
    }
    if (names.has(value.name)) throw new Error("tool catalog contains duplicate names");
    names.add(value.name);
    assertBoundedSchema(value.inputSchema);
    const definition = {
      name: value.name,
      description: value.description,
      inputSchema: value.inputSchema,
    };
    if (utf8Bytes(JSON.stringify(definition)) > CODEBUDDY_TOOL_LIMITS.maxToolBytes) {
      throw new Error("tool catalog contains an oversized definition");
    }
    return definition;
  });
}

export async function runCodeBuddyMcpServer(catalogPath: string): Promise<void> {
  if (!catalogPath) throw new Error("missing tool catalog");
  // The pinned SDK does not detect stdin EOF itself. The capture server must exit when
  // the parent terminates its CLI, including after a captured message_stop.
  const exitOnStdinClose = (): void => process.exit(0);
  process.stdin.on("end", exitOnStdinClose);
  process.stdin.on("close", exitOnStdinClose);

  const tools = await loadTools(catalogPath);
  const advertisedNames = new Set(tools.map(tool => tool.name));
  const server = new Server(
    { name: "opencodex-codebuddy-capture", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    if (!advertisedNames.has(request.params.name)) throw new Error("unknown isolated tool");
    // The external Codex client retains approval and execution ownership.
    return await new Promise<never>(() => {});
  });
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) await runCodeBuddyMcpServer(process.argv[2] ?? "");
