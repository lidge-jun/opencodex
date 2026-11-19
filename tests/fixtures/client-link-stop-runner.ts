/** Isolated disk and native-runtime coverage for a connected Link Child's stop. */
import { mock } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { CODEX_CONFIG_PATH, CODEX_HOME, CODEX_PROFILE_PATH, DEFAULT_CATALOG_PATH } from "../../src/codex/paths";
import { JOURNAL_PATH, markJournalInjectedState, writeJournal } from "../../src/codex/journal";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import { ensureCatalogBackup } from "../../src/codex/catalog/parsing";
import { takeDesktopSupervisedMarker } from "../../src/lib/system-restart-contract";
import { claimPendingTeardown } from "../../src/config/pending-teardown";

const options = JSON.parse(readFileSync(0, "utf8")) as {
  mode: "runtime" | "helper" | "api" | "parent" | "guard" | "retry";
  transport?: "link" | "hub";
  signal?: NodeJS.Signals;
  osSignal?: boolean;
  syncBeforeStop?: boolean;
  externalSignal?: boolean;
  holdShutdown?: boolean;
  runtimeRecord?: "absent" | "invalid" | "foreign";
  retryError?: "busy" | "locked" | "exhausted" | "permission" | "unwrapped" | "identity";
  repeat?: boolean;
  preserve?: "service" | "desktop" | "receipt" | "sibling" | "restart" | "restart-rollback" | "recycle-pending" | "restart-rollback-recycle";
  mutation?: "connection" | "journal" | "process-journal" | "config" | "profile" | "unverified" | "selection" | "oversized" | "nonregular" | "rotation" | "hub" | "catalog" | "prior-catalog" | "api-key" | "token" | "management" | "link-id";
};
const home = process.env.OPENCODEX_HOME!;
mkdirSync(CODEX_HOME, { recursive: true });
mkdirSync(home, { recursive: true });
const lifecycle = await import("../../src/client/lifecycle-lock");
const lock = lifecycle.withClientLifecycleSync;
mock.module("../../src/client/lifecycle-lock", () => ({ ...lifecycle,
  withClientLifecycleSync: (work: Parameters<typeof lock>[0]) => lock(work, { lockPath: join(home, "lifecycle.sqlite") }),
}));
const token = `ocx_data_${"c".repeat(40)}`;
const config = getDefaultConfig();
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
config.port = probe.port!;
await probe.stop(true);
config.runtimeRole = "client";
config.client = {
  serverUrl: options.transport === "hub" ? "https://hub.example.test" : "http://127.0.0.1:34567",
  managementUrl: options.transport === "hub" ? "https://hub.example.test" : "http://127.0.0.1:34567",
  managementTransport: "direct", transport: options.transport ?? "link",
  ...(options.transport === "hub" ? {} : { link: { tunnelPort: 34567, linkId: "lnk_0123456789abcdef" } }),
  selectedClients: ["codex"], tokenEnv: "OPENCODEX_API_AUTH_TOKEN", apiKeyId: "fixture-client",
  tokenFingerprint: serviceApiTokenFingerprint(token), protocolVersion: 1, connectedAt: "2026-10-01T00:00:00.000Z",
};
saveConfig(config);
const expected = structuredClone(config.client);
const original = 'model = "native"\n';
const injected = `# Auto-injected by opencodex (undo: ocx restore)\nopenai_base_url = "http://127.0.0.1:${config.port}/v1"\n${original}`;
writeFileSync(CODEX_CONFIG_PATH, original);
writeJournal({ currentStateIsNative: true, owner: { kind: "client", apiKeyId: expected.apiKeyId } });
writeFileSync(CODEX_CONFIG_PATH, injected);
writeFileSync(CODEX_PROFILE_PATH, 'model = "managed"\n');
markJournalInjectedState(injected, 'model = "managed"\n', {
  injectedOpenaiBaseUrl: `http://127.0.0.1:${config.port}/v1`, injectedRealtimeWsBaseUrl: null, injectedCatalogPath: DEFAULT_CATALOG_PATH,
});
const nativeCatalog = { models: [{ slug: "fixture-native", visibility: "list" }] };
writeFileSync(DEFAULT_CATALOG_PATH, JSON.stringify(nativeCatalog));
ensureCatalogBackup(DEFAULT_CATALOG_PATH, nativeCatalog);
writeFileSync(DEFAULT_CATALOG_PATH, '{"models":[{"slug":"fixture/home-model"}]}');
writeFileSync(join(home, "service-api-token"), token);
const grokHome = join(home, "grok");
process.env.GROK_HOME = grokHome;
mkdirSync(grokHome, { recursive: true });
const grokPath = join(grokHome, "config.toml");
const grokNative = 'theme = "fixture"\n';
writeFileSync(grokPath, grokNative + '\n# >>> opencodex managed block — do not edit (removed by `ocx stop`) >>>\n[model_providers.opencodex]\nbase_url = "http://127.0.0.1:10100/v1"\n# <<< opencodex managed block <<<\n');
const mutate = () => {
  if (options.mutation === "catalog") { config.client!.catalogFingerprint = "synced"; config.client!.catalogSyncedAt = "2026-10-31T00:00:00.000Z"; saveConfig(config); }
  if (options.mutation === "prior-catalog") { config.client!.priorCatalog = ""; saveConfig(config); }
  if (options.mutation === "api-key") { config.client!.apiKeyId = "other-client"; saveConfig(config); }
  if (options.mutation === "token") { config.client!.tokenFingerprint = serviceApiTokenFingerprint("different-token"); saveConfig(config); }
  if (options.mutation === "management") { config.client!.managementUrl = "https://other.example.test"; saveConfig(config); }
  if (options.mutation === "link-id") { config.client!.link!.linkId = "lnk_fedcba9876543210"; saveConfig(config); }
  if (options.mutation === "connection") { config.client!.connectedAt = "2026-10-02T00:00:00.000Z"; saveConfig(config); }
  if (options.mutation === "selection") { config.client!.selectedClients = ["claude"]; saveConfig(config); }
  if (options.mutation === "hub") {
    delete config.client!.transport; delete config.client!.link;
    config.client!.serverUrl = config.client!.managementUrl = "https://hub.example.test";
    saveConfig(config);
  }
  if (options.mutation === "rotation") {
    config.client!.pendingOperation = { kind: "rotate", rotationId: "fixture-rotation", newKeyIssuedAt: "2026-10-02T00:00:00.000Z", oldKeyBackupPath: join(home, "token.prev") };
    saveConfig(config);
  }
  if (options.mutation === "journal" || options.mutation === "process-journal" || options.mutation === "unverified") {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8"));
    if (options.mutation === "unverified") delete journal.injectedConfigHash;
    else journal.owner = options.mutation === "journal" ? { kind: "client", apiKeyId: "another-client" } : { kind: "process", pid: process.pid };
    writeFileSync(JOURNAL_PATH, JSON.stringify(journal));
  }
  if (options.mutation === "config") writeFileSync(CODEX_CONFIG_PATH, injected + 'approval_policy = "on-request"\n');
  if (options.mutation === "profile") writeFileSync(CODEX_PROFILE_PATH, 'model = "operator-edit"\n');
  if (options.mutation === "oversized" || options.mutation === "nonregular") {
    unlinkSync(JOURNAL_PATH);
    if (options.mutation === "oversized") writeFileSync(CODEX_CONFIG_PATH, " ".repeat(1024 * 1024 + 1));
    else { unlinkSync(CODEX_CONFIG_PATH); mkdirSync(CODEX_CONFIG_PATH); }
  }
};
if (options.mode !== "runtime" && options.mode !== "guard") mutate();
const protectedPaths = [join(home, "config.json"), join(home, "service-api-token")];
let protectedBefore = protectedPaths.map(path => readFileSync(path, "utf8"));
const catalogBefore = readFileSync(DEFAULT_CATALOG_PATH, "utf8");
const grokBefore = readFileSync(grokPath, "utf8");
const configContents = () => statSync(CODEX_CONFIG_PATH).isFile() ? readFileSync(CODEX_CONFIG_PATH, "utf8") : "<nonregular>";
const before = configContents();
const profileBefore = readFileSync(CODEX_PROFILE_PATH, "utf8");
let syncEvidence: { changedFields: string[]; fullCasRefused: boolean; catalogWritten: boolean; injected: boolean; journalHomeBound: boolean } | undefined;
const snapshot = (result: unknown) => ({
  result, before, profileBefore, syncEvidence, after: configContents(),
  profileAfter: existsSync(CODEX_PROFILE_PATH) ? readFileSync(CODEX_PROFILE_PATH, "utf8") : null,
  journalRetained: existsSync(JOURNAL_PATH),
  journalHomeBound: existsSync(JOURNAL_PATH) && typeof JSON.parse(readFileSync(JOURNAL_PATH, "utf8")).opencodexHome === "string",
  protectedUnchanged: protectedPaths.every((path, index) => readFileSync(path, "utf8") === protectedBefore[index]),
  catalogBefore, catalogAfter: JSON.parse(readFileSync(DEFAULT_CATALOG_PATH, "utf8")),
  grokBefore, grokAfter: readFileSync(grokPath, "utf8"),
});
const report = (result: unknown) => writeFileSync(join(home, "result.json"), JSON.stringify(snapshot(result)));
process.on("exit", () => writeFileSync(join(home, "exit.json"), JSON.stringify(snapshot(null))));
if (options.preserve === "service") process.env.OCX_SERVICE = "1";
if (options.preserve === "desktop") takeDesktopSupervisedMarker({ OCX_DESKTOP_SUPERVISED: "1" });
if (options.preserve === "receipt") claimPendingTeardown({ hostname: "127.0.0.1", port: config.port }, "exact");
if (options.preserve === "sibling") (await import("../../src/codex/sibling-start")).markSiblingStart(10100);
if (options.mode === "retry") {
  const { ConfigMutationLockError } = await import("../../src/config");
  const { ClientSyncRuntimeError, markClientRuntimeStoppingWithRetry } = await import("../../src/client/sync-runtime");
  let attempts = 0;
  const waits: number[] = [];
  const success = await markClientRuntimeStoppingWithRetry({ pid: process.pid, port: config.port, attestationSecret: "unused-fixture-identity" }, {
    mark: () => {
      attempts += 1;
      if ((options.retryError === "busy" || options.retryError === "locked") && attempts === 3) return;
      if (options.retryError === "identity") throw new ClientSyncRuntimeError("client_runtime_changed");
      const cause = Object.assign(new Error("fixture acquisition failure"), { code: options.retryError === "permission" ? "EACCES" : options.retryError === "locked" ? "SQLITE_LOCKED" : "SQLITE_BUSY" });
      if (options.retryError === "unwrapped") throw cause;
      throw new ConfigMutationLockError("fixture acquisition failure", { cause });
    },
    sleep: async ms => { waits.push(ms); },
  });
  report({ success, attempts, waits });
} else if (options.mode === "guard") {
  const { stopRestoreWriteGuard } = await import("../../src/client/restore-ownership");
  const guard = stopRestoreWriteGuard(expected);
  const writes: string[] = [];
  guard.run(() => writes.push("before-change"));
  mutate();
  // A caller mutating its own snapshot cannot move an already-created guard's authority.
  Object.assign(expected, config.client);
  let refused = false;
  try { guard.run(() => writes.push("after-change")); } catch { refused = true; }
  protectedBefore = protectedPaths.map(path => readFileSync(path, "utf8"));
  report({ writes, refused, boundary: guard.boundary() });
} else if (options.mode === "runtime") {
  if (options.holdShutdown) {
    const diagnostics = await import("../../src/link/diagnostics");
    mock.module("../../src/link/diagnostics", () => ({ ...diagnostics, flushLinkDiagnostics: async () => {
      writeFileSync(join(home, "shutdown-drained"), "ready");
      while (!existsSync(join(home, "shutdown-release"))) await Bun.sleep(10);
    } }));
  }
  if (options.preserve?.startsWith("restart-rollback")) {
    const replacement = await import("../../src/server/restart-replacement");
    mock.module("../../src/server/restart-replacement", () => ({ ...replacement,
      spawnReplacementStart: async () => { throw Object.assign(new Error("fixture replacement refused"), { code: "not_ready" }); },
    }));
  }
  const { scheduleStandaloneRecycle, startClientRuntime } = await import("../../src/client/runtime");
  const { startMachineListener } = await import("../../src/client/machine-listener");
  let requestRestart: (() => Promise<unknown>) | undefined;
  await startClientRuntime({ block: false }, { restartSupervisor: () => options.preserve?.startsWith("restart-rollback") ? Promise.resolve(null) : new Promise(() => {}), startListener: (port, deps) => {
    requestRestart = deps?.restart?.request;
    const server = startMachineListener(port, deps);
    const stop = server.stop.bind(server);
    server.stop = ((close: boolean) => { report({ atListenerStop: true }); return stop(close); }) as typeof server.stop;
    return server;
  } });
  if (options.syncBeforeStop) {
    const { syncConnectedClient } = await import("../../src/client/connect");
    const { assertClientConnectionUnchanged } = await import("../../src/client/state");
    const synced = await syncConnectedClient({}, {
      fetchImpl: (async () => Response.json({ models: [{ slug: "fixture/synced" }] })) as typeof fetch,
      now: () => new Date("2026-10-31T00:00:00.000Z"),
      catalogCompatibility: { supportedEfforts: () => new Set(["low", "medium", "high"]) },
      linkHome: { fetchImpl: (async () => Response.json({}, { status: 404 })) as typeof fetch },
    });
    const keys = new Set([...Object.keys(expected), ...Object.keys(synced.connection)]);
    const changedFields = [...keys].filter(key => !Bun.deepEquals(Reflect.get(expected, key), Reflect.get(synced.connection, key))).sort();
    let fullCasRefused = false;
    try { assertClientConnectionUnchanged(expected); } catch { fullCasRefused = true; }
    syncEvidence = { changedFields, fullCasRefused, catalogWritten: synced.catalogWritten, injected: synced.injected,
      journalHomeBound: typeof JSON.parse(readFileSync(JOURNAL_PATH, "utf8")).opencodexHome === "string" };
  }
  if (options.runtimeRecord) {
    const path = join(home, "runtime-port.json");
    if (options.runtimeRecord === "absent") unlinkSync(path);
    else if (options.runtimeRecord === "invalid") writeFileSync(path, "{");
    else { const record = JSON.parse(readFileSync(path, "utf8")); record.pid += 100_000; writeFileSync(path, JSON.stringify(record)); }
  }
  mutate();
  protectedBefore = protectedPaths.map(path => readFileSync(path, "utf8"));
  if (options.preserve === "restart") {
    if (!requestRestart) throw new Error("fixture missing real restart admission");
    void requestRestart();
  }
  if (options.preserve?.startsWith("restart-rollback")) {
    if (!requestRestart) throw new Error("fixture missing real restart admission");
    await requestRestart();
  }
  if (options.preserve === "recycle-pending" || options.preserve === "restart-rollback-recycle") scheduleStandaloneRecycle(expected.tokenFingerprint);
  // Exercises the registered production handler; it is not evidence of native OS signal delivery.
  if (options.externalSignal) {
    writeFileSync(join(home, "ready"), "ready");
    while (!existsSync(join(home, "signal-now"))) await Bun.sleep(10);
    process.emit(options.signal ?? "SIGTERM", options.signal ?? "SIGTERM");
  } else if (options.osSignal) writeFileSync(join(home, "ready"), "ready");
  else process.emit(options.signal ?? "SIGTERM", options.signal ?? "SIGTERM");
} else {
  const result = options.mode === "api"
    ? await (await import("../../src/server/stop-teardown")).performStopTeardown(new URL("http://127.0.0.1:10100/api/stop?deferSharedTeardown=1&teardownNonce=fixture"), { ownsReceipt: () => true })
    : options.mode === "parent" ? await (await import("../../src/cli/stop-restore")).restoreSharedClientStateAfterStop(() => {})
    // The direct helper fixture has no runtime, async sync or other writer.
    : (await import("../../src/client/stop-routing")).restoreLinkClientRouting(expected, { syncFenced: true });
  const repeated = options.repeat ? (await import("../../src/client/stop-routing")).restoreLinkClientRouting(expected, { syncFenced: true }) : undefined;
  report(repeated ? { first: result, repeated } : result);
}
