import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { resolveTrustedWindowsSystemDirectory } from "../lib/windows-elevation";
import {
  REMOTE_WORKSPACE_MAX_TOOL_RESULT_BYTES,
  REMOTE_WORKSPACE_TOOL_NAMESPACE,
  parseRemoteWorkspaceToolCall,
  remoteWorkspaceCodexDeveloperInstructions,
  remoteWorkspaceCapabilityForTool,
  remoteWorkspaceDeveloperInstructions,
  remoteWorkspaceToolsForCapabilities,
  type RemoteWorkspaceCapability,
  type RemoteWorkspaceToolName,
  type RemoteWorkspaceToolCallParams,
  type RemoteWorkspaceToolResult,
} from "./workspace-tools";
import type { RemoteWorkspaceExecutionRequest } from "./workspace-executor";

export interface RemoteWorkspaceSessionBinding {
  sessionId: string;
  threadId: string;
  executorDeviceId: string;
  executorName: string;
  rootId: string;
  capabilities: RemoteWorkspaceCapability[];
  tools: RemoteWorkspaceToolName[];
}

export interface RemoteWorkspaceTransport {
  isOnline(deviceId: string): boolean;
  invoke(request: RemoteWorkspaceExecutionRequest): Promise<RemoteWorkspaceToolResult>;
}

export interface AppServerDynamicToolRequest {
  method: "item/tool/call";
  id: string | number;
  params: unknown;
}

export interface AppServerDynamicToolResponse {
  id: string | number;
  result: {
    contentItems: Array<{ type: "inputText"; text: string }>;
    success: boolean;
  };
}

function identifier(value: string, label: string): string {
  if (value.length < 1 || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`invalid remote workspace ${label}`);
  }
  return value;
}

function resultText(result: RemoteWorkspaceToolResult): string {
  const encoded = JSON.stringify(result);
  if (Buffer.byteLength(encoded, "utf8") > REMOTE_WORKSPACE_MAX_TOOL_RESULT_BYTES) {
    return JSON.stringify({ ok: false, error: "remote workspace tool result exceeded the coordinator limit" });
  }
  return encoded;
}

export function remoteWorkspaceThreadStartParams(options: {
  executorName: string;
  coordinatorIsolationPath: string;
  tools: readonly RemoteWorkspaceToolName[];
  platform?: NodeJS.Platform;
  windowsSystemDirectory?: string;
  mcp?: {
    url: string;
    bearerTokenEnvVar: string;
    disabledServerNames?: readonly string[];
    disabledHookNames?: readonly string[];
    hubRuntimeReadPaths?: readonly string[];
  };
}): Record<string, unknown> {
  if (!isAbsolute(options.coordinatorIsolationPath) || options.coordinatorIsolationPath.includes("\0")) {
    throw new Error("remote workspace coordinator isolation path must be absolute");
  }
  const platform = options.platform ?? process.platform;
  const shellEnvironment = platform === "win32"
    ? {
      HOME: options.coordinatorIsolationPath,
      USERPROFILE: options.coordinatorIsolationPath,
      TEMP: options.coordinatorIsolationPath,
      TMP: options.coordinatorIsolationPath,
      PATH: options.windowsSystemDirectory ?? resolveTrustedWindowsSystemDirectory(),
    }
    : {
      HOME: options.coordinatorIsolationPath,
      PATH: platform === "darwin" ? "/usr/bin:/bin" : "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
    };
  const config = options.mcp ? {
    // A Remote Workspace thread may authenticate/model-call from the Hub, but every
    // model-visible action must either be the one OCX MCP server or fail closed.
    default_permissions: "ocx-remote-deny-local",
    permissions: {
      "ocx-remote-deny-local": {
        description: "Deny Hub-local command filesystem and network access for Remote Workspace.",
        filesystem: {
          ":minimal": "read",
          ":workspace_roots": { ".": "read" },
          ...Object.fromEntries((options.mcp.hubRuntimeReadPaths ?? []).map(path => [path, "read"])),
        },
        network: { enabled: false },
      },
    },
    approval_policy: "never",
    allow_login_shell: false,
    shell_environment_policy: {
      inherit: "none",
      ignore_default_excludes: false,
      set: shellEnvironment,
    },
    web_search: "disabled",
    tools: { view_image: false, web_search: false },
    agents: { enabled: false },
    apps: { _default: { enabled: false } },
    features: {
      apps: false,
      browser_use: false,
      computer_use: false,
      in_app_browser: false,
      memories: false,
      multi_agent: false,
      plugins: false,
      remote_plugin: false,
    },
    memories: { use_memories: false, generate_memories: false },
    hooks: Object.fromEntries((options.mcp.disabledHookNames ?? []).map(name => [name, []])),
    mcp_servers: {
      ...Object.fromEntries((options.mcp.disabledServerNames ?? [])
        .filter(name => name !== REMOTE_WORKSPACE_TOOL_NAMESPACE)
        .map(name => [name, { enabled: false }])),
      [REMOTE_WORKSPACE_TOOL_NAMESPACE]: {
        enabled: true,
        required: true,
        url: options.mcp.url,
        bearer_token_env_var: options.mcp.bearerTokenEnvVar,
        enabled_tools: [...options.tools],
        default_tools_approval_mode: "approve",
        startup_timeout_sec: 5,
        tool_timeout_sec: 65,
      },
    },
  } : undefined;
  return {
    cwd: options.coordinatorIsolationPath,
    runtimeWorkspaceRoots: [options.coordinatorIsolationPath],
    approvalPolicy: "never",
    ephemeral: false,
    serviceName: "opencodex_remote_workspace",
    developerInstructions: options.mcp
      ? remoteWorkspaceCodexDeveloperInstructions(options.executorName, options.tools)
      : remoteWorkspaceDeveloperInstructions(options.executorName, options.tools),
    ...(config ? { config } : {}),
  };
}

