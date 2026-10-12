import { readFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface CodingAgentMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Advertise client tools without executing them: only Codex/client may execute a call. */
export async function serveCodingAgentMcpTools(tools: CodingAgentMcpTool[], serverName: string): Promise<void> {
  const exitOnStdinClose = (): void => process.exit(0);
  process.stdin.on("end", exitOnStdinClose);
  process.stdin.on("close", exitOnStdinClose);

  const names = new Set(tools.map(tool => tool.name));
  const server = new Server({ name: serverName, version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    if (!names.has(request.params.name)) throw new Error("unknown isolated tool");
    return new Promise<never>(() => {});
  });
  await server.connect(new StdioServerTransport());
}

export async function runCodingAgentMcpServer(catalogPath: string): Promise<void> {
  const tools = JSON.parse(await readFile(catalogPath, "utf8")) as CodingAgentMcpTool[];
  await serveCodingAgentMcpTools(tools, "opencodex-coding-agent-tools");
}

if (import.meta.main) await runCodingAgentMcpServer(process.argv[2] ?? "");
