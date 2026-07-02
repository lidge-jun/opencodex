import { execFileSync } from "node:child_process";
import { readRuntimePort } from "./config";

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function waitForExit(pid: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  const marker = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    Atomics.wait(marker, 0, 0, 50);
  }
  return !isProcessAlive(pid);
}

/** Injectable seams so the graceful-stop flow is unit-testable without a live proxy. */
export interface GracefulStopIo {
  fetchFn?: typeof fetch;
  readRuntime?: (pid: number) => { port: number; hostname?: string } | null;
  waitExit?: (pid: number, timeoutMs: number) => boolean;
  env?: Record<string, string | undefined>;
  exitTimeoutMs?: number;
}

/**
 * Host to POST /api/stop against: follow the recorded bind hostname when it names a
 * concrete address (a proxy bound to ::1 or a LAN IP is unreachable on 127.0.0.1);
 * loopback aliases and wildcard binds all answer on IPv4 loopback.
 */
export function gracefulStopHost(hostname: string | undefined): string {
  const trimmed = (hostname ?? "").trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed || lower === "localhost" || trimmed === "127.0.0.1" || trimmed === "0.0.0.0" || trimmed === "::" || trimmed === "[::]") {
    return "127.0.0.1";
  }
  if (lower === "::1" || lower === "[::1]") return "[::1]";
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
  return trimmed.includes(":") ? `[${trimmed}]` : trimmed;
}

/**
 * Ask a running proxy to stop itself via the management API (`POST /api/stop`), which
 * drains in-flight turns, restores native Codex, and cleans its pid/runtime files.
 * This is the only way to get a GRACEFUL stop on Windows, where the POSIX
 * SIGTERM-then-SIGKILL ladder does not exist and `taskkill /F` gives the proxy no
 * chance to run its shutdown handlers. Returns false when the proxy can't be reached
 * or doesn't exit in time — callers fall back to {@link killProxy}.
 */
export async function stopProxyGracefully(pid: number, io: GracefulStopIo = {}): Promise<boolean> {
  const readRuntime = io.readRuntime ?? readRuntimePort;
  const runtime = readRuntime(pid);
  if (!runtime?.port) return false;
  const env = io.env ?? process.env;
  const headers: Record<string, string> = {};
  // Non-loopback binds require management auth; loopback ignores the extra header.
  const token = env.OPENCODEX_API_AUTH_TOKEN?.trim();
  if (token) headers["x-opencodex-api-key"] = token;
  const fetchFn = io.fetchFn ?? fetch;
  try {
    const res = await fetchFn(`http://${gracefulStopHost(runtime.hostname)}:${runtime.port}/api/stop`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
  } catch {
    return false;
  }
  const waitExit = io.waitExit ?? waitForExit;
  return waitExit(pid, io.exitTimeoutMs ?? 8000);
}

/** Graceful-first stop: management-API drain, then the platform kill ladder. */
export async function stopProxy(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) return;
  if (await stopProxyGracefully(pid)) return;
  killProxy(pid);
}

export function killProxy(pid: number): void {
  if (!isProcessAlive(pid)) return;
  if (process.platform === "win32") {
    const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
    try {
      execFileSync(taskkill, ["/PID", String(pid), "/T", "/F"], { stdio: "pipe" });
    } catch (err) {
      if (isProcessAlive(pid)) throw err;
    }
  } else {
    process.kill(pid, "SIGTERM");
    if (!waitForExit(pid, 5000)) process.kill(pid, "SIGKILL");
  }
  if (!waitForExit(pid, 5000)) throw new Error(`process ${pid} did not exit`);
}