export class RemoteWorkspaceCoordinator {
  private readonly sessions = new Map<string, RemoteWorkspaceSessionBinding>();

  constructor(private readonly transport: RemoteWorkspaceTransport) {}

  register(binding: RemoteWorkspaceSessionBinding): () => void {
    const capabilities = [...binding.capabilities];
    const tools = remoteWorkspaceToolsForCapabilities(capabilities);
    if (tools.length < 1) throw new Error("remote workspace binding has no usable tools");
    const normalized: RemoteWorkspaceSessionBinding = {
      sessionId: identifier(binding.sessionId, "session ID"),
      threadId: identifier(binding.threadId, "thread ID"),
      executorDeviceId: identifier(binding.executorDeviceId, "executor device ID"),
      executorName: identifier(binding.executorName, "executor name"),
      rootId: identifier(binding.rootId, "root ID"),
      capabilities,
      tools,
    };
    if (this.sessions.has(normalized.threadId)) throw new Error("remote workspace thread is already bound");
    this.sessions.set(normalized.threadId, normalized);
    return () => {
      if (this.sessions.get(normalized.threadId)?.sessionId === normalized.sessionId) {
        this.sessions.delete(normalized.threadId);
      }
    };
  }

  async handle(request: AppServerDynamicToolRequest): Promise<AppServerDynamicToolResponse> {
    if (request.method !== "item/tool/call") throw new Error("unsupported App Server request");
    let call: RemoteWorkspaceToolCallParams;
    try {
      call = parseRemoteWorkspaceToolCall(request.params);
    } catch (error) {
      return this.response(request.id, { ok: false, error: error instanceof Error ? error.message : "invalid remote tool call" });
    }
    const binding = this.sessions.get(call.threadId);
    if (!binding) return this.response(request.id, { ok: false, error: "remote workspace thread is not bound" });
    if (!binding.tools.includes(call.tool)
      || !binding.capabilities.includes(remoteWorkspaceCapabilityForTool(call.tool))) {
      return this.response(request.id, { ok: false, error: "remote workspace tool is not supported by this executor" });
    }
    if (!this.transport.isOnline(binding.executorDeviceId)) {
      return this.response(request.id, { ok: false, error: "remote executor is offline; local fallback is disabled" });
    }
    let result: RemoteWorkspaceToolResult;
    try {
      result = await this.transport.invoke({
        requestId: randomUUID(),
        sessionId: binding.sessionId,
        executorDeviceId: binding.executorDeviceId,
        rootId: binding.rootId,
        tool: call.tool,
        arguments: call.arguments,
      });
    } catch {
      result = { ok: false, error: "remote executor transport failed; local fallback is disabled" };
    }
    return this.response(request.id, result);
  }

  private response(id: string | number, result: RemoteWorkspaceToolResult): AppServerDynamicToolResponse {
    return {
      id,
      result: {
        contentItems: [{ type: "inputText", text: resultText(result) }],
        success: result.ok,
      },
    };
  }
}
