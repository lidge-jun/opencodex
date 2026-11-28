/** Real file recovery and bound restart; only replacement process launch is a loopback fixture. */
import { mock, spyOn } from "bun:test";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { unavailableFixtureHome } from "../helpers/client-stop-fixture-home";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { serviceApiTokenFingerprint, writeServiceApiTokenFile, readServiceApiTokenState } from "../../src/lib/service-secrets";
import { readRuntimePort, type ClientStopOwner } from "../../src/config/process-state";
import { readClientConnectionStateWithEvidence, markClientConnectPending } from "../../src/client/state";
import { readDesktopDisconnectReceipt } from "../../src/claude/desktop-remote-store";
import { storePaths } from "../../src/claude/desktop-remote-store-io";
import { createLocalAttestationChallenge } from "../../src/lib/local-management-attestation";
import { createSystemRestartCapability, SYSTEM_RESTART_CAPABILITY_HEADER, SYSTEM_RESTART_EXPECTED_PID_HEADER,
  SYSTEM_RESTART_NONCE_HEADER, SYSTEM_RESTART_PATH } from "../../src/lib/system-restart-contract";

const options = JSON.parse(readFileSync(0, "utf8")) as { mode: string; scheduled?: boolean };
let phase: string;
function enterPhase(name: string): void {
  phase = name;
  // Flush before synchronous filesystem work so a parent timeout retains the last transition.
  writeSync(1, `recovery phase ${Math.round(performance.now())}ms: ${name}\n`);
}
enterPhase("fixture setup");
const home = process.env.OPENCODEX_HOME!;
mkdirSync(home, { recursive: true });
const lifecycle = await import("../../src/client/lifecycle-lock");
const lock = lifecycle.withClientLifecycleSync, asyncLock = lifecycle.withClientLifecycle;
const lifecycleLockDeps = { lockPath: join(dirname(home), "runtime", "lifecycle.sqlite") };
mock.module("../../src/client/lifecycle-lock", () => ({ ...lifecycle,
  withClientLifecycleSync: (work: Parameters<typeof lock>[0], deps?: Parameters<typeof lock>[1]) => lock(work, { lockPath: deps?.lockPath ?? lifecycleLockDeps.lockPath }),
  withClientLifecycle: (work: Parameters<typeof asyncLock>[0], deps?: Parameters<typeof asyncLock>[1]) => asyncLock(work, { lockPath: deps?.lockPath ?? lifecycleLockDeps.lockPath }),
}));

