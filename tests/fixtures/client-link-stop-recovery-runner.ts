/** Real file recovery and bound restart; only replacement process launch is a loopback fixture. */
import { mock, spyOn } from "bun:test";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { serviceApiTokenFingerprint, writeServiceApiTokenFile, readServiceApiTokenState } from "../../src/lib/service-secrets";
import { readRuntimePort } from "../../src/config/process-state";
import { readClientConnectionStateWithEvidence, markClientConnectPending } from "../../src/client/state";
import { readDesktopDisconnectReceipt } from "../../src/claude/desktop-remote-store";
import { storePaths } from "../../src/claude/desktop-remote-store-io";
import { createLocalAttestationChallenge } from "../../src/lib/local-management-attestation";
import { createSystemRestartCapability, SYSTEM_RESTART_CAPABILITY_HEADER, SYSTEM_RESTART_EXPECTED_PID_HEADER,
  SYSTEM_RESTART_NONCE_HEADER, SYSTEM_RESTART_PATH } from "../../src/lib/system-restart-contract";

const options = JSON.parse(readFileSync(0, "utf8")) as { mode: string; scheduled?: boolean };
const home = process.env.OPENCODEX_HOME!;
mkdirSync(home, { recursive: true });
const lifecycle = await import("../../src/client/lifecycle-lock");
const lock = lifecycle.withClientLifecycleSync, asyncLock = lifecycle.withClientLifecycle;
const lifecycleLockDeps = { lockPath: join(home, "lifecycle.sqlite") };
mock.module("../../src/client/lifecycle-lock", () => ({ ...lifecycle,
  withClientLifecycleSync: (work: Parameters<typeof lock>[0], deps?: Parameters<typeof lock>[1]) => lock(work, { lockPath: deps?.lockPath ?? lifecycleLockDeps.lockPath }),
  withClientLifecycle: (work: Parameters<typeof asyncLock>[0], deps?: Parameters<typeof asyncLock>[1]) => asyncLock(work, { lockPath: deps?.lockPath ?? lifecycleLockDeps.lockPath }),
}));

async function main() {
  const token = `ocx_data_${"c".repeat(40)}`;
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const config = getDefaultConfig(); config.port = probe.port!; await probe.stop(true);
  config.runtimeRole = "client";
  config.client = { serverUrl: "http://127.0.0.1:34567", managementUrl: "http://127.0.0.1:34567", managementTransport: "direct", transport: "link",
    link: { tunnelPort: 34567, linkId: "lnk_0123456789abcdef" }, selectedClients: ["pi"], tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
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
    // A successful bind proves the real Child listener released its port. No native coordinator,
    // provider request or external process participates in this replacement seam.
    const server = Bun.serve({ hostname: "127.0.0.1", port: request.port, fetch: () => Response.json({ role: "standalone" }) });
    const health = await (await fetch(new URL("/healthz", server.url))).json() as { role: string };
    await report(health.role); await server.stop(true);
  } }));
  const { startClientRuntime, scheduleStandaloneRecycle } = await import("../../src/client/runtime");
  await startClientRuntime({ block: false }, { restartSupervisor: async () => null });
  const pendingRecycle = options.mode === "signal-pending-recycle";
  const scheduleAndCountTimers = () => {
    const timer = spyOn(globalThis, "setTimeout");
    try {
      scheduleStandaloneRecycle(expected.tokenFingerprint);
      return timer.mock.calls.filter(([, delay]) => delay === 50).length;
    } finally { timer.mockRestore(); }
  };
  const restart = async () => {
    const runtime = readRuntimePort(process.pid)!;
    const nonce = createLocalAttestationChallenge();
    const response = await fetch(`http://127.0.0.1:${config.port}${SYSTEM_RESTART_PATH}`, { method: "POST", headers: {
      [SYSTEM_RESTART_EXPECTED_PID_HEADER]: String(process.pid), [SYSTEM_RESTART_NONCE_HEADER]: nonce,
      [SYSTEM_RESTART_CAPABILITY_HEADER]: createSystemRestartCapability(runtime.attestationSecret!, nonce, "POST", SYSTEM_RESTART_PATH, process.pid, config.port),
    } });
    await response.arrayBuffer(); return response.status;
  };
  let finishStop: () => Promise<void> = async () => {};
  if (options.mode.startsWith("signal")) {
    // Queue and signal in one turn so the first timer is still pending at shutdown.
    if (pendingRecycle) observations.firstRecycleTimers = scheduleAndCountTimers();
    process.emit("SIGTERM", "SIGTERM");
    await (options.mode === "signal-active" ? entered : refused);
  } else {
    const { preflightConnectedClientStop } = await import("../../src/cli/stop-restore");
    const outcome = await preflightConnectedClientStop({ pid: process.pid, port: config.port }, finish => { finishStop = finish; });
    observations.stopRefused = outcome !== null && outcome !== "already-stopped" && !outcome.ok;
    observations.activeAdmission = await restart(); // Latch the active marker before finalization.
    if (options.mode !== "parent-active") await finishStop();
  }
  observations.beforeRecoveryAdmission = await restart();
  observations.finishedMarker = readRuntimePort(process.pid)?.clientStopRequested;
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
  if (pendingRecycle) {
    observations.recoveryRecycleTimers = scheduleAndCountTimers();
    if (observations.recoveryRecycleTimers === 0) {
      const health = await (await fetch(`http://127.0.0.1:${config.port}/healthz`)).json() as { role: string };
      await report(health.role); process.exit(0);
    }
    return; // The scheduled replacement reports after binding the released listener's port.
  } else if (options.mode === "timer-parent-active") {
    scheduleStandaloneRecycle(expected.tokenFingerprint);
    const runtime = readRuntimePort(process.pid)!;
    (await import("../../src/client/sync-runtime")).markClientRuntimeStopping({ pid: process.pid, port: config.port, attestationSecret: runtime.attestationSecret! }, { explicitStop: true });
  } else if (options.scheduled) scheduleStandaloneRecycle(expected.tokenFingerprint);
  else observations.recoveryAdmission = await restart();
  if (["parent", "signal"].includes(options.mode) && !options.scheduled && observations.recoveryAdmission !== 202) {
    const health = await (await fetch(`http://127.0.0.1:${config.port}/healthz`)).json() as { role: string };
    await report(health.role); process.exit(0);
  }
  if (!["parent", "signal"].includes(options.mode)) {
    // Also exercise the scheduled callback; neither path may replace an active or unproven owner.
    scheduleStandaloneRecycle(expected.tokenFingerprint);
    await Bun.sleep(350);
    const health = await (await fetch(`http://127.0.0.1:${config.port}/healthz`)).json() as { role: string };
    await report(health.role);
    process.exit(0); // Dispose only this synthetic retained runtime after observing it.
  }
}

const deadline = setTimeout(() => { console.error("recovery fixture timed out"); process.exit(1); }, 10_000);
deadline.unref();
try { await main(); } catch (error) { console.error(error); process.exit(1); }
