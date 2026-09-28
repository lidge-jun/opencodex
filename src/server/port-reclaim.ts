/**
 * Reclaim a listen port after stop/update so restart can stay on the configured
 * port instead of hopping to an ephemeral one (Windows CLOSE_WAIT / leftover ocx).
 *
 * Killing is never the default. It requires `killOcxHolders`, an allowed PID or
 * `killAllOcxOnPort`, and successful ocx verification. A historical PID allowlist
 * never overrides a rejected verifier result; rejected live holders stay protected.
 */
import { execFile, execFileSync } from "node:child_process";
import { readFile, readdir, readlink } from "node:fs/promises";
import { promisify } from "node:util";
import { verifyPidIdentity } from "../config/process-state";
import { isProcessAlive, killProxy } from "../lib/process-control";
import { isPortAvailable, type WaitForPortOptions } from "./ports";
import { dropWindowsTcpRowsForLocalPort } from "./windows-tcp-drop";

export type ListenPidScan =
  | { ok: true; pids: number[] }
  | { ok: false; error?: string };

/** One listening socket with its bound local address (host part only). */
export interface ListenEntry {
  pid: number;
  address: string;
}

export type ListenEntryScan =
  | { ok: true; listeners: ListenEntry[] }
  | { ok: false; error?: string };

export type ReclaimListenPortOptions = WaitForPortOptions & {
  /**
   * When true AND `onlyKillPids` is a non-empty allowlist, those PIDs may be
   * killed after revalidation. Default false — never kill without an allowlist.
   * When {@link killAllOcxOnPort} is also true, any ocx listener on this port
   * may be killed even if it is not in `onlyKillPids`.
   */
  killOcxHolders?: boolean;
  /**
   * Explicit PIDs the caller just stopped / hard-killed. An omitted or empty
   * list means no process may be killed — unless {@link killAllOcxOnPort} is set.
   * The allowlist only narrows kill candidates: every candidate, allowlisted or
   * not, still requires verifier acceptance (`verifyOcxFn(pid) === pid`) on each
   * scan, and a rejected live holder is never killed or TCP-row dropped.
   */
  onlyKillPids?: number[];
  /**
   * When true with `killOcxHolders`, every live ocx listener on this port may be
   * killed (re-checked each scan). Used by post-update restart so a Windows
   * service wrapper that respawns a *new* bun PID mid-reclaim cannot stay
   * protected just because it was absent from the pre-wait allowlist snapshot.
   * Every candidate still requires ocx verifier acceptance before termination.
   */
  killAllOcxOnPort?: boolean;
  /**
   * On Windows, force-delete IPv4 TCP rows for this local port via SetTcpEntry.
   * Default true on win32. Never kills foreign processes, never runs while a
   * live foreign / protected ocx listener owns the port, and never runs when
   * the listener scan failed.
   */
  dropTcpRows?: boolean;
  /** How often to scan for listen PIDs / attempt TCB drop (ms). Default 500. */
  scanIntervalMs?: number;
  listListenPidsFn?: (port: number) => ListenPidScan | number[];
  isAliveFn?: (pid: number) => boolean;
  verifyOcxFn?: (pid: number) => number | null;
  killFn?: (pid: number) => void;
  dropTcpFn?: (port: number) => number | { dropped: number; skippedIpv6: number };
  isAvailableFn?: (port: number, hostname?: string) => Promise<boolean>;
  sleepMs?: (ms: number) => Promise<void>;
};

/** Split `host:port`/`[v6]:port` on a numeric port boundary; returns the host part. */
function listenHost(token: string): string {
  const bracketed = /^(\[[0-9a-fA-F:.]+\]):/.exec(token);
  if (bracketed) return bracketed[1].slice(1, -1).toLowerCase();
  // Only a trailing :<digits> is a port; a bare "::" or hostname wildcard has none.
  const withPort = /^(.*):(\d+)$/.exec(token);
  return (withPort ? withPort[1] : token).toLowerCase();
}

/** Normalize a listen-address host: strips brackets and the IPv4-mapped prefix. */
export function normalizeListenAddress(token: string): string {
  let host = listenHost(token);
  if (host.startsWith("::ffff:")) host = host.slice(7);
  return host;
}