async function main() {
  const token = `ocx_data_${"c".repeat(40)}`;
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const fixtureHome = unavailableFixtureHome();
  const config = getDefaultConfig(); config.port = probe.port!;
  config.runtimeRole = "client";
  config.client = { serverUrl: fixtureHome.url.origin, managementUrl: fixtureHome.url.origin, managementTransport: "direct", transport: "link",
    link: { tunnelPort: fixtureHome.port!, linkId: "lnk_0123456789abcdef" }, selectedClients: ["pi"], tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
    apiKeyId: "fixture-client", tokenFingerprint: serviceApiTokenFingerprint(token), protocolVersion: 1, connectedAt: "2026-10-01T00:00:00.000Z" };
  saveConfig(config); writeServiceApiTokenFile(token);
  const expected = structuredClone(config.client);
  process.env.PI_CODING_AGENT_DIR = join(process.env.HOME!, ".pi", "agent");
  const { INTEGRATION_CLIENTS } = await import("../../src/integrations/registry");
  const path = INTEGRATION_CLIENTS.pi.configPath(process.env, process.env.HOME!);
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '{"userSetting":"keep"}\n');
  const { ROUTE_CLIENT_IDS } = await import("../../src/link/route-intent");
  const { applyConnectedRouteIntent } = await import("../../src/integrations/route-intent-connected");
  const document = { version: 1 as const, home: { name: "fixture", version: "1" },
    clients: Object.fromEntries(ROUTE_CLIENT_IDS.map(id => [id, { enabled: id === "pi" }])),
    sources: Object.fromEntries(ROUTE_CLIENT_IDS.map(id => [id, "default"])) } as import("../../src/link/route-intent").HomeRouteIntentDocument;
  enterPhase("applying the file route");
  const applied = await applyConnectedRouteIntent(expected, token, { document, stale: false, fetchedAt: "2026-11-16T00:00:00.000Z" },
    { onlyClients: ["pi"], lifecycleLockDeps }, { fetchImpl: (async () => Response.json({ data: [{ id: "fixture/home-model" }] })) as typeof fetch });
  if (applied?.outcomes.find(row => row.client === "pi")?.outcome !== "current") throw new Error("fixture apply failed");
  const edited = JSON.parse(readFileSync(path, "utf8")); edited.providers.opencodex.apiKey = "operator-edited-placeholder";
  writeFileSync(path, JSON.stringify(edited));

  let signalEntered!: () => void, signalRefused!: () => void;
  const entered = new Promise<void>(resolve => { signalEntered = resolve; });
  const refused = new Promise<void>(resolve => { signalRefused = resolve; });
  const error = console.error;
  console.error = (...args: unknown[]) => { error(...args); if (args.some(value => String(value).includes("The listener remains bound"))) signalRefused(); };
  if (options.mode === "signal-active") {
    const routing = await import("../../src/client/stop-routing");
    mock.module("../../src/client/stop-routing", () => ({ ...routing, restoreLinkClientRoutingBeforeExit: async () => {
      signalEntered(); return await new Promise<never>(() => {});
    } }));
  }

  let spawned = 0;
  const observations: Record<string, unknown> = {};
  const report = async (role: string) => {
    const receipt = readDesktopDisconnectReceipt();
    console.log(JSON.stringify({ ...observations, role, spawned, file: JSON.parse(readFileSync(path, "utf8")),
      state: readClientConnectionStateWithEvidence().kind, token: readServiceApiTokenState().kind,
      phase: receipt.kind === "valid" ? receipt.value.phase : receipt.kind,
      marker: readRuntimePort(process.pid)?.clientStopRequested, runtimePresent: readRuntimePort(process.pid) !== null }));
  };
  const replacement = await import("../../src/server/restart-replacement");
  mock.module("../../src/server/restart-replacement", () => ({ ...replacement, spawnReplacementStart: async (request: { port: number }) => {
    spawned++;
    enterPhase("binding the replacement listener");
    // A successful bind proves the real Child listener released its port. No native coordinator,
    // provider request or external process participates in this replacement seam.
    const server = Bun.serve({ hostname: "127.0.0.1", port: request.port, fetch: () => Response.json({ role: "standalone" }) });
    try {
      const health = await (await fetch(new URL("/healthz", server.url), { headers: { Connection: "close" } })).json() as { role: string };
      await report(health.role);
    } finally {
      await server.stop(true);
    }
  } }));
  // This fixture runs CLI preflight and the Child together. Model the CLI incarnation
  // with the real process's creation identity, preserving stale-proof detection.
  const owner = await import("../../src/client/stop-teardown-owner");
  const observeOwner = owner.observeClientStopOwner;
  mock.module("../../src/client/stop-teardown-owner", () => ({ ...owner,
    observeClientStopOwner: (proof: ClientStopOwner) => {
      if (proof.nonce === "malformed" || proof.startTime === "malformed") return observeOwner(proof);
      const observedStart = options.mode === "parent-unverified" ? undefined : owner.readClientStopProcessStart(proof.pid);
      if (observedStart === undefined) return "unverified";
      return observedStart === proof.startTime ? "active" : "confirmed-stale";
    },
  }));
  const { startClientRuntime, scheduleStandaloneRecycle } = await import("../../src/client/runtime");
  const { startMachineListener } = await import("../../src/client/machine-listener");
  const { isAddrInUse } = await import("../../src/server/ports");
  enterPhase("starting the Child listener");
  // Keep the selected port reserved while preparing the fixture and loading the runtime.
  await probe.stop(true);
  try {
    await startClientRuntime({ block: false }, { restartSupervisor: async () => null,
      startListener: (port, deps) => {
        try { return startMachineListener(port, deps); }
        catch (error) {
          // Only a proven bind collision requests a fresh, fully owned fixture from the parent.
          if (isAddrInUse(error)) throw new Error("fixture-port-collision");
          throw error;
        }
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "fixture-port-collision") {
      console.error("fixture-port-collision"); process.exit(75);
    }
    throw error;
  }
  // The parent bounds setup; the existing phase watchdog starts only once the Child serves.
  setTimeout(() => {
    console.error(`recovery fixture timed out 10s after listener startup (${options.mode}: ${phase})`);
    process.exit(1);
  }, 10_000).unref();
  const pendingRecycle = options.mode === "signal-pending-recycle";
  let lastRecycleTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleAndCountTimers = () => {
    const timer = spyOn(globalThis, "setTimeout");
    try {
      scheduleStandaloneRecycle(expected.tokenFingerprint);
      const index = timer.mock.calls.findIndex(([, delay]) => delay === 50);
      lastRecycleTimer = index < 0 ? undefined : timer.mock.results[index]!.value;
      return timer.mock.calls.filter(([, delay]) => delay === 50).length;
    } finally { timer.mockRestore(); }
  };
  const restart = async () => {
    const runtime = readRuntimePort(process.pid)!;
    const nonce = createLocalAttestationChallenge();
    const response = await fetch(`http://127.0.0.1:${config.port}${SYSTEM_RESTART_PATH}`, { method: "POST", headers: {
      Connection: "close",
      [SYSTEM_RESTART_EXPECTED_PID_HEADER]: String(process.pid), [SYSTEM_RESTART_NONCE_HEADER]: nonce,
      [SYSTEM_RESTART_CAPABILITY_HEADER]: createSystemRestartCapability(runtime.attestationSecret!, nonce, "POST", SYSTEM_RESTART_PATH, process.pid, config.port),
    } });
    await response.arrayBuffer();
    if (response.status === 202) enterPhase("restart request accepted");
    return response.status;
  };
  let finishStop: () => Promise<void> = async () => {};
  enterPhase("observing the refused stop");
  if (options.mode.startsWith("signal")) {
    // Queue and signal in one turn so the first timer is still pending at shutdown.
    if (pendingRecycle) {
      observations.firstRecycleTimers = scheduleAndCountTimers();
      const original = lastRecycleTimer;
      if (original === undefined) throw new Error("fixture did not create the first recycle timer");
      const cancel = spyOn(globalThis, "clearTimeout");
      try {
        process.emit("SIGTERM", "SIGTERM");
        observations.firstRecycleCanceled = cancel.mock.calls.some(([timer]) => timer === original);
      } finally { cancel.mockRestore(); }
    } else process.emit("SIGTERM", "SIGTERM");
    await (options.mode === "signal-active" ? entered : refused);
  } else {
    const { preflightConnectedClientStop } = await import("../../src/cli/stop-restore");
    const outcome = await preflightConnectedClientStop({ pid: process.pid, port: config.port }, finish => { finishStop = finish; });
    observations.stopRefused = outcome !== null && outcome !== "already-stopped" && !outcome.ok;
    observations.activeAdmission = await restart(); // Latch the active marker before finalization.
    if (["parent-stale-owner", "parent-malformed", "parent-malformed-start"].includes(options.mode)) {
      const runtimePath = join(home, "runtime-port.json");
      const disk = JSON.parse(readFileSync(runtimePath, "utf8"));
      const currentStart: string = disk.clientStopOwner.startTime;
      const otherStart = currentStart.replace(/:\d+$/, value => value === ":0" ? ":1" : `:${BigInt(value.slice(1)) - 1n}`);
      if (options.mode === "parent-malformed") disk.clientStopOwner.nonce = "malformed";
      else disk.clientStopOwner.startTime = options.mode === "parent-malformed-start" ? "malformed" : otherStart;
      writeFileSync(runtimePath, JSON.stringify(disk));
    } else if (!["parent-active", "parent-unverified"].includes(options.mode)) await finishStop();
  }
  observations.beforeRecoveryAdmission = await restart();
  observations.finishedMarker = readRuntimePort(process.pid)?.clientStopRequested;
  enterPhase("disconnecting the Child");
  const { disconnectClient } = await import("../../src/client/connect");
  await disconnectClient({ recoverConfig: true }, { lifecycleLockDeps });
  const receiptPath = storePaths().disconnect;
  if (["pending", "foreign-owner", "wrong-token"].includes(options.mode)) {
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (options.mode === "pending") receipt.phase = "clearing_connection";
    if (options.mode === "foreign-owner") receipt.owner.apiKeyId = "another-client";
    if (options.mode === "wrong-token") receipt.tokenFingerprint = "d".repeat(64);
    writeFileSync(receiptPath, JSON.stringify(receipt));
  }
  if (options.mode === "corrupt-receipt") writeFileSync(receiptPath, "{");
  if (options.mode === "missing-config") unlinkSync(join(home, "config.json"));
  if (options.mode === "new-connection") { config.client!.connectedAt = "2026-11-16T01:00:00.000Z"; saveConfig(config); }
  if (options.mode === "pending-connect") markClientConnectPending("b".repeat(64));
  enterPhase("observing restart or recycle after disconnect");
  if (pendingRecycle) {
    observations.recoveryRecycleTimers = scheduleAndCountTimers();
    if (observations.recoveryRecycleTimers === 0) {
      const health = await (await fetch(`http://127.0.0.1:${config.port}/healthz`)).json() as { role: string };
      await report(health.role); process.exit(0);
    }
    return; // The scheduled replacement reports after binding the released listener's port.
  } else if (options.mode === "timer-parent-active") {
    const { markClientRuntimeStopping } = await import("../../src/client/sync-runtime");
    const runtime = readRuntimePort(process.pid)!;
    const startTime = owner.readClientStopProcessStart(process.pid);
    if (!startTime) throw new Error("fixture stop creation identity unavailable");
    // Queue the recycle and publish the stop in the same turn. Loading the
    // marker module after scheduling could yield to the timer on a busy runner.
    if (scheduleAndCountTimers() !== 1) throw new Error("fixture did not schedule the pre-stop recycle");
    markClientRuntimeStopping(
      { pid: process.pid, port: config.port, attestationSecret: runtime.attestationSecret! },
      { pid: process.pid, startTime, nonce: "b".repeat(32) },
    );
  } else if (options.scheduled) {
    if (scheduleAndCountTimers() !== 1) throw new Error("fixture did not schedule the post-disconnect recycle");
  } else observations.recoveryAdmission = await restart();
  if (["parent", "signal"].includes(options.mode) && !options.scheduled && observations.recoveryAdmission !== 202) {
    const health = await (await fetch(`http://127.0.0.1:${config.port}/healthz`)).json() as { role: string };
    await report(health.role); process.exit(0);
  }
  if (!["parent", "signal", "parent-stale-owner"].includes(options.mode) || options.mode === "parent-stale-owner" && observations.recoveryAdmission !== 202) {
    // Also exercise the scheduled callback; neither path may replace an active or unproven owner.
    scheduleStandaloneRecycle(expected.tokenFingerprint);
    await Bun.sleep(350);
    const health = await (await fetch(`http://127.0.0.1:${config.port}/healthz`)).json() as { role: string };
    await report(health.role);
    process.exit(0); // Dispose only this synthetic retained runtime after observing it.
  }
}

try { await main(); } catch (error) { console.error(error); process.exit(1); }
