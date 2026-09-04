import { randomBytes, randomUUID } from "node:crypto";
import type { RemoteWorkspaceCoordinator } from "./workspace-coordinator";
import {
  REMOTE_WORKSPACE_DYNAMIC_TOOLS,
  REMOTE_WORKSPACE_TOOL_NAMESPACE,
  isRemoteWorkspaceToolName,
  type RemoteWorkspaceToolName,
} from "./workspace-tools";

const MAX_BRIDGE_BODY_BYTES = 512 * 1024;
const MAX_BRIDGE_ACTIVE_REQUESTS = 8;
function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function errorText(value: unknown): string {
  return (value instanceof Error ? value.message : "Remote Workspace tool failed")
    .replace(/[^\x20-\x7e\n\t]/g, " ")
    .slice(0, 4_096);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function readBoundedJson(req: Request): Promise<unknown> {
  if (!req.body) throw new Error("invalid JSON");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_BRIDGE_BODY_BYTES) {
        await reader.cancel("request too large").catch(() => {});
        throw new Error("request too large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
}

export interface RemoteWorkspaceToolBridge {
  url: string;
  token: string;
  stop(): Promise<void>;
}

/**
 * Loopback-only bridge used by Hub-owned CLIs whose extension boundary is HTTP.
 * The random bearer is passed only to the child process. The model sees tool schemas,
 * never this endpoint or token, and every invocation still goes through the E2EE coordinator.
 */
export function startRemoteWorkspaceToolBridge(options: {
  coordinator: RemoteWorkspaceCoordinator;
  threadId: string | (() => string);
  tools: readonly RemoteWorkspaceToolName[];
  onTool?: (tool: RemoteWorkspaceToolName) => void;
}): RemoteWorkspaceToolBridge {
  const token = randomBytes(32).toString("base64url");
  const toolNames = new Set(options.tools);
  const definitions = REMOTE_WORKSPACE_DYNAMIC_TOOLS[0].tools.filter(tool => toolNames.has(tool.name));
  if (definitions.length < 1) throw new Error("Remote Workspace bridge needs at least one tool");
  const invoke = async (tool: unknown, args: unknown): Promise<{ success: boolean; text: string }> => {
    if (!isRemoteWorkspaceToolName(tool) || !toolNames.has(tool)) {
      return { success: false, text: JSON.stringify({ ok: false, error: "unknown Remote Workspace tool" }) };
    }
    options.onTool?.(tool);
    const threadId = typeof options.threadId === "function" ? options.threadId() : options.threadId;
    if (!threadId) return { success: false, text: JSON.stringify({ ok: false, error: "remote workspace thread is not ready" }) };
    const result = await options.coordinator.handle({
      method: "item/tool/call",
      id: randomUUID(),
      params: {
        threadId,
        turnId: randomUUID(),
        callId: randomUUID(),
        namespace: REMOTE_WORKSPACE_TOOL_NAMESPACE,
        tool,
        arguments: args,
      },
    });
    return { success: result.result.success, text: result.result.contentItems[0]!.text };
  };
  let activeRequests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.headers.get("origin")) return json({ error: "browser origins are not allowed" }, 403);
      if (req.headers.get("authorization") !== `Bearer ${token}`) return json({ error: "unauthorized" }, 401);
      if (req.method !== "POST" || (url.pathname !== "/invoke" && url.pathname !== "/mcp")) {
        return json({ error: "not found" }, 404);
      }
      if (activeRequests >= MAX_BRIDGE_ACTIVE_REQUESTS) return json({ error: "Remote Workspace bridge is busy" }, 429);
      activeRequests += 1;
      try {
        const length = Number(req.headers.get("content-length") ?? "0");
        if (!Number.isFinite(length) || length > MAX_BRIDGE_BODY_BYTES) return json({ error: "request too large" }, 413);
        let parsed: unknown;
        try { parsed = await readBoundedJson(req); }
        catch (error) {
          return json({ error: error instanceof Error && error.message === "request too large" ? error.message : "invalid JSON" },
            error instanceof Error && error.message === "request too large" ? 413 : 400);
        }
        const body = record(parsed);
        if (!body) return json({ error: "invalid request" }, 400);

        if (url.pathname === "/invoke") {
          try {
            return json(await invoke(body.tool, body.arguments));
          } catch (error) {
            return json({ success: false, text: JSON.stringify({ ok: false, error: errorText(error) }) }, 502);
          }
        }

        const id = body.id;
        const method = body.method;
        const params = record(body.params) ?? {};
        if (typeof method !== "string") return json({ jsonrpc: "2.0", id: id ?? null, error: { code: -32_600, message: "invalid MCP request" } });
        if (method === "notifications/initialized") return new Response(null, { status: 202 });
        if (method === "initialize") {
          return json({
            jsonrpc: "2.0",
            id: id ?? null,
            result: {
              protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "opencodex-remote-workspace", version: "1" },
            },
          });
        }
        if (method === "ping") return json({ jsonrpc: "2.0", id: id ?? null, result: {} });
        if (method === "tools/list") {
          return json({
            jsonrpc: "2.0",
            id: id ?? null,
            result: {
              tools: definitions.map(tool => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
              })),
            },
          });
        }
        if (method === "tools/call") {
          try {
            const called = await invoke(params.name, params.arguments);
            return json({
              jsonrpc: "2.0",
              id: id ?? null,
              result: { content: [{ type: "text", text: called.text }], isError: !called.success },
            });
          } catch (error) {
            return json({
              jsonrpc: "2.0",
              id: id ?? null,
              result: { content: [{ type: "text", text: errorText(error) }], isError: true },
            });
          }
        }
        return json({ jsonrpc: "2.0", id: id ?? null, error: { code: -32_601, message: "MCP method not found" } });
      } finally {
        activeRequests -= 1;
      }
    },
  });
  let stopping: Promise<void> | null = null;
  return {
    url: new URL("/", server.url).toString().replace(/\/$/, ""),
    token,
    stop() {
      stopping ??= server.stop(true);
      return stopping;
    },
  };
}