/** Normalize a bare bind address (no port): drops brackets, keeps bare IPv6 whole. */
function bareListenAddress(address: string): string {
  let host = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (host.startsWith("::ffff:")) host = host.slice(7);
  return host;
}

const WILDCARD_LISTEN_HOSTS = new Set(["", "*", "0.0.0.0", "::"]);

/**
 * Whether a socket bound to `listenerAddress` also serves connections to `bound` —
 * exact match, or a wildcard listener, or a wildcard `bound` (the caller listens on
 * every address). IPv4-mapped IPv6 forms of the same address are equalized first.
 */
export function listenAddressServes(listenerAddress: string, bound: string): boolean {
  const listener = normalizeListenAddress(listenerAddress);
  const want = bareListenAddress(bound);
  return WILDCARD_LISTEN_HOSTS.has(listener) || WILDCARD_LISTEN_HOSTS.has(want)
    || listener === want;
}

/**
 * Parse `netstat -ano` (Windows) / `netstat -anlp` listen lines for a port, keeping
 * each distinct PID/address pair. Exported for unit tests.
 */
export function parseListenEntriesFromNetstat(output: string, port: number): ListenEntry[] {
  const entries = new Map<string, ListenEntry>();
  const portSuffix = `:${port}`;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^TCP\b/i.test(line) && !/^tcp\b/i.test(line)) continue;
    const parts = line.split(/\s+/);
    // Prefer the first address token that ends with :port (local), not a later foreign one.
    const localIdx = parts.findIndex(part => part.endsWith(portSuffix) || part.endsWith(`]:${port}`));
    if (localIdx < 0) continue;
    const foreign = parts[localIdx + 1] ?? "";
    // Locale-safe listen detection: English LISTEN*, or unbound foreign wildcard
    // (German ABHÖREN still shows 0.0.0.0:0 / *:*).
    const listenWord = /\bLISTEN/i.test(line);
    const wildcardForeign = /^(0\.0\.0\.0|::|\*|\[::\]):0$/.test(foreign) || foreign === "*:*";
    if (!listenWord && !wildcardForeign) continue;
    const last = parts[parts.length - 1] ?? "";
    const winPid = /^\d+$/.test(last) ? Number(last) : NaN;
    const unixPid = /^(\d+)(?:\/\S*)?$/.exec(last);
    const pid = Number.isSafeInteger(winPid) && winPid > 0
      ? winPid
      : unixPid
        ? Number(unixPid[1])
        : NaN;
    if (Number.isSafeInteger(pid) && pid > 0) {
      const address = normalizeListenAddress(parts[localIdx]);
      entries.set(`${pid}|${address}`, { pid, address });
    }
  }
  return [...entries.values()];
}

/** Parse netstat LISTEN owners, deduplicating PIDs after preserving their addresses. */
export function parseListenPidsFromNetstat(output: string, port: number): number[] {
  return [...new Set(parseListenEntriesFromNetstat(output, port).map(entry => entry.pid))];
}

/**
 * Field names `ss -p` is known to emit inside a `users:` tuple. comm names are printed
 * unescaped and are attacker-controlled, but bounded to 15 bytes (TASK_COMM_LEN - 1):
 * a forged complete tuple needs `",pid=N,fd=N),("` — closing one tuple and opening the
 * next leaves no room for a nonempty name — and a forged in-tuple field needs a key
 * outside this list to stay under the bound, so it trips the grammar check instead.
 */
const SS_OWNER_FIELD_KEYS = new Set(["fd", "ino", "sk", "v6only"]);

/**
 * Strictly parse a `users:(("name",pid=N,fd=N)[,("name2",...)])` column, returning every
 * attributed PID, or null when the column deviates from the grammar anywhere — a row that
 * cannot be trusted must not attribute an owner at all.
 */
