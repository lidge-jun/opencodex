/** Real config/N/C/catalog writes in a disposable home; no network or host process control. */
import { mock } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, withConfigMutationLockSync } from "../../src/config";
import { injectCodexConfig } from "../../src/codex/inject";
import { CODEX_CONFIG_PATH, DEFAULT_CATALOG_PATH, getCodexHome } from "../../src/codex/paths";
import { acquireConfigWriteLock, releaseConfigWriteLock } from "../../src/codex/config-write-lock";
import { openCodexCoordinatorTransaction } from "../../src/codex/transition-state";
import { resolveCodexCoordinatorDatabasePath, resolveEffectiveUserIdentity } from "../../src/codex/user-identity";
import { markClientConnectPending } from "../../src/client/state";

const mode = process.argv[2]!;
const home = process.env.OPENCODEX_HOME!;
const coordinator = resolveCodexCoordinatorDatabasePath(resolveEffectiveUserIdentity(), getCodexHome());
const config = { ...loadConfig(), port: 10100, syncResumeHistory: false };
const connection = { serverUrl: "https://hub.example.test", managementUrl: "https://hub.example.test",
  managementTransport: "direct", selectedClients: ["codex"], tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
  apiKeyId: "fixture-client", tokenFingerprint: "a".repeat(64), protocolVersion: 1, connectedAt: "2026-10-01T00:00:00.000Z" };
function publishHub() {
  withConfigMutationLockSync(() => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ ...config, runtimeRole: "client", client: connection }));
    writeFileSync(CODEX_CONFIG_PATH, 'openai_base_url = "https://hub.example.test/v1"\n');
    writeFileSync(DEFAULT_CATALOG_PATH, JSON.stringify({ models: [{ slug: "hub/model" }] }));
  });
}
const snapshot = () => [CODEX_CONFIG_PATH, DEFAULT_CATALOG_PATH].map(path => readFileSync(path, "utf8"));
let nativeBlocker: ReturnType<typeof openCodexCoordinatorTransaction> | undefined;
let fileBlocker: Awaited<ReturnType<typeof acquireConfigWriteLock>> | undefined;
const history = await import("../../src/codex/history-job");
mock.module("../../src/codex/history-job", () => ({ ...history, runCodexHistoryJob: async () => ({ kind: "skipped" }) }));
const grok = await import("../../src/grok/inject");
let grokCalls = 0;
let lateSnapshot: string[] | undefined;
const lateHistory = mode === "late-history-hub";
const lateCatalog = mode === "late-catalog-hub";
let historyArmed = false;
let catalogArmed = false;
if (lateHistory) mock.module("../../src/codex/history-job", () => ({ ...history, runCodexHistoryJob: async () => {
  if (!historyArmed) return { kind: "skipped" };
  await Promise.resolve(); publishHub(); lateSnapshot = snapshot(); return { kind: "skipped" };
} }));
const fileLocks = await import("../../src/codex/config-write-lock");
const releaseFile = fileLocks.releaseConfigWriteLock;
if (lateCatalog) mock.module("../../src/codex/config-write-lock", () => ({ ...fileLocks,
  releaseConfigWriteLock: (held: Parameters<typeof releaseFile>[0]) => {
    releaseFile(held);
    if (catalogArmed) { catalogArmed = false; publishHub(); lateSnapshot = snapshot(); }
  },
}));
mock.module("../../src/grok/inject", () => ({ ...grok, stripGrokConfig: () => { grokCalls++; return { ok: true, changed: false, message: "fixture" }; } }));
const log = console.log;
console.log = () => {};
try {
  writeFileSync(CODEX_CONFIG_PATH, 'model = "gpt-5"\n');
  writeFileSync(DEFAULT_CATALOG_PATH, JSON.stringify({ models: [{ slug: "gpt-5" }] }));
  const initialized = openCodexCoordinatorTransaction(coordinator);
  initialized.commit(); initialized.close();
  const seed = await injectCodexConfig(10100, config, { catalogPath: DEFAULT_CATALOG_PATH });
  if (!seed.success) throw new Error(`seed failed: ${seed.message}`);
  writeFileSync(DEFAULT_CATALOG_PATH, JSON.stringify({ models: [{ slug: "gpt-5" }, { slug: "fixture/model" }] }));
  const { restoreBoundaryOwnership, restoreSharedClientStateAfterStop } = await import("../../src/cli/stop-restore");
  // Keep lifecycle fixture admission local; N, C and the config-file lock below are real.
  const inspected = restoreBoundaryOwnership({ withLifecycle: work => work({} as never) });
  if (inspected !== "restore") throw new Error(`unexpected initial boundary: ${inspected}`);
  historyArmed = true;
  catalogArmed = true;
  const apiMode = mode.startsWith("api-");
  if (mode.endsWith("file-hub")) {
    fileBlocker = await acquireConfigWriteLock(CODEX_CONFIG_PATH, { timeoutMs: 0 });
    if (!fileBlocker.ok) throw new Error("file blocker acquisition failed");
  } else if (!lateCatalog && !lateHistory) nativeBlocker = openCodexCoordinatorTransaction(coordinator);
  let completed = false;
  const pending = (apiMode
    ? (await import("../../src/server/stop-teardown")).performStopTeardown(new URL("http://127.0.0.1:10100/api/stop"))
    : restoreSharedClientStateAfterStop(() => {})).finally(() => { completed = true; });
  if (lateCatalog || lateHistory) {
    const result = await pending;
    if (!lateSnapshot) throw new Error("late publication checkpoint was not reached");
    log(JSON.stringify({ result, before: lateSnapshot, after: snapshot(), grokCalls, marker: false }));
    process.exitCode = 0;
  } else {
  // Observe the real restore waiting, before allowing the writer's publication to win.
  await Bun.sleep(100);
  if (completed) throw new Error("restore did not wait for the concurrent writer");
  if (mode.endsWith("native-pending")) withConfigMutationLockSync(() => markClientConnectPending("b".repeat(64)));
  else publishHub();
  const before = snapshot();
  if (fileBlocker?.ok) releaseConfigWriteLock(fileBlocker.handle);
  fileBlocker = undefined;
  nativeBlocker?.rollback(); nativeBlocker?.close(); nativeBlocker = undefined;
  const result = await pending;
  log(JSON.stringify({ result, before, after: snapshot(), grokCalls, marker: existsSync(join(home, "client-connect-pending")) }));
  }
} finally {
  if (fileBlocker?.ok) releaseConfigWriteLock(fileBlocker.handle);
  nativeBlocker?.rollback(); nativeBlocker?.close();
  for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(coordinator + suffix, { force: true });
}
