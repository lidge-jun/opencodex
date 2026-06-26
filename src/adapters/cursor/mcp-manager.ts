import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ResolvedMcpServer } from "./mcp-config";

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;

/** A tool discovered on a connected MCP server, with its opencodex-advertised name. */
export interface McpToolHandle {
  serverName: string;
  toolName: string;
  /** Name advertised to the Cursor agent (toolPrefix applied). */
  advertisedName: string;
  description: string;
  inputSchema: unknown;
}

/** Normalized MCP tool-call result (SDK-shape-agnostic). */
export interface McpCallResult {
  isError: boolean;
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
}

export interface McpResourceListing {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  server: string;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: Uint8Array;
}

export interface CursorMcpManagerOptions {
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  /** Test seam: provide a transport factory instead of spawning real processes. */
  transportFactory?: (server: ResolvedMcpServer) => Transport;
  log?: (message: string) => void;
}

interface ConnectedServer {
  server: ResolvedMcpServer;
  client: Client;
}

/**
 * Owns the lifecycle of MCP client connections for one Cursor stream. Lazily connects to the
 * configured servers, discovers their tools/resources, and executes tool/resource calls.
 *
 * Connection failures are isolated per-server: one unreachable server never blocks the others
 * and never throws out of `ensureConnected`. Tool-level errors from a server resolve as
 * `{ isError: true }` (they do not throw); only protocol/transport failures throw from
 * `callTool`/`listResources`/`readResource`, and callers are expected to map those to typed
 * protobuf error results.
 */
export class CursorMcpManager {
  private readonly connectTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private connected?: Promise<void>;
  private readonly servers = new Map<string, ConnectedServer>();
  /** advertisedName -> { serverName, original toolName } */
  private readonly toolIndex = new Map<string, { serverName: string; toolName: string; handle: McpToolHandle }>();

  constructor(
    private readonly resolved: ResolvedMcpServer[],
    private readonly options: CursorMcpManagerOptions = {},
  ) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  }

  /** Idempotent, lazy connect + tool discovery across all servers. Never throws. */
  ensureConnected(): Promise<void> {
    if (!this.connected) this.connected = this.connectAll();
    return this.connected;
  }

  private async connectAll(): Promise<void> {
    await Promise.all(this.resolved.map(server => this.connectOne(server)));
  }

  private async connectOne(server: ResolvedMcpServer): Promise<void> {
    try {
      const transport = this.options.transportFactory
        ? this.options.transportFactory(server)
        : this.createTransport(server);
      const client = new Client({ name: "opencodex", version: "1.0.0" });
      await this.withTimeout(client.connect(transport), this.connectTimeoutMs, `connect ${server.serverName}`);
      this.servers.set(server.serverName, { server, client });
      await this.indexTools(server, client);
    } catch (err) {
      this.options.log?.(`[cursor-mcp] server "${server.serverName}" failed to connect: ${errText(err)}`);
    }
  }

  private createTransport(server: ResolvedMcpServer): Transport {
    if (server.command) {
      return new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: server.env,
        cwd: server.cwd,
      });
    }
    if (server.url) {
      return new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: server.headers ? { headers: server.headers } : undefined,
      });
    }
    throw new Error(`MCP server "${server.serverName}" has neither command nor url`);
  }

  private async indexTools(server: ResolvedMcpServer, client: Client): Promise<void> {
    const prefix = server.toolPrefix ?? "";
    const { tools } = await this.withTimeout(client.listTools(), this.connectTimeoutMs, `listTools ${server.serverName}`);
    for (const tool of tools ?? []) {
      const advertisedName = `${prefix}${tool.name}`;
      const handle: McpToolHandle = {
        serverName: server.serverName,
        toolName: tool.name,
        advertisedName,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema ?? {},
      };
      this.toolIndex.set(advertisedName, { serverName: server.serverName, toolName: tool.name, handle });
    }
  }

  async listToolHandles(): Promise<McpToolHandle[]> {
    await this.ensureConnected();
    return [...this.toolIndex.values()].map(entry => entry.handle);
  }

  async resolveTool(advertisedName: string): Promise<McpToolHandle | undefined> {
    await this.ensureConnected();
    return this.toolIndex.get(advertisedName)?.handle;
  }

  async toolNames(): Promise<string[]> {
    await this.ensureConnected();
    return [...this.toolIndex.keys()];
  }

  /** Throws only on protocol/transport failure or unknown tool; tool-level errors resolve. */
  async callTool(advertisedName: string, args: Record<string, unknown>): Promise<McpCallResult> {
    await this.ensureConnected();
    const entry = this.toolIndex.get(advertisedName);
    if (!entry) throw new Error(`MCP tool not found: ${advertisedName}`);
    const conn = this.servers.get(entry.serverName);
    if (!conn) throw new Error(`MCP server not connected: ${entry.serverName}`);
    const result = await this.withTimeout(
      conn.client.callTool({ name: entry.toolName, arguments: args }),
      this.callTimeoutMs,
      `callTool ${advertisedName}`,
    );
    return {
      isError: Boolean((result as { isError?: boolean }).isError),
      content: normalizeContent((result as { content?: unknown[] }).content),
    };
  }

  async listResources(server?: string): Promise<McpResourceListing[]> {
    await this.ensureConnected();
    const targets = server ? [this.servers.get(server)].filter(Boolean) as ConnectedServer[] : [...this.servers.values()];
    const out: McpResourceListing[] = [];
    for (const conn of targets) {
      const { resources } = await this.withTimeout(conn.client.listResources(), this.callTimeoutMs, `listResources ${conn.server.serverName}`);
      for (const r of resources ?? []) {
        out.push({ uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType, server: conn.server.serverName });
      }
    }
    return out;
  }

  async readResource(server: string, uri: string): Promise<McpResourceContent> {
    await this.ensureConnected();
    const conn = this.servers.get(server);
    if (!conn) throw new Error(`MCP server not connected: ${server}`);
    const result = await this.withTimeout(conn.client.readResource({ uri }), this.callTimeoutMs, `readResource ${uri}`);
    const first = (result.contents ?? [])[0] as { uri?: string; mimeType?: string; text?: string; blob?: string } | undefined;
    if (!first) return { uri, mimeType: undefined, text: "" };
    return {
      uri: first.uri ?? uri,
      mimeType: first.mimeType,
      text: typeof first.text === "string" ? first.text : undefined,
      blob: typeof first.blob === "string" ? Uint8Array.from(Buffer.from(first.blob, "base64")) : undefined,
    };
  }

  async dispose(): Promise<void> {
    const conns = [...this.servers.values()];
    this.servers.clear();
    this.toolIndex.clear();
    await Promise.all(conns.map(async conn => {
      try {
        await conn.client.close();
      } catch (err) {
        this.options.log?.(`[cursor-mcp] dispose "${conn.server.serverName}": ${errText(err)}`);
      }
    }));
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`MCP ${label} timed out after ${ms}ms`)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function normalizeContent(content: unknown[] | undefined): McpCallResult["content"] {
  if (!Array.isArray(content)) return [];
  return content.map(item => {
    const block = item as { type?: string; text?: string; data?: string; mimeType?: string };
    return { type: block.type ?? "text", text: block.text, data: block.data, mimeType: block.mimeType };
  });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
