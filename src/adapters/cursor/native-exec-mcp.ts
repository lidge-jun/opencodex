import { create } from "@bufbuild/protobuf";
import { decodeCursorArgsMap } from "./arg-codec";
import {
  ListMcpResourcesErrorSchema,
  ListMcpResourcesExecResultSchema,
  ListMcpResourcesExecResult_McpResourceSchema,
  ListMcpResourcesSuccessSchema,
  McpErrorSchema,
  McpImageContentSchema,
  McpResultSchema,
  McpSuccessSchema,
  McpTextContentSchema,
  McpToolDefinitionSchema,
  McpToolNotFoundSchema,
  McpToolResultContentItemSchema,
  ReadMcpResourceErrorSchema,
  ReadMcpResourceExecResultSchema,
  ReadMcpResourceSuccessSchema,
  type McpArgs,
  type McpToolDefinition,
  type McpToolResultContentItem,
  type ReadMcpResourceExecArgs,
} from "./gen/agent_pb";
import type { McpCallResult } from "./mcp-manager";
import { CursorMcpManager } from "./mcp-manager";
import { errorText } from "./native-exec-common";
import type { CursorNativeToolDeps } from "./native-exec-tools";
import { encodeCursorInputSchema } from "./tool-definitions";

/**
 * Build the `McpToolDefinition[]` advertised to the Cursor agent via `requestContextResult`.
 * Without this, the Cursor server never knows any MCP tool exists and never sends `mcpArgs`.
 */
export async function buildMcpToolDefinitions(manager: CursorMcpManager): Promise<McpToolDefinition[]> {
  const handles = await manager.listToolHandles();
  return handles.map(handle => create(McpToolDefinitionSchema, {
    name: handle.advertisedName,
    toolName: handle.advertisedName,
    providerIdentifier: "opencodex",
    description: handle.description,
    inputSchema: encodeCursorInputSchema(handle.inputSchema ?? {}),
  }));
}

/**
 * Adapt a live `CursorMcpManager` into the `CursorNativeToolDeps` the native-exec dispatcher
 * consumes. Every method maps SDK results to protobuf and NEVER throws — a thrown error here
 * would propagate into the stream loop and fail the whole conversation (the dispatcher does not
 * wrap `listMcpResources`). Tool-not-found is RETURNED as a typed `toolNotFound`, not thrown,
 * because the dispatcher's catch maps throws to a generic `error`.
 */
export function mcpDepsFromManager(manager: CursorMcpManager): CursorNativeToolDeps {
  return {
    async mcp(args: McpArgs) {
      const name = args.toolName || args.name;
      try {
        const handle = await manager.resolveTool(name);
        if (!handle) {
          return create(McpResultSchema, {
            result: { case: "toolNotFound", value: create(McpToolNotFoundSchema, { name, availableTools: await manager.toolNames() }) },
          });
        }
        const result = await manager.callTool(name, decodeMcpArgs(args.args));
        return create(McpResultSchema, {
          result: { case: "success", value: create(McpSuccessSchema, { isError: result.isError, content: toContentItems(result) }) },
        });
      } catch (err) {
        return create(McpResultSchema, { result: { case: "error", value: create(McpErrorSchema, { error: errorText(err) }) } });
      }
    },

    async listMcpResources() {
      try {
        const resources = await manager.listResources();
        return create(ListMcpResourcesExecResultSchema, {
          result: { case: "success", value: create(ListMcpResourcesSuccessSchema, {
            resources: resources.map(r => create(ListMcpResourcesExecResult_McpResourceSchema, {
              uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType, server: r.server,
            })),
          }) },
        });
      } catch (err) {
        return create(ListMcpResourcesExecResultSchema, {
          result: { case: "error", value: create(ListMcpResourcesErrorSchema, { error: errorText(err) }) },
        });
      }
    },

    async readMcpResource(args: ReadMcpResourceExecArgs) {
      try {
        const content = await manager.readResource(args.server, args.uri);
        return create(ReadMcpResourceExecResultSchema, {
          result: { case: "success", value: create(ReadMcpResourceSuccessSchema, {
            uri: content.uri,
            mimeType: content.mimeType,
            content: content.blob
              ? { case: "blob", value: content.blob }
              : { case: "text", value: content.text ?? "" },
          }) },
        });
      } catch (err) {
        return create(ReadMcpResourceExecResultSchema, {
          result: { case: "error", value: create(ReadMcpResourceErrorSchema, { uri: args.uri, error: errorText(err) }) },
        });
      }
    },
  };
}

/** Decode the wire `map<string, bytes>` MCP args into JSON values. */
function decodeMcpArgs(raw: { [key: string]: Uint8Array }): Record<string, unknown> {
  return decodeCursorArgsMap(raw);
}

function toContentItems(result: McpCallResult): McpToolResultContentItem[] {
  return result.content.map(block => {
    // Promote real image payloads to McpImageContent so the model receives the actual bytes,
    // not a "[image]" placeholder. Non-text, non-image blocks (audio/resource) still degrade
    // to a text placeholder via renderNonText.
    if (block.type === "image" && typeof block.data === "string") {
      const bytes = base64ToBytes(block.data);
      if (bytes) {
        return create(McpToolResultContentItemSchema, {
          content: { case: "image", value: create(McpImageContentSchema, {
            data: bytes,
            mimeType: block.mimeType ?? "application/octet-stream",
          }) },
        });
      }
    }
    return create(McpToolResultContentItemSchema, {
      content: { case: "text", value: create(McpTextContentSchema, { text: block.text ?? renderNonText(block) }) },
    });
  });
}

/** Decode base64 image data to bytes; returns undefined on malformed input so we fall back to text. */
function base64ToBytes(b64: string): Uint8Array | undefined {
  if (b64.length === 0) return undefined;
  try {
    const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
    return bytes.length > 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function renderNonText(block: { type: string; data?: string; mimeType?: string }): string {
  if (block.data) return `[${block.type}${block.mimeType ? ` ${block.mimeType}` : ""}]`;
  return `[${block.type}]`;
}
