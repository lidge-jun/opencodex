/**
 * Reclaim a listen port after stop/update so restart can stay on the configured
 * port instead of hopping to an ephemeral one (Windows CLOSE_WAIT / leftover ocx).
 *
 * Killing is never the default. A process may be killed only when the caller
 * sets `killOcxHolders` and either supplies a non-empty `onlyKillPids` allowlist
 * (trusted teardown PIDs, including allowlisted holders that fail ocx revalidate)
 * or enables `killAllOcxOnPort` for revalidated ocx listeners. Unknown foreign
 * (non-ocx, non-allowlisted) processes are never killed.
 */
import { execFileSync } from "node:child_process";
import { verifyPidIdentity } from "../config";
import { isProcessAlive, killProxy } from "../lib/process-control";
import { isPortAvailable, type WaitForPortOptions } from "./ports";
import { dropWindowsTcpRowsForLocalPort } from "./windows-tcp-drop";

export type ListenPidScan =
  | { ok: true; pids: number[] }
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
   */
  onlyKillPids?: number[];
  /**
   * When true with `killOcxHolders`, every live ocx listener on this port may be
   * killed (re-checked each scan). Used by post-update restart so a Windows
   * service wrapper that respawns a *new* bun PID mid-reclaim cannot stay
   * protected just because it was absent from the pre-wait allowlist snapshot.
   * Never kills foreign (non-ocx) processes — only allowlisted teardown PIDs
   * and revalidated ocx listeners.
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

/**
 * Parse `netstat -ano` (Windows) / `netstat -anlp` listen lines for a port.
 * Exported for unit tests.
 */
export function parseListenPidsFromNetstat(output: string, port: number): number[] {
  const pids = new Set<number>();
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
    if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
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
 * Scan for PIDs currently LISTENing on `port`.
 * Distinguishes probe failure (`ok: false`) from a successful empty result.
 */
export function scanListenPids(port: number): ListenPidScan {
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return { ok: false, error: "invalid port" };
  }
  try {
    if (process.platform === "win32") {
      return { ok: true, pids: parseListenPidsFromNetstat(readWindowsNetstatAno(), port) };
    }
    try {
      const output = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      });
      return {
        ok: true,
        pids: output
          .split(/\r?\n/)
          .map(line => Number(line.trim()))
          .filter(pid => Number.isSafeInteger(pid) && pid > 0),
      };
    } catch (lsofErr) {
      try {
        const output = execFileSync("netstat", ["-anlp"], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 3000,
        });
        return { ok: true, pids: parseListenPidsFromNetstat(output, Math.trunc(port)) };
      } catch (netstatErr) {
        return {
          ok: false,
          error: `lsof/netstat unavailable: ${String(lsofErr)} / ${String(netstatErr)}`,
        };
      }
    }
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/** Best-effort PIDs currently LISTENing on `port`. Empty on probe failure. */
export function listListenPids(port: number): number[] {
  const scan = scanListenPids(port);
  return scan.ok ? scan.pids : [];
}

/**
 * Wait until `port` can bind.
 * Never kills a process unless `killOcxHolders === true` and either
 * `onlyKillPids` is a non-empty allowlist or `killAllOcxOnPort` is set — then
 * revalidates immediately before each kill.
 * Never kills foreign processes. Never drops TCP rows while a live foreign or
 * protected ocx listener owns the port, or when the listener scan failed.
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
        // Pre-update PIDs can fail verify while still LISTENing (dead owner still
        // listed, or cmdline probe raced). Allowlisted teardown PIDs may be killed;
        // unknown foreign claimants must remain fail-closed.
        if (!isOcx) {
          if (mayKill && allowlisted) {
            if (!killed.has(pid)) {
              try {
                killFn(pid);
                killed.add(pid);
              } catch {
                // Kill failed: never SetTcpEntry while the process may still own the port.
                protectedOcxListener = true;
              }
            }
            if (!isAliveFn(pid)) killed.delete(pid);
            else protectedOcxListener = true;
            continue;
          }
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
