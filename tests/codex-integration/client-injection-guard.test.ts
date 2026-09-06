import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { resolveCodexCoordinatorDatabasePath, resolveEffectiveUserIdentity } from "../../src/codex/user-identity";

const roots: string[] = [];
const coordinators: string[] = [];
const children: Array<{ kill(signal?: number | NodeJS.Signals): void; exited: Promise<number>; exitCode: number | null }> = [];
const SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { Database } = require("bun:sqlite");
const configApi = require("./src/config");
const { injectCodexConfig } = require("./src/codex/inject");
const paths = require("./src/codex/paths");
const { restoreJournalState } = require("./src/codex/journal");
const { readCodexTransitionState, openCodexCoordinatorTransaction } = require("./src/codex/transition-state");
const { resolveCodexCoordinatorDatabasePath, resolveEffectiveUserIdentity } = require("./src/codex/user-identity");
const { withClientLifecycleSync } = require("./src/client/lifecycle-lock");
const { readDesktopDisconnectReceipt, writeDesktopDisconnectReceipt } = require("./src/claude/desktop-remote-store");
const mode = process.env.OCX_GUARD_SCENARIO;
const root = process.env.OCX_GUARD_ROOT;
const tokenFingerprint = createHash("sha256").update("test-key").digest("hex");
const owner = { serverUrl: "https://hub.example.test", apiKeyId: "client-fixture", connectedAt: "2026-01-01T00:00:00.000Z" };
let guardCalls = 0;
const observations = [];
let nBlocker;
let cBlocker;
function snapshot() {
  return Object.fromEntries([paths.CODEX_CONFIG_PATH, paths.CODEX_PROFILE_PATH, path.join(paths.getCodexHome(), "opencodex-journal.json")].map(file => {
    if (!fs.existsSync(file)) return [path.basename(file), null];
    const stat = fs.lstatSync(file, { bigint: true });
    return [path.basename(file), {
      hash: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
      identity: String(stat.dev) + ":" + String(stat.ino) + ":" + String(stat.mtimeNs) + ":" + String(stat.size),
    }];
  }));
}
function claimDisconnect() {
  withClientLifecycleSync(held => {
    writeDesktopDisconnectReceipt(held, null, {
      version: 1, owner, tokenFingerprint, keepCatalog: false, phase: "prepared",
    });
  }, { lockPath: path.join(root, "client-lock.sqlite") });
}
function guard() {
  guardCalls++;
  if (mode === "async") return Promise.resolve();
  if (mode === "async-reject") return Promise.reject(new Error("guard async rejection"));
  if (mode === "external" || mode === "malformed") throw new Error("client_guard_refused");
  const read = readDesktopDisconnectReceipt();
  observations.push(read.kind === "valid" ? read.value.phase : read.kind);
  if (read.kind === "valid" && read.value.phase !== "complete") throw new Error("client_guard_refused");
}
async function invoke() {
  try {
    const result = await injectCodexConfig(19999, configApi.loadConfig(), {
      catalogPath: null, lockTimeoutMs: 5000,
      journalOwner: { kind: "client", apiKeyId: owner.apiKeyId },
      routingTarget: { baseUrl: owner.serverUrl + "/v1", requiresAdmissionToken: true, tokenEnv: "OPENCODEX_API_AUTH_TOKEN" },
      beforeClientWrite: guard,
    });
    return { success: result.success, message: result.message };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : String(error) };
  }
}
(async () => {
  configApi.withConfigMutationLockSync(() => {});
  const coordinatorPath = resolveCodexCoordinatorDatabasePath(resolveEffectiveUserIdentity(), fs.realpathSync.native(paths.getCodexHome()));
  if (mode !== "legacy" && mode !== "external") {
    const ready = readCodexTransitionState();
    if (ready.kind !== "ready") throw new Error("coordinator_setup_failed");
  }
  if (mode === "queued") {
    const seeded = await invoke();
    if (!seeded.success) throw new Error("injected_seed_failed: " + seeded.message);
    guardCalls = 0;
    observations.length = 0;
  }
  if (mode === "malformed") fs.writeFileSync(path.join(paths.getCodexHome(), "opencodex-journal.json"), "malformed journal sentinel\n");
  const before = snapshot();
  let contention;
  if (mode === "queued" || mode === "queued-native") {
    // A real N transaction alone leaves C available for the disconnect claim.
    nBlocker = openCodexCoordinatorTransaction(coordinatorPath);
    const pending = invoke();
    if (guardCalls !== 0) throw new Error("guard_ran_before_coordinated_commit");
    claimDisconnect();
    const restored = restoreJournalState();
    if (mode === "queued" && !restored.complete) throw new Error("injected_restore_failed");
    const restoredBeforeRelease = snapshot();
    nBlocker.rollback(); nBlocker.close(); nBlocker = undefined;
    const result = await pending;
    console.log(JSON.stringify({ result, before: restoredBeforeRelease, after: snapshot(), guardCalls, observations, restored }));
    return;
  }
  if (mode === "legacy") {
    const databasePath = configApi.prepareConfigMutationDatabasePathForWrite();
    cBlocker = new Database(databasePath, { readwrite: true, create: false });
    cBlocker.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    contention = await invoke();
    const during = snapshot();
    cBlocker.exec("ROLLBACK"); cBlocker.close(); cBlocker = undefined;
    if (JSON.stringify(during) !== JSON.stringify(before)) throw new Error("legacy_write_escaped_C");
    if (guardCalls !== 0) throw new Error("legacy_guard_ran_outside_C");
  }
  if (mode === "deny" || mode === "legacy") claimDisconnect();
  const result = await invoke();
  let restored;
  if (mode === "allow" && result.success) {
    claimDisconnect();
    restored = restoreJournalState();
  }
  console.log(JSON.stringify({ result, contention, before, after: snapshot(), guardCalls, observations, restored }));
})().catch(error => {
  console.log(JSON.stringify({ fatal: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}).finally(() => {
  try { nBlocker?.rollback(); nBlocker?.close(); } catch { process.exitCode = 1; }
  try { cBlocker?.exec("ROLLBACK"); cBlocker?.close(); } catch { process.exitCode = 1; }
});
`;

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("injection guard child deadline")), milliseconds);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
async function runScenario(mode: string): Promise<Record<string, any>> {
  const root = mkdtempSync(join(tmpdir(), "ocx-client-guard-")); roots.push(root);
  const codex = join(root, "codex"); const ocx = join(root, "ocx"); const desktop = join(root, "desktop");
  for (const directory of [codex, ocx, desktop]) mkdirSync(directory, { recursive: true });
  const client = {
    serverUrl: "https://hub.example.test", managementUrl: "https://hub.example.test",
    managementTransport: "direct", selectedClients: ["codex"], tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
    apiKeyId: "client-fixture",
    tokenFingerprint: (await import("node:crypto")).createHash("sha256").update("test-key").digest("hex"),
    protocolVersion: 1, connectedAt: "2026-01-01T00:00:00.000Z",
  };
  writeFileSync(join(ocx, "config.json"), JSON.stringify({
    port: 19999, providers: {}, defaultProvider: "openai", runtimeRole: "client",
    client, syncResumeHistory: false, clientIntegrations: { codex: true },
  }));
  writeFileSync(join(ocx, "service-api-token"), "test-key\n", { mode: 0o600 });
  writeFileSync(join(codex, "config.toml"), mode === "external"
    ? 'model_provider = "user-managed"\n[model_providers.user-managed]\nbase_url = "https://user.example.test/v1"\n'
    : 'model = "gpt-5"\n');
  if (mode === "legacy") writeFileSync(join(codex, "opencodex.config.toml"), '# user reference\nmodel = "gpt-5"\n');
  if (mode === "external") writeFileSync(join(codex, "opencodex-journal.json"), "guarded journal sentinel\n");
  coordinators.push(resolveCodexCoordinatorDatabasePath(resolveEffectiveUserIdentity(), realpathSync.native(codex)));
  const child = Bun.spawn({
    cmd: [process.execPath, "--eval", SCRIPT], cwd: repoRoot(),
    env: {
      ...process.env, CODEX_HOME: codex, OPENCODEX_HOME: ocx,
      OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: desktop,
      OCX_GUARD_SCENARIO: mode, OCX_GUARD_ROOT: root,
      PATH: [dirname(process.execPath), ...(process.platform === "win32"
        ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32")]
        : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(delimiter),
    },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  children.push(child);
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const code = await within(child.exited, 30_000);
  const output = await within(Promise.all([stdout, stderr]), 5_000);
  const result = JSON.parse(output[0].trim().split("\n").at(-1) ?? "{}");
  if (code !== 0) throw new Error("injection fixture failed: " + String(result.fatal ?? output[1]));
  return result;
}

afterEach(async () => {
  const errors: unknown[] = [];
  for (const child of children.splice(0)) {
    try {
      if (child.exitCode === null) child.kill("SIGKILL");
      await within(child.exited, 5_000);
    } catch (error) { errors.push(error); }
  }
  for (const file of coordinators.splice(0)) for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    try { rmSync(file + suffix, { force: true }); } catch (error) { errors.push(error); }
  }
  for (const root of roots.splice(0)) {
    try { removeTreeWithRetry(root); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "injection fixture cleanup failed");
}, 30_000);

for (const mode of ["deny", "queued-native", "legacy", "external", "malformed", "async", "async-reject"]) {
  test("client commit guard preserves every routing artifact (" + mode + ")", async () => {
    const result = await runScenario(mode);
    expect(result.result.success).toBe(false);
    expect(result.result.message).toContain(mode.startsWith("async") ? "must be synchronous" : "client_guard_refused");
    expect(result.guardCalls).toBe(1);
    expect(result.after).toEqual(result.before);
    if (mode === "queued-native") expect(result.observations).toContain("prepared");
    if (mode === "legacy") expect(result.contention.success).toBe(false);
  }, { timeout: 45_000 });
}
test("a queued reinjection cannot recreate artifacts after a genuine disconnect restore", async () => {
  const result = await runScenario("queued");
  expect(result.result.success).toBe(false);
  expect(result.restored.complete).toBe(true);
  expect(result.after).toEqual(result.before);
  // Restoring artifacts may invalidate N admission before the callback. The
  // native queued case above separately proves the receipt guard is reached.
  expect(result.guardCalls).toBeLessThanOrEqual(1);
}, { timeout: 45_000 });
test("an injection committed before the disconnect claim is restored afterward", async () => {
  const result = await runScenario("allow");
  expect(result.result.success).toBe(true);
  expect(result.guardCalls).toBe(1);
  expect(result.restored.complete).toBe(true);
  for (const [name, before] of Object.entries(result.before) as Array<[string, any]>) {
    expect(result.after[name]?.hash ?? null).toBe(before?.hash ?? null);
  }
}, { timeout: 45_000 });
