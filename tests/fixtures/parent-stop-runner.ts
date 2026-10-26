/** Runs the real CLI/stop module graph with process and client I/O isolated in this child. */
import { mock } from "bun:test";
import * as childProcess from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CodexNativeRestoreResult } from "../../src/codex/inject";

const options = JSON.parse(readFileSync(0, "utf8")) as {
  receipt: boolean;
  response: unknown;
  restore: CodexNativeRestoreResult;
  status?: number;
  /** #7563: run the stop as a connected client of this transport. */
  clientTransport?: "hub" | "link";
  serverTeardown?: boolean;
  json?: boolean;
  clientServer?: "legacy" | "unknown" | "wrong-pid" | "malformed" | "oversized" | "unauthorized" | "redirect" | "body-timeout";
  managerCascades?: boolean;
  guarded?: boolean;
  orphan?: boolean;
  exitCleanup?: boolean;
  nativeSignal?: boolean;
  apiFailure?: boolean;
  proxyProbePort?: number;
  alreadyStopped?: boolean;
  absence?: "dead" | "unknown" | "live";
  managerState?: "inactive" | "active" | "unknown";
  /** #7423: run the stop the way an update that restarts the proxy runs it. */
  handover?: boolean;
  /** The runtime-port record is missing, so the stop can only record a guessed endpoint. */
  noRuntimeRecord?: boolean;
  /** Like the real readPid, report no PID once the process is gone (a manager stop exited it). */
  deadPidReadsNull?: boolean;
};
if (options.proxyProbePort) {
  // Deliberately bypass every fixture mock for the real proxy-environment regression.
  const origin = `http://127.0.0.1:${options.proxyProbePort}`;
  const control = await fetch(`${origin}/__proxy-control`, { signal: AbortSignal.timeout(2000) }).then(r => r.json());
  if (control.via !== "proxy") throw new Error("proxy environment control was not intercepted");
  const { assertConnectedClientStopSupported } = await import("../../src/cli/stop-restore");
  await assertConnectedClientStopSupported({ pid: process.pid, port: options.proxyProbePort, hostname: "127.0.0.1" });
  const { stopProxyGracefully } = await import("../../src/lib/process-control");
  const { directLocalHttpFetch } = await import("../../src/server/direct-local-http");
  const result = await stopProxyGracefully(process.pid, {
    runtimeEndpoint: { port: options.proxyProbePort, hostname: "127.0.0.1" },
    fetchFn: directLocalHttpFetch, waitExit: () => true,
  });
  if (result !== true) throw new Error("direct stop request failed");
  console.log(JSON.stringify({ ok: true, control: control.via }));
  process.exit(0);
}
const home = process.env.OPENCODEX_HOME!;
const endpoint = { hostname: "127.0.0.1", port: 10100 };
const fakePid = 4242;
const calls = { killed: 0, native: 0, grok: 0, cleared: 0, exited: 0, service: 0 };
const urls: string[] = [];
const probes: string[] = [];
const unexpectedIo: string[] = [];
let alive = !options.alreadyStopped;
let nonce: string | undefined;

function unexpected(operation: string): never {
  unexpectedIo.push(operation);
  throw new Error(`unexpected external I/O in parent stop fixture: ${operation}`);
}

// Neither an accidental POSIX signal nor the Windows taskkill fallback may reach the host.
process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
  if (options.nativeSignal && pid === fakePid && signal === "SIGTERM") { calls.killed++; alive = false; return true; }
  if (pid !== fakePid || signal !== 0) {
    calls.killed += 1;
    return unexpected(`process.kill(${pid}, ${signal})`);
  }
  if (alive) return true;
  calls.exited += 1;
  throw Object.assign(new Error("fixture process exited"), { code: "ESRCH" });
}) as typeof process.kill;
mock.module("node:child_process", () => ({
  ...childProcess,
  execFileSync: (file: string) => {
    if (options.nativeSignal && file.endsWith("taskkill.exe")) { calls.killed++; alive = false; return Buffer.alloc(0); }
    calls.killed += 1; return unexpected("execFileSync");
  },
}));

