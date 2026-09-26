/**
 * PAC-file support for the ChatGPT desktop send-unblock intercept.
 *
 * With `chatgptDesktop.pacFallback` on, the app is launched with
 * `--proxy-pac-url=file://<configDir>/chatgpt-unblock.pac` instead of a resolver rule. The PAC
 * sends chatgpt.com to the entry CONNECT listener (which splices onto the TLS origin listener),
 * and every other host the way the system routes it. When opencodex stops, the refused CONNECT
 * makes Chromium fall through to the system route on its own -- the app keeps working, no
 * restart -- which is the whole point of the fallback.
 *
 * The system route is captured at generation time, not hard-coded, because it depends on the
 * VPN's mode at the time:
 *  - system proxy mode: the HTTPS / HTTP / SOCKS proxies from `scutil --proxy`, then DIRECT;
 *  - PAC mode: the system PAC script itself, embedded so its per-host rules keep applying;
 *  - TUN mode / no VPN: no system proxy, so DIRECT and Chromium resolves and dials on its own.
 */

import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { fileURLToPath } from "node:url";
import { CHATGPT_INTERCEPT_HOST } from "./listener";

export const CHATGPT_UNBLOCK_PAC_FILENAME = "chatgpt-unblock.pac";

/** gfwlist-style PACs run to a few hundred KiB; anything this large is not a PAC script. */
const MAX_SYSTEM_PAC_BYTES = 4 * 1024 * 1024;
const SYSTEM_PAC_TIMEOUT_MS = 3_000;

export interface SystemProxyChain {
  /** e.g. "PROXY 127.0.0.1:7892; SOCKS5 127.0.0.1:7892" -- no trailing DIRECT. */
  entries: string[];
  /** True when a PAC file is configured system-wide. */
  autoConfig: boolean;
  /** The system PAC's URL when `autoConfig` is on and one is set. */
  autoConfigUrl: string | null;
}

interface ScutilValue {
  get(key: string): string | null;
}

export function parseScutilOutput(output: string): ScutilValue {
  const map = new Map<string, string>();
  for (const line of output.split("\n")) {
    // `scutil --proxy` prints `Key : value` inside its dictionary; accept `=` too.
    const match = /^\s*(\S+)\s*[:=]\s*(.*?)\s*$/.exec(line);
    if (match) map.set(match[1]!, match[2]!);
  }
  return { get: key => map.get(key) ?? null };
}

function runScutil(): ScutilValue | null {
  try {
    return parseScutilOutput(execFileSync("scutil", ["--proxy"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return null;
  }
}

/**
 * The system proxy as Chromium sees it in a PAC: HTTPS proxy first (browser traffic is
 * HTTPS), then HTTP, then SOCKS, each once.
 */
export function systemProxyChain(scutil: ScutilValue | null = runScutil()): SystemProxyChain {
  if (!scutil) return { entries: [], autoConfig: false, autoConfigUrl: null };
  const autoConfig = scutil.get("ProxyAutoConfigEnable") === "1";
  const url = scutil.get("ProxyAutoConfigURLString");
  const entries = new Set<string>();
  const push = (kind: "PROXY" | "SOCKS5", enabled: string | null, host: string | null, port: string | null) => {
    if (enabled === "1" && host && port && host !== "(null)") entries.add(`${kind} ${host}:${port}`);
  };
  push("PROXY", scutil.get("HTTPSEnable"), scutil.get("HTTPSProxy"), scutil.get("HTTPSPort"));
  push("PROXY", scutil.get("HTTPEnable"), scutil.get("HTTPProxy"), scutil.get("HTTPPort"));
  push("SOCKS5", scutil.get("SOCKSEnable"), scutil.get("SOCKSProxy"), scutil.get("SOCKSPort"));
  return { entries: [...entries], autoConfig, autoConfigUrl: autoConfig && url && url !== "(null)" ? url : null };
}

function fetchPacText(url: URL): Promise<string | null> {
  // node:http, not fetch: Bun's fetch honours HTTP(S)_PROXY even for loopback, and a local PAC
  // server (the usual VPN-client setup) must be reached directly, the way Chromium reaches it.
  const get = url.protocol === "https:" ? httpsGet : httpGet;
  return new Promise(resolve => {
    const request = get(url, { timeout: SYSTEM_PAC_TIMEOUT_MS }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        resolve(null);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_SYSTEM_PAC_BYTES) {
          request.destroy();
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      response.on("error", () => resolve(null));
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(null));
  });
}

/**
 * The system PAC script's text: file:// from disk, http(s):// fetched directly. Null when it
 * cannot be read, is empty, is implausibly large, or defines no `FindProxyForURL`.
 */
export async function loadSystemPac(rawUrl: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  let text: string | null = null;
  try {
    if (url.protocol === "file:") {
      const path = fileURLToPath(url);
      if ((await stat(path)).size <= MAX_SYSTEM_PAC_BYTES) text = await readFile(path, "utf8");
    } else if (url.protocol === "http:" || url.protocol === "https:") {
      text = await fetchPacText(url);
    }
  } catch {
    return null;
  }
  return text && /\bFindProxyForURL\b/.test(text) ? text : null;
}

/**
 * The PAC script. For the intercepted host: the entry listener first (the intercept), then the
 * system route (the fallback). For every other host: the system route, so login, telemetry and
 * subdomains behave as they would without the feature.
 *
 * With a system PAC, its script is embedded inside a function scope: its own
 * `FindProxyForURL` stays reachable as a local, and the final assignment makes the wrapper the
 * global Chromium calls, however the embedded script declared its entry point.
 */
export function buildChatgptUnblockPac(entryPort: number, chain: SystemProxyChain, systemPac: string | null = null): string {
  const header = `// Generated by opencodex for the ChatGPT desktop send-unblock fallback.
// Rewritten at every opencodex start; the ChatGPT app must be relaunched to pick up changes.
`;
  if (systemPac) {
    return `${header}// The system PAC below is embedded unchanged so every other host keeps its routing.
var __ocxSystemFindProxyForURL = (function () {
${systemPac}
;return FindProxyForURL;
})();
var FindProxyForURL = function (url, host) {
  var system = __ocxSystemFindProxyForURL(url, host) || "DIRECT";
  if (host == "${CHATGPT_INTERCEPT_HOST}") return "PROXY 127.0.0.1:${entryPort}; " + system;
  return system;
};
`;
  }
  const chainText = [...chain.entries, "DIRECT"].join("; ");
  return `${header}function FindProxyForURL(url, host) {
  if (host == "${CHATGPT_INTERCEPT_HOST}") return "PROXY 127.0.0.1:${entryPort}; ${chainText}";
  return "${chainText}";
}
`;
}
