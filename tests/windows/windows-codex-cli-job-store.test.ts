/**
 * Windows Codex CLI update job store — the real handle-bound backend in
 * src/codex/cli-update-job-store-windows.ts exercised through the public
 * admit/run/read/finish API in src/codex/cli-update-job.ts, plus the
 * mixed-policy ACL parser in src/lib/windows-owner-acl.ts it consumes.
 *
 * Parser cases are pure and run everywhere. Backend cases require Windows x64:
 * they run the actual PowerShell ACL verifier and icacls hardening against a
 * private fixture under %TEMP%, so each case carries a real-subprocess budget.
 * Cross-account (other-SID) and ARM64 behavior are unverified by design.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { createCodexCliTestRoot } from "../helpers/codex-cli-fixture-root";
import { toNamespacedPath } from "node:path";
import { readWindowsJobStore, withWindowsJobStoreLock } from "../../src/codex/cli-update-job-store-windows";
import { trustWindowsTempFixtureAncestry } from "../helpers/windows-temp-ancestry";
import { admitCodexCliUpdateJob, finishCodexCliUpdateJob, readCodexCliUpdateJob, runCodexCliUpdateJob } from "../../src/codex/cli-update-job";
import { codexCliUpdateUnjoinedWorkerCount, runCodexCliUpdateApplyInWorker } from "../../src/codex/cli-update-job-worker";
import { FIXTURE_CONTROL_WORDS, FIXTURE_RELEASE } from "../helpers/cli-update-fixture-worker";
import { setWindowsOwnerAclAsyncRunnerForTests, windowsEntriesAclMatches, windowsOwnerAclDefaultRunnerForTests,
  type WindowsAclEntry } from "../../src/lib/windows-owner-acl";
import { hardenSecretDirAsync } from "../../src/lib/windows-secret-acl";
import { windowsCanonicalPathMatches } from "../../src/codex/windows-installation-files";
import { handleCodexCliUpdateRoutes } from "../../src/server/management/codex-cli-update-routes";
import { handleCodexCliUpdateCommand } from "../../src/cli/codex-cli-update";
import type { ManagementContext } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";
import type { CodexCliApplyResult } from "../../src/codex/cli-update-apply";

const USER_SID = "S-1-5-21-9-9-9-1001";
const FOREIGN_SID = "S-1-5-21-8-8-8-2002";
const ADMIN_SID = "S-1-5-32-544";
const SYSTEM_SID = "S-1-5-18";
const TRUSTED_INSTALLER_SID = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
const FULL_CONTROL = 2032127;
// Matches READ_MASK in src/lib/windows-owner-acl.ts: generic read/execute plus
// SYNCHRONIZE, READ_CONTROL and the attribute/EA/list bits. Nothing write-side.
const READ_ONLY_MASK = (0x80000000 | 0x20000000 | 0x100000 | 0x20000 | 0x80 | 0x20 | 0x8 | 0x1) >>> 0;
const CREATE_ONLY_MASK = 0x4 | 0x2;
const WRITE_BITS = 0x100 /* FILE_WRITE_ATTRIBUTES */ | 0x2 /* FILE_WRITE_DATA */;

function aclRun(user: string, tokenOwner: string, elevated: boolean, entries: readonly { owner: string; flags?: number; aces: readonly string[] }[]): string {
  const lines = [`U|${user}|${tokenOwner}|${elevated ? "True" : "False"}`];
  entries.forEach((entry, index) => {
    lines.push(`E|${index}|${entry.owner}|${entry.flags ?? 4}|${entry.aces.length}`);
    for (const ace of entry.aces) lines.push(`A|${index}|${ace}`);
  });
  lines.push("END");
  return lines.join("\n");
}
const allow = (mask: number, sid: string, flags = 0) => `0|${flags}|${mask}|${sid}|False`;
const deny = (mask: number, sid: string) => `1|0|${mask}|${sid}|False`;
const opaqueAce = (objectType = 5) => `${objectType}|X`;