const receipts = await import("../../src/config/pending-teardown");
process.on("exit", () => {
  writeFileSync(join(home, "parent-stop-result.json"), JSON.stringify({
    calls, urls, probes, unexpectedIo, nonce,
    receiptExists: nonce !== undefined && existsSync(receipts.pendingTeardownPathFor(nonce)),
  }));
});
const claimReceipt = receipts.claimPendingTeardown;
const clearReceipt = receipts.clearPendingTeardown;
mock.module("../../src/config/pending-teardown", () => ({
  ...receipts,
  claimPendingTeardown: (...args: Parameters<typeof claimReceipt>) => {
    if (!options.receipt) throw new Error("receipt storage unavailable");
    const receipt = claimReceipt(...args);
    nonce = receipt.nonce;
    return receipt;
  },
  clearPendingTeardown: (value: string) => { calls.cleared += 1; return clearReceipt(value); },
}));

const state = await import("../../src/config/process-state");
mock.module("../../src/config/process-state", () => ({
  ...state,
  readPid: () => options.orphan || options.alreadyStopped || (options.deadPidReadsNull && !alive) ? null : fakePid,
  readRuntimePort: () => options.alreadyStopped || options.noRuntimeRecord ? null : endpoint,
  removePid() {},
  removeRuntimePort() {},
}));
const service = await import("../../src/service");
mock.module("../../src/service", () => ({ ...service, stopServiceIfInstalledDetailed: () => {
  calls.service++;
  if (options.managerCascades) { alive = false; return "stopped"; }
  return "absent";
} }));
if (options.guarded) {
  const approval = { pid: fakePid, ...endpoint, configHome: home, cliVersion: "2.93.0", compatibilityToken: "fixture" };
  const manager = { kind: "bound", pid: fakePid, managerPid: fakePid + 1, backend: "launchd" };
  const stopApproval = await import("../../src/cli/stop-approval");
  mock.module("../../src/cli/stop-approval", () => ({ ...stopApproval,
    parseStopApproval: () => ({ ok: true, json: true, approval }),
    runApprovedStop: async (_a: unknown, _r: unknown, _f: unknown, _m: unknown, stop: (s: unknown) => unknown) => stop({ approval, manager }),
    settleApprovedTarget: async () => !alive,
  }));
  const guarded = await import("../../src/service/guarded-manager-target");
  mock.module("../../src/service/guarded-manager-target", () => ({ ...guarded,
    inspectGuardedManagerTarget: () => manager, observeGuardedManagerStopped: () => "stopped",
  }));
}
if (options.orphan || options.alreadyStopped) {
  const liveness = await import("../../src/server/proxy-liveness");
  mock.module("../../src/server/proxy-liveness", () => ({ ...liveness,
    findLiveProxy: async () => alive ? { ...endpoint, pid: fakePid, source: "config" } : null,
    proveLiveProxyOwnedByHome: async () => "proven",
    probeEndpointLiveness: async () => options.absence ?? "dead",
  }));
}
if (options.alreadyStopped) {
  const guarded = await import("../../src/service/guarded-manager-target");
  mock.module("../../src/service/guarded-manager-target", () => ({ ...guarded,
    observeGuardedManagerStopped: async () => options.managerState ?? "inactive",
  }));
}
const native = await import("../../src/codex/inject");
mock.module("../../src/codex/inject", () => ({
  ...native,
  restoreNativeCodexAsync: async () => { calls.native += 1; return options.restore; },
}));
const grok = await import("../../src/grok/inject");
mock.module("../../src/grok/inject", () => ({
  ...grok,
  stripGrokConfig: () => { calls.grok += 1; return { ok: true, changed: true, message: "Grok restored" }; },
}));
const systemEnv = await import("../../src/server/system-env");
mock.module("../../src/server/system-env", () => ({ ...systemEnv, revertSystemEnv() {} }));
const portReclaim = await import("../../src/server/port-reclaim");
mock.module("../../src/server/port-reclaim", () => ({ ...portReclaim, reclaimListenPort: async () => {} }));
// Only shim preflight is unrelated to this stop contract; parsing and dispatch stay real.
mock.module("../../src/cli/codex-shim-autorestore", () => ({ maybeAutoRestoreCodexShim() {} }));

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (init?.method === "GET") {
    probes.push(url);
    if (init.redirect !== "error") return unexpected("redirectable compatibility probe");
    if (url.endsWith("/healthz")) {
      if (new Headers(init.headers).has("x-opencodex-api-key")) return unexpected("credential on health probe");
      return Response.json({ service: "opencodex", version: "2.93.0", pid: fakePid,
        ...(!options.serverTeardown && !options.clientServer ? { role: "client" } : {}) });
    }
    if (!url.endsWith("/api/stop")) return unexpected(`GET ${url}`);
    if (options.clientServer === "unknown") throw new Error("fixture probe unavailable");
    if (options.clientServer === "legacy") return Response.json({ error: "not found" }, { status: 404 });
    if (options.clientServer === "unauthorized") return new Response(null, { status: 401 });
    if (options.clientServer === "redirect") return Response.redirect("http://example.test/", 302);
    if (options.clientServer === "malformed") return new Response("{bad json");
    if (options.clientServer === "oversized") return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4097)); c.close(); } }));
    if (options.clientServer === "body-timeout") return new Response(new ReadableStream({ start(c) {
      init.signal?.addEventListener("abort", () => c.error(init.signal!.reason), { once: true });
    } }));
    return Response.json({ schema: "ocx-stop-capabilities/1", connectedClientOwnership: true,
      pid: options.clientServer === "wrong-pid" ? fakePid + 1 : fakePid });
  }
  if (!url.startsWith("http://127.0.0.1:10100/api/stop")) return unexpected(`fetch(${url})`);
  urls.push(url);
  const body = options.serverTeardown && !options.apiFailure
    ? await (await import("../../src/server/stop-teardown")).performStopTeardown(new URL(url))
    : options.response;
  if (!options.nativeSignal && (options.status ?? 200) !== 409) alive = false;
  return Response.json(body, { status: options.status ?? 200 });
}) as typeof fetch;

