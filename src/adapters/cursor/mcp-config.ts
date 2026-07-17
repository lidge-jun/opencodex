import type { OcxProviderConfig } from "../../types";

/**
 * One MCP server opencodex starts/connects and exposes to the Cursor agent as callable tools.
 * Either `command` (stdio: opencodex spawns the server as a child process) or `url`
 * (streamable-http: opencodex connects to a remote MCP server) must be set.
 */
export interface CursorMcpServerConfig {
  /** stdio: executable to spawn (e.g. "npx", "node", "uvx"). */
  command?: string;
  /** stdio: arguments for the spawned command. */
  args?: string[];
  /** stdio: extra environment variables for the child process. */
  env?: Record<string, string>;
  /** stdio: working directory for the child process. */
  cwd?: string;
  /** streamable-http: remote MCP server URL (alternative to `command`). */
  url?: string;
  /** streamable-http: extra headers for the remote connection. */
  headers?: Record<string, string>;
  /** Set false to keep the server in config but not connect. Default true. */
  enabled?: boolean;
  /** Optional namespace prepended to advertised tool names to avoid collisions. */
  toolPrefix?: string;
}

export interface ResolvedMcpServer extends CursorMcpServerConfig {
  serverName: string;
}

/**
 * Resolve the enabled, connectable MCP servers from a provider config. A server is
 * connectable only if it declares either a `command` (stdio) or a `url` (http).
 */
export function resolveMcpServers(provider: OcxProviderConfig): ResolvedMcpServer[] {
  const raw = provider.mcpServers;
  if (!raw) return [];
  const servers: ResolvedMcpServer[] = [];
  for (const [serverName, cfg] of Object.entries(raw)) {
    const server = { serverName, ...cfg };
    if (server.enabled !== false && Boolean(server.command || server.url)) {
      servers.push(server);
    }
  }
  return servers;
}
