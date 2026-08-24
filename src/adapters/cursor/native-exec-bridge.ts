import { create } from "@bufbuild/protobuf";
import {
  ExecServerMessageSchema,
  McpArgsSchema,
  type ExecServerMessage,
} from "./gen/agent_pb";
import {
  CODEX_SHELL_BRIDGE_TOOL_NAMES,
  isCodexShellBridgeToolName,
  normalizeCursorWireName,
  OCX_RESPONSES_TOOL_PROVIDER,
} from "./tool-definitions";

export type NativeExecBridgePlan =
  | { bridge: false }
  | {
      bridge: true;
      toolName: string;
      toolCallId: string;
      args: { command: string; workdir?: string };
    };

export function posixSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function advertisedBareCodexShellBridgeName(clientToolNames: Iterable<string>): string | undefined {
  const advertised = new Set(
    [...clientToolNames]
      .map(normalizeCursorWireName)
      .filter(isCodexShellBridgeToolName),
  );
  for (const bridgeName of CODEX_SHELL_BRIDGE_TOOL_NAMES) {
    if (advertised.has(bridgeName)) return bridgeName;
  }
  return undefined;
}

export function planNativeExecBridge(
  execMsg: ExecServerMessage,
  opts: { nativeLocalExecEnabled: boolean; advertisedShellBridgeName?: string },
): NativeExecBridgePlan {
  if (opts.nativeLocalExecEnabled || !opts.advertisedShellBridgeName) return { bridge: false };

  const execCase = execMsg.message.case;
  if (!execCase) return { bridge: false };

  let toolCallId = `exec_${execMsg.id}`;
  let command = "";
  let workdir: string | undefined;

  switch (execCase) {
    case "shellArgs":
    case "shellStreamArgs": {
      const args = execMsg.message.value;
      command = args.command.trim();
      if (args.workingDirectory.trim()) workdir = args.workingDirectory.trim();
      if (args.toolCallId) toolCallId = args.toolCallId;
      break;
    }
    case "backgroundShellSpawnArgs": {
      const args = execMsg.message.value;
      command = args.command.trim();
      if (args.workingDirectory.trim()) workdir = args.workingDirectory.trim();
      if (args.toolCallId) toolCallId = args.toolCallId;
      break;
    }
    case "readArgs": {
      const args = execMsg.message.value;
      const path = args.path.trim();
      if (!path) return { bridge: false };
      command = `cat -- ${posixSingleQuote(path)}`;
      if (args.toolCallId) toolCallId = args.toolCallId;
      break;
    }
    case "lsArgs": {
      const args = execMsg.message.value;
      const path = args.path.trim();
      if (!path) return { bridge: false };
      command = `ls -la -- ${posixSingleQuote(path)}`;
      if (args.toolCallId) toolCallId = args.toolCallId;
      break;
    }
    case "grepArgs": {
      const args = execMsg.message.value;
      const pattern = args.pattern.trim();
      if (!pattern) return { bridge: false };
      const path = args.path?.trim();
      command = path
        ? `rg -n -- ${posixSingleQuote(pattern)} ${posixSingleQuote(path)}`
        : `rg -n -- ${posixSingleQuote(pattern)}`;
      if (args.toolCallId) toolCallId = args.toolCallId;
      break;
    }
    case "fetchArgs": {
      const args = execMsg.message.value;
      const url = args.url.trim();
      if (!url) return { bridge: false };
      command = `curl -fsSL -- ${posixSingleQuote(url)}`;
      if (args.toolCallId) toolCallId = args.toolCallId;
      break;
    }
    default:
      return { bridge: false };
  }

  if (!command) return { bridge: false };

  return {
    bridge: true,
    toolName: opts.advertisedShellBridgeName,
    toolCallId,
    args: workdir ? { command, workdir } : { command },
  };
}

export function nativeExecBridgeToMcpExec(
  execMsg: ExecServerMessage,
  plan: Extract<NativeExecBridgePlan, { bridge: true }>,
): ExecServerMessage {
  const args: Record<string, Uint8Array> = {
    command: new TextEncoder().encode(JSON.stringify(plan.args.command)),
  };
  if (plan.args.workdir) {
    args.workdir = new TextEncoder().encode(JSON.stringify(plan.args.workdir));
  }
  return create(ExecServerMessageSchema, {
    id: execMsg.id,
    execId: execMsg.execId,
    message: {
      case: "mcpArgs",
      value: create(McpArgsSchema, {
        name: plan.toolName,
        toolName: plan.toolName,
        toolCallId: plan.toolCallId,
        providerIdentifier: OCX_RESPONSES_TOOL_PROVIDER,
        args,
      }),
    },
  });
}
