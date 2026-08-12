export interface McpStubTool {
  namespace: string;
  name: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpStubCall {
  namespace: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface McpStubResult {
  content: Array<{ type: "text"; text: string }>;
}

const tools = new Map<string, McpStubTool>();
const invocations: McpStubCall[] = [];

function toolKey(namespace: string, name: string): string {
  return `${namespace}::${name}`;
}

/** Register a lab-owned MCP stub tool (in-memory only). */
export function registerMcpStubTool(tool: McpStubTool): void {
  tools.set(toolKey(tool.namespace, tool.name), { ...tool });
}

export function clearMcpStub(): void {
  tools.clear();
  invocations.length = 0;
}

export function listMcpStubTools(): McpStubTool[] {
  return [...tools.values()];
}

/** Invoke the in-memory MCP stub with fixed pure results. */
export function invokeMcpStub(
  namespace: string,
  name: string,
  args: Record<string, unknown>,
  result: McpStubResult,
): McpStubResult {
  const key = toolKey(namespace, name);
  if (!tools.has(key)) throw new Error(`MCP stub tool not registered: ${namespace}/${name}`);
  invocations.push({ namespace, name, arguments: { ...args } });
  return result;
}

export function mcpStubInvocations(): readonly McpStubCall[] {
  return invocations;
}

export function wireName(namespace: string, name: string): string {
  return `mcp__${namespace}__${name}`;
}
