import { execFileSync } from "node:child_process";
import { isIP } from "node:net";

export type MacOSProxyReader = () => string | null;
type MacOSSystemProxyResult =
  | { kind: "proxy"; httpUrl?: string; httpsUrl?: string; noProxy: string[] }
  | { kind: "disabled" | "unreadable" };

function readScutilProxy(): string {
  return execFileSync("/usr/sbin/scutil", ["--proxy"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000,
    maxBuffer: 64 * 1024,
  });
}

function proxyUrl(host: string | undefined, port: string | undefined): string | undefined {
  if (!host || !port || !/^\d+$/.test(port) || +port < 1 || +port > 65535) return undefined;
  const bareHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!isIP(bareHost) && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.?$/i.test(host)) return undefined;
  try {
    const url = new URL(`http://${isIP(bareHost) === 6 ? `[${bareHost}]` : host}:${port}`);
    return url.origin;
  } catch {
    return undefined;
  }
}

/** Read only the effective top-level dictionary; scoped/supplemental proxies are not global. */
export function readMacOSSystemProxy(reader: MacOSProxyReader = readScutilProxy): MacOSSystemProxyResult {
  try {
    const output = reader();
    if (!output || !/^\s*<dictionary>\s*\{/.test(output)) return { kind: "unreadable" };
    const values = new Map<string, string>();
    const noProxy: string[] = [];
    let depth = 0;
    let exceptions = false;
    for (const row of output.split(/\r?\n/)) {
      const line = row.trim();
      if (line.endsWith("{")) {
        if (depth === 1) exceptions = /^ExceptionsList\s*:\s*<array>\s*\{$/.test(line);
        depth++;
      } else if (line === "}") {
        if (--depth < 0) return { kind: "unreadable" };
        if (depth === 1) exceptions = false;
      } else {
        const entry = line.match(/^([^:]+)\s*:\s*(.*?)\s*$/);
        if (!entry) continue;
        if (depth === 1) values.set(entry[1]!.trim(), entry[2]!);
        if (depth === 2 && exceptions && /^\d+$/.test(entry[1]!.trim())) {
          const host = entry[2]!;
          // Keep each exception one entry; never turn malformed output into additional bypasses.
          if (host && !/[\s,{}]/.test(host)) noProxy.push(host);
        }
      }
    }
    if (depth !== 0) return { kind: "unreadable" };
    const httpUrl = values.get("HTTPEnable") === "1" ? proxyUrl(values.get("HTTPProxy"), values.get("HTTPPort")) : undefined;
    const httpsUrl = values.get("HTTPSEnable") === "1" ? proxyUrl(values.get("HTTPSProxy"), values.get("HTTPSPort")) : undefined;
    return httpUrl || httpsUrl ? { kind: "proxy", httpUrl, httpsUrl, noProxy } : { kind: "disabled" };
  } catch {
    return { kind: "unreadable" };
  }
}
