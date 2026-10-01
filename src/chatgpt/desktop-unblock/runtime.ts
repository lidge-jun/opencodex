import type { Server } from "bun";
import type { OcxConfig } from "../../types";
import { getConfigDir } from "../../config/paths";
import {
  claudeInterceptCaCertPath,
  ensureLocalInterceptCaForStartup,
  issueLocalInterceptLeaf,
} from "../../claude/intercept/local-ca";
import { CHATGPT_INTERCEPT_HOST, startChatgptUnblockListener } from "./listener";
import { startChatgptUnblockEntryProxy } from "./entry-proxy";
import type { EntryProxyHandle } from "./entry-proxy";
import { CHATGPT_UNBLOCK_PAC_FILENAME, buildChatgptUnblockPac, loadSystemPac, systemProxyChain } from "./pac";
import type { SystemProxyChain } from "./pac";
import type { WsRelaySocketData } from "./ws-relay";
import { join } from "node:path";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CHATGPT_APP_CODEX_BINARY } from "./app-server-shim";

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

/** The CONNECT entry listener sits right after the TLS origin listener. */
export const CHATGPT_UNBLOCK_ENTRY_PORT_OFFSET = 1;

export function chatgptUnblockEnabled(config: Pick<OcxConfig, "chatgptDesktop" | "runtimeRole">): boolean {
  if (config.runtimeRole === "client") return false;
  return config.chatgptDesktop?.unblockSend === true;
}

/**
 * Whether the app-server shim is on. It covers builds where the composer's send gate comes from
 * the bundled app-server rather than the Chromium network stack, so it is opt-in and additive to
 * whichever launch mode is configured.
 */
export function chatgptAppServerShimEnabled(config: Pick<OcxConfig, "chatgptDesktop" | "runtimeRole">): boolean {
  return chatgptUnblockEnabled(config) && config.chatgptDesktop?.appServerShim === true;
}

