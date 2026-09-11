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
};
const home = process.env.OPENCODEX_HOME!;
const endpoint = { hostname: "127.0.0.1", port: 10100 };
const fakePid = 4242;
const calls = { killed: 0, native: 0, grok: 0, cleared: 0, exited: 0 };
const urls: string[] = [];
const unexpectedIo: string[] = [];
let alive = true;
let nonce: string | undefined;

function unexpected(operation: string): never {
  unexpectedIo.push(operation);
  throw new Error(`unexpected external I/O in parent stop fixture: ${operation}`);
}

// Neither an accidental POSIX signal nor the Windows taskkill fallback may reach the host.
process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
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
  execFileSync: () => { calls.killed += 1; return unexpected("execFileSync"); },
}));

const receipts = await import("../../src/config/pending-teardown");
process.on("exit", () => {
  writeFileSync(join(home, "parent-stop-result.json"), JSON.stringify({
    calls, urls, unexpectedIo, nonce,
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
  readPid: () => fakePid,
  readRuntimePort: () => endpoint,
  removePid() {},
  removeRuntimePort() {},
}));
const service = await import("../../src/service");
mock.module("../../src/service", () => ({ ...service, stopServiceIfInstalledDetailed: () => "absent" }));
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

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (!url.startsWith("http://127.0.0.1:10100/api/stop")) return unexpected(`fetch(${url})`);
  urls.push(url);
  if ((options.status ?? 200) !== 409) alive = false;
  return Response.json(options.response, { status: options.status ?? 200 });
}) as typeof fetch;

process.argv = [process.execPath, "ocx", "stop"];
await import("../../src/cli/index");