describe("windows owner ACL mixed policies", () => {
  const userRun = (entries: readonly { owner: string; flags?: number; aces: readonly string[] }[],
    user = USER_SID, tokenOwner = USER_SID, elevated = false) => aclRun(user, tokenOwner, elevated, entries);

  test("held DOS long-name comparison refuses short aliases and accepts canonical casing", () => {
    expect(windowsCanonicalPathMatches("C:\\fixture\\LONGPR~1\\ocx", "\\\\?\\C:\\fixture\\LongProfileName\\ocx")).toBe(false);
    expect(windowsCanonicalPathMatches("c:/fixture/LongProfileName/ocx", "\\\\?\\C:\\FIXTURE\\LongProfileName\\ocx")).toBe(true);
    expect(windowsCanonicalPathMatches("C:\\fixture\\LongProfileName\\ocx", "C:\\fixture\\LongProfileName\\ocx")).toBe(false);
  });

  test("a foreign read-only grantee passes write-private but an untrusted writer refuses", () => {
    const entries: WindowsAclEntry[] = [{ path: "C:\\cfg", directory: true, policy: "write-private" }];
    expect(windowsEntriesAclMatches(userRun([{ owner: USER_SID, aces: [allow(FULL_CONTROL, USER_SID), allow(READ_ONLY_MASK, FOREIGN_SID)] }]), entries)).toBe(true);
    expect(windowsEntriesAclMatches(userRun([{ owner: USER_SID, aces: [allow(FULL_CONTROL, USER_SID), allow(READ_ONLY_MASK | WRITE_BITS, FOREIGN_SID)] }]), entries)).toBe(false);
    expect(windowsEntriesAclMatches(userRun([{ owner: USER_SID, aces: [allow(FULL_CONTROL, USER_SID), allow(CREATE_ONLY_MASK, FOREIGN_SID)] }]), entries)).toBe(false);
    // Kernel-equivalent owners are trusted independent of this token's elevation
    // state: a SYSTEM-owned entry granting only SYSTEM is confined either way.
    expect(windowsEntriesAclMatches(userRun([{ owner: SYSTEM_SID, aces: [allow(FULL_CONTROL, SYSTEM_SID)] }]), entries)).toBe(true);
    // Regression: an Administrators-owned profile parent must pass under a
    // filtered token exactly as under an elevated one — elevation only gates the
    // strict "private" objects this process hardened itself.
    const adminOwned = [{ owner: ADMIN_SID, aces: [allow(FULL_CONTROL, USER_SID), allow(FULL_CONTROL, ADMIN_SID)] }];
    expect(windowsEntriesAclMatches(userRun(adminOwned, USER_SID, USER_SID, false), entries)).toBe(true);
    expect(windowsEntriesAclMatches(userRun(adminOwned, USER_SID, ADMIN_SID, true), entries)).toBe(true);
    // A trusted owner does not launder an untrusted writer.
    const adminOwnedLeaky = [{ owner: ADMIN_SID, aces: [allow(FULL_CONTROL, USER_SID), allow(READ_ONLY_MASK | WRITE_BITS, FOREIGN_SID)] }];
    expect(windowsEntriesAclMatches(userRun(adminOwnedLeaky, USER_SID, USER_SID, false), entries)).toBe(false);
  });

  test("trusted ancestry accepts kernel-owned read-sharing and admin-owned create-only ancestors", () => {
    const entries: WindowsAclEntry[] = [{ path: "C:\\", directory: true, policy: "trusted-ancestry" }];
    for (const owner of [SYSTEM_SID, ADMIN_SID, TRUSTED_INSTALLER_SID]) {
      expect(windowsEntriesAclMatches(userRun([{ owner, aces: [allow(READ_ONLY_MASK, FOREIGN_SID)] }]), entries)).toBe(true);
    }
    // The stock C:\\ shape: a trusted owner may share create-only rights broadly.
    expect(windowsEntriesAclMatches(userRun([{ owner: ADMIN_SID, aces: [allow(READ_ONLY_MASK | CREATE_ONLY_MASK, FOREIGN_SID)] }]), entries)).toBe(true);
    // A user-owned ancestor may not share create rights, and nobody may share delete/write.
    expect(windowsEntriesAclMatches(userRun([{ owner: USER_SID, aces: [allow(CREATE_ONLY_MASK, FOREIGN_SID)] }]), entries)).toBe(false);
    expect(windowsEntriesAclMatches(userRun([{ owner: ADMIN_SID, aces: [allow(READ_ONLY_MASK | CREATE_ONLY_MASK | 0x10000, FOREIGN_SID)] }]), entries)).toBe(false);
    expect(windowsEntriesAclMatches(userRun([{ owner: FOREIGN_SID, aces: [allow(FULL_CONTROL, USER_SID)] }]), entries)).toBe(false);
  });

  test("confined policies tolerate deny ACEs but refuse callback, opaque and NULL-DACL output", () => {
    const entries: WindowsAclEntry[] = [{ path: "C:\\cfg", directory: true, policy: "write-private" }];
    expect(windowsEntriesAclMatches(userRun([{ owner: USER_SID, aces: [allow(FULL_CONTROL, USER_SID), deny(FULL_CONTROL, FOREIGN_SID)] }]), entries)).toBe(true);
    expect(windowsEntriesAclMatches(userRun([{ owner: USER_SID, aces: [allow(FULL_CONTROL, USER_SID), "9|0|2032127|S-1-5-11|True"] }]), entries)).toBe(false);
    expect(windowsEntriesAclMatches(userRun([{ owner: USER_SID, aces: [allow(FULL_CONTROL, USER_SID), opaqueAce()] }]), entries)).toBe(false);
    // NULL DACL: count -1 grants Everyone full access; never acceptable anywhere.
    const nullDacl = [`U|${USER_SID}|${USER_SID}|False`, `E|0|${USER_SID}|4|-1`, "END"].join("\n");
    expect(windowsEntriesAclMatches(nullDacl, entries)).toBe(false);
  });

  test("a mixed batch evaluates ancestry, parent and store policies in one protocol run", () => {
    const entries: WindowsAclEntry[] = [
      { path: "C:\\", directory: true, policy: "trusted-ancestry" },
      { path: "C:\\parent", directory: true, policy: "write-private" },
      { path: "C:\\parent\\ocx\\codex-cli-update-jobs", directory: true },
    ];
    const good = userRun([
      { owner: ADMIN_SID, aces: [allow(READ_ONLY_MASK | CREATE_ONLY_MASK, FOREIGN_SID)] },
      { owner: USER_SID, aces: [allow(FULL_CONTROL, USER_SID)] },
      { owner: USER_SID, flags: 4100, aces: [`0|3|${FULL_CONTROL}|${USER_SID}|False`] },
    ]);
    expect(windowsEntriesAclMatches(good, entries)).toBe(true);
    // The private leaf still requires the hardened shape; a relaxed leaf refuses the batch.
    const weakLeaf = userRun([
      { owner: ADMIN_SID, aces: [allow(READ_ONLY_MASK | CREATE_ONLY_MASK, FOREIGN_SID)] },
      { owner: USER_SID, aces: [allow(FULL_CONTROL, USER_SID)] },
      { owner: USER_SID, flags: 4100, aces: [`0|3|${FULL_CONTROL}|${USER_SID}|False`, `0|3|${READ_ONLY_MASK}|${FOREIGN_SID}|False`] },
    ]);
    expect(windowsEntriesAclMatches(weakLeaf, entries)).toBe(false);
  });
});