/** Whether the PAC-fallback launch mode is on (it implies `unblockSend`). */
export function chatgptPacFallbackEnabled(config: Pick<OcxConfig, "chatgptDesktop" | "runtimeRole">): boolean {
  return chatgptUnblockEnabled(config) && config.chatgptDesktop?.pacFallback === true;
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
 * The CONNECT entry listener's port: one after the origin listener, wrapped inside the TCP
 * range the same way Desktop's picker proxy derives its neighbour port.
 */
export function chatgptUnblockEntryPort(config: Pick<OcxConfig, "chatgptDesktop">, publicPort: number): number {
  const origin = chatgptUnblockPort(config, publicPort);
  return origin < 65535 ? origin + CHATGPT_UNBLOCK_ENTRY_PORT_OFFSET : origin - CHATGPT_UNBLOCK_ENTRY_PORT_OFFSET;
}

/** The PAC file lives beside the rest of the opencodex state; the app reads it at launch. */
export function chatgptUnblockPacPath(configDir: string): string {
  return join(configDir, CHATGPT_UNBLOCK_PAC_FILENAME);
}

/**
 * The PAC switch's fixed prefix. The script travels INLINE as a `data:` URL: on the ChatGPT
 * desktop app (Chromium 154) a `--proxy-pac-url=file://...` switch is ignored -- the app then
 * dials every host directly, bypassing both the intercept and the user's VPN chain -- and an
 * `http://` PAC would need opencodex alive to be fetched, defeating the fallback. A `data:` PAC
 * needs neither, and keeps working while opencodex is stopped.
 */
export const CHATGPT_UNBLOCK_PAC_ARG_PREFIX = "--proxy-pac-url=data:application/x-ns-proxy-autoconfig;base64,";

/** The PAC switch for a given script text. */
export function chatgptUnblockPacArgFor(pacText: string | Uint8Array): string {
  return `${CHATGPT_UNBLOCK_PAC_ARG_PREFIX}${Buffer.from(pacText).toString("base64")}`;
}

/**
 * The PAC as the app's command-line switch, from the file opencodex wrote at start. When the file
 * is not there yet the bare prefix comes back, which matches no real command line.
 */
export function chatgptUnblockPacArg(configDir: string): string {
  try {
    return chatgptUnblockPacArgFor(readFileSync(chatgptUnblockPacPath(configDir)));
  } catch {
    return CHATGPT_UNBLOCK_PAC_ARG_PREFIX;
  }
}

export const CHATGPT_UNBLOCK_SHIM_FILENAME = "chatgpt-codex-shim.sh";

/** The launcher script the app is pointed at through `CODEX_CLI_PATH`. */
export function chatgptUnblockShimPath(configDir: string): string {
  return join(configDir, CHATGPT_UNBLOCK_SHIM_FILENAME);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The launcher the desktop app runs in place of the bundled `codex`. It `exec`s the real binary,
 * so the app-server keeps the pid, parent and code-signing identity the app expects (the app
 * rejects its app-tools pipe for any other peer), and only redirects the server's stdout into the
 * filter. It fails open at startup: the filter is first run once on empty input, and when that
 * fails (its runtime or source is gone, or the source no longer loads) the launcher executes the
 * real binary with its stdout untouched. Once the probe has passed there is no fallback.
 */
export function buildChatgptShimLauncher(bun: string, shimEntry: string, real: string = CHATGPT_APP_CODEX_BINARY): string {
  return `#!/bin/bash
# opencodex: runs the ChatGPT app-server with its stdout passed through the send-unblock filter.
REAL=${shellQuote(real)}
BUN=${shellQuote(bun)}
SHIM=${shellQuote(shimEntry)}
if [ -x "$BUN" ] && [ -f "$SHIM" ] && "$BUN" "$SHIM" </dev/null >/dev/null 2>&1; then
  exec "$REAL" "$@" > >(exec "$BUN" "$SHIM")
fi
exec "$REAL" "$@"
`;
}

/** Write the launcher next to the PAC file. Returns its path. */
export function writeChatgptShimLauncher(configDir: string): string {
  const path = chatgptUnblockShimPath(configDir);
  writeFileSync(path, buildChatgptShimLauncher(process.execPath, fileURLToPath(new URL("./app-server-shim.ts", import.meta.url))), { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

export interface ChatgptUnblockState {
  port: number;
  caCertPath: string;
  /** Set in PAC-fallback mode: the CONNECT entry listener the PAC points chatgpt.com at. */
  entryProxy?: EntryProxyHandle;
  /** PAC mode: how the generated file routes every host other than the intercepted one. */
  pacRoute?: ChatgptUnblockPacRoute;
}

export interface ChatgptUnblockHandle<T = undefined> extends ChatgptUnblockState {
  listener: Server<WsRelaySocketData>;
  stop(): Promise<void>;
}

/**
 * `system-proxy`: the scutil proxies (or DIRECT in TUN mode); `system-pac`: the system PAC,
 * embedded; `system-pac-unreadable`: a system PAC is set but could not be read, so the scutil
 * proxies then DIRECT; `system-pac-too-large`: the same fallback, because embedding the system
 * PAC would make the launch switch too long to pass to the app.
 */
export type ChatgptUnblockPacRoute = "system-proxy" | "system-pac" | "system-pac-unreadable" | "system-pac-too-large";

/**
 * The longest PAC switch handed to the app. The switch carries the script inline as base64, and
 * macOS limits one exec's arguments plus environment to 1 MiB (`ARG_MAX`): past that `open`
 * fails with E2BIG after the watcher has already quit the app. Half the limit leaves room for the
 * environment and the other switches.
 */
export const CHATGPT_UNBLOCK_PAC_SWITCH_MAX_BYTES = 512 * 1024;

/**
 * The PAC script to write and the route it encodes. A system PAC is embedded only while the
 * resulting switch fits {@link CHATGPT_UNBLOCK_PAC_SWITCH_MAX_BYTES}.
 */
export function chooseChatgptUnblockPac(
  entryPort: number,
  chain: SystemProxyChain,
  systemPac: string | null,
  maxSwitchBytes: number = CHATGPT_UNBLOCK_PAC_SWITCH_MAX_BYTES,
): { text: string; route: ChatgptUnblockPacRoute } {
  if (systemPac) {
    const text = buildChatgptUnblockPac(entryPort, chain, systemPac);
    if (chatgptUnblockPacArgFor(text).length <= maxSwitchBytes) return { text, route: "system-pac" };
    return { text: buildChatgptUnblockPac(entryPort, chain, null), route: "system-pac-too-large" };
  }
  return { text: buildChatgptUnblockPac(entryPort, chain, null), route: chain.autoConfig ? "system-pac-unreadable" : "system-proxy" };
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
  const configDir = options.configDir ?? getConfigDir();
  const ca = await ensureLocalInterceptCaForStartup(configDir);
  const leaf = issueLocalInterceptLeaf(ca, [CHATGPT_INTERCEPT_HOST]);
  // The port must be the configured one, not ephemeral: the launcher's launch arguments name it.
  const port = chatgptUnblockPort(options.config, options.publicPort);
  const listener = startChatgptUnblockListener({ leaf, port });
  let entryProxy: EntryProxyHandle | undefined;
  let pacRoute: ChatgptUnblockPacRoute | undefined;
  if (chatgptPacFallbackEnabled(options.config)) {
    try {
      // The PAC names this port; it must be the derived entry port, not ephemeral, and it
      // must be bound before the app ever reads the file.
      entryProxy = await startChatgptUnblockEntryProxy({ originPort: listener.port ?? port, port: chatgptUnblockEntryPort(options.config, options.publicPort) });
      // Regenerated at every start: the entry port and the captured system route (the
      // user's VPN state) are what the file encodes. A stale file after a config or
      // network change would point the app at a dead chain.
      const chain = systemProxyChain();
      const systemPac = chain.autoConfigUrl ? await loadSystemPac(chain.autoConfigUrl) : null;
      const pac = chooseChatgptUnblockPac(entryProxy.port, chain, systemPac);
      pacRoute = pac.route;
      writeFileSync(chatgptUnblockPacPath(configDir), pac.text, { mode: 0o644 });
    } catch (error) {
      await entryProxy?.stop();
      await listener.stop(true);
      throw error;
    }
  }
  if (chatgptAppServerShimEnabled(options.config)) {
    try {
      writeChatgptShimLauncher(configDir);
    } catch (error) {
      await entryProxy?.stop();
      await listener.stop(true);
      throw error;
    }
  }
  return {
    port,
    caCertPath: claudeInterceptCaCertPath(configDir),
    ...(entryProxy ? { entryProxy } : {}),
    ...(pacRoute ? { pacRoute } : {}),
    listener,
    stop: async () => {
      await entryProxy?.stop();
      await listener.stop(true);
    },
  };
}
