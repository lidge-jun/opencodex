import { create } from "@bufbuild/protobuf";
import {
  ComputerUseErrorSchema,
  ComputerUseResultSchema,
  ListMcpResourcesErrorSchema,
  ListMcpResourcesExecResultSchema,
  McpErrorSchema,
  McpResultSchema,
  ReadMcpResourceErrorSchema,
  ReadMcpResourceExecResultSchema,
  RecordScreenFailureSchema,
  RecordScreenResultSchema,
  type ComputerUseArgs,
  type ComputerUseResult,
  type ExecServerMessage,
  type ListMcpResourcesExecResult,
  type McpArgs,
  type McpResult,
  type ReadMcpResourceExecArgs,
  type ReadMcpResourceExecResult,
  type RecordScreenArgs,
  type RecordScreenResult,
} from "./gen/agent_pb";
import { errorText, execBytes } from "./native-exec-common";

export interface CursorNativeToolDeps {
  mcp?: (args: McpArgs) => McpResult | Promise<McpResult>;
  listMcpResources?: () => ListMcpResourcesExecResult | Promise<ListMcpResourcesExecResult>;
  readMcpResource?: (args: ReadMcpResourceExecArgs) => ReadMcpResourceExecResult | Promise<ReadMcpResourceExecResult>;
  computerUse?: (args: ComputerUseArgs) => ComputerUseResult | Promise<ComputerUseResult>;
  recordScreen?: (args: RecordScreenArgs) => RecordScreenResult | Promise<RecordScreenResult>;
}

export async function mcpExec(execMsg: ExecServerMessage, deps: CursorNativeToolDeps): Promise<Uint8Array> {
  if (execMsg.message.case !== "mcpArgs") throw new Error("invalid mcp exec");
  try {
    const result = deps.mcp
      ? await deps.mcp(execMsg.message.value)
      : create(McpResultSchema, { result: { case: "error", value: create(McpErrorSchema, { error: "No local MCP executor is configured inside opencodex." }) } });
    return execBytes(execMsg, "mcpResult", result);
  } catch (err) {
    return execBytes(execMsg, "mcpResult", create(McpResultSchema, {
      result: { case: "error", value: create(McpErrorSchema, { error: errorText(err) }) },
    }));
  }
}

export async function listMcpResourcesExec(execMsg: ExecServerMessage, deps: CursorNativeToolDeps): Promise<Uint8Array> {
  if (execMsg.message.case !== "listMcpResourcesExecArgs") throw new Error("invalid list mcp resources exec");
  // No executor wired (no MCP configured, or prepareMcp() stripped deps after a setup
  // failure): return a typed error, symmetric with readMcpResource. An empty-success here
  // would falsely imply "connected, zero resources" and mask a misconfiguration.
  const result = deps.listMcpResources
    ? await deps.listMcpResources()
    : create(ListMcpResourcesExecResultSchema, {
        result: { case: "error", value: create(ListMcpResourcesErrorSchema, {
          error: "No local MCP resource executor is configured inside opencodex.",
        }) },
      });
  return execBytes(execMsg, "listMcpResourcesExecResult", result);
}

export async function readMcpResourceExec(execMsg: ExecServerMessage, deps: CursorNativeToolDeps): Promise<Uint8Array> {
  if (execMsg.message.case !== "readMcpResourceExecArgs") throw new Error("invalid read mcp resource exec");
  const args = execMsg.message.value;
  try {
    const result = deps.readMcpResource
      ? await deps.readMcpResource(args)
      : create(ReadMcpResourceExecResultSchema, {
        result: { case: "error", value: create(ReadMcpResourceErrorSchema, { uri: args.uri, error: "No local MCP resource executor is configured inside opencodex." }) },
      });
    return execBytes(execMsg, "readMcpResourceExecResult", result);
  } catch (err) {
    return execBytes(execMsg, "readMcpResourceExecResult", create(ReadMcpResourceExecResultSchema, {
      result: { case: "error", value: create(ReadMcpResourceErrorSchema, { uri: args.uri, error: errorText(err) }) },
    }));
  }
}

export async function computerUseExec(execMsg: ExecServerMessage, deps: CursorNativeToolDeps): Promise<Uint8Array> {
  if (execMsg.message.case !== "computerUseArgs") throw new Error("invalid computer use exec");
  const args = execMsg.message.value;
  try {
    const result = deps.computerUse
      ? await deps.computerUse(args)
      : create(ComputerUseResultSchema, {
        result: { case: "error", value: create(ComputerUseErrorSchema, { error: "computer-use is not supported in this headless opencodex proxy. Configure provider.desktopExecutor.computerUseCommand to enable it.", actionCount: args.actions.length, durationMs: 0 }) },
      });
    return execBytes(execMsg, "computerUseResult", result);
  } catch (err) {
    return execBytes(execMsg, "computerUseResult", create(ComputerUseResultSchema, {
      result: { case: "error", value: create(ComputerUseErrorSchema, { error: errorText(err), actionCount: args.actions.length, durationMs: 0 }) },
    }));
  }
}

export async function recordScreenExec(execMsg: ExecServerMessage, deps: CursorNativeToolDeps): Promise<Uint8Array> {
  if (execMsg.message.case !== "recordScreenArgs") throw new Error("invalid record screen exec");
  const args = execMsg.message.value;
  try {
    const result = deps.recordScreen
      ? await deps.recordScreen(args)
      : create(RecordScreenResultSchema, {
        result: { case: "failure", value: create(RecordScreenFailureSchema, { error: "record-screen is not supported in this headless opencodex proxy. Configure provider.desktopExecutor.recordScreenCommand to enable it." }) },
      });
    return execBytes(execMsg, "recordScreenResult", result);
  } catch (err) {
    return execBytes(execMsg, "recordScreenResult", create(RecordScreenResultSchema, {
      result: { case: "failure", value: create(RecordScreenFailureSchema, { error: errorText(err) }) },
    }));
  }
}