// Only the real proxy-environment mode above exercises TCP; other cases inject responses.
const direct = await import("../../src/server/direct-local-http");
mock.module("../../src/server/direct-local-http", () => ({ ...direct,
  directLocalHttpFetch: async (input: string | URL | Request, init?: RequestInit) => {
    if (!alive && String(input).endsWith("/healthz")) throw Object.assign(new Error("fixture listener closed"), { code: "ECONNREFUSED" });
    return globalThis.fetch(input, { ...init, method: init?.method ?? "GET", redirect: "error" });
  },
}));

process.argv = [process.execPath, "ocx", "stop", ...(options.json ? ["--json"] : [])];
if (options.handover) process.env.OCX_UPDATE_TEARDOWN_HANDOVER = "1";
if (options.exitCleanup) {
  delete process.env.OCX_SERVICE;
  // Execute the actual startup exit closure, with only host/config effects replaced.
  const { repoPath } = await import("../helpers/repo-root");
  const source = readFileSync(repoPath("src", "cli", "index.ts"), "utf8");
  const from = source.indexOf("  const syncCleanup = () => {");
  const to = source.indexOf("\n  let shuttingDown", from);
  if (from < 0 || to < 0) throw new Error("startup cleanup closure missing");
  const restore = await import("../../src/cli/stop-restore");
  const dispatch = await import("../../src/cli/dispatch");
  const bindings = {
    catalogHealer: null, routingHealer: null, guardian: { stop() {} }, historyGuardian: null, healthSentinel: null,
    siblingStart: false, isRecyclingForExit: () => false, decideStartExitTeardown: dispatch.decideStartExitTeardown,
    preserveConnectedClientRoutingOnExit: (restore as Record<string, unknown>).preserveConnectedClientRoutingOnExit,
    revertSystemEnv() {}, removePid() {}, removeRuntimePort() {}, serviceEnvironmentOwnedHere: () => true,
    getCodexHome: () => "fixture", codexHomeIsAbsent: () => false,
    restoreNativeCodex: () => { calls.native++; return options.restore; },
    stripGrokConfig: () => { calls.grok++; return { ok: true, changed: true, message: "stripped" }; },
  };
  const cleanup = new Function(...Object.keys(bindings), "let cleaned = false; let cleanupSucceeded = true;\n" + source.slice(from, to) + "\nreturn syncCleanup();");
  cleanup(...Object.values(bindings));
  process.exit(0);
}
await import("../../src/cli/index");