function parseSsOwnerPids(field: string): number[] | null {
  if (!field.startsWith("users:(")) return null;
  const pids: number[] = [];
  let at = "users:(".length;
  while (field.startsWith("(", at)) {
    at += 1;
    // ss prints comm raw between quotes with no escaping; a quote inside the name
    // therefore ends it early and the rest of the name lands in field position.
    const name = /^"[^"\n]*"/.exec(field.slice(at));
    if (name === null || name[0] === `""`) return null;
    at += name[0].length;
    const pid = /^,pid=(\d+)/.exec(field.slice(at));
    if (pid === null) return null;
    at += pid[0].length;
    pids.push(Number(pid[1]));
    for (;;) {
      const kv = /^,([a-z_]+)=([^,"()\s]+)/.exec(field.slice(at));
      if (kv === null) break;
      if (!SS_OWNER_FIELD_KEYS.has(kv[1]!)) return null;
      at += kv[0].length;
    }
    if (field[at] !== ")") return null;
    at += 1;
    if (field.startsWith(",(", at)) at += 1;
  }
  return field[at] === ")" && field.slice(at + 1).trim() === "" ? pids : null;
}

/**
 * Parse `ss -Hltnp` rows for a port, keeping each distinct PID/address pair. A row
 * without a `pid=` attribution (another user's socket), or whose `users:` column
 * does not parse cleanly, is dropped rather than reported unverifiable. Exported
 * for unit tests.
 */
export function parseListenEntriesFromSs(output: string, port: number): ListenEntry[] {
  const entries = new Map<string, ListenEntry>();
  const portSuffix = `:${port}`;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^LISTEN\b/i.test(line)) continue;
    const parts = line.split(/\s+/);
    // LISTEN <recv-q> <send-q> <local-addr:port> <peer-addr:port> users:(...)
    const localIdx = parts.findIndex(part => part.endsWith(portSuffix) || part.endsWith(`]:${port}`));
    if (localIdx < 0) continue;
    const usersIdx = line.indexOf("users:(");
    if (usersIdx < 0) continue;
    const ownerPids = parseSsOwnerPids(line.slice(usersIdx));
    if (ownerPids === null) continue;
    const address = normalizeListenAddress(parts[localIdx]);
    for (const pid of ownerPids) {
      if (Number.isSafeInteger(pid) && pid > 0) entries.set(`${pid}|${address}`, { pid, address });
    }
  }
  return [...entries.values()];
}

/**
 * Parse `lsof -nP -iTCP:<port> -sTCP:LISTEN` output (without -t), keeping each
 * distinct PID/address pair. The NAME column is the last address token, optionally
 * followed by `(LISTEN)`; skip the header and nonnumeric PIDs. Exported for tests.
 */
export function parseListenEntriesFromLsof(output: string, port: number): ListenEntry[] {
  const entries = new Map<string, ListenEntry>();
  const portSuffix = `:${port}`;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^COMMAND\b/.test(line)) continue;
    const parts = line.split(/\s+/);
    const pid = /^\d+$/.test(parts[1] ?? "") ? Number(parts[1]) : NaN;
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    let addressIdx = parts.length - 1;
    if (/^\(.*\)$/.test(parts[addressIdx] ?? "")) addressIdx -= 1;
    const address = parts[addressIdx] ?? "";
    if (!address.endsWith(portSuffix) && !address.endsWith(`]:${port}`)) continue;
    const normalized = normalizeListenAddress(address);
    entries.set(`${pid}|${normalized}`, { pid, address: normalized });
  }
  return [...entries.values()];
}

function normalizeListenPidScan(result: ListenPidScan | number[]): ListenPidScan {
  if (Array.isArray(result)) return { ok: true, pids: result };
  return result;
}

