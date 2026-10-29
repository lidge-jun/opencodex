import { windowsChildHttpArgv } from "./remote-windows";
import { MEMORY_DRAIN_RESTART_MS, REPLACEMENT_READY_TIMEOUT_MS } from "../lib/system-restart-contract";

export const LINK_COMMAND_WORK_MS = 15_000;
export const LINK_COMMAND_MAX_MS = 60_000;
export const LINK_RELAY_VERIFY_MS = 15_000;
export const LINK_CATALOG_MAX_BYTES = 4 * 1024 * 1024;

/** Probe latency pays for SSH setup without making the remote work window unbounded. */
export function linkCommandBudget(latencyMs = 0): number {
  const latency = Number.isFinite(latencyMs) ? Math.max(0, latencyMs) : 0;
  return Math.min(LINK_COMMAND_MAX_MS, LINK_COMMAND_WORK_MS + Math.ceil(latency * 4));
}

export function linkRestartBudget(latencyMs = 0): number {
  return MEMORY_DRAIN_RESTART_MS + REPLACEMENT_READY_TIMEOUT_MS + linkCommandBudget(latencyMs);
}

/** Credential-free Child HTTP probe. Ignore curlrc/proxies; never follow a redirect. */
export function remoteChildHttpArgv(port: number, path: "healthz" | "v1/catalog", timeoutMs = LINK_RELAY_VERIFY_MS, platform: "posix" | "windows" = "posix"): string[] {
  if (platform === "windows") return windowsChildHttpArgv(port, path, timeoutMs);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid Child port");
  const seconds = Math.max(1, Math.ceil(Math.min(LINK_RELAY_VERIFY_MS, timeoutMs) / 1000));
  return ["sh", "-c", 'curl -q --noproxy "*" --silent --show-error --fail --connect-timeout 3 --max-time "$3" --write-out "\\n%{http_code}" "http://127.0.0.1:$1/$2"', "ocx-child-http", String(port), path, String(seconds)];
}

export const REMOTE_CURL_PREFLIGHT = ["sh", "-c", 'command -v curl >/dev/null 2>&1 && curl -q --version >/dev/null 2>&1', "ocx-curl-preflight"];

export function parseChildHttp(stdout: string): unknown {
  const match = /\n200$/.exec(stdout.trimEnd());
  if (!match) throw new Error("Child HTTP probe did not return 200");
  return JSON.parse(stdout.trimEnd().slice(0, match.index));
}

export function isChildHealth(value: unknown, role: "standalone" | "client", expectedPort: number): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return body.port === expectedPort && body.service === "opencodex" && Number.isInteger(body.pid) && (body.pid as number) > 0
    && (role === "client" ? body.role === "client" : (body.role === undefined || body.role === "standalone") && body.restartCapability === "v1");
}
