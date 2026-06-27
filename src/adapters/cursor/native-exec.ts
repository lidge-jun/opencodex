import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
  DiagnosticsResultSchema,
  DiagnosticsSuccessSchema,
  GetBlobResultSchema,
  KvClientMessageSchema,
  McpErrorSchema,
  McpResultSchema,
  RequestContextResultSchema,
  RequestContextSchema,
  RequestContextSuccessSchema,
  SetBlobResultSchema,
  type ExecServerMessage,
  type KvServerMessage,
} from "./gen/agent_pb";
import { deleteExec, grepExec, lsExec, readExec, writeExec } from "./native-exec-fs";
import { fetchExec, type CursorNativeNetworkDeps } from "./native-exec-network";
import { backgroundShellSpawnExec, shellExec, shellStreamExec, writeShellStdinExec } from "./native-exec-shell";
import {
  computerUseExec,
  listMcpResourcesExec,
  mcpExec,
  readMcpResourceExec,
  recordScreenExec,
  type CursorNativeToolDeps,
} from "./native-exec-tools";
import { clientBytes, execBytes } from "./native-exec-common";
import type { McpToolDefinition } from "./gen/agent_pb";
import { OCX_RESPONSES_TOOL_PROVIDER } from "./tool-definitions";

export type CursorNativeExecDeps = CursorNativeNetworkDeps & CursorNativeToolDeps;

/**
 * Execution context for a Cursor stream: the per-call executors plus the MCP tool definitions
 * advertised to the server via `requestContextResult`. Without `mcpToolDefs`, the server is
 * never told any MCP tools exist, so it never sends `mcpArgs`.
 */
export interface CursorNativeExecContext extends CursorNativeExecDeps {
  mcpToolDefs?: McpToolDefinition[];
  clientToolDefs?: McpToolDefinition[];
}

const blobs = new Map<string, Uint8Array>();

function key(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/**
 * Store a blob (SHA-256 keyed) in the shared map that `handleCursorNativeKv` serves, and return its
 * blob id. Cursor's `rootPromptMessagesJson`/turn entries are blob IDS, not inline content — the
 * server fetches the bytes back via `getBlobArgs`. Mirrors jawcode `createBlobId`/`storeCursorBlob`.
 */
export function storeCursorBlob(data: Uint8Array): Uint8Array {
  const blobId = new Uint8Array(createHash("sha256").update(data).digest());
  blobs.set(key(blobId), data);
  return blobId;
}

export async function handleCursorNativeExec(execMsg: ExecServerMessage, deps: CursorNativeExecContext = {}): Promise<Uint8Array[]> {
  const execCase = execMsg.message.case;
  if (execCase === "requestContextArgs") {
    const tools = [...(deps.mcpToolDefs ?? []), ...(deps.clientToolDefs ?? [])];
    return [execBytes(execMsg, "requestContextResult", create(RequestContextResultSchema, {
      result: { case: "success", value: create(RequestContextSuccessSchema, { requestContext: create(RequestContextSchema, { tools }) }) },
    }))];
  }
  if (execCase === "readArgs") return [readExec(execMsg)];
  if (execCase === "writeArgs") return [writeExec(execMsg)];
  if (execCase === "deleteArgs") return [deleteExec(execMsg)];
  if (execCase === "lsArgs") return [lsExec(execMsg)];
  if (execCase === "grepArgs") return [grepExec(execMsg)];
  if (execCase === "shellArgs") return [shellExec(execMsg)];
  if (execCase === "shellStreamArgs") return shellStreamExec(execMsg);
  if (execCase === "backgroundShellSpawnArgs") return [backgroundShellSpawnExec(execMsg)];
  if (execCase === "writeShellStdinArgs") return [writeShellStdinExec(execMsg)];
  if (execCase === "fetchArgs") return [await fetchExec(execMsg, deps)];
  if (execCase === "mcpArgs" && execMsg.message.value.providerIdentifier === OCX_RESPONSES_TOOL_PROVIDER) {
    return [execBytes(execMsg, "mcpResult", create(McpResultSchema, {
      result: {
        case: "error",
        value: create(McpErrorSchema, { error: "Cursor requested a client Responses tool through the native exec channel; bridge suspension is not implemented." }),
      },
    }))];
  }
  if (execCase === "mcpArgs") return [await mcpExec(execMsg, deps)];
  if (execCase === "listMcpResourcesExecArgs") return [await listMcpResourcesExec(execMsg, deps)];
  if (execCase === "readMcpResourceExecArgs") return [await readMcpResourceExec(execMsg, deps)];
  if (execCase === "computerUseArgs") return [await computerUseExec(execMsg, deps)];
  if (execCase === "recordScreenArgs") return [await recordScreenExec(execMsg, deps)];
  if (execCase === "diagnosticsArgs") {
    const path = execMsg.message.value.path;
    return [execBytes(execMsg, "diagnosticsResult", create(DiagnosticsResultSchema, {
      result: { case: "success", value: create(DiagnosticsSuccessSchema, { path, diagnostics: [], totalDiagnostics: 0 }) },
    }))];
  }
  return [];
}

export function handleCursorNativeKv(kvMsg: KvServerMessage): Uint8Array {
  if (kvMsg.message.case === "getBlobArgs") {
    const blobData = blobs.get(key(kvMsg.message.value.blobId));
    return clientBytes({
      message: {
        case: "kvClientMessage",
        value: create(KvClientMessageSchema, {
          id: kvMsg.id,
          message: { case: "getBlobResult", value: create(GetBlobResultSchema, blobData ? { blobData } : {}) },
        }),
      },
    });
  }
  if (kvMsg.message.case === "setBlobArgs") {
    blobs.set(key(kvMsg.message.value.blobId), kvMsg.message.value.blobData);
    return clientBytes({
      message: {
        case: "kvClientMessage",
        value: create(KvClientMessageSchema, {
          id: kvMsg.id,
          message: { case: "setBlobResult", value: create(SetBlobResultSchema, {}) },
        }),
      },
    });
  }
  return clientBytes({ message: { case: "kvClientMessage", value: create(KvClientMessageSchema, { id: kvMsg.id }) } });
}
