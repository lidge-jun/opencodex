/**
 * Soft SIGTERM-before-/F is NOT available on Windows (process.kill is TerminateProcess).
 * Graceful drain is stopProxyGracefully(); this module only resets leftover TCBs after hard kill.
 */
import { dlopen, ptr, type Pointer } from "bun:ffi";
import { execFileSync } from "node:child_process";

export type TcpQuad = {
  localAddr: string;
  localPort: number;
  remoteAddr: string;
  remotePort: number;
  state: string;
};

/** Parse netstat -ano rows whose local address uses `port`. Exported for tests. */
export function parseTcpQuadsForLocalPort(output: string, port: number): TcpQuad[] {
  const rows: TcpQuad[] = [];
  const portSuffix = `:${port}`;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^TCP\b/i.test(line)) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const local = parts[1]!;
    const remote = parts[2]!;
    const state = parts[3]!;
    if (!local.endsWith(portSuffix) && !local.endsWith(`]:${port}`)) continue;
    const localAddr = stripPort(local, port);
    const remoteParsed = splitHostPort(remote);
    if (!localAddr || !remoteParsed) continue;
    rows.push({
      localAddr,
      localPort: port,
      remoteAddr: remoteParsed.host,
      remotePort: remoteParsed.port,
      state,
    });
  }
  return rows;
}

function stripPort(addr: string, port: number): string | null {
  const suffix = `:${port}`;
  if (addr.endsWith(suffix)) return addr.slice(0, -suffix.length).replace(/^\[|\]$/g, "") || "0.0.0.0";
  return null;
}

function splitHostPort(addr: string): { host: string; port: number } | null {
  if (addr === "0.0.0.0:0" || addr === "*:*" || addr === "[::]:0") {
    return { host: "0.0.0.0", port: 0 };
  }
  const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(addr);
  if (!m) return null;
  return { host: (m[1] ?? m[2] ?? "0.0.0.0").replace(/^::ffff:/i, ""), port: Number(m[3]) };
}

function ipv4ToWinUint32(addr: string): number | null {
  const host = addr.replace(/^::ffff:/i, "");
  // Refuse bare IPv6 — SetTcpEntry is IPv4-only; coercing "::"/"::1" to 0 would
  // miss the real TCB and can hit an unrelated IPv4 wildcard row.
  if (isBareIpv6Address(host)) return null;
  if (host === "0.0.0.0" || host === "*") return 0;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return (parts[0]! | (parts[1]! << 8) | (parts[2]! << 16) | (parts[3]! << 24)) >>> 0;
}

/** True for bare IPv6 (including :: / ::1), false for dotted IPv4 and IPv4-mapped. */
export function isBareIpv6Address(addr: string): boolean {
  const host = String(addr || "").replace(/^\[|\]$/g, "").replace(/^::ffff:/i, "");
  if (!host) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  return host.includes(":");
}

export type WindowsTcpDropResult = {
  /** Successful SetTcpEntry(DELETE_TCB) calls for IPv4 rows. */
  dropped: number;
  /** IPv6 (or unparseable) rows skipped — never coerced into IPv4 wildcards. */
  skippedIpv6: number;
  /**
   * SetTcpEntry returned ERROR_ACCESS_DENIED (5) or the UAC-non-elevated code (317).
   * On a normal (non-admin) update worker this is expected — ghost LISTEN rows must
   * clear by waiting for the OS, not by SetTcpEntry.
   */
  accessDenied: number;
};

function htons(port: number): number {
  return (((port & 0xff) << 8) | ((port >> 8) & 0xff)) >>> 0;
}

type SetTcpEntryFn = (row: Pointer) => number;
let setTcpEntryFn: SetTcpEntryFn | null | undefined;

function loadSetTcpEntry(): SetTcpEntryFn | null {
  if (setTcpEntryFn !== undefined) return setTcpEntryFn;
  if (process.platform !== "win32") {
    setTcpEntryFn = null;
    return null;
  }
  try {
    const lib = dlopen("iphlpapi.dll", {
      SetTcpEntry: { args: ["ptr"], returns: "u32" },
    });
    setTcpEntryFn = (row: Pointer) => lib.symbols.SetTcpEntry(row) as number;
  } catch {
    setTcpEntryFn = null;
  }
  return setTcpEntryFn;
}

function readNetstatAno(): string {
  const netstat = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\netstat.exe`;
  const cmd = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`;
  try {
    return execFileSync(cmd, ["/d", "/c", `chcp 437>nul & "${netstat}" -ano -p tcp`], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      windowsHide: true,
    });
  } catch {
    return execFileSync(netstat, ["-ano", "-p", "tcp"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 4000,
      windowsHide: true,
    });
  }
}

/**
 * Force-delete IPv4 TCP rows bound to `localPort` via SetTcpEntry(DELETE_TCB).
 * Does not kill foreign processes — only resets sockets so the listen port can bind again.
 * Bare IPv6 rows (`::1`, `::`, etc.) are skipped (not coerced into IPv4 wildcards);
 * IPv6 TCB reclamation is unsupported on this path.
 */
export function dropWindowsTcpRowsForLocalPort(port: number): WindowsTcpDropResult {
  if (process.platform !== "win32" || !Number.isFinite(port) || port <= 0) {
    return { dropped: 0, skippedIpv6: 0, accessDenied: 0 };
  }
  const setTcpEntry = loadSetTcpEntry();
  if (!setTcpEntry) return { dropped: 0, skippedIpv6: 0, accessDenied: 0 };

  let output = "";
  try {
    output = readNetstatAno();
  } catch {
    return { dropped: 0, skippedIpv6: 0, accessDenied: 0 };
  }

  const rows = parseTcpQuadsForLocalPort(output, Math.trunc(port));
  let dropped = 0;
  let skippedIpv6 = 0;
  let accessDenied = 0;
  for (const row of rows) {
    const localDw = ipv4ToWinUint32(row.localAddr);
    const remoteDw = ipv4ToWinUint32(row.remoteAddr);
    if (localDw === null || remoteDw === null) {
      if (isBareIpv6Address(row.localAddr) || isBareIpv6Address(row.remoteAddr)) {
        skippedIpv6 += 1;
      }
      continue;
    }
    const buf = new ArrayBuffer(20);
    const view = new DataView(buf);
    view.setUint32(0, 12, true); // MIB_TCP_STATE_DELETE_TCB
    view.setUint32(4, localDw, true);
    view.setUint32(8, htons(row.localPort), true);
    view.setUint32(12, remoteDw, true);
    view.setUint32(16, htons(row.remotePort), true);
    try {
      const rc = setTcpEntry(ptr(buf));
      if (rc === 0) dropped += 1;
      // 5 = ERROR_ACCESS_DENIED, 317 = non-elevated SetTcpEntry (MSDN).
      else if (rc === 5 || rc === 317) accessDenied += 1;
    } catch {
      /* keep going */
    }
  }
  return { dropped, skippedIpv6, accessDenied };
}
