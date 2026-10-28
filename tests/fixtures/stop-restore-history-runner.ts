import { mock } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Only the scheduling seam is replaced. Both history implementations and all persistence
// are real, including the async Worker's DB, rollout and manifest writes.
const [mode, ownership] = process.argv.slice(2);
const ocx = process.env.OPENCODEX_HOME!;
const codex = process.env.CODEX_HOME!;
mkdirSync(ocx, { recursive: true }); mkdirSync(codex, { recursive: true });
delete process.env.OCX_SERVICE;
const configPath = join(ocx, "config.json");
const nativePath = join(codex, "config.toml");
const config = { port: 10100, providers: {}, defaultProvider: "openai", syncResumeHistory: false };
writeFileSync(configPath, JSON.stringify(config));
writeFileSync(nativePath, 'model = "gpt-5"\n');
const { withConfigMutationLockSync } = await import("../../src/config");
const { markClientConnectPending } = await import("../../src/client/state");
const historyProvider = await import("../../src/codex/history-provider");
const realSyncHistory = historyProvider.syncCodexHistoryProvider;
const history = await import("../../src/codex/history-job");
const realHistory = history.runCodexHistoryJob;
let armed = false;
let publication: ReturnType<typeof snapshot> | undefined;
let workerResult: unknown;
let backup = "";
const dbPath = join(codex, "state_5.sqlite");
const rollout = join(codex, "rollout.jsonl");
function snapshot() {
  const db = new Database(dbPath, { readonly: true });
  try {
    return { row: db.query("SELECT model_provider, source, has_user_event FROM threads").get(),
      rollout: readFileSync(rollout, "utf8"), manifest: existsSync(backup) ? readFileSync(backup, "utf8") : null };
  } finally { db.close(); }
}
function publish() {
  withConfigMutationLockSync(() => {
    if (ownership === "pending") markClientConnectPending("b".repeat(64));
    if (ownership === "hub") {
      writeFileSync(configPath, JSON.stringify({ ...config, runtimeRole: "client", client: {
        serverUrl: "https://hub.example.test", managementUrl: "https://hub.example.test",
        managementTransport: "direct", selectedClients: ["codex"], tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
        apiKeyId: "fixture-client", tokenFingerprint: "a".repeat(64), protocolVersion: 1,
        connectedAt: "2026-10-01T00:00:00.000Z",
      } }));
      writeFileSync(nativePath, 'openai_base_url = "https://hub.example.test/v1"\n');
    }
    publication = snapshot();
  });
}
mock.module("../../src/codex/history-job", () => ({ ...history, runCodexHistoryJob: async (...args: Parameters<typeof realHistory>) => {
  if (armed && mode !== "sync") { await Promise.resolve(); publish(); }
  const result = await realHistory(...args);
  if (armed) workerResult = result;
  return result;
} }));
mock.module("../../src/codex/history-provider", () => ({ ...historyProvider,
  syncCodexHistoryProvider: (...args: Parameters<typeof realSyncHistory>) => {
    if (armed && mode === "sync") publish();
    const result = realSyncHistory(...args);
    if (armed && mode === "sync") workerResult = result;
    return result;
  },
}));
const inject = await import("../../src/codex/inject");
const seeded = await inject.injectCodexConfig(10100, config as never);
if (!seeded.success) throw new Error(`seed failed: ${seeded.message}`);
writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: {
  id: "thread-1", model_provider: "opencodex", source: "cli", cwd: codex,
} }) + "\n");
const db = new Database(dbPath);
db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, model_provider TEXT NOT NULL, source TEXT NOT NULL, first_user_message TEXT NOT NULL, has_user_event INTEGER NOT NULL DEFAULT 0)");
db.run("INSERT INTO threads VALUES ('thread-1', ?, 'opencodex', 'cli', 'hello', 1)", [rollout]);
db.close();
const canonicalDb = join(realpathSync.native(codex), "state_5.sqlite");
backup = historyProvider.historyBackupPathFor(canonicalDb);
writeFileSync(backup, JSON.stringify({ version: 1, stateDbPath: canonicalDb, entries: {
  "thread-1": { id: "thread-1", rolloutPath: rollout, modelProvider: "opencodex", source: "exec", hasUserEvent: 0 },
} }));
// Independent SQLite connections prove C/H remain held at the real rollout write
// and manifest deletion boundaries, rather than accepting an entry-only check.
const lockChecks: { phase: string; config: boolean; history: boolean }[] = [];
if (mode === "sync" && ownership === "standalone") {
  const identity = await import("../../src/codex/user-identity");
  const historyLockPath = identity.resolveCodexHistorySerializationDatabasePath(identity.resolveEffectiveUserIdentity(), codex, canonicalDb);
  function held(path: string): boolean {
    const probe = new Database(path);
    try { probe.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE; ROLLBACK"); return false; }
    catch (error) { if ((error as { code?: string }).code === "SQLITE_BUSY") return true; throw error; }
    finally { probe.close(); }
  }
  const check = (phase: string) => lockChecks.push({ phase,
    config: held(join(ocx, "config-mutation.sqlite")), history: held(historyLockPath) });
  historyProvider.setBeforeStrictHistoryRolloutAppendForTests(() => { check("rollout"); });
  historyProvider.setBeforeHistoryBackupConsumeForTests(() => { check("manifest"); });
}
const receipts = await import("../../src/config/pending-teardown");
const receipt = receipts.claimPendingTeardown({ hostname: "127.0.0.1", port: 10100 }, "exact", process.pid);
// Contend on the real H database, without blocking C or changing client ownership.
let heldHistory: Database | undefined;
const grok = await import("../../src/grok/inject");
if (ownership === "history-busy") {
  // Let the real serialization owner create and harden the H database first. A file this
  // fixture created itself would carry the umask mode, and on POSIX H refuses anything but
  // 0600 as an unsafe path; that would exercise "unsafe-path", not the contention under test.
  const { withHistoryWriteSerialization } = await import("../../src/codex/history-lock");
  const prepared = withHistoryWriteSerialization(realpathSync.native(codex), canonicalDb, () => undefined);
  if (prepared.kind !== "completed") throw new Error(`H preparation failed: ${prepared.reason}`);
  const identity = await import("../../src/codex/user-identity");
  const lockPath = identity.resolveCodexHistorySerializationDatabasePath(identity.resolveEffectiveUserIdentity(), realpathSync.native(codex), canonicalDb);
  heldHistory = new Database(lockPath);
  heldHistory.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  mkdirSync(process.env.GROK_HOME!, { recursive: true });
  const seededGrok = grok.injectGrokConfig(10100, []);
  if (!seededGrok.ok || !grok.grokManagedBlockPresent()) throw new Error("Grok seed failed");
  publication = snapshot();
}
armed = true;
const stop = await import("../../src/cli/stop-restore-guard");
const guard = stop.stopRestoreWriteGuard();
let result: unknown;
try { result = mode === "sync"
  ? inject.restoreNativeCodex({ withWriteGuard: guard.run })
  : mode === "api"
  ? await (await import("../../src/server/stop-teardown")).performStopTeardown(new URL("http://127.0.0.1:10100/api/stop"))
  : await (await import("../../src/cli/stop-restore")).restoreSharedClientStateAfterStop(() => {});
} catch (error) { result = { error: String(error), boundary: guard.boundary() }; }
let grokResult: unknown;
if (ownership === "history-busy") {
  try { grokResult = guard.run(() => grok.stripGrokConfig()); }
  catch (error) { grokResult = { error: String(error) }; }
  heldHistory!.close();
}
const record = { sharedTeardown: "pending" as import("../../src/cli/stop-report").StopRunRecord["sharedTeardown"], receiptClearFailed: false };
const observed = result as { boundary?: "hub-owned" | "unproven"; sharedTeardown?: string };
const boundary = observed.boundary ?? (mode === "api"
  ? observed.sharedTeardown === "not-owned" ? "hub-owned" : observed.sharedTeardown === "refused" ? "unproven" : undefined
  : undefined);
if (boundary) {
  stop.settleUnrestoredStopBoundary(boundary, record, [receipt.nonce]);
}
console.log(JSON.stringify({ result, before: publication, after: snapshot(), workerResult, lockChecks,
  boundary: guard.boundary(), grokResult, grokManaged: grok.grokManagedBlockPresent(), native: readFileSync(nativePath, "utf8"),
  receiptExists: existsSync(receipts.pendingTeardownPathFor(receipt.nonce)), settled: record.sharedTeardown }));
