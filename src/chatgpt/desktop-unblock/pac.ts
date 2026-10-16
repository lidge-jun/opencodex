/**
 * PAC-file support for the ChatGPT desktop send-unblock intercept.
 *
 * With `chatgptDesktop.pacFallback` on, the app is launched with
 * an inline `--proxy-pac-url=data:` switch (the generated script, base64) instead of a resolver rule. The PAC
 * sends chatgpt.com to the entry CONNECT listener (which splices onto the TLS origin listener),
 * and every other host the way the system routes it. When opencodex stops, the refused CONNECT
 * makes Chromium fall through to the system route on its own -- the app keeps working, no
 * restart -- which is the whole point of the fallback.
 *
 * The system route is captured at generation time, not hard-coded, because it depends on the
 * VPN's mode at the time:
 *  - system proxy mode: only the HTTPS / HTTP / SOCKS proxies from `scutil --proxy`;
 *  - PAC mode: the system PAC script itself, embedded so its per-host rules keep applying;
 *  - TUN mode / no VPN: no system proxy, so DIRECT and Chromium resolves and dials on its own.
 */

import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { get as httpGet, type ClientRequest } from "node:http";
import { get as httpsGet } from "node:https";
import { isIP } from "node:net";
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
    const output = execFileSync("scutil", ["--proxy"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: SYSTEM_PAC_TIMEOUT_MS });
    return /^\s*<dictionary>\s*\{[\s\S]*\}\s*$/.test(output) ? parseScutilOutput(output) : null;
  } catch {
    return null;
  }
}

/**
 * The system proxy as Chromium sees it in a PAC: HTTPS proxy first (browser traffic is
 * HTTPS), then HTTP, then SOCKS, each once.
 */
export function systemProxyChain(scutil: ScutilValue | null = runScutil()): SystemProxyChain {
  if (!scutil) throw new Error("Cannot read the system proxy configuration; refusing to create a direct fallback.");
  for (const key of ["HTTPSEnable", "HTTPEnable", "SOCKSEnable", "ProxyAutoConfigEnable", "ProxyAutoDiscoveryEnable"]) {
    const value = scutil.get(key);
    if (value !== null && value !== "0" && value !== "1") throw new Error("The system proxy configuration is malformed; refusing to replace its route.");
  }
  if (scutil.get("ProxyAutoDiscoveryEnable") === "1") throw new Error("Automatic proxy discovery cannot be captured safely; refusing to replace its route.");
  const autoConfig = scutil.get("ProxyAutoConfigEnable") === "1";
  const url = scutil.get("ProxyAutoConfigURLString");
  const entries = new Set<string>();
  const push = (kind: "PROXY" | "SOCKS5", enabled: string | null, host: string | null, port: string | null) => {
    if (enabled !== "1") return;
    if (!host || host === "(null)" || !port || !/^\d+$/.test(port) || +port < 1 || +port > 65535) {
      throw new Error("An enabled system proxy has an invalid address; refusing to create a direct fallback.");
    }
    const address = isIP(host) === 6 ? `[${host}]` : host;
    let endpoint: URL;
    try { endpoint = new URL(`http://${address}:${port}`); } catch {
      throw new Error("An enabled system proxy has an invalid address; refusing to create a direct fallback.");
    }
    const hostname = endpoint.hostname;
    const validHostname = isIP(hostname.replace(/^\[|\]$/g, "")) !== 0
      || (hostname.length <= 254 && hostname.replace(/\.$/, "").split(".")
        .every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)));
    if (endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash
      || /[\s;/?#@\\]/.test(host) || !validHostname) {
      throw new Error("An enabled system proxy has an invalid address; refusing to create a direct fallback.");
    }
    entries.add(`${kind} ${hostname}:${+port}`);
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
    let request: ClientRequest | undefined;
    let settled = false;
    const finish = (text: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (text === null) request?.destroy();
      resolve(text);
    };
    // A socket inactivity timeout alone lets a slow stream keep startup pending indefinitely.
    const deadline = setTimeout(() => finish(null), SYSTEM_PAC_TIMEOUT_MS);
    try {
      request = get(url, { timeout: SYSTEM_PAC_TIMEOUT_MS }, response => {
        if (response.statusCode !== 200) { finish(null); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          if (settled) return;
          size += chunk.length;
          if (size > MAX_SYSTEM_PAC_BYTES) { finish(null); return; }
          chunks.push(chunk);
        });
        response.on("end", () => { if (!settled) finish(Buffer.concat(chunks).toString("utf8")); });
        response.on("error", () => finish(null));
        response.on("aborted", () => finish(null));
      });
      request.on("timeout", () => finish(null));
      request.on("error", () => finish(null));
    } catch { finish(null); }
  });
}

async function readPacText(path: string): Promise<string | null> {
  // Keep symlinked PACs working, but do not block opening a FIFO before the regular-file check.
  const file = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_SYSTEM_PAC_BYTES) return null;
    // Read through one descriptor, with an extra byte to detect growth after stat without truncation.
    const bytes = Buffer.alloc(MAX_SYSTEM_PAC_BYTES + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await file.read(bytes, used, Math.min(64 * 1024, bytes.length - used), null);
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    return used > MAX_SYSTEM_PAC_BYTES ? null : bytes.subarray(0, used).toString("utf8");
  } finally { await file.close(); }
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
      text = await readPacText(fileURLToPath(url));
    } else if (url.protocol === "http:" || url.protocol === "https:") {
      text = await fetchPacText(url);
    }
  } catch {
    return null;
  }
  return text && Buffer.byteLength(text) <= MAX_SYSTEM_PAC_BYTES && /\bFindProxyForURL\b/.test(text) ? text : null;
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
  if (chain.autoConfig) throw new Error("The configured system PAC could not be read; refusing to replace its route.");
  const chainText = chain.entries.length ? chain.entries.join("; ") : "DIRECT";
  return `${header}function FindProxyForURL(url, host) {
  if (host == "${CHATGPT_INTERCEPT_HOST}") return ${JSON.stringify(`PROXY 127.0.0.1:${entryPort}; ${chainText}`)};
  return ${JSON.stringify(chainText)};
}
`;
}
