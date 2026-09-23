import type { Server } from "bun";
import type { OcxConfig } from "../../types";
import { getConfigDir } from "../../config/paths";
import { CLAUDE_INTERCEPT_HOSTS, startConnectProxy, type ConnectProxyHandle } from "./connect-proxy";
import { startClaudeInterceptListener } from "./listener";
import { claudeInterceptCaCertPath, ensureLocalInterceptCaForStartup, issueLocalInterceptLeaf } from "./local-ca";

/**
 * Lifecycle for the Claude intercept pair (CONNECT proxy + TLS listener).
 *
 * Started next to the public listener, torn down with it. The proxy port is derived from the
 * public port unless configured, because Claude Code's `settings.json` must name a port that
 * survives restarts; the TLS listener is ephemeral and only ever reached through the proxy.
 */

export const CLAUDE_INTERCEPT_PORT_OFFSET = 100;

export function claudeInterceptEnabled(config: Pick<OcxConfig, "claudeCode" | "runtimeRole">): boolean {
  if (config.runtimeRole === "client") return false;
  if (config.claudeCode?.enabled === false) return false;
  return config.claudeCode?.intercept?.enabled !== false;
}

export function claudeInterceptProxyPort(config: Pick<OcxConfig, "claudeCode">, publicPort: number): number {
  const configured = config.claudeCode?.intercept?.port;
  if (typeof configured === "number" && Number.isInteger(configured) && configured >= 1 && configured <= 65535) return configured;
  return publicPort + CLAUDE_INTERCEPT_PORT_OFFSET;
}

export interface ClaudeInterceptState {
  proxyPort: number;
  caCertPath: string;
}

export interface ClaudeInterceptHandle<T = undefined> extends ClaudeInterceptState {
  listener: Server<T>;
  stop(): Promise<void>;
}

let activeState: ClaudeInterceptState | null = null;

/** Live intercept endpoints, or `null` when the pair is not running in this process. */
export function getClaudeInterceptState(): ClaudeInterceptState | null {
  return activeState;
}

export interface StartClaudeInterceptOptions<T> {
  config: OcxConfig;
  /** Bound public port; the derived proxy port is offset from it. */
  publicPort: number;
  /**
   * Port the operator asked for. `0` (ephemeral) gives the derived proxy port no stable value
   * to write into `settings.json`, so intercept stays off unless `intercept.port` is explicit.
   */
  requestedPort?: number;
  dispatch: (req: Request, server: Server<T>) => Promise<Response>;
  maxRequestBodySize?: number;
  configDir?: string;
}

/**
 * Bind both halves. Resolves `null` when intercept is disabled. A bind failure is reported by
 * rejecting; callers treat it as a degraded optional integration, never as a startup failure.
 */
export async function startClaudeIntercept<T>(options: StartClaudeInterceptOptions<T>): Promise<ClaudeInterceptHandle<T> | null> {
  if (!claudeInterceptEnabled(options.config)) return null;
  const explicitPort = typeof options.config.claudeCode?.intercept?.port === "number";
  if (options.requestedPort === 0 && !explicitPort) return null;
  const configDir = options.configDir ?? getConfigDir();
  const ca = await ensureLocalInterceptCaForStartup(configDir);
  const leaf = issueLocalInterceptLeaf(ca, CLAUDE_INTERCEPT_HOSTS);
  const listener = startClaudeInterceptListener<T>({
    leaf,
    dispatch: options.dispatch,
    upstreamBase: options.config.claudeCode?.anthropicBaseUrl,
    ...(options.maxRequestBodySize !== undefined ? { maxRequestBodySize: options.maxRequestBodySize } : {}),
  });
  let proxy: ConnectProxyHandle;
  try {
    proxy = await startConnectProxy(claudeInterceptProxyPort(options.config, options.publicPort), {
      interceptPort: listener.port!,
    });
  } catch (error) {
    await listener.stop(true);
    throw error;
  }
  const state: ClaudeInterceptState = { proxyPort: proxy.port, caCertPath: claudeInterceptCaCertPath(configDir) };
  activeState = state;
  return {
    ...state,
    listener,
    stop: async () => {
      if (activeState === state) activeState = null;
      await proxy.close();
      await listener.stop(true);
    },
  };
}