/** Prefer English netstat states; fall back to the UI-locale table. */
function readWindowsNetstatAno(): string {
  const netstat = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\netstat.exe`;
  const cmd = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`;
  try {
    // chcp 437 forces English LISTENING/ESTABLISHED labels on localized Windows.
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
 * Scan for the sockets currently LISTENing on `port`, with each listener's bound
 * local address. Distinguishes probe failure (`ok: false`) from a successful empty
 * result. POSIX backends are tried in order — `lsof`, `ss` (iproute2, the only
 * scanner on minimal Linux installs), then `netstat` — and a missing scanner falls
 * through to the next instead of failing the scan.
 */
export function scanListenEntries(port: number): ListenEntryScan {
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return { ok: false, error: "invalid port" };
  }
  const scanned = Math.trunc(port);
  try {
    if (process.platform === "win32") {
      return { ok: true, listeners: parseListenEntriesFromNetstat(readWindowsNetstatAno(), scanned) };
    }
    const errors: string[] = [];
    try {
      const output = execFileSync("lsof", ["-nP", `-iTCP:${scanned}`, "-sTCP:LISTEN"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      });
      return { ok: true, listeners: parseListenEntriesFromLsof(output, scanned) };
    } catch (error) {
      errors.push(`lsof: ${String(error)}`);
    }
    try {
      const output = execFileSync("ss", ["-Hltnp"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      });
      return { ok: true, listeners: parseListenEntriesFromSs(output, scanned) };
    } catch (error) {
      errors.push(`ss: ${String(error)}`);
    }
    try {
      const output = execFileSync("netstat", ["-anlp"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      });
      return { ok: true, listeners: parseListenEntriesFromNetstat(output, scanned) };
    } catch (error) {
      errors.push(`netstat: ${String(error)}`);
    }
    return { ok: false, error: `no listener scanner available (${errors.join(" / ")})` };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/**
 * Scan for PIDs currently LISTENing on `port`.
 * Distinguishes probe failure (`ok: false`) from a successful empty result.
 */
export function scanListenPids(port: number): ListenPidScan {
  const scan = scanListenEntries(port);
  if (!scan.ok) return { ok: false, error: scan.error };
  return { ok: true, pids: [...new Set(scan.listeners.map(entry => entry.pid))] };
}

/**
 * PIDs LISTENing on `port` that actually serve `address`: listeners bound to that
 * exact address plus wildcards (0.0.0.0/::). A listener on a different loopback or
 * interface address (e.g. 127.0.0.2 while the tunnel binds 127.0.0.1) never receives
 * the connection and must not block or qualify a readiness check.
 */
export function scanListenPidsForAddress(port: number, address = "127.0.0.1"): ListenPidScan {
  const scan = scanListenEntries(port);
  if (!scan.ok) return { ok: false, error: scan.error };
  const pids = new Set<number>();
  for (const entry of scan.listeners) {
    if (listenAddressServes(entry.address, address)) pids.add(entry.pid);
  }
  return { ok: true, pids: [...pids] };
}

/** Best-effort PIDs currently LISTENing on `port`. Empty on probe failure. */
export function listListenPids(port: number): number[] {
  const scan = scanListenPids(port);
  return scan.ok ? scan.pids : [];
}

const execFileAsync = promisify(execFile);
const OWNER_LOOKUP_TIMEOUT_MS = 2_000;
const MAX_PROC_NET_BYTES = 4 * 1024 * 1024;
const MAX_PROCESS_FDS = 4_096;

/** The exact IPv4 listener the Child relay contacts; ::1 and wildcard binds are not proof. */
export function parseProcLoopbackListenInodes(tcp: string, tcp6: string, port: number): string[] {
  const wantedPort = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set<string>();
  for (const [content, wantedAddress] of [
    [tcp, "0100007F"],
    [tcp6, "0000000000000000FFFF00000100007F"], // ::ffff:127.0.0.1 in proc word order
  ] as const) {
    for (const line of content.split(/\r?\n/).slice(1)) {
      const fields = line.trim().split(/\s+/);
      const [address, hexPort] = (fields[1] ?? "").toUpperCase().split(":");
      if (address !== wantedAddress || hexPort !== wantedPort || fields[3] !== "0A") continue;
      const inode = fields[9];
      if (inode && /^[1-9]\d*$/.test(inode)) inodes.add(inode);
    }
  }
  return [...inodes];
}

/** Parse only 127.0.0.1:port LISTEN owners; an unrelated [::1]:port must not veto it. */
export function parseIpv4LoopbackListenPidsFromNetstat(output: string, port: number): number[] {
  const pids = new Set<number>();
  for (const raw of output.split(/\r?\n/)) {
    const fields = raw.trim().split(/\s+/);
    if (fields[0]?.toUpperCase() !== "TCP" || fields[1] !== `127.0.0.1:${port}`) continue;
    const state = fields[3] ?? "";
    const foreign = fields[2] ?? "";
    if (!/^LISTEN/i.test(state) && !["0.0.0.0:0", "[::]:0", "*:*"].includes(foreign)) continue;
    const pid = Number(fields.at(-1));
    if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

async function runOwnerLookup(file: string, args: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync(file, args, {
    encoding: "utf8", timeout: timeoutMs, maxBuffer: MAX_PROC_NET_BYTES, windowsHide: true,
  });
  return stdout;
}

export interface LoopbackOwnerLookupIo {
  platform?: NodeJS.Platform;
  readProc?: (path: string) => Promise<string>;
  listFds?: (path: string) => Promise<string[]>;
  readFdLink?: (path: string) => Promise<string>;
  run?: (file: string, args: string[], timeoutMs: number) => Promise<string>;
}

/** Async, bounded proof that this PID owns the IPv4 loopback LISTEN socket used by the relay. */
export async function ownsIpv4LoopbackListener(
  port: number,
  expectedPid: number,
  io: LoopbackOwnerLookupIo = {},
): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535
    || !Number.isSafeInteger(expectedPid) || expectedPid < 1) return false;
  const platform = io.platform ?? process.platform;
  const lookup = async (): Promise<boolean> => {
    if (platform === "linux") {
      const readProc = io.readProc ?? (path => readFile(path, "utf8"));
      const tcp = await readProc("/proc/net/tcp");
      const tcp6 = await readProc("/proc/net/tcp6").catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
      });
      if (tcp.length > MAX_PROC_NET_BYTES || tcp6.length > MAX_PROC_NET_BYTES) return false;
      const inodes = parseProcLoopbackListenInodes(tcp, tcp6, port);
      if (inodes.length !== 1) return false;
      const fdDir = `/proc/${expectedPid}/fd`;
      const fds = await (io.listFds ?? readdir)(fdDir);
      if (fds.length > MAX_PROCESS_FDS) return false;
      const wanted = `socket:[${inodes[0]}]`;
      const readFdLink = io.readFdLink ?? readlink;
      for (const fd of fds) {
        try { if (await readFdLink(`${fdDir}/${fd}`) === wanted) return true; }
        catch { /* an fd may close while it is enumerated */ }
      }
      return false;
    }
    const run = io.run ?? runOwnerLookup;
    if (platform === "darwin") {
      const stdout = await run("/usr/sbin/lsof", ["-nP", "-a", `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN", "-t"], OWNER_LOOKUP_TIMEOUT_MS);
      const pids = new Set(stdout.split(/\r?\n/).map(line => Number(line.trim())).filter(pid => Number.isSafeInteger(pid) && pid > 0));
      return pids.size === 1 && pids.has(expectedPid);
    }
    if (platform === "win32") {
      const netstat = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\netstat.exe`;
      const stdout = await run(netstat, ["-ano", "-p", "tcp"], OWNER_LOOKUP_TIMEOUT_MS);
      const pids = parseIpv4LoopbackListenPidsFromNetstat(stdout, port);
      return pids.length === 1 && pids[0] === expectedPid;
    }
    return false;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>(resolve => {
    timer = setTimeout(() => resolve(false), OWNER_LOOKUP_TIMEOUT_MS);
    timer.unref?.();
  });
  try { return await Promise.race([lookup().catch(() => false), deadline]); }
  finally { if (timer) clearTimeout(timer); }
}

/**
 * Wait until `port` can bind.
 * Never kills a process unless `killOcxHolders === true` and either
 * `onlyKillPids` is a non-empty allowlist or `killAllOcxOnPort` is set — then
 * revalidates immediately before each kill.
 * Never overrides a rejected ocx verifier result. Never drops TCP rows while a
 * rejected live or protected ocx listener owns the port, or when the scan failed.
 */
export async function reclaimListenPort(
  port: number,
  hostname = "127.0.0.1",
  opts: ReclaimListenPortOptions = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 100;
  const scanIntervalMs = opts.scanIntervalMs ?? 500;
  const allowedKillPids = new Set(
    (opts.onlyKillPids ?? []).filter(pid => Number.isSafeInteger(pid) && pid > 0),
  );
  const killAllOcx = opts.killAllOcxOnPort === true;
  const mayKill = opts.killOcxHolders === true
    && (allowedKillPids.size > 0 || killAllOcx);
  const dropTcpRows = opts.dropTcpRows ?? process.platform === "win32";
  const listFn = opts.listListenPidsFn ?? scanListenPids;
  const isAliveFn = opts.isAliveFn ?? isProcessAlive;
  const verifyOcxFn = opts.verifyOcxFn ?? verifyPidIdentity;
  const killFn = opts.killFn ?? killProxy;
  const dropTcpFn = opts.dropTcpFn ?? dropWindowsTcpRowsForLocalPort;
  const isAvailableFn = opts.isAvailableFn ?? isPortAvailable;
  const sleep = opts.sleepMs ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));

  const deadline = Date.now() + timeoutMs;
  let lastScan = 0;
  const killed = new Set<number>();

  for (;;) {
    if (await isAvailableFn(port, hostname)) return true;
    if (Date.now() >= deadline) return false;

    if (Date.now() - lastScan >= scanIntervalMs) {
      lastScan = Date.now();

      const scan = normalizeListenPidScan(listFn(port));
      if (!scan.ok) {
        // Failed probe ≠ empty listeners: do not kill and do not reset TCP rows.
        await sleep(intervalMs);
        continue;
      }

      let foreignLive = false;
      let protectedOcxListener = false;

      for (const pid of scan.pids) {
        if (pid === process.pid) continue;
        if (!isAliveFn(pid)) {
          // Clear "already tried" so a later respawn that reuses this PID slot
          // is not skipped (Windows service :loop / npm rename respawns).
          killed.delete(pid);
          continue; // Windows may still list a dead owner briefly
        }
        const isOcx = verifyOcxFn(pid) === pid;
        const allowlisted = allowedKillPids.has(pid);
        if (!isOcx) {
          // A saved PID narrows eligible candidates; it cannot override verifier rejection.
          // Dead ghost owners have already been skipped by the liveness check above.
          foreignLive = true;
          continue;
        }
        const mayKillThis = allowlisted || killAllOcx;
        if (!mayKill || !mayKillThis) {
          // Healthy / intentional ocx proxy — never steal its port.
          protectedOcxListener = true;
          continue;
        }
        if (!killed.has(pid)) {
          // Revalidate immediately before termination.
          if (isAliveFn(pid) && verifyOcxFn(pid) === pid && mayKillThis) {
            try {
              killFn(pid);
              killed.add(pid);
            } catch {
              // Kill failed: keep waiting and never reset this listener's TCP rows.
              protectedOcxListener = true;
            }
          } else {
            // Revalidation failed while the allowlisted listener is still listed live.
            protectedOcxListener = true;
          }
        }
        // Respawning supervisors (Windows service :loop) mint a new PID after each
        // kill — clear the per-PID "already tried" bit once the process is gone so a
        // later child with a reused slot is not skipped, and keep reclaiming while live.
        if (!isAliveFn(pid)) {
          killed.delete(pid);
        } else {
          protectedOcxListener = true;
        }
      }

      if (foreignLive || protectedOcxListener) {
        // Foreign app or an unprotected live ocx listener owns the port: never
        // SetTcpEntry-reset their sockets, and fail reclaim once the deadline hits.
        await sleep(intervalMs);
        continue;
      }

      // After hard-kill, browsers often keep ESTABLISHED/CLOSE_WAIT to the dead listener.
      // Reset those IPv4 TCBs (and ghost LISTEN rows) so the configured port can bind again —
      // without killing the browser process. Only safe when no live foreign/protected listener remains.
      if (dropTcpRows) {
        try {
          dropTcpFn(port);
        } catch {
          /* access denied / unsupported — keep waiting */
        }
      }
    }

    await sleep(intervalMs);
  }
}
