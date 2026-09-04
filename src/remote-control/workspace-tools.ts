export const REMOTE_WORKSPACE_TOOL_NAMESPACE = "ocx_remote_workspace" as const;
export const REMOTE_WORKSPACE_MAX_TOOL_RESULT_BYTES = 256 * 1024;

export const REMOTE_WORKSPACE_CAPABILITIES = [
  "workspace.read",
  "workspace.write",
  "workspace.exec",
] as const;

export type RemoteWorkspaceCapability = typeof REMOTE_WORKSPACE_CAPABILITIES[number];

export type RemoteWorkspaceToolName =
  | "list_directory"
  | "read_file"
  | "write_file"
  | "exec";

export interface RemoteWorkspaceDynamicToolFunction {
  type: "function";
  name: RemoteWorkspaceToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RemoteWorkspaceDynamicToolNamespace {
  type: "namespace";
  name: typeof REMOTE_WORKSPACE_TOOL_NAMESPACE;
  description: string;
  tools: RemoteWorkspaceDynamicToolFunction[];
}

export interface RemoteWorkspaceToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: typeof REMOTE_WORKSPACE_TOOL_NAMESPACE;
  tool: RemoteWorkspaceToolName;
  arguments: unknown;
}

export type RemoteWorkspaceToolResult =
  | { ok: true; value?: unknown; error?: never }
  | { ok: false; error: string; value?: never };

const RELATIVE_PATH = {
  type: "string",
  minLength: 1,
  maxLength: 4096,
  description: "Path relative to the workspace root. Absolute paths and parent traversal are rejected.",
} as const;

export const REMOTE_WORKSPACE_DYNAMIC_TOOLS: readonly [RemoteWorkspaceDynamicToolNamespace] = [{
  type: "namespace",
  name: REMOTE_WORKSPACE_TOOL_NAMESPACE,
  description: "Operate only on the selected remote OpenCodex executor workspace.",
  tools: [
    {
      type: "function",
      name: "list_directory",
      description: "List one directory inside the selected remote workspace.",
      inputSchema: {
        type: "object",
        properties: { path: { ...RELATIVE_PATH, default: "." } },
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "read_file",
      description: "Read a bounded UTF-8 regular file from the selected remote workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: RELATIVE_PATH,
          maxBytes: { type: "integer", minimum: 1, maximum: REMOTE_WORKSPACE_MAX_TOOL_RESULT_BYTES },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "write_file",
      description: "Atomically replace a bounded UTF-8 file in the selected remote workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: RELATIVE_PATH,
          content: { type: "string", maxLength: REMOTE_WORKSPACE_MAX_TOOL_RESULT_BYTES },
          expectedSha256: {
            type: ["string", "null"],
            pattern: "^[0-9a-f]{64}$",
            description: "Expected current file hash, or null when the file must not already exist.",
          },
        },
        required: ["path", "content", "expectedSha256"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "exec",
      description: "Execute an argv vector in a directory inside the selected remote workspace.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "array",
            minItems: 1,
            maxItems: 64,
            items: { type: "string", minLength: 1, maxLength: 4096 },
          },
          cwd: { ...RELATIVE_PATH, default: "." },
          timeoutMs: { type: "integer", minimum: 1, maximum: 60_000 },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  ],
}];

const TOOL_CAPABILITY: Readonly<Record<RemoteWorkspaceToolName, RemoteWorkspaceCapability>> = {
  list_directory: "workspace.read",
  read_file: "workspace.read",
  write_file: "workspace.write",
  exec: "workspace.exec",
};

export function parseRemoteWorkspaceCapabilities(
  value: unknown,
  fallback: readonly RemoteWorkspaceCapability[] = ["workspace.read", "workspace.write"],
): RemoteWorkspaceCapability[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length < 1 || value.length > REMOTE_WORKSPACE_CAPABILITIES.length) {
    throw new Error("invalid remote workspace capabilities");
  }
  const result = new Set<RemoteWorkspaceCapability>();
  for (const capability of value) {
    if (!isRemoteWorkspaceCapability(capability)) {
      throw new Error("invalid remote workspace capability");
    }
    result.add(capability);
  }
  if (!result.has("workspace.read")) {
    throw new Error("remote workspace executors must support workspace.read");
  }
  return REMOTE_WORKSPACE_CAPABILITIES.filter(capability => result.has(capability));
}

