/** Isolated disk and native-runtime coverage for a connected Link Child's stop. */
import { mock } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDefaultConfig, prepareConfigMutationDatabasePathForWrite, saveConfig } from "../../src/config";
import { CODEX_CONFIG_PATH, CODEX_HOME, CODEX_PROFILE_PATH, DEFAULT_CATALOG_PATH } from "../../src/codex/paths";
import { JOURNAL_PATH, markJournalInjectedState, writeJournal } from "../../src/codex/journal";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import { ensureCatalogBackup } from "../../src/codex/catalog/parsing";
import { takeDesktopSupervisedMarker } from "../../src/lib/system-restart-contract";
import { claimPendingTeardown, pendingTeardownOutstanding, pendingTeardownPathFor, quarantinePendingTeardown } from "../../src/config/pending-teardown";
import type { ClientStopOwner } from "../../src/config/process-state";
import type { StopTargetProof } from "../../src/cli/stop-restore";
import { randomBytes } from "node:crypto";

const options = JSON.parse(readFileSync(0, "utf8")) as {
  mode: "runtime" | "helper" | "api" | "parent" | "guard" | "retry" | "file-preflight" | "file-stop" | "file-cycle" | "file-restart-overlap" | "file-restart-control" | "offline-stop" | "termination";
  transport?: "link" | "hub";
  signal?: NodeJS.Signals;
  osSignal?: boolean;
  syncBeforeStop?: boolean;
  externalSignal?: boolean;
  holdShutdown?: boolean;
  runtimeRecord?: "absent" | "invalid" | "foreign" | "explicit-stop-unfenced";
  retryError?: "busy" | "locked" | "exhausted" | "permission" | "unwrapped" | "identity";
  repeat?: boolean;
  fileClients?: Array<"pi" | "opencode">;
  fileStandalone?: boolean;
  fileConflict?: boolean;
  fileOwnerChange?: boolean;
  fileOnly?: boolean;
  lateFileSync?: boolean;
  deferFileApply?: boolean;
  oldStopCapability?: boolean;
  missingStopRecord?: "absent" | "invalid";
  startIdentityChanges?: "request" | "escalation";
  failedRollback?: "before-rebind" | "during-rebind";
  legacyOwnerRecord?: boolean;
  stopConnectionDrift?: "invalid" | "mismatched" | "disconnected" | "other-link" | "hub";
  driftDuringFallback?: boolean;
  finishStopBeforeRollback?: boolean;
  unverifiedStopOwner?: boolean;
  receiptWriteFails?: boolean;
  installedUnit?: boolean;
  danglingServiceRecord?: boolean;
  busyStopFence?: boolean;
  busyRollbackPublication?: boolean;
  terminationPlatform?: "linux" | "darwin";
  siblingEscalation?: "stopping" | "different-generation";
  removeToken?: boolean;
  finalizeFailure?: boolean;
  repairFileRefusal?: boolean;
  observeFileRefusal?: boolean;
  observeNativeRefusal?: boolean;
  receiptState?: "live" | "abandoned" | "abandoned-guessed" | "abandoned-other" | "abandoned-unknown" | "abandoned-dead-other" | "quarantined" | "invalid" | "parent" | "parent-stale" | "parent-invalid" | "parent-start" | "parent-status" | "parent-unfenced" | "parent-finished" | "parent-port" | "parent-host" | "parent-guessed" | "parent-oversized" | "parent-nonregular" | "parent-symlink" | "parent-reused" | "parent-wrong-nonce" | "parent-spaced";
  preserve?: "service" | "desktop" | "receipt" | "sibling" | "restart" | "restart-rollback" | "recycle-pending" | "restart-rollback-recycle";
  mutation?: "connection" | "journal" | "process-journal" | "config" | "profile" | "unverified" | "selection" | "oversized" | "nonregular" | "rotation" | "hub" | "catalog" | "prior-catalog" | "api-key" | "token" | "management" | "link-id";
};
const home = process.env.OPENCODEX_HOME!;
mkdirSync(CODEX_HOME, { recursive: true });
mkdirSync(home, { recursive: true });
const lifecycle = await import("../../src/client/lifecycle-lock");
const lock = lifecycle.withClientLifecycleSync;
const asyncLock = lifecycle.withClientLifecycle;
mock.module("../../src/client/lifecycle-lock", () => ({ ...lifecycle,
  withClientLifecycleSync: (work: Parameters<typeof lock>[0], deps?: Parameters<typeof lock>[1]) => lock(work, { lockPath: deps?.lockPath ?? join(home, "lifecycle.sqlite") }),
  withClientLifecycle: (work: Parameters<typeof asyncLock>[0], deps?: Parameters<typeof asyncLock>[1]) => asyncLock(work, { lockPath: deps?.lockPath ?? join(home, "lifecycle.sqlite") }),
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
  selectedClients: ["codex", ...(options.deferFileApply ? [] : options.fileClients ?? [])], tokenEnv: "OPENCODEX_API_AUTH_TOKEN", apiKeyId: "fixture-client",
  tokenFingerprint: serviceApiTokenFingerprint(token), protocolVersion: 1, connectedAt: "2026-10-01T00:00:00.000Z",
};
saveConfig(config);
const expected = structuredClone(config.client);
const codexProbe = join(home, "unexpected-codex-discovery");
if (process.platform !== "win32") {
  const executable = join(home, "fixture-codex");
  writeFileSync(executable, '#!/bin/sh\n: > "$OPENCODEX_HOME/unexpected-codex-discovery"\nprintf "codex-cli 0.135.0\\n"\n', { mode: 0o700 });
  process.env.CODEX_CLI_PATH = executable;
}
// The fixture supplies its catalogs. Neither driver needs to launch an installed Codex
// CLI, whose Node wrapper can leave subprocesses and caches behind after the fixture exits.
const codexRuntime = await import("../../src/codex/runtime");
mock.module("../../src/codex/runtime", () => ({
  ...codexRuntime,
  resolveAndPersistCodexRuntime: (): import("../../src/codex/runtime").ResolveCodexRuntimeResult => ({
    runtime: { command: join(home, "unavailable-fixture-codex"), source: "environment", version: null }, failures: [],
  }),
  resolveAndPersistCodexRuntimeAsync: async () => null,
}));
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
const filePaths: Record<string, string> = {};
const fileOwnedBytes: Record<string, string> = {};
let preparedFileIntent: import("../../src/integrations/route-intent-connected").PreparedConnectedRouteIntent | undefined;
if (options.fileClients?.length) {
  process.env.XDG_CONFIG_HOME = join(process.env.HOME!, ".config");
  process.env.PI_CODING_AGENT_DIR = join(process.env.HOME!, ".pi", "agent");
  const { INTEGRATION_CLIENTS } = await import("../../src/integrations/registry");
  const writers = await import("../../src/integrations/writer");
  const { createIntegrationStateStore } = await import("../../src/integrations/store");
  const { ROUTE_CLIENT_IDS } = await import("../../src/link/route-intent");
  const { applyConnectedRouteIntent } = await import("../../src/integrations/route-intent-connected");
  for (const client of options.fileClients) {
    const spec = INTEGRATION_CLIENTS[client];
    const path = filePaths[client] = spec.configPath(process.env, process.env.HOME!);
    mkdirSync(spec.detectDir(process.env, process.env.HOME!), { recursive: true });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"fixtureUserSetting":"keep"}\n');
    if (options.fileStandalone) {
      const applied = writers.applyIntegration({ clientId: client, config, port: config.port,
        models: [{ namespaced: "fixture/native", provider: "fixture", id: "native" }], store: createIntegrationStateStore() });
      if (!applied.ok) throw new Error(applied.message);
    }
  }
  const document = { version: 1 as const, home: { name: "fixture", version: "1" },
    clients: Object.fromEntries(ROUTE_CLIENT_IDS.map(id => [id, { enabled: options.fileClients!.includes(id as "pi" | "opencode") }])),
    sources: Object.fromEntries(ROUTE_CLIENT_IDS.map(id => [id, "default"])) } as import("../../src/link/route-intent").HomeRouteIntentDocument;
  preparedFileIntent = { document, stale: false, fetchedAt: "2026-11-16T00:00:00.000Z" };
  const applied = options.deferFileApply ? undefined : await applyConnectedRouteIntent(expected, token, preparedFileIntent, {
    onlyClients: options.fileClients, lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
  }, { fetchImpl: (async () => Response.json({ data: [{ id: "fixture/home-model" }] })) as typeof fetch });
  for (const client of options.fileClients) {
    if (!options.deferFileApply && applied?.outcomes.find(row => row.client === client)?.outcome !== "current") throw new Error("fixture route apply failed");
    fileOwnedBytes[client] = readFileSync(filePaths[client]!, "utf8");
  }
  if (options.fileConflict) {
    const path = filePaths.pi!;
    const changed = JSON.parse(fileOwnedBytes.pi!); changed.providers.opencodex.apiKey = "operator-edited-placeholder";
    writeFileSync(path, JSON.stringify(changed));
  }
  if (options.fileOwnerChange) {
    const disable = writers.disableIntegrationCoordinated;
    mock.module("../../src/integrations/writer", () => ({ ...writers, disableIntegrationCoordinated: async (...args: Parameters<typeof disable>) => {
      config.client!.connectedAt = "2026-11-16T01:00:00.000Z"; saveConfig(config);
      return disable(...args);
    } }));
  }
}
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
let fileRefusal: { bound: boolean; stopping: boolean; before: Record<string, string> } | undefined;
let fileLateResult: string | undefined;
let fileSyncFlight: Promise<void> | undefined;
let releaseFileModels: (() => void) | undefined;
const snapshot = (result: unknown) => ({
  result, before, profileBefore, syncEvidence, after: configContents(),
  profileAfter: existsSync(CODEX_PROFILE_PATH) ? readFileSync(CODEX_PROFILE_PATH, "utf8") : null,
  journalRetained: existsSync(JOURNAL_PATH),
  journalHomeBound: existsSync(JOURNAL_PATH) && typeof JSON.parse(readFileSync(JOURNAL_PATH, "utf8")).opencodexHome === "string",
  protectedUnchanged: protectedPaths.every((path, index) => existsSync(path) && readFileSync(path, "utf8") === protectedBefore[index]),
  catalogBefore, catalogAfter: JSON.parse(readFileSync(DEFAULT_CATALOG_PATH, "utf8")),
  grokBefore, grokAfter: readFileSync(grokPath, "utf8"),
  fileOwnedBytes, fileAfter: Object.fromEntries(Object.entries(filePaths).map(([id, path]) => [id, readFileSync(path, "utf8")])), fileRefusal, fileLateResult,
  teardownOutstanding: pendingTeardownOutstanding(), codexDiscovery: existsSync(codexProbe),
});
const report = (result: unknown) => writeFileSync(join(home, "result.json"), JSON.stringify(snapshot(result)));
process.on("exit", () => writeFileSync(join(home, "exit.json"), JSON.stringify(snapshot(null))));
function holdConfigLock() {
  const db = new Database(prepareConfigMutationDatabasePathForWrite());
  db.exec("BEGIN IMMEDIATE");
  setTimeout(() => db.close(), 120);
}
let receiptOwner: ClientStopOwner | undefined;
if (options.preserve === "service") process.env.OCX_SERVICE = "1";
if (options.preserve === "desktop") takeDesktopSupervisedMarker({ OCX_DESKTOP_SUPERVISED: "1" });
if (options.preserve === "receipt") {
  let ownerPid = process.pid;
  if (options.receiptState?.startsWith("abandoned")) {
    const owner = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
    await owner.exited; ownerPid = owner.pid;
  }
  if (options.receiptState?.startsWith("parent")) {
    // An owned, inert process supplies real argv/UID/liveness observations. It never
    // runs the CLI; the fixture sets the real exact-runtime stop marker below.
    const path = join(home, process.platform === "linux" || options.receiptState === "parent-spaced" ? "fixture owner" : "fixture-owner", "src", "cli", "index.ts");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'console.log("ready"); setInterval(() => {}, 1000);');
    const verb = options.receiptState === "parent-start" ? "start" : options.receiptState === "parent-status" ? "status" : "stop";
    const owner = Bun.spawn([process.execPath, path, `--ocx-internal-launch-proof=${"a".repeat(43)}`, verb, "--json"], { stdout: "pipe", stderr: "ignore" });
    process.on("exit", () => owner.kill("SIGKILL"));
    const reader = owner.stdout.getReader();
    const ready = await reader.read(); reader.releaseLock();
    if (!ready.value || !new TextDecoder().decode(ready.value).includes("ready")) throw new Error("fixture owner did not start");
    ownerPid = owner.pid;
    const { readClientStopProcessStart } = await import("../../src/client/stop-teardown-owner");
    const observedStart = readClientStopProcessStart(ownerPid);
    if (!observedStart) throw new Error("fixture stop process creation identity unavailable");
    const startTime = options.receiptState === "parent-reused"
      ? observedStart.replace(/:\d+$/, value => value === ":0" ? ":1" : `:${BigInt(value.slice(1)) - 1n}`)
      : observedStart;
    receiptOwner = { pid: ownerPid, nonce: randomBytes(16).toString("hex"), startTime };
  }
  const other = ["abandoned-other", "abandoned-unknown", "abandoned-dead-other"].includes(options.receiptState ?? "")
    ? Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => options.receiptState === "abandoned-unknown"
      ? new Response(null, { status: 503 }) : Response.json({ service: "opencodex", version: "1.0.0", pid: process.pid }) }) : null;
  const otherPort = other?.port;
  if (options.receiptState === "abandoned-dead-other") await other?.stop(true);
  const guessed = options.receiptState === "parent-guessed" || options.receiptState === "abandoned-guessed";
  const receipt = claimPendingTeardown({ hostname: options.receiptState === "parent-host" ? "192.0.2.10" : "127.0.0.1",
    port: otherPort ?? (options.receiptState === "parent-port" ? (config.port === 65535 ? config.port - 1 : config.port + 1) : config.port) },
  guessed ? "guessed" : "exact", ownerPid, undefined, undefined, guessed ? undefined : receiptOwner);
  const path = pendingTeardownPathFor(receipt.nonce);
  if (options.receiptState === "quarantined" && !quarantinePendingTeardown(receipt.nonce)) throw new Error("fixture quarantine failed");
  if (options.receiptState === "invalid") writeFileSync(pendingTeardownPathFor(receipt.nonce), "{");
  if (options.receiptState === "parent-oversized") writeFileSync(path, JSON.stringify(receipt) + " ".repeat(4096));
  if (options.receiptState === "parent-nonregular") { unlinkSync(path); mkdirSync(path); }
  if (options.receiptState === "parent-symlink") { const target = `${path}.fixture`; writeFileSync(target, readFileSync(path)); unlinkSync(path); symlinkSync(target, path); }
  if (options.receiptState === "parent-stale") {
    const stale = claimPendingTeardown({ hostname: "127.0.0.1", port: config.port }, "exact", process.pid);
    writeFileSync(pendingTeardownPathFor(stale.nonce), "{");
    if (!quarantinePendingTeardown(stale.nonce)) throw new Error("fixture stale quarantine failed");
    const owner = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
    await owner.exited;
    claimPendingTeardown({ hostname: "127.0.0.1", port: config.port }, "exact", owner.pid);
  }
  if (options.receiptState === "parent-invalid") {
    const invalid = claimPendingTeardown({ hostname: "127.0.0.1", port: config.port }, "exact", process.pid);
    writeFileSync(pendingTeardownPathFor(invalid.nonce), "{");
  }
}
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
} else if (["runtime", "file-preflight", "file-stop", "file-restart-overlap", "file-restart-control"].includes(options.mode)) {
  if (options.mode === "file-restart-overlap") {
    // Exercise parent preflight and Child restart in one synthetic process.
    const owner = await import("../../src/client/stop-teardown-owner");
    mock.module("../../src/client/stop-teardown-owner", () => ({ ...owner,
      observeClientStopOwner: (proof: ClientStopOwner) => options.unverifiedStopOwner ? "unverified"
        : owner.readClientStopProcessStart(proof.pid) === proof.startTime ? "active" : "confirmed-stale",
    }));
  }
  if (options.fileOnly) {
    // File-route tests isolate the existing native restore owner. Its own real-disk tests
    // above remain independent; this stub performs no Codex/catalog/history writes.
    const native = await import("../../src/codex/inject");
    mock.module("../../src/codex/inject", () => ({ ...native, restoreNativeCodex: () => ({ success: true, message: "native restore outside this fixture",
      artifacts: { config: { state: "skipped", changed: false }, catalog: { state: "skipped", changed: false }, history: { state: "skipped", changed: false } },
    }) }));
  }
  if (options.holdShutdown || options.lateFileSync) {
    const diagnostics = await import("../../src/link/diagnostics");
    mock.module("../../src/link/diagnostics", () => ({ ...diagnostics, flushLinkDiagnostics: async () => {
      if (options.holdShutdown) {
        writeFileSync(join(home, "shutdown-drained"), "ready");
        while (!existsSync(join(home, "shutdown-release"))) await Bun.sleep(10);
      }
      await fileSyncFlight;
    } }));
  }
  let replacementAttempts = 0;
  let observeRollback!: (closed: boolean) => void;
  const rollbackTurn = new Promise<boolean>(resolve => { observeRollback = resolve; });
  let restartSettled: (() => Promise<void>) | undefined;
  const replaceSavedConnection = () => {
    config.client!.connectedAt = "2026-11-17T00:00:00.000Z";
    saveConfig(config);
    protectedBefore = protectedPaths.map(path => readFileSync(path, "utf8"));
  };
  if (options.failedRollback) {
    const controller = await import("../../src/client/runtime-restart");
    const create = controller.createClientRestartController;
    mock.module("../../src/client/runtime-restart", () => ({ ...controller, createClientRestartController: (...args: Parameters<typeof create>) => {
      const result = create(...args);
      restartSettled = result.settled;
      return result;
    } }));
  }
  if (options.preserve?.startsWith("restart-rollback")) {
    const replacement = await import("../../src/server/restart-replacement");
    mock.module("../../src/server/restart-replacement", () => ({ ...replacement,
      spawnReplacementStart: async () => {
        replacementAttempts++;
        if (options.failedRollback === "before-rebind") replaceSavedConnection();
        if (replacementAttempts === 1) throw Object.assign(new Error("fixture replacement refused"), { code: "not_ready" });
      },
    }));
  }
  const { scheduleStandaloneRecycle, startClientRuntime } = await import("../../src/client/runtime");
  const { startMachineListener } = await import("../../src/client/machine-listener");
  let requestRestart: (() => Promise<unknown>) | undefined;
  let restartStopEntered!: () => void, releaseRestartStop!: () => void;
  const restartStopping = new Promise<void>(resolve => { restartStopEntered = resolve; });
  const restartRelease = new Promise<void>(resolve => { releaseRestartStop = resolve; });
  await startClientRuntime({ block: false }, { restartSupervisor: () => options.preserve?.startsWith("restart-rollback") ? Promise.resolve(null) : new Promise(() => {}), startListener: (port, deps) => {
    requestRestart = deps?.restart?.request;
    if (options.failedRollback === "during-rebind" && replacementAttempts === 1) replaceSavedConnection();
    const server = startMachineListener(port, options.oldStopCapability && deps?.restart
      ? { ...deps, restart: { ...deps.restart, linkStopFence: undefined } } : deps);
    if (options.busyRollbackPublication && replacementAttempts === 1) {
      const lock = new Database(prepareConfigMutationDatabasePathForWrite());
      lock.exec("BEGIN IMMEDIATE");
      const stop = server.stop.bind(server);
      let closed = false;
      server.stop = ((force: boolean) => { const result = stop(force); closed = force; return result; }) as typeof server.stop;
      // The bind and failed admission complete before the next event-loop turn. Keep C
      // held until the observation, so a retry cannot publish in the meantime.
      setImmediate(() => { observeRollback(closed); lock.close(); });
      return server;
    }
    const stop = server.stop.bind(server);
    server.stop = ((close: boolean) => {
      if (options.mode === "file-restart-overlap" && !close) {
        restartStopEntered(); return restartRelease.then(() => stop(close));
      }
      report({ atListenerStop: true }); releaseFileModels?.(); return stop(close);
    }) as typeof server.stop;
    return server;
  } });
  if (options.mode === "file-restart-overlap" || options.mode === "file-restart-control") {
    const { readRuntimePort } = await import("../../src/config/process-state");
    const { clientSyncRuntimeGuard } = await import("../../src/client/sync-runtime");
    const before = readRuntimePort(process.pid)!;
    if (!requestRestart) throw new Error("fixture missing restart admission");
    await requestRestart();
    let preflight: unknown;
    if (options.mode === "file-restart-overlap") {
      await restartStopping;
      let finishStop = async () => {};
      preflight = await (await import("../../src/cli/stop-restore")).preflightConnectedClientStop({ pid: process.pid, port: config.port, hostname: "127.0.0.1" }, finish => { finishStop = finish; });
      if (options.finishStopBeforeRollback) await finishStop();
      releaseRestartStop();
    }
    if (options.busyRollbackPublication) {
      const closedBeforeYield = await rollbackTurn;
      report({ preflight, closedBeforeYield, published: readRuntimePort(process.pid)?.servingGeneration !== before.servingGeneration, replacementAttempts });
      process.exit(0);
    }
    if (options.failedRollback) {
      await restartSettled!();
      report({ preflight, replacementAttempts, runtimePresent: readRuntimePort(process.pid) !== null,
        explicitStop: readRuntimePort(process.pid)?.clientStopRequested });
      process.exit(0);
    }
    let after = readRuntimePort(process.pid)!;
    for (let attempt = 0; attempt < 400 && after.servingGeneration === before.servingGeneration; attempt++) {
      await Bun.sleep(10); after = readRuntimePort(process.pid)!;
    }
    let sync = "accepted";
    try { clientSyncRuntimeGuard()(); } catch (error) { sync = (error as { code: string }).code; }
    const admission = options.mode === "file-restart-overlap" ? await requestRestart() : undefined;
    const health = await fetch(`http://127.0.0.1:${config.port}/healthz`);
    report({ preflight, rolledBack: after.servingGeneration !== before.servingGeneration, bound: health.ok,
      stopping: after.clientStopping === true, explicitStop: after.clientStopRequested === true,
      ...(options.finishStopBeforeRollback ? { retainedStop: after.clientStopRequested === false } : {}), sync, admission });
    process.exit(0);
  }
  if (options.lateFileSync) {
    const { clientSyncRuntimeGuard } = await import("../../src/client/sync-runtime");
    const { withConfigMutationLockSync } = await import("../../src/config");
    const { applyConnectedRouteIntent } = await import("../../src/integrations/route-intent-connected");
    const guard = clientSyncRuntimeGuard();
    let modelsReady!: () => void;
    const ready = new Promise<void>(resolve => { modelsReady = resolve; });
    const release = new Promise<void>(resolve => { releaseFileModels = resolve; });
    // The real materializer has already committed its write-ahead receipt, then awaits
    // this Home catalog response. Deliver it only after the stopping listener releases.
    fileSyncFlight = applyConnectedRouteIntent(expected, token, preparedFileIntent, {
      onlyClients: options.fileClients, lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
      beforeWrite: () => withConfigMutationLockSync(guard),
    }, { fetchImpl: (async () => {
      modelsReady(); await release; return Response.json({ data: [{ id: "fixture/late-home-model" }] });
    }) as typeof fetch }).then(() => { fileLateResult = "unexpected completion"; }, error => { fileLateResult = error.message; });
    await ready;
  }
  if (options.siblingEscalation) {
    const { preflightConnectedClientStop } = await import("../../src/cli/stop-restore");
    const { readRuntimePort, writeRuntimePort } = await import("../../src/config/process-state");
    const { markClientRuntimeStopping } = await import("../../src/client/sync-runtime");
    const runtime = readRuntimePort(process.pid)!;
    const control = await import("../../src/lib/process-control");
    const owner = await import("../../src/client/stop-teardown-owner");
    const linux = await import("../../src/service/health-sentinel-linux");
    const state = await import("../../src/client/state");
    const readConnection = state.readClientConnectionState;
    const readStart = owner.readClientStopProcessStart;
    const open = linux.openVerifiedPidfd;
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const setPlatform = (value: string) => Object.defineProperty(process, "platform", { ...platform, value });
    const native = <T>(action: () => T): T => {
      const previous = process.platform;
      setPlatform(platform.value);
      try { return action(); } finally { setPlatform(previous); }
    };
    const signals: Array<[fd: number, signal: number]> = [];
    const closed: number[] = [];
    const opened: number[] = [];
    mock.module("../../src/lib/process-control", () => ({ ...control, waitForExit: () => signals.some(([, signal]) => signal === 9) }));
    mock.module("../../src/client/stop-teardown-owner", () => ({ ...owner, readClientStopProcessStart: (pid: number) => native(() => readStart(pid)) }));
    mock.module("../../src/client/state", () => ({ ...state, readClientConnectionState: () => native(readConnection) }));
    mock.module("../../src/service/health-sentinel-linux", () => ({ ...linux,
      openVerifiedPidfd: (pid: number, verify: () => boolean) => open(pid, verify, { load: () => ({
        open: target => {
          opened.push(target);
          return { value: 73, errno: 0 };
        },
        signal: (fd, signal) => {
          if (signal !== 0) signals.push([fd, signal]);
          if (signal === 15) native(() => {
            markClientRuntimeStopping({ pid, port: runtime.port, attestationSecret: runtime.attestationSecret! });
            if (options.siblingEscalation === "different-generation") {
              writeRuntimePort({ ...readRuntimePort(pid)!, servingGeneration: randomBytes(16).toString("hex") });
            }
          });
          return { value: 0, errno: 0 };
        },
        close: fd => { closed.push(fd); },
        dispose: () => {},
      }) }),
    }));
    let proof: StopTargetProof | undefined;
    const outcome = await preflightConnectedClientStop(runtime, () => {
      throw new Error("a sibling must not acquire the shared stop fence");
    }, undefined, undefined, value => { proof = value; }, 10100);
    if (outcome !== null || !proof?.terminateSibling) throw new Error("fixture sibling preflight did not admit termination");
    let refusal: string | undefined;
    try {
      setPlatform("linux");
      proof.terminateSibling();
    } catch (error) {
      refusal = (error as Error).message;
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    report({ signals, openedExactlyOnceForTarget: Bun.deepEquals(opened, [process.pid]), closed, refusal,
      stopping: readRuntimePort(process.pid)?.clientStopping });
    process.exit(0);
  }
  if (options.mode === "file-stop") {
    if (options.receiptWriteFails) {
      const pending = await import("../../src/config/pending-teardown");
      mock.module("../../src/config/pending-teardown", () => ({ ...pending, claimPendingTeardown: () => {
        throw new Error("fixture receipt write denied");
      } }));
    }
    if (options.missingStopRecord) {
      const path = join(home, "runtime-port.json");
      if (options.missingStopRecord === "absent") unlinkSync(path);
      else writeFileSync(path, "{");
      const processState = await import("../../src/config/process-state");
      mock.module("../../src/config/process-state", () => ({ ...processState, readPid: () => process.pid }));
    }
    if (options.legacyOwnerRecord) {
      const path = join(home, "runtime-port.json");
      const runtime = JSON.parse(readFileSync(path, "utf8"));
      delete runtime.clientLinkOwner;
      writeFileSync(path, JSON.stringify(runtime));
    }
    if (options.stopConnectionDrift) {
      const path = join(home, "config.json");
      const saved = JSON.parse(readFileSync(path, "utf8"));
      switch (options.stopConnectionDrift) {
        case "invalid": saved.client = {}; break;
        case "mismatched": delete saved.runtimeRole; break;
        case "disconnected": delete saved.runtimeRole; delete saved.client; break;
        case "other-link": saved.client.connectedAt = "2026-11-17T00:00:00Z"; break;
        case "hub":
          saved.client.transport = "hub"; delete saved.client.link;
          saved.client.serverUrl = saved.client.managementUrl = "https://hub.example.test";
          break;
      }
      writeFileSync(path, JSON.stringify(saved));
    }
    if (options.finalizeFailure) {
      const sync = await import("../../src/client/sync-runtime");
      mock.module("../../src/client/sync-runtime", () => ({ ...sync, finishClientRuntimeStop: () => { throw new Error("fixture storage refusal"); } }));
    }
    const calls = { service: 0, killed: 0 };
    let startChanged = false;
    const kill = process.kill;
    process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0) return kill(pid, signal);
      calls.killed++;
      if (options.startIdentityChanges === "escalation" && signal === "SIGTERM") {
        startChanged = true;
        return true;
      }
      throw new Error("unexpected stop signal after file refusal");
    }) as typeof process.kill;
    if (options.startIdentityChanges === "escalation" && process.platform === "linux") {
      const linux = await import("../../src/service/health-sentinel-linux");
      mock.module("../../src/service/health-sentinel-linux", () => ({ ...linux,
        openVerifiedPidfd: (pid: number, verify: () => boolean) => {
          verify();
          return { kind: "bound", handle: {
            terminate: (signal: number) => { process.kill(pid, signal === 15 ? "SIGTERM" : "SIGKILL"); return "terminated"; },
            close() {},
          } };
        },
      }));
    }
    if (options.startIdentityChanges) {
      const owner = await import("../../src/client/stop-teardown-owner");
      const readStart = owner.readClientStopProcessStart;
      mock.module("../../src/client/stop-teardown-owner", () => ({ ...owner,
        readClientStopProcessStart: (pid: number) => startChanged ? "fixture:replacement" : readStart(pid),
      }));
    }
    const control = await import("../../src/lib/process-control");
    const realStopProxy = control.stopProxy;
    mock.module("../../src/lib/process-control", () => ({ ...control, stopProxy: async (pid: number, io: Parameters<typeof control.stopProxy>[1]) => {
      if (options.driftDuringFallback || options.startIdentityChanges) {
        return realStopProxy(pid, { ...io, fetchFn: async () => {
          if (options.driftDuringFallback) writeFileSync(join(home, "config.json"), "{");
          if (options.startIdentityChanges === "request") startChanged = true;
          return new Response(null, { status: 404 });
        } });
      }
      calls.killed++; throw new Error("unexpected process stop after file refusal");
    } }));
    const service = await import("../../src/service");
    mock.module("../../src/service", () => ({ ...service, stopServiceIfInstalledDetailed: () => {
      calls.service++;
      if (options.driftDuringFallback || options.startIdentityChanges) return "absent";
      throw new Error("unexpected service stop after file refusal");
    } }));
    const dispatch = await import("../../src/cli/dispatch");
    const command = dispatch.dispatchCommand;
    mock.module("../../src/cli/dispatch", () => ({ ...dispatch, dispatchCommand: async (...args: Parameters<typeof command>) => {
      const exitCode = await command(...args);
      const health = await fetch(`http://127.0.0.1:${config.port}/healthz`);
      const runtime = (await import("../../src/config/process-state")).readRuntimePort();
      report({ exitCode, calls, bound: health.ok, stopping: runtime?.clientStopping === true,
        ...(options.finalizeFailure ? { activeStop: runtime?.clientStopRequested === true } : {}) });
      return exitCode;
    } }));
    mock.module("../../src/cli/codex-shim-autorestore", () => ({ async maybeAutoRestoreCodexShimAsync() {} }));
    process.argv = [process.execPath, "ocx", "stop", "--json"];
    await import("../../src/cli/index");
  }
  if (options.mode === "file-preflight") {
    const { clientSyncRuntimeGuard } = await import("../../src/client/sync-runtime");
    const { withConfigMutationLockSync } = await import("../../src/config");
    const admitted = options.deferFileApply ? clientSyncRuntimeGuard() : undefined;
    const { preflightConnectedClientStop } = await import("../../src/cli/stop-restore");
    const outcome = await preflightConnectedClientStop({ pid: process.pid, port: config.port, hostname: "127.0.0.1" }, () => {
      if (options.busyStopFence) holdConfigLock();
    });
    if (admitted) {
      try {
        await (await import("../../src/integrations/route-intent-connected")).applyConnectedRouteIntent(expected, token, preparedFileIntent, {
          onlyClients: options.fileClients, lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
          beforeWrite: () => withConfigMutationLockSync(admitted),
        }, { fetchImpl: (async () => Response.json({ data: [{ id: "fixture/home-model" }] })) as typeof fetch });
        fileLateResult = "unexpected completion";
      } catch (error) { fileLateResult = (error as { code: string }).code; }
    }
    const health = await fetch(`http://127.0.0.1:${config.port}/healthz`);
    report({ outcome, bound: health.ok, stopping: JSON.parse(readFileSync(join(home, "runtime-port.json"), "utf8")).clientStopping === true });
    // The test owns this synthetic runtime and disposes it after observing the preflight.
    process.exit(0);
  }
  if (options.repairFileRefusal || options.observeFileRefusal || options.observeNativeRefusal) {
    const printError = console.error;
    console.error = (...args: unknown[]) => {
      printError(...args);
      if (!args.some(value => String(value).includes(options.observeNativeRefusal
        ? "Link Child Codex routing restore refused" : "The listener remains bound"))) return;
      void (async () => {
        const health = await fetch(`http://127.0.0.1:${config.port}/healthz`);
        const { readRuntimePort } = await import("../../src/config/process-state");
        fileRefusal = { bound: health.ok, stopping: readRuntimePort(process.pid)?.clientStopping === true,
          before: Object.fromEntries(Object.entries(filePaths).map(([id, path]) => [id, readFileSync(path, "utf8")])) };
        if (options.observeFileRefusal || options.observeNativeRefusal) {
          report({ refused: true, bound: fileRefusal.bound, stopping: fileRefusal.stopping });
          // Dispose only this synthetic process after observing that production kept it bound.
          process.exit(0);
        }
        for (const [id, path] of Object.entries(filePaths)) writeFileSync(path, fileOwnedBytes[id]!);
        process.emit("SIGTERM", "SIGTERM");
      })();
    };
  }
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
    else if (options.runtimeRecord === "explicit-stop-unfenced") {
      const record = JSON.parse(readFileSync(path, "utf8")); record.clientStopRequested = true; delete record.clientStopping;
      writeFileSync(path, JSON.stringify(record));
    }
    else { const record = JSON.parse(readFileSync(path, "utf8")); record.pid += 100_000; writeFileSync(path, JSON.stringify(record)); }
  }
  if (options.receiptState?.startsWith("parent") && options.receiptState !== "parent-unfenced") {
    const { readRuntimePort } = await import("../../src/config/process-state");
    const { markClientRuntimeStopping, finishClientRuntimeStop } = await import("../../src/client/sync-runtime");
    const runtime = readRuntimePort(process.pid)!;
    const identity = { pid: process.pid, port: config.port, attestationSecret: runtime.attestationSecret! };
    if (!receiptOwner) throw new Error("fixture stop owner missing");
    const proof = options.receiptState === "parent-wrong-nonce" ? { ...receiptOwner, nonce: "b".repeat(32) } : receiptOwner;
    markClientRuntimeStopping(identity, proof);
    if (options.receiptState === "parent-finished") finishClientRuntimeStop(identity, proof);
  }
  mutate();
  if (options.removeToken) unlinkSync(join(home, "service-api-token"));
  if (!options.removeToken) protectedBefore = protectedPaths.map(path => readFileSync(path, "utf8"));
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
} else if (options.mode === "termination") {
  const control = await import("../../src/lib/process-control");
  const linux = await import("../../src/service/health-sentinel-linux");
  const { terminateAttestedClient } = await import("../../src/cli/stop-client-process");
  mock.module("../../src/lib/process-control", () => ({ ...control, waitForExit: () => false }));
  mock.module("../../src/service/health-sentinel-linux", () => ({ ...linux,
    openVerifiedPidfd: () => ({ kind: "unsupported", reason: "fixture kernel without pidfd" }),
  }));
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const kill = process.kill;
  const signals: Array<number | string> = [];
  let message = "";
  try {
    Object.defineProperty(process, "platform", { ...platform, value: options.terminationPlatform });
    process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0) return kill(pid, signal);
      signals.push(signal ?? "SIGTERM");
      return true;
    }) as typeof process.kill;
    terminateAttestedClient(process.pid, "fixture", () => {});
  } catch (error) {
    message = (error as Error).message;
  } finally {
    process.kill = kill;
    Object.defineProperty(process, "platform", platform);
  }
  report({ signals, message });
} else if (options.mode === "offline-stop") {
  const { unitPath } = await import("../../src/service/systemd");
  if (options.danglingServiceRecord) symlinkSync(join(home, "missing-service-state"), join(home, "service-state.json"));
  if (options.installedUnit) {
    mkdirSync(dirname(unitPath()), { recursive: true });
    writeFileSync(unitPath(), "[Service]\n");
  }
  const manager = await import("../../src/service/guarded-manager-target");
  mock.module("../../src/service/guarded-manager-target", () => ({ ...manager,
    observeGuardedManagerStopped: async () => "unknown",
  }));
  const dispatch = await import("../../src/cli/dispatch");
  const command = dispatch.dispatchCommand;
  mock.module("../../src/cli/dispatch", () => ({ ...dispatch, dispatchCommand: async (...args: Parameters<typeof command>) => {
    const exitCode = await command(...args);
    report({ exitCode });
    return exitCode;
  } }));
  mock.module("../../src/cli/codex-shim-autorestore", () => ({ async maybeAutoRestoreCodexShimAsync() {} }));
  Object.defineProperty(process, "platform", { value: "linux" });
  process.argv = [process.execPath, "ocx", "stop", "--json"];
  await import("../../src/cli/index");
} else if (options.mode === "file-cycle") {
  const { restoreLinkFileRouting } = await import("../../src/client/stop-file-routing");
  const first = await restoreLinkFileRouting(expected);
  const second = await restoreLinkFileRouting(expected);
  const stopped = Object.fromEntries(Object.entries(filePaths).map(([id, path]) => [id, readFileSync(path, "utf8")]));
  const { applyConnectedRouteIntent } = await import("../../src/integrations/route-intent-connected");
  const reapplied = await applyConnectedRouteIntent(expected, token, preparedFileIntent, {
    onlyClients: options.fileClients, lifecycleLockDeps: { lockPath: join(home, "lifecycle.sqlite") },
  }, { fetchImpl: (async () => Response.json({ data: [{ id: "fixture/home-model" }] })) as typeof fetch });
  report({ first, second, stopped, reapplied: reapplied?.outcomes.filter(row => options.fileClients?.includes(row.client as "pi" | "opencode")) });
} else {
  if (options.mode === "parent" && options.stopConnectionDrift === "disconnected") {
    delete config.client;
    delete config.runtimeRole;
    saveConfig(config);
  }
  const result = options.mode === "api"
    ? await (await import("../../src/server/stop-teardown")).performStopTeardown(new URL("http://127.0.0.1:10100/api/stop?deferSharedTeardown=1&teardownNonce=fixture"), { ownsReceipt: () => true })
    : options.mode === "parent" ? await (await import("../../src/cli/stop-restore")).restoreSharedClientStateAfterStop(() => {})
    // The direct helper fixture has no runtime, async sync or other writer.
    : (await import("../../src/client/stop-routing")).restoreLinkClientRouting(expected, { syncFenced: true });
  const repeated = options.repeat ? (await import("../../src/client/stop-routing")).restoreLinkClientRouting(expected, { syncFenced: true }) : undefined;
  report(repeated ? { first: result, repeated } : result);
}
