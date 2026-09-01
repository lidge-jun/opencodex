import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { decodeWindowsTextBytes } from "./windows-text";

/**
 * Startup-time discovery of the Windows WinINET static proxy (#1525, slice 1).
 *
 * Reads `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` once and returns a
 * normalized `http://host:port` URL when a static proxy is enabled. PAC/WPAD, per-request
 * resolution, ProxyOverride, live refresh, and direct fallback are deliberately out of scope:
 * this is the piece an operator can audit from one log line, and everything else needs the
 * transport boundary the reviewer asked for first.
 */

const INTERNET_SETTINGS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

export type WindowsSystemProxyResult =
  | { kind: "proxy"; url: string }
  | { kind: "disabled" }
  | { kind: "socks-only" }
  | { kind: "unsupported" }
  | { kind: "unreadable" };

/** Raw registry values; `null` when the value is absent or the read failed. */
export interface WindowsProxyRegistryValues {
  proxyEnable: string | null;
  proxyServer: string | null;
}

export type WindowsProxyRegistryReader = () => WindowsProxyRegistryValues | null;

function registryExe(): string {
  const candidate = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
  return existsSync(candidate) ? candidate : "reg.exe";
}

function queryValue(name: string): string | null {
  try {
    const stdout = execFileSync(registryExe(), ["query", INTERNET_SETTINGS_KEY, "/v", name], {
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    const text = decodeWindowsTextBytes(stdout);
    // "    ProxyServer    REG_SZ    host:port"
    const line = text.split(/\r?\n/).find(row => row.trim().startsWith(name));
    if (!line) return null;
    const match = line.match(/REG_(?:SZ|DWORD|EXPAND_SZ)\s+(.*)$/);
    return match ? match[1]!.trim() : null;
  } catch {
    return null;
  }
}

export function readWindowsProxyRegistry(): WindowsProxyRegistryValues | null {
  const proxyEnable = queryValue("ProxyEnable");
  if (proxyEnable === null) return null;
  return { proxyEnable, proxyServer: queryValue("ProxyServer") };
}

/**
 * `ProxyServer` is either a bare `host:port` (applies to every scheme) or a semicolon list of
 * `scheme=host:port` entries. Prefer the https entry, then http; a SOCKS-only value cannot be
 * mirrored into HTTP_PROXY/HTTPS_PROXY.
 */
export function parseWindowsProxyServer(value: string): { kind: "proxy"; url: string } | { kind: "socks-only" } | { kind: "disabled" } {
  const trimmed = value.trim();
  if (!trimmed) return { kind: "disabled" };
  if (!trimmed.includes("=")) return normalize(trimmed);
  const entries = new Map<string, string>();
  for (const part of trimmed.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    entries.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
  }
  const candidate = entries.get("https") || entries.get("http");
  if (candidate) return normalize(candidate);
  if (entries.has("socks")) return { kind: "socks-only" };
  return { kind: "disabled" };
}

function normalize(hostPort: string): { kind: "proxy"; url: string } | { kind: "disabled" } {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(hostPort) ? hostPort : `http://${hostPort}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname || (url.protocol !== "http:" && url.protocol !== "https:")) return { kind: "disabled" };
    // Keep userinfo: a credentialed proxy is valid in HTTP_PROXY. Only the log strips it.
    const auth = url.username ? `${url.username}${url.password ? `:${url.password}` : ""}@` : "";
    return { kind: "proxy", url: `${url.protocol}//${auth}${url.host}` };
  } catch {
    return { kind: "disabled" };
  }
}

export function readWindowsSystemProxy(
  reader: WindowsProxyRegistryReader = readWindowsProxyRegistry,
  platform: NodeJS.Platform = process.platform,
): WindowsSystemProxyResult {
  if (platform !== "win32") return { kind: "unsupported" };
  const values = reader();
  if (!values) return { kind: "unreadable" };
  // REG_DWORD prints as 0x1 / 0x0.
  const enabled = /^(0x)?0*1$/i.test((values.proxyEnable ?? "").trim());
  if (!enabled) return { kind: "disabled" };
  if (!values.proxyServer) return { kind: "disabled" };
  return parseWindowsProxyServer(values.proxyServer);
}

/** Log-safe form: origin only, so a credentialed value can never reach the console. */
export function describeProxyForLog(url: string): string {
  try { return new URL(url).origin; } catch { return "<unparseable>"; }
}