export function remoteWorkspaceToolsForCapabilities(
  capabilities: readonly RemoteWorkspaceCapability[],
): RemoteWorkspaceToolName[] {
  const allowed = new Set(parseRemoteWorkspaceCapabilities(capabilities));
  return REMOTE_WORKSPACE_DYNAMIC_TOOLS[0].tools
    .filter(tool => allowed.has(TOOL_CAPABILITY[tool.name]))
    .map(tool => tool.name);
}

export function remoteWorkspaceDynamicToolsForCapabilities(
  capabilities: readonly RemoteWorkspaceCapability[],
): readonly [RemoteWorkspaceDynamicToolNamespace] {
  const names = new Set(remoteWorkspaceToolsForCapabilities(capabilities));
  return [{
    ...REMOTE_WORKSPACE_DYNAMIC_TOOLS[0],
    tools: REMOTE_WORKSPACE_DYNAMIC_TOOLS[0].tools.filter(tool => names.has(tool.name)),
  }];
}

export function remoteWorkspaceCapabilityForTool(tool: RemoteWorkspaceToolName): RemoteWorkspaceCapability {
  return TOOL_CAPABILITY[tool];
}

const TOOL_NAMES: ReadonlySet<string> = new Set(
  REMOTE_WORKSPACE_DYNAMIC_TOOLS[0].tools.map(tool => tool.name),
);

export function isRemoteWorkspaceCapability(value: unknown): value is RemoteWorkspaceCapability {
  return value === "workspace.read" || value === "workspace.write" || value === "workspace.exec";
}

export function isRemoteWorkspaceToolName(value: unknown): value is RemoteWorkspaceToolName {
  return typeof value === "string" && TOOL_NAMES.has(value);
}

function boundedIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
}

export function parseRemoteWorkspaceToolCall(value: unknown): RemoteWorkspaceToolCallParams {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid remote workspace tool call");
  }
  const raw = value as Record<string, unknown>;
  if (
    !boundedIdentifier(raw.threadId)
    || !boundedIdentifier(raw.turnId)
    || !boundedIdentifier(raw.callId)
    || raw.namespace !== REMOTE_WORKSPACE_TOOL_NAMESPACE
    || !isRemoteWorkspaceToolName(raw.tool)
  ) throw new Error("invalid remote workspace tool call identity");
  return {
    threadId: raw.threadId,
    turnId: raw.turnId,
    callId: raw.callId,
    namespace: REMOTE_WORKSPACE_TOOL_NAMESPACE,
    tool: raw.tool,
    arguments: raw.arguments,
  };
}

export function remoteWorkspaceDeveloperInstructions(
  deviceName: string,
  tools: readonly RemoteWorkspaceToolName[] = REMOTE_WORKSPACE_DYNAMIC_TOOLS[0].tools.map(tool => tool.name),
): string {
  const safeName = deviceName.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 120) || "remote executor";
  const allowed = tools.map(tool => `${REMOTE_WORKSPACE_TOOL_NAMESPACE}.${tool}`).join(", ");
  return [
    `This thread operates on the OpenCodex remote executor named ${JSON.stringify(safeName)}.`,
    `Its available remote tools are: ${allowed}. Use no other tool for filesystem or command work.`,
    "The coordinator filesystem is an empty isolation boundary and is not the user's workspace.",
    "Never use local shell, local file, or local patch tools for this thread.",
    "If a remote tool is unavailable, stop and report that the executor is offline; never fall back locally.",
  ].join(" ");
}

export function remoteWorkspaceCodexDeveloperInstructions(
  deviceName: string,
  tools: readonly RemoteWorkspaceToolName[] = REMOTE_WORKSPACE_DYNAMIC_TOOLS[0].tools.map(tool => tool.name),
): string {
  const nestedTools = tools.map(tool => `tools.mcp__${REMOTE_WORKSPACE_TOOL_NAMESPACE}__${tool}`).join(", ");
  return [
    remoteWorkspaceDeveloperInstructions(deviceName, tools),
    `Current Codex versions expose MCP through the functions.exec code-mode tool. Inside it, call only: ${nestedTools}.`,
    "Do not call exec_command, apply_patch, view_image, browser, apps, plugins, or any other nested helper on the Hub.",
  ].join(" ");
}
