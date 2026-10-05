import type { Server } from "bun";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OcxConfig } from "../../types";
import { getConfigDir } from "../../config/paths";
import {
  claudeInterceptCaCertPath,
  ensureLocalInterceptCaForStartup,
  issueLocalInterceptLeaf,
} from "../../claude/intercept/local-ca";
import { CHATGPT_INTERCEPT_HOST, startChatgptUnblockListener } from "./listener";
import type { WsRelaySocketData } from "./ws-relay";

/**
 * Lifecycle for the ChatGPT desktop send-unblock listener.
 *
 * Opt-in via `chatgptDesktop.unblockSend`. The listener shares the Claude intercept authority
 * (one trusted certificate covers both features) and binds a stable loopback port derived from
 * the public port so the launcher's `--host-resolver-rules` value survives restarts. A bind
 * failure degrades to a warning exactly like the Claude intercept pair: the proxy's other
 * duties never depend on this listener existing.
 */

export const CHATGPT_UNBLOCK_PORT_OFFSET = 200;

export function chatgptUnblockEnabled(config: Pick<OcxConfig, "chatgptDesktop" | "runtimeRole">): boolean {
  if (process.platform !== "darwin" || config.runtimeRole === "client") return false;
  return config.chatgptDesktop?.unblockSend === true;
}

/**
 * The listener port: `chatgptDesktop.port` when valid, else the public port plus the offset.
 * Throws when the derived port would leave the TCP range (a public port of 65336 or more);
 * callers report that as the optional integration being unavailable.
 */
export function chatgptUnblockPort(config: Pick<OcxConfig, "chatgptDesktop">, publicPort: number): number {
  const configured = config.chatgptDesktop?.port;
  if (typeof configured === "number" && Number.isInteger(configured) && configured >= 1 && configured <= 65535) return configured;
  const derived = publicPort + CHATGPT_UNBLOCK_PORT_OFFSET;
  if (derived > 65535) {
    throw new Error(
      `the default ChatGPT unblock port (${publicPort} + ${CHATGPT_UNBLOCK_PORT_OFFSET} = ${derived}) is out of range; set chatgptDesktop.port to a free port`,
    );
  }
  return derived;
}

/** The resolver rule to hand the ChatGPT desktop app at launch. */
export function chatgptUnblockResolverRule(port: number): string {
  return `MAP ${CHATGPT_INTERCEPT_HOST} 127.0.0.1:${port}`;
}

/**
 * The rule as the app's command-line switch. Chromium silently ignores a bare rule passed as
 * a positional argument, so every launch path must pass this form.
 */
export function chatgptUnblockResolverArg(port: number): string {
  return `--host-resolver-rules=${chatgptUnblockResolverRule(port)}`;
}

/**
 * Rewritten once the listener is up. The launch watcher wakes on it as well as on the app's own
 * launch, so an app that started before opencodex (both opened at login) is still routed.
 */
export const CHATGPT_UNBLOCK_READY_FILENAME = "chatgpt-unblock.ready";

export function chatgptUnblockReadyPath(configDir: string): string {
  return join(configDir, CHATGPT_UNBLOCK_READY_FILENAME);
}


export interface ChatgptUnblockState {
  port: number;
  caCertPath: string;
}

export interface ChatgptUnblockHandle<T = undefined> extends ChatgptUnblockState {
  listener: Server<WsRelaySocketData>;
  stop(): Promise<void>;
}

export interface StartChatgptUnblockOptions {
  config: OcxConfig;
  /** Bound public port; the derived listener port is offset from it. */
  publicPort: number;
  configDir?: string;
}

/**
 * Bind the listener. Resolves `null` when the feature is disabled. A bind failure is reported
 * by rejecting; callers treat it as a degraded optional integration, never a startup failure.
 */
export async function startChatgptUnblock<T = undefined>(options: StartChatgptUnblockOptions): Promise<ChatgptUnblockHandle<T> | null> {
  if (!chatgptUnblockEnabled(options.config)) return null;
  const port = chatgptUnblockPort(options.config, options.publicPort);
  const configDir = options.configDir ?? getConfigDir();
  const ca = await ensureLocalInterceptCaForStartup(configDir);
  const leaf = issueLocalInterceptLeaf(ca, [CHATGPT_INTERCEPT_HOST]);
  // The port must be the configured one, not ephemeral: the launcher's launch arguments name it.
  const listener = startChatgptUnblockListener({ leaf, port });
  // Best effort: without the marker the watcher still acts on the app's next launch.
  try {
    writeFileSync(chatgptUnblockReadyPath(configDir), `${port} ${new Date().toISOString()}\n`, { mode: 0o644 });
  } catch {
    // An unwritable config dir already failed the CA write; nothing to add here.
  }
  return {
    port,
    caCertPath: claudeInterceptCaCertPath(configDir),
    listener,
    stop: async () => {
      await listener.stop(true);
    },
  };
}