describe("Windows CLI update job store backend", () => {
  const result: CodexCliApplyResult = { outcome: "applied", reason: "verified_target", planId: "a".repeat(32),
    installedVersion: "1.0.0", targetVersion: "1.1.0", installerExitCode: 0, leaseRetained: false,
    verificationPid: null, cleanupErrors: [] };
  const fixtures: string[] = [];
  const envStack: (string | undefined)[] = [];
  const fixtureOwners = new Map<string, number>();
  function holdFixture(root: string): () => void {
    fixtureOwners.set(root, (fixtureOwners.get(root) ?? 0) + 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const count = fixtureOwners.get(root)! - 1;
      if (count) fixtureOwners.set(root, count); else fixtureOwners.delete(root);
    };
  }

  afterEach(() => {
    setWindowsOwnerAclAsyncRunnerForTests(null);
    while (envStack.length) {
      const previous = envStack.pop()!;
      if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
    }
    // A timeout does not cancel an async store operation or close its Worker.
    // Keep exact roots queued until both owners have actually completed.
    for (const root of fixtures.splice(0)) {
      if (fixtureOwners.has(root)) { fixtures.push(root); continue; }
      rmSync(root, { recursive: true, force: true });
    }
  });

  const winOnly = process.platform === "win32" && process.arch === "x64";
  // The test adapter trusts ancestry above this hardened OS-temp root only.
  // Every fixture object still runs its actual native pin and ACL policy.
  async function fixture(prefix: string, onCreated?: (root: string) => void): Promise<{ outer: string; configDir: string }> {
    const outer = createCodexCliTestRoot(prefix);
    onCreated?.(outer);
    fixtures.push(outer);
    await hardenSecretDirAsync(outer, { required: true });
    trustWindowsTempFixtureAncestry(outer);
    return { outer, configDir: join(outer, "ocx") };
  }
  async function withOwnedFixture(prefix: string,
    run: (input: { outer: string; configDir: string }) => Promise<void>): Promise<void> {
    let releaseBase: (() => void) | undefined;
    try {
      // Acquire before fixture()'s first await, including ACL hardening and admission.
      const input = await fixture(prefix, root => { releaseBase = holdFixture(root); });
      await run(input);
    } finally { releaseBase?.(); }
  }
  test("job-store fixture allocation stays inside the OS temp directory", async () => {
    let requested = "";
    const allocation = spyOn(fs, "mkdtempSync").mockImplementation(prefix => {
      requested = String(prefix); throw new Error("allocation_observed");
    });
    try { await expect(fixture("ocx-location-" )).rejects.toThrow("allocation_observed"); }
    finally { allocation.mockRestore(); }
    const child = relative(fs.realpathSync.native(tmpdir()), requested.replace(/^\\\\\?\\/, ""));
    expect(child.length).toBeGreaterThan(0);
    expect(child.startsWith("..")).toBe(false);
    expect(isAbsolute(child)).toBe(false);
  });
  test.skipIf(!winOnly)("canonical config beyond MAX_PATH publishes and reads the private ledger", async () => withOwnedFixture("ocx-long-ledger-", async ({ outer }) => {
    let parent = outer;
    while (parent.length < 270) {
      parent = join(parent, "c".repeat(Math.min(60, 270 - parent.length))); mkdirSync(parent);
      await hardenSecretDirAsync(toNamespacedPath(parent), { required: true });
    }
    const config = join(parent, "ocx");
    expect(config.length).toBeGreaterThan(260);
    await withWindowsJobStoreLock(config, true, async io => {
      await io.writeStore("{\"longPath\":true}");
      expect(await io.readStore()).toBe("{\"longPath\":true}");
    });
    expect(await readWindowsJobStore(config)).toBe("{\"longPath\":true}");
    expect(fs.realpathSync.native(config)).toBe(config);
  }), 180_000);
  function useHome(configDir: string): void {
    envStack.push(process.env.OPENCODEX_HOME);
    process.env.OPENCODEX_HOME = configDir;
  }
  function managementCtx(req: Request): ManagementContext {
    return { req, url: new URL(req.url),
      config: { port: 10100, providers: {} } as OcxConfig, deps: {}, version: "test",
      principal: "gui-session", trustedLoopbackIngress: true, guiSessionIssuance: "loopback",
      convergeCodexCatalog: async () => ({ status: "skipped", reason: "not-requested", retryable: false }),
      syncClaudeAgentDefsBestEffort: async () => {} };
  }

  test.skipIf(!winOnly)("private-store admission and status fence one production Worker completion", () => withOwnedFixture("ocx-winjob-worker-", async ({ outer, configDir }) => {
    useHome(configDir);
    const accepted = await admitCodexCliUpdateJob({ requestId: "win-worker-once-01", planId: result.planId, confirmed: true, configDir });
    expect(accepted.kind).toBe("accepted");
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let engineCalls = 0, workerStarts = 0;
    const releaseStore = holdFixture(outer);
    const pending = runCodexCliUpdateJob(accepted.job.jobId, accepted.generation, async () => {
      engineCalls++; enter(); await gate;
      return runCodexCliUpdateApplyInWorker(result.planId, {
        jobId: accepted.job.jobId, snapshot: null,
        env: { OPENCODEX_HOME: configDir, CODEX_HOME: join(outer, "codex") },
        spawnWorkerFn: url => {
          workerStarts++;
          const worker = new Worker(url, { type: "module" }), releaseWorker = holdFixture(outer);
          worker.addEventListener("close", releaseWorker, { once: true });
          return worker;
        },
      });
    }, configDir).finally(releaseStore);
    void pending.catch(() => {});
    try {
      await Promise.race([entered, pending.then(() => { throw new Error("store callback did not start"); })]);
      expect(await readCodexCliUpdateJob(accepted.job.jobId, configDir)).toMatchObject({ status: "running", ownerState: "active" });
      expect(await admitCodexCliUpdateJob({ requestId: "win-worker-once-01", planId: result.planId, confirmed: true, configDir }))
        .toMatchObject({ kind: "duplicate", job: { jobId: accepted.job.jobId, status: "running" } });
      // A stale generation cannot publish a fabricated successful completion.
      expect(await finishCodexCliUpdateJob(accepted.job.jobId, crypto.randomUUID(), 1, result, configDir))
        .toMatchObject({ status: "running", outcome: null });
      const status = await handleCodexCliUpdateRoutes(managementCtx(
        new Request(`http://localhost/api/codex/cli-update/jobs/${accepted.job.jobId}`)));
      expect(status?.status).toBe(200);
      expect(await status?.json()).toMatchObject({ jobId: accepted.job.jobId, status: "running", ownerState: "active" });
      const lines: string[] = [];
      const log = spyOn(console, "log").mockImplementation((...values: unknown[]) => lines.push(values.map(String).join(" ")));
      try {
        expect(await handleCodexCliUpdateCommand(["status", accepted.job.jobId, "--json"])).toBe(0);
        expect(JSON.parse(lines[0]!)).toMatchObject({ jobId: accepted.job.jobId, status: "running" });
      } finally { log.mockRestore(); }
    } finally { release(); await pending.catch(() => {}); }
    expect(await pending).toMatchObject({ status: "refused", outcome: "refused", reason: "mutation_evidence_unverified", ownerState: "finished" });
    // A null proof-bound snapshot cannot authorize installation in this enabled Windows lane.
    expect(engineCalls).toBe(1); expect(workerStarts).toBe(1);
    expect(await readCodexCliUpdateJob(accepted.job.jobId, configDir)).toMatchObject({ status: "refused", ownerState: "finished" });
    const ledger = JSON.parse(readFileSync(join(configDir, "codex-cli-update-jobs", "jobs.json"), "utf8")) as { jobs: { revision: number }[] };
    expect(ledger.jobs[0]!.revision).toBe(2);
  }), 60_000);

  test.skipIf(!winOnly)("private-store completion preserves an unknown live Worker without replaying its engine", () => withOwnedFixture("ocx-winjob-worker-unknown-", async ({ outer, configDir }) => {
    useHome(configDir);
    const accepted = await admitCodexCliUpdateJob({ requestId: "win-worker-unknown-01", planId: result.planId, confirmed: true, configDir });
    const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * FIXTURE_CONTROL_WORDS));
    const worker = new Worker(new URL("../helpers/cli-update-fixture-worker.ts", import.meta.url), { type: "module" });
    const terminate = spyOn(worker, "terminate");
    const releaseWorker = holdFixture(outer);
    let closed = false;
    const joined = new Promise<void>(resolve => worker.addEventListener("close", () => {
      closed = true; releaseWorker(); resolve();
    }, { once: true }));
    worker.postMessage({ type: "fixture-config", control: control.buffer, reply: "ambiguous", block: "after-reply" });
    const initial = codexCliUpdateUnjoinedWorkerCount();
    let engineCalls = 0, workerStarts = 0;
    const releaseStore = holdFixture(outer);
    const pending = runCodexCliUpdateJob(accepted.job.jobId, accepted.generation, () => {
      engineCalls++;
      return runCodexCliUpdateApplyInWorker(result.planId, { jobId: accepted.job.jobId, snapshot: null,
        closeGraceMs: 10, spawnWorkerFn: () => { workerStarts++; return worker; } });
    }, configDir).finally(releaseStore);
    void pending.catch(() => {});
    try {
      expect(await pending).toMatchObject({ status: "ambiguous", reason: "job_result_unknown", ownerState: "finished",
        childState: "unknown", leaseState: "unknown", lifetimeUncertain: true });
      expect(closed).toBe(false);
      expect(terminate).not.toHaveBeenCalled();
      expect(codexCliUpdateUnjoinedWorkerCount()).toBe(initial + 1);
      expect(await admitCodexCliUpdateJob({ requestId: "win-worker-unknown-01", planId: result.planId, confirmed: true, configDir }))
        .toMatchObject({ kind: "duplicate", job: { jobId: accepted.job.jobId, status: "ambiguous" } });
      const status = await handleCodexCliUpdateRoutes(managementCtx(
        new Request(`http://localhost/api/codex/cli-update/jobs/${accepted.job.jobId}`)));
      expect(status?.status).toBe(200);
      expect(await status?.json()).toMatchObject({ status: "ambiguous", childState: "unknown", leaseState: "unknown" });
      expect(engineCalls).toBe(1); expect(workerStarts).toBe(1);
    } finally {
      Atomics.store(control, FIXTURE_RELEASE, 1); Atomics.notify(control, FIXTURE_RELEASE);
      // If store admission failed before dispatch, this fixture may still be idle.
      try { worker.postMessage({ type: "fixture-close" }); } catch { /* close still must be observed */ }
      await joined; await pending.catch(() => {});
      terminate.mockRestore();
    }
    expect(codexCliUpdateUnjoinedWorkerCount()).toBe(initial);
    expect(await readCodexCliUpdateJob(accepted.job.jobId, configDir)).toMatchObject({ status: "ambiguous", reason: "job_result_unknown" });
  }), 60_000);

  test.skipIf(!winOnly)("admission dedupes, conflicts, applies and reads back through the real private store", async () => {
    const { configDir } = await fixture("ocx-winjob-admit-");
    const accepted = await admitCodexCliUpdateJob({ requestId: "win-admit-0001", planId: result.planId, confirmed: true, configDir });
    expect(accepted.kind).toBe("accepted");
    const replay = await admitCodexCliUpdateJob({ requestId: "win-admit-0001", planId: result.planId, confirmed: true, configDir });
    expect(replay).toMatchObject({ kind: "duplicate", job: { jobId: accepted.job.jobId } });
    await expect(admitCodexCliUpdateJob({ requestId: "win-admit-0001", planId: "b".repeat(32), confirmed: true, configDir }))
      .rejects.toThrow("idempotency_conflict");
    let runs = 0;
    const terminal = await runCodexCliUpdateJob(accepted.job.jobId, accepted.generation, async () => { runs++; return result; }, configDir);
    expect(terminal).toMatchObject({ status: "applied", outcome: "applied", ownerState: "finished" });
    expect(runs).toBe(1);
    expect(await readCodexCliUpdateJob(accepted.job.jobId, configDir)).toMatchObject({ status: "applied", ownerState: "finished" });
    expect(existsSync(join(configDir, "codex-cli-update-jobs", "jobs.json"))).toBe(true);
    expect(existsSync(join(configDir, "codex-cli-update-jobs", "admission.lock"))).toBe(false);
    expect(JSON.stringify(terminal)).not.toMatch(/ownerPid|generation|payloadHash|requestKey|token|path/i);
  }, 180_000);

  test.skipIf(!winOnly)("a competing begin preserves ownership while running publication is pending", () => withOwnedFixture("ocx-winjob-begin-", async ({ configDir }) => {
    const accepted = await admitCodexCliUpdateJob({ requestId: "win-begin-race-01", planId: result.planId, confirmed: true, configDir });
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let gated = false, runs = 0;
    // Real native handles and hardened objects; synthetic ACL replies hold the
    // first publication before engine entry while the contender exhausts retries.
    setWindowsOwnerAclAsyncRunnerForTests(async entries => {
      if (!gated && entries.length === 1 && entries[0]!.path.endsWith(".tmp")) {
        gated = true; entered.resolve(); await release.promise;
      }
      return { success: true, timedOut: false, stdout: aclRun(USER_SID, USER_SID, false,
        entries.map(entry => ({ owner: USER_SID, flags: 4100,
          aces: [allow(FULL_CONTROL, USER_SID, entry.directory ? 3 : 0)] }))) };
    });
    const engine = async () => { runs++; return result; };
    const first = runCodexCliUpdateJob(accepted.job.jobId, accepted.generation, engine, configDir);
    try {
      await Promise.race([entered.promise, first.then(() => { throw new Error("begin settled before barrier"); })]);
      expect(runs).toBe(0);
      await runCodexCliUpdateJob(accepted.job.jobId, accepted.generation, engine, configDir);
      expect(runs).toBe(0);
      release.resolve();
      await first;
      setWindowsOwnerAclAsyncRunnerForTests(null);
      expect(runs).toBe(1);
      expect(await readCodexCliUpdateJob(accepted.job.jobId, configDir)).toMatchObject(
        { status: "applied", reason: "verified_target", ownerState: "finished" });
      const stored = JSON.parse(readFileSync(join(configDir, "codex-cli-update-jobs", "jobs.json"), "utf8"));
      expect(stored.jobs[0]).toMatchObject({ status: "applied", revision: 2 });
    } finally {
      release.resolve(); await first.catch(() => {});
      setWindowsOwnerAclAsyncRunnerForTests(null);
    }
  }), 180_000);

  test.skipIf(!winOnly)("a pre-rename ACL failure removes the unpublished temp and preserves jobs.json", async () => {
    const { configDir } = await fixture("ocx-winjob-temp-");
    const input = { requestId: "win-temp-clean-01", planId: result.planId, confirmed: true as const, configDir };
    const accepted = await admitCodexCliUpdateJob(input);
    const dir = join(configDir, "codex-cli-update-jobs"), file = join(dir, "jobs.json");
    const before = readFileSync(file, "utf8");
    let injected = 0;
    setWindowsOwnerAclAsyncRunnerForTests(async (entries, timeout) => {
      if (entries.some(entry => entry.path.endsWith(".tmp"))) {
        injected++;
        return { success: false, timedOut: false, stdout: "" };
      }
      return windowsOwnerAclDefaultRunnerForTests(entries, timeout);
    });
    try {
      for (const requestId of ["win-temp-clean-02", "win-temp-clean-03"]) {
        await expect(admitCodexCliUpdateJob({ ...input, requestId })).rejects.toThrow("unsafe_store");
        expect(readFileSync(file, "utf8")).toBe(before);
        expect(readdirSync(dir).filter(name => /^\.jobs-.*\.tmp$/.test(name))).toEqual([]);
        expect(existsSync(join(dir, "admission.lock"))).toBe(false);
      }
      expect(injected).toBe(2);
    } finally { setWindowsOwnerAclAsyncRunnerForTests(null); }
    expect(await readCodexCliUpdateJob(accepted.job.jobId, configDir)).toMatchObject({ status: "queued" });
  }, 180_000);

  test.skipIf(!winOnly)("a post-rename verification failure never deletes the published jobs.json", async () => {
    const { configDir } = await fixture("ocx-winjob-published-");
    const input = { requestId: "win-published-01", planId: result.planId, confirmed: true as const, configDir };
    const accepted = await admitCodexCliUpdateJob(input);
    let verifiedTemp = false, injected = 0;
    setWindowsOwnerAclAsyncRunnerForTests(async (entries, timeout) => {
      if (entries.some(entry => entry.path.endsWith(".tmp"))) verifiedTemp = true;
      if (verifiedTemp && entries.some(entry => entry.path.endsWith("jobs.json"))) {
        injected++;
        return { success: false, timedOut: false, stdout: "" };
      }
      return windowsOwnerAclDefaultRunnerForTests(entries, timeout);
    });
    try {
      await expect(admitCodexCliUpdateJob({ ...input, requestId: "win-published-02" })).rejects.toThrow("unsafe_store");
      expect(injected).toBe(1);
    } finally { setWindowsOwnerAclAsyncRunnerForTests(null); }
    const dir = join(configDir, "codex-cli-update-jobs");
    const stored = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8"));
    expect(stored.jobs).toHaveLength(2);
    expect(stored.jobs[0].id).toBe(accepted.job.jobId);
    expect(readdirSync(dir).sort()).toEqual(["jobs.json"]);
    expect(await readCodexCliUpdateJob(accepted.job.jobId, configDir)).toMatchObject({ status: "queued" });
  }, 180_000);

  test.skipIf(!winOnly)("a second process dedupes the admitted request key and conflicts on a different payload", async () => {
    const { outer, configDir } = await fixture("ocx-winjob-twoproc-");
    mkdirSync(configDir);
    const modulePath = new URL("../../src/codex/cli-update-job.ts", import.meta.url).href;
    const accepted = await admitCodexCliUpdateJob({ requestId: "win-two-proc-01", planId: result.planId, confirmed: true, configDir });
    const script = `import { trustWindowsTempFixtureAncestry } from ${JSON.stringify(new URL("../helpers/windows-temp-ancestry.ts", import.meta.url).href)};
      trustWindowsTempFixtureAncestry(${JSON.stringify(outer)});
      import { admitCodexCliUpdateJob } from ${JSON.stringify(modulePath)};
      const planId = process.argv.at(-1);
      try {
        const admitted = await admitCodexCliUpdateJob({ requestId: "win-two-proc-01", planId, confirmed: true });
        console.log(JSON.stringify({ kind: admitted.kind, jobId: admitted.job.jobId }));
      } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(3); }`;
    const env = { ...process.env, OPENCODEX_HOME: configDir };
    const duplicate = spawnSync(process.execPath, ["-e", script, result.planId], { encoding: "utf8", timeout: 120_000, env });
    expect(duplicate.error).toBeUndefined();
    expect(duplicate.stderr).toBe("");
    expect(duplicate.status).toBe(0);
    expect(JSON.parse(duplicate.stdout.trim())).toEqual({ kind: "duplicate", jobId: accepted.job.jobId });
    const conflict = spawnSync(process.execPath, ["-e", script, "d".repeat(32)], { encoding: "utf8", timeout: 120_000, env });
    expect(conflict.status).toBe(3);
    expect(conflict.stderr).toContain("idempotency_conflict");
  }, 300_000);

  test.skipIf(!winOnly)("an ACL verification failure refuses before the engine runs", async () => {
    const { configDir } = await fixture("ocx-winjob-aclfail-");
    const accepted = await admitCodexCliUpdateJob({ requestId: "win-acl-fail-01", planId: result.planId, confirmed: true, configDir });
    let runs = 0;
    setWindowsOwnerAclAsyncRunnerForTests(async () => ({ success: false, timedOut: false, stdout: "" }));
    try {
      await expect(runCodexCliUpdateJob(accepted.job.jobId, accepted.generation,
        async () => { runs++; return result; }, configDir)).rejects.toThrow("unsafe_store");
      expect(runs).toBe(0);
    } finally { setWindowsOwnerAclAsyncRunnerForTests(null); }
    // The refused begin left the durable record intact; with this process having
    // released ownership it reads back honestly as an owner-unknown queued record.
    expect(await readCodexCliUpdateJob(accepted.job.jobId, configDir)).toMatchObject(
      { status: "ambiguous", ownerState: "unknown", reason: "owner_state_unknown" });
    // A replaced (corrupt) ledger body refuses reads and later admission the same closed way.
    writeFileSync(join(configDir, "codex-cli-update-jobs", "jobs.json"), "not a ledger", "utf8");
    await expect(readCodexCliUpdateJob(accepted.job.jobId, configDir)).rejects.toThrow();
    await expect(admitCodexCliUpdateJob({ requestId: "win-acl-fail-02", planId: result.planId, confirmed: true, configDir })).rejects.toThrow();
  }, 180_000);

  test.skipIf(!winOnly)("a transient persistence failure retries the completed revision without rerunning the engine", async () => {
    const { configDir } = await fixture("ocx-winjob-retry-");
    const accepted = await admitCodexCliUpdateJob({ requestId: "win-retry-0001", planId: result.planId, confirmed: true, configDir });
    const nativeSync = fs.fsyncSync;
    let calls = 0, runs = 0;
    let sync: ReturnType<typeof spyOn> | undefined;
    try {
      const terminal = await runCodexCliUpdateJob(accepted.job.jobId, accepted.generation, async () => {
        runs++;
        // Installed here so call numbering starts at completion: call 1 is the
        // finish admission-lock owner fsync, call 2 the ledger temp-body fsync —
        // a transient failure there retries the same revision, never the engine.
        sync = spyOn(fs, "fsyncSync").mockImplementation(fd => {
          if (++calls === 2) throw Object.assign(new Error("injected transient sync failure"), { code: "EBUSY" });
          return nativeSync(fd);
        });
        return result;
      }, configDir);
      expect(terminal).toMatchObject({ status: "applied", reason: "verified_target" });
    } finally { sync?.mockRestore(); }
    expect(runs).toBe(1);
    expect(calls).toBeGreaterThan(2);
    expect(await readCodexCliUpdateJob(accepted.job.jobId, configDir)).toMatchObject({ outcome: "applied" });
    const ledger = JSON.parse(readFileSync(join(configDir, "codex-cli-update-jobs", "jobs.json"), "utf8")) as { jobs: { revision: number }[] };
    expect(ledger.jobs[0]!.revision).toBe(2);
  }, 180_000);

  test.skipIf(!winOnly)("a restarted reader reports an unfinished owner unknown without claiming it stopped",
    () => withOwnedFixture("ocx-winjob-restart-", async ({ outer, configDir }) => {
    const accepted = await admitCodexCliUpdateJob({ requestId: "win-restart-001", planId: result.planId, confirmed: true, configDir });
    // Both resolves exist before the engine callback can be entered: entered marks
    // that begin committed the running revision, and whenever finally runs release()
    // settles the engine even if the engine starts late or never.
    let entered!: () => void;
    let release!: () => void;
    const engineEntered = new Promise<void>(resolve => { entered = resolve; });
    const engineGate = new Promise<CodexCliApplyResult>(resolve => { release = () => resolve(result); });
    const releaseStore = holdFixture(outer);
    const pending = runCodexCliUpdateJob(accepted.job.jobId, accepted.generation,
      () => { entered(); return engineGate; }, configDir).finally(releaseStore);
    try {
      // Wait on the causal precondition instead of polling the store for its
      // projection: engine entry means begin committed "running" with live+started
      // registered, so a single read at that point is stable evidence. A failed
      // begin settles pending early with its read-back DTO (production swallows the
      // begin error), so that DTO or error is asserted as-is; the 120s deadline
      // still bounds a begin that neither settles nor commits.
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const observation = await Promise.race([
        engineEntered.then(() => "entered" as const),
        pending.then(() => "settled" as const, () => "settled" as const),
        new Promise<"timeout">(resolve => { deadline = setTimeout(() => resolve("timeout"), 120_000); }),
      ]);
      if (deadline) clearTimeout(deadline);
      const observed = observation === "entered"
        ? await readCodexCliUpdateJob(accepted.job.jobId, configDir)
        : observation === "settled" ? await pending
        : null;
      expect(observed).toMatchObject({ status: "running", ownerState: "active" });
      const modulePath = new URL("../../src/codex/cli-update-job.ts", import.meta.url).href;
      const script = `import { trustWindowsTempFixtureAncestry } from ${JSON.stringify(new URL("../helpers/windows-temp-ancestry.ts", import.meta.url).href)};
        trustWindowsTempFixtureAncestry(${JSON.stringify(outer)});
        import { readCodexCliUpdateJob } from ${JSON.stringify(modulePath)};
        console.log(JSON.stringify(await readCodexCliUpdateJob(${JSON.stringify(accepted.job.jobId)})));`;
      const releaseChild = holdFixture(outer);
      try {
        const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 120_000,
          env: { ...process.env, OPENCODEX_HOME: configDir } });
        expect({ error: child.error ?? null, status: child.status, signal: child.signal,
          stdout: child.stdout?.trim() ?? null, stderr: child.stderr?.trim() ?? null })
          .toMatchObject({ error: null, status: 0 });
        expect(JSON.parse(child.stdout.trim())).toMatchObject({ status: "ambiguous", outcome: "ambiguous",
          ownerState: "unknown", lifetimeUncertain: true, reason: "owner_state_unknown" });
      } finally { releaseChild(); }
    } finally {
      release();
      await pending.catch(() => undefined);
    }
    expect(await pending).toMatchObject({ status: "applied", ownerState: "finished" });
  }), 300_000);

  test.skipIf(!winOnly)("HTTP apply advertises retry on a leftover lock and status reads the same durable record", async () => {
    const { configDir } = await fixture("ocx-winjob-http-");
    const accepted = await admitCodexCliUpdateJob({ requestId: "win-http-00001", planId: result.planId, confirmed: true, configDir });
    useHome(configDir);
    // Crash-shaped residue: an admission.lock the backend never wrote keeps later admission busy.
    mkdirSync(join(configDir, "codex-cli-update-jobs", "admission.lock"));
    const applyReq = () => new Request("http://localhost/api/codex/cli-update/apply", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "win-http-other-1", planId: "e".repeat(32), confirmed: true }) });
    const busy = await handleCodexCliUpdateRoutes(managementCtx(applyReq()));
    expect(busy?.status).toBe(503);
    expect(await busy?.json()).toEqual({ error: "job_store_busy" });
    expect(busy?.headers.get("Retry-After")).toBe("1");
    rmSync(join(configDir, "codex-cli-update-jobs", "admission.lock"), { recursive: true });
    const status = await handleCodexCliUpdateRoutes(managementCtx(
      new Request(`http://localhost/api/codex/cli-update/jobs/${accepted.job.jobId}`)));
    expect(status?.status).toBe(200);
    expect(await status?.json()).toMatchObject({ jobId: accepted.job.jobId, status: "queued", ownerState: "active" });
    const logs: string[] = [];
    const oldLog = console.log;
    try {
      console.log = (...values: unknown[]) => logs.push(values.map(String).join(" "));
      expect(await handleCodexCliUpdateCommand(["status", accepted.job.jobId, "--json"])).toBe(0);
    } finally { console.log = oldLog; }
    expect(JSON.parse(logs[0]!)).toMatchObject({ jobId: accepted.job.jobId, status: "queued" });
  }, 180_000);

  test.skipIf(!winOnly)("a config path that is a file refuses before any write", async () => {
    const { configDir } = await fixture("ocx-winjob-filecfg-");
    writeFileSync(configDir, "not a directory", "utf8");
    let runs = 0;
    await expect(admitCodexCliUpdateJob({ requestId: "win-file-cfg-01", planId: result.planId, confirmed: true, configDir })).rejects.toThrow();
    await expect(runCodexCliUpdateJob("12345678-1234-1234-1234-123456789012", "12345678-1234-1234-1234-123456789012",
      async () => { runs++; return result; }, configDir)).rejects.toThrow();
    expect(runs).toBe(0);
  }, 60_000);
});
