/** Real API stop -> drain/listener close -> process.exit -> CLI exit cleanup, in one child. */
import { mock } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoPath } from "../helpers/repo-root";

const query = process.argv[2] as "valid" | "foreign" | "missing" | "none" | "pending";
const home = process.env.OPENCODEX_HOME;
if (!home || !process.env.CODEX_HOME) throw new Error("isolated fixture homes required");
delete process.env.OCX_SERVICE;
delete process.env.OCX_DESKTOP_SUPERVISED;
const events: string[] = [];
const calls = { service: 0, apiNative: 0, apiGrok: 0, exitNative: 0, exitGrok: 0, env: 0, pid: 0, runtime: 0 };
const restored = { success: true, message: "fixture restored", artifacts: {
  config: { state: "restored" }, catalog: { state: "restored" }, history: { state: "restored" },
} };

// Replace host mutation only. Receipt verification, handler, drain and exit remain real.
const service = await import("../../src/service");
mock.module("../../src/service", () => ({ ...service,
  installedServiceRespawnRisk: () => "none", stopServiceIfInstalledDetailed: () => { calls.service++; return "stopped"; },
}));
const native = await import("../../src/codex/inject");
mock.module("../../src/codex/inject", () => ({ ...native,
  restoreNativeCodexAsync: async () => { calls.apiNative++; events.push("native-api"); return restored; },
}));
const grok = await import("../../src/grok/inject");
mock.module("../../src/grok/inject", () => ({ ...grok,
  stripGrokConfig: () => { calls.apiGrok++; events.push("grok-api"); return { ok: true, changed: true, message: "fixture stripped" }; },
}));

const { claimPendingTeardown, readPendingTeardown } = await import("../../src/config/pending-teardown");
const { isSharedTeardownDeferredOnExit } = await import("../../src/server/stop-teardown");
const { preserveConnectedClientRoutingOnExit } = await import("../../src/cli/stop-restore");
const { stopRestoreWriteGuard } = await import("../../src/cli/stop-restore-guard");
const { decideStartExitTeardown } = await import("../../src/cli/dispatch");
const { setServerRef, setServerStartupLifecycleReleaseForTests, isRecyclingForExit, markRecyclingForExit } = await import("../../src/server/lifecycle");
const { handleManagementAPI } = await import("../../src/server/management-api");
const { directLocalHttpFetch } = await import("../../src/server/direct-local-http");
const config = { port: 0, hostname: "127.0.0.1", providers: {}, defaultProvider: "openai", shutdownTimeoutMs: 0 };
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, reusePort: false,
  async fetch(req) {
    // Auth is a fixture prerequisite; exercise the actual admitted management handler.
    return await handleManagementAPI(req, new URL(req.url), config as never, {}, "admin-token")
      ?? new Response("not found", { status: 404 });
  },
});
config.port = server.port!;
setServerRef(server);
const realStop = server.stop.bind(server);
server.stop = (force?: boolean) => { events.push("listener-stop"); return realStop(force); };
setServerStartupLifecycleReleaseForTests(async () => { events.push("startup-release"); });
const receipt = claimPendingTeardown({ hostname: "127.0.0.1", port: config.port }, "exact");

// Register the real CLI cleanup body on the real exit event; do not call it as a substitute
// for the API handler. The API's own timer must drain and invoke process.exit first.
const source = readFileSync(repoPath("src", "cli", "index.ts"), "utf8");
const from = source.indexOf("  const syncCleanup = () => {");
const to = source.indexOf("\n  let shuttingDown", from);
if (from < 0 || to < 0) throw new Error("CLI exit cleanup missing");
const bindings = {
  catalogHealer: null, routingHealer: null, guardian: { stop() {} }, historyGuardian: null, healthSentinel: null,
  siblingStart: false, isRecyclingForExit, decideStartExitTeardown, preserveConnectedClientRoutingOnExit, stopRestoreWriteGuard,
  revertSystemEnv() { calls.env++; }, removePid() { calls.pid++; }, removeRuntimePort() { calls.runtime++; },
  serviceEnvironmentOwnedHere: () => true, getCodexHome: () => process.env.CODEX_HOME!, codexHomeIsAbsent: () => false,
  restoreNativeCodex: (options?: { withWriteGuard?: <T>(write: () => T) => T }) => {
    const write = () => { calls.exitNative++; events.push("native-exit"); return restored; };
    return options?.withWriteGuard ? options.withWriteGuard(write) : write();
  },
  stripGrokConfig: () => { calls.exitGrok++; events.push("grok-exit"); return { ok: true, changed: true, message: "fixture stripped" }; },
};
const cleanup = new Function(...Object.keys(bindings),
  "let cleaned = false; let cleanupSucceeded = true;\n" + source.slice(from, to) + "\nreturn syncCleanup;",
)(...Object.values(bindings)) as () => boolean;
let responseStatus: number | undefined;
let body: unknown;
let refusedKeptServing = false;
let automaticRestarted = false;
process.on("exit", () => { events.push("exit-cleanup"); cleanup(); });
process.on("exit", () => {
  writeFileSync(join(home, "api-stop-exit-result.json"), JSON.stringify({
    calls, events, responseStatus, body, port: config.port,
    deferredOnExit: isSharedTeardownDeferredOnExit(), receiptState: readPendingTeardown(receipt.nonce).state, refusedKeptServing, automaticRestarted,
  }));
});

const url = new URL("/api/stop", server.url);
if (query === "pending") (await import("../../src/client/state")).markClientConnectPending("b".repeat(64));
if (query !== "none") url.searchParams.set("deferSharedTeardown", "1");
if (query === "valid") url.searchParams.set("teardownNonce", receipt.nonce);
if (query === "foreign") url.searchParams.set("teardownNonce", "ffffffffffffffffffffffffffffffff");
const response = await directLocalHttpFetch(url, { method: "POST", signal: AbortSignal.timeout(5_000) }, { timeoutMs: 5_000 });
responseStatus = response.status;
body = await response.json();
if (query === "pending") {
  await Bun.sleep(350); // An accepted stop would already have drained and exited.
  const probe = await directLocalHttpFetch(new URL("/api/stop", server.url), { method: "GET", signal: AbortSignal.timeout(2000) }, { timeoutMs: 2000 });
  refusedKeptServing = probe.status === 200;
  await probe.body?.cancel();
  (await import("../../src/client/state")).clearClientConnectPending("b".repeat(64));
  let scheduled!: () => void | Promise<void>;
  (await import("../../src/server/management/system-restart")).acceptSystemRestart({
    isShutdownDraining: () => false, getActiveTurnCount: () => 0,
    acquireTemporaryDrain: () => ({ release() {} }), beginShutdownDrain() {},
    schedule: work => { scheduled = work; }, scheduleDeadline: () => () => {},
    drainAndShutdown: async () => true, stopListener() {}, listenPort: () => config.port,
    isDesktopSupervised: () => false, isSupervisedServiceChild: () => false,
    spawnStart() { automaticRestarted = true; }, markRecycling: markRecyclingForExit, exitProcess() {},
  }, { onAccepted() {}, beforeScheduledDrain: () => true });
  await scheduled();
  await server.stop(true);
  process.exit(0);
}
if (response.status !== 200) {
  await server.stop(true);
  throw new Error(`unexpected API stop status: ${response.status}`);
}
// The real management handler's 200ms callback owns drain and process.exit. No fixture exit.
