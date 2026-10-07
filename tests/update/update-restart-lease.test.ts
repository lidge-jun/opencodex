/**
 * #5760's other half. A service-manager start child is not a descendant of the
 * updater: Task Scheduler, launchd and systemd spawn `ocx start` with the stored
 * registration environment, so it carries no OCX_OWNERSHIP_MUTATION_LEASE_TOKEN and
 * can never join the lease the updater holds. `bin/ocx.mjs` already releases before
 * the service refresh; the dashboard restart worker held the lease across the whole
 * restart — including the repair's serving wait — so the managed child died at the
 * acquire deadline and every service-installed update restarted into an unmanaged
 * direct proxy beside a suppressed supervisor.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import * as os from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  OWNERSHIP_MUTATION_LEASE_TOKEN_ENV,
} from "../../src/service/ownership-mutation-lease.mjs";
import { protectedHomeForTests } from "../../src/lib/test-home-guard";
import {
  readUpdateJob,
  restartAfterUpdateForTests,
  updateJobPath,
  type UpdateJobState,
} from "../../src/update/job";
import { runUpdateRestartWithOwnershipLease } from "../../src/update/restart-ownership";
import { serviceStatePaths, type ServiceOwnershipResolution } from "../../src/service/state";
import { isolationBudgetMs, watchdogMs } from "../helpers/ci-watchdog";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

type Sandbox = {
  root: string;
  home: string;
  ocxHome: string;
  codexHome: string;
  /** The last entry serviceStatePaths() keeps — the path the lease binds to. */
  authority: string;
  lockDir: string;
};

const ENV_KEYS = [
  "OPENCODEX_HOME",
  "HOME",
  "USERPROFILE",
  "CODEX_HOME",
  "CODEX_SQLITE_HOME",
  "XDG_RUNTIME_DIR",
  "OCX_TEST_HOME_GUARD",
  "OCX_REAL_HOME",
  OWNERSHIP_MUTATION_LEASE_TOKEN_ENV,
] as const;

let saved: Record<string, string | undefined> = {};
let sandboxes: Sandbox[] = [];
type FixtureChild = {
  box: Sandbox;
  process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  output: string[];
  abort: AbortController;
  drains: Promise<unknown>[];
  reaped: boolean;
  drained: boolean;
  forced: boolean;
  cleanupProven: boolean;
  released?: string;
  cleanup?: Promise<void>;
  failureObserved?: boolean;
};
let children: FixtureChild[] = [];
let childLogs: string[] = [];
let childDrains: Promise<unknown>[] = [];
let homeSpy: ReturnType<typeof spyOn<typeof os, "homedir">>;

/** The real home this process was started under, for the spawned child's guard. */
const realHome = dirname(protectedHomeForTests());

function sandbox(): Sandbox {
  const root = realpathSync.native(mkdtempSync(join(os.tmpdir(), "ocx-restart-lease-")));
  const home = join(root, "home");
  const codexHome = join(root, "codex");
  const ocxHome = join(root, "ocx");
  for (const path of [home, codexHome, ocxHome, join(root, "runtime"), join(home, ".opencodex")]) {
    mkdirSync(path, { recursive: true });
  }
  // In-process callers (serviceStatePaths, updateJobPath) resolve from these.
  process.env.OPENCODEX_HOME = ocxHome;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_SQLITE_HOME = codexHome;
  process.env.XDG_RUNTIME_DIR = join(root, "runtime");
  process.env.OCX_TEST_HOME_GUARD = "1";
  process.env.OCX_REAL_HOME = realHome;
  delete process.env[OWNERSHIP_MUTATION_LEASE_TOKEN_ENV];
  homeSpy.mockReturnValue(home);
  const paths = serviceStatePaths();
  for (const candidate of paths) assertContained(root, candidate);
  const authority = paths.at(-1)!;
  assertContained(root, authority);
  const box = { root, home, ocxHome, codexHome, authority, lockDir: leasePathFor(authority) };
  assertContained(root, box.lockDir);
  sandboxes.push(box);
  return box;
}

/** The environment a Task Scheduler / launchd / systemd child actually gets: stored, no token. */
function serviceManagerChildEnvironment(box: Sandbox): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: box.home,
    USERPROFILE: box.home,
    CODEX_HOME: box.codexHome,
    CODEX_SQLITE_HOME: box.codexHome,
    OPENCODEX_HOME: box.ocxHome,
    XDG_RUNTIME_DIR: join(box.root, "runtime"),
    NO_PROXY: "127.0.0.1,localhost",
    OCX_TEST_HOME_GUARD: "1",
    OCX_REAL_HOME: realHome,
    OCX_SERVICE: "1",
    OCX_SERVICE_MANAGED: "1",
  };
  delete env[OWNERSHIP_MUTATION_LEASE_TOKEN_ENV];
  return env;
}

function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
  });
  return promise;
}

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  expect(rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), candidate).toBe(true);
}

async function bounded<T>(work: Promise<T>, label: string, ms = isolationBudgetMs(5_000)): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

function trackChild(box: Sandbox, child: FixtureChild["process"]): FixtureChild {
  const entry: FixtureChild = {
    box, process: child, output: [], abort: new AbortController(), drains: [], reaped: false, drained: false, forced: false, cleanupProven: false,
  };
  children.push(entry);
  for (const stream of [child.stdout, child.stderr]) {
    const decoder = new TextDecoder();
    entry.drains.push(stream.pipeTo(new WritableStream({ write(chunk: Uint8Array) {
      const text = decoder.decode(chunk, { stream: true });
      entry.output.push(text);
      childLogs.push(text);
    } }), { signal: entry.abort.signal }));
  }
  // Observe failures immediately, but keep the rejected originals for teardown.
  void Promise.allSettled(entry.drains);
  childDrains.push(...entry.drains);
  return entry;
}

/** Startup probes the configured port before applying --port; keep both case-owned. */
function writeServiceConfig(box: Sandbox, port: number): void {
  writeFileSync(join(box.ocxHome, "config.json"), JSON.stringify({
    port,
    hostname: "127.0.0.1",
    codexAutoStart: false,
    clientIntegrations: { codex: false, grok: false, "claude-desktop": false },
    claudeCode: { systemEnv: false },
    providers: {},
    defaultProvider: "openai",
  }));
}

function spawnServiceChild(box: Sandbox, port: number): FixtureChild["process"] {
  return trackChild(box, Bun.spawn(
    [process.execPath, repoPath("src/cli/index.ts"), "start", "--port", String(port)],
    { cwd: box.root, env: serviceManagerChildEnvironment(box), stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )).process;
}

const LEASE_MODULE_URL = pathToFileURL(repoPath("src/service/ownership-mutation-lease.mjs")).href;
const SERVICE_STATE_MODULE_URL = pathToFileURL(repoPath("src/service/state.ts")).href;

async function serviceManagerChildAuthority(box: Sandbox): Promise<string> {
  const child = trackChild(box, Bun.spawn([process.execPath, "-e", `
    const { serviceStatePaths } = await import(${JSON.stringify(SERVICE_STATE_MODULE_URL)});
    process.stdout.write(JSON.stringify(serviceStatePaths()));
  `], {
    cwd: box.root, env: serviceManagerChildEnvironment(box), stdin: "pipe", stdout: "pipe", stderr: "pipe",
  }));
  const exitCode = await bounded(child.process.exited, "service-state authority probe timed out");
  await bounded(Promise.all(child.drains), "authority probe drains timed out");
  if (exitCode !== 0) throw new Error(`service-state authority probe failed (${exitCode}): ${child.output.join("")}`);
  const paths: string[] = JSON.parse(child.output.join(""));
  for (const candidate of paths) assertContained(box.root, candidate);
  expect(paths).toEqual(serviceStatePaths());
  return paths.at(-1)!;
}

/**
 * A real lease holder in a separate process. It acquires through the lease module alone, on the
 * paths this process resolved for the sandbox (sandbox() already proved them contained), and
 * re-checks containment before it touches anything.
 *
 * It deliberately does not re-resolve them by importing src/service/state.ts. That import pulls
 * in the whole config graph (~460 modules, ~1 s of CPU in a cold Bun child), and on hosted
 * Windows runners a cold import of that size has a multi-second I/O-latency tail: holders were
 * measured spending 8 s of wall time on ~0.6 s of CPU inside it, which is the acknowledgment
 * budget below (B8, dev f924820652). The holder's job is to hold the real lease; that a
 * service-manager child resolves the same authority from its stored environment is proven
 * separately by serviceManagerChildAuthority().
 */
function spawnHolder(box: Sandbox, behavior: "release" | "ignore-eof" | "missing-ack" = "release"): FixtureChild {
  const ready = join(box.root, "holder-ready.json");
  const released = join(box.root, "holder-released");
  const statePaths = serviceStatePaths();
  const child = trackChild(box, Bun.spawn([process.execPath, "-e", `
    const { writeFileSync, renameSync } = await import("node:fs");
    const { relative, isAbsolute, sep } = await import("node:path");
    const paths = ${JSON.stringify(statePaths)};
    for (const candidate of paths) {
      const rel = relative(${JSON.stringify(box.root)}, candidate);
      if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) throw new Error("holder authority escaped");
    }
    if (paths.at(-1) !== ${JSON.stringify(box.authority)}) throw new Error("holder authority mismatch");
    const { acquireOwnershipMutationLease } = await import(${JSON.stringify(LEASE_MODULE_URL)});
    const lease = acquireOwnershipMutationLease(paths);
    writeFileSync(${JSON.stringify(ready + ".pending")}, JSON.stringify({ pid: process.pid, paths }));
    renameSync(${JSON.stringify(ready + ".pending")}, ${JSON.stringify(ready)});
    await Bun.stdin.text();
    if (${JSON.stringify(behavior)} === "ignore-eof") await new Promise(() => { setInterval(() => {}, 1_000); });
    lease.release();
    if (${JSON.stringify(behavior)} !== "missing-ack") writeFileSync(${JSON.stringify(released)}, String(process.pid));
  `], {
    cwd: box.root, env: serviceManagerChildEnvironment(box), stdin: "pipe", stdout: "pipe", stderr: "pipe",
  }));
  child.released = released;
  const deadline = Date.now() + isolationBudgetMs(5_000);
  while (!existsSync(ready) && Date.now() < deadline) Bun.sleepSync(20);
  expect(existsSync(ready), "holder did not acknowledge acquisition").toBe(true);
  const receipt = JSON.parse(readFileSync(ready, "utf8"));
  expect(receipt).toEqual({ pid: child.process.pid, paths: serviceStatePaths() });
  const owners = readdirSync(box.lockDir);
  expect(owners).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(box.lockDir, owners[0]!), "utf8")).pid).toBe(child.process.pid);
  return child;
}

function cleanupChild(child: FixtureChild, graceMs = isolationBudgetMs(5_000)): Promise<void> {
  return child.cleanup ??= (async () => {
    const failures: unknown[] = [];
    try {
      if (child.released) await bounded(Promise.resolve(child.process.stdin.end()), "fixture child stdin close timed out", graceMs);
      else if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill();
      const exit = await bounded(child.process.exited, "fixture child graceful exit timed out", graceMs);
      child.reaped = true;
      if (child.released && (exit !== 0 || !existsSync(child.released)
        || readFileSync(child.released, "utf8") !== String(child.process.pid) || existsSync(child.box.lockDir))) {
        throw new Error("holder graceful release lacked acknowledgment, exit 0, or exact lock absence");
      }
    } catch (error) {
      failures.push(error);
      try {
        if (!child.reaped) {
          child.process.kill("SIGKILL");
          child.forced = true;
          await bounded(child.process.exited, "fixture child fallback reap timed out");
          child.reaped = true;
        }
      } catch (fallbackError) { failures.push(fallbackError); }
    } finally {
      const outcomes: Array<PromiseSettledResult<unknown> | undefined> = child.drains.map(() => undefined);
      const settled = Promise.all(child.drains.map((drain, index) => drain.then(
        value => { outcomes[index] = { status: "fulfilled", value }; },
        reason => { outcomes[index] = { status: "rejected", reason }; },
      )));
      const ownedCancellation = new Error("fixture-owned drain cancellation");
      try {
        await bounded(Promise.all(child.drains), "fixture child drains timed out");
        child.drained = true;
      } catch (error) {
        // A drain rejection is collected by index below; only the wait's own error is added here.
        if (!outcomes.some(result => result?.status === "rejected" && result.reason === error)) failures.push(error);
        child.abort.abort(ownedCancellation);
        try {
          await bounded(settled, "fixture child drain cancellation timed out");
          child.drained = true;
        } catch (drainError) { failures.push(drainError); }
      }
      // Preserve late and same-object rejections from every drain, even after a bounded wait fails.
      for (const result of outcomes) {
        if (result?.status === "rejected" && result.reason !== ownedCancellation) failures.push(result.reason);
      }
    }
    if (failures.length) throw new AggregateError(failures, `fixture cleanup failed: ${failures.map(String).join("; ")}`);
    child.cleanupProven = true;
  })();
}

function canRemoveSandbox(box: Sandbox): boolean {
  return children.filter(child => child.box === box).every(child =>
    child.reaped && child.drained && (child.cleanupProven || child.failureObserved === true));
}

function expectOnlyCleanupFailure(error: unknown, message: string): void {
  expect(error).toBeInstanceOf(AggregateError);
  const failures = (error as AggregateError).errors;
  expect(failures).toHaveLength(1);
  expect(failures[0]).toBeInstanceOf(Error);
  expect(failures[0].message).toBe(message);
}

/** Mirrors leasePath() in src/service/ownership-mutation-lease.mjs. */
function leasePathFor(authority: string): string {
  try { return `${realpathSync.native(authority)}.mutation.lock`; }
  catch {
    try { return join(realpathSync.native(dirname(authority)), `${basename(authority)}.mutation.lock`); }
    catch { return `${authority}.mutation.lock`; }
  }
}

/** The authority the wrapper's `serviceStatePaths()` binds its lock to. */
function authorityPath(box: Sandbox): string {
  return box.authority;
}

/** A fresh-process acquire probe with no delegated token — what a foreign claimant faces. */
function contenderAcquire(box: Sandbox): number | null {
  const env = { ...process.env, FIXTURE_AUTHORITY: authorityPath(box) };
  delete env[OWNERSHIP_MUTATION_LEASE_TOKEN_ENV];
  return spawnSync(process.execPath, ["-e", `
    const { acquireOwnershipMutationLease } = await import(${JSON.stringify(LEASE_MODULE_URL)});
    try {
      const lease = acquireOwnershipMutationLease([process.env.FIXTURE_AUTHORITY], { waitMs: 0 });
      lease.release();
      process.exit(0);
    } catch { process.exit(17); }
  `], { env, timeout: 15_000 }).status;
}

function fakeChild(): ChildProcess {
  const fake = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
  fake.pid = 1;
  fake.exitCode = null;
  fake.signalCode = null;
  return fake as ChildProcess;
}

function proxyPublished(box: Sandbox, port: number): boolean {
  try {
    const runtime = JSON.parse(readFileSync(join(box.ocxHome, "runtime-port.json"), "utf8"));
    return runtime?.port === port && Number.isSafeInteger(runtime?.pid);
  } catch {
    return false;
  }
}

/** What serviceRestartServed's production probe asks: is anything serving on the port? */
async function proxyServes(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function writeJob(ocxHome: string, partial: Partial<UpdateJobState> = {}): UpdateJobState {
  const now = new Date().toISOString();
  const job: UpdateJobState = {
    id: `restart-lease-${process.pid}-${Math.random().toString(36).slice(2)}`,
    status: "restarting",
    startedAt: now,
    updatedAt: now,
    currentVersion: "2.74.0",
    latestVersion: "2.76.0",
    channel: "latest",
    installer: "npm",
    restart: true,
    command: "",
    releaseNotesUrl: "",
    log: [],
    ...partial,
  };
  writeFileSync(updateJobPath(), JSON.stringify(job));
  return job;
}

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  homeSpy = spyOn(os, "homedir");
});

afterEach(async () => {
  const failures: unknown[] = [];
  try {
    for (const child of children) {
      try { await cleanupChild(child); }
      catch (error) { if (!child.failureObserved) failures.push(error); }
    }
    for (const box of sandboxes) {
      if (!canRemoveSandbox(box)) {
        failures.push(new Error(`retaining fixture with unconfirmed child cleanup: ${box.root}`));
      } else {
        try { removeTreeWithRetry(box.root); }
        catch (error) { failures.push(error); }
      }
    }
  } finally {
    try { homeSpy.mockRestore(); }
    finally {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      children = [];
      childDrains = [];
      sandboxes = [];
      childLogs = [];
    }
  }
  if (failures.length) throw new AggregateError(failures, "lease fixture teardown failed");
}, watchdogMs(90_000));

describe("the restart veto lease frees a service-manager child (#5760)", () => {
  test("a supervised `ocx start` outside the process tree dies at a held lease — the mechanic the release exists for", async () => {
    const box = sandbox();
    expect(await serviceManagerChildAuthority(box)).toBe(box.authority);
    const port = await freePort();
    writeServiceConfig(box, port);
    const { acquireOwnershipMutationLease } = await import("../../src/service/ownership-mutation-lease.mjs");
    const { serviceStatePaths } = await import("../../src/service/state");
    const lease = acquireOwnershipMutationLease(serviceStatePaths());
    const child = spawnServiceChild(box, port);
    let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const awaitingChildDrains = Promise.all(childDrains);
      const exit = await Promise.race([
        child.exited.then(async code => {
          await awaitingChildDrains;
          return code;
        }),
        new Promise<never>((_, reject) => {
          watchdogTimer = setTimeout(
            () => reject(new Error("service child survived a held lease")),
            watchdogMs(10_000),
          );
        }),
      ]);
      const output = childLogs.join("");
      expect(exit, output).not.toBe(0);
      expect(output).toContain("another process owns the runtime mutation lease");
    } finally {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      lease.release();
    }
  }, watchdogMs(10_000) + 10_000);

  test("a GUI restart releases the lease before the service refresh so the managed child binds", async () => {
    const box = sandbox();
    expect(await serviceManagerChildAuthority(box)).toBe(box.authority);
    const port = await freePort();
    writeServiceConfig(box, port);
    const job = writeJob(box.ocxHome);
    let child: FixtureChild["process"] | undefined;
    let directStarts = 0;
    const outcome = await runUpdateRestartWithOwnershipLease(
      () => ({ kind: "none", revision: 0 }),
      async lease => {
        await restartAfterUpdateForTests(job, { port, hostname: "127.0.0.1" }, {
          platform: "win32",
          serviceInstalledFn: () => true,
          serviceViableFn: () => true,
          // `ocx service repair` only exits 0 after ITS own 45s serving probe, so the
          // served window below starts while the child is still in Bun's cold boot.
          serviceHealthTimeoutMs: isolationBudgetMs(45_000),
          healthTimeoutMs: 5_000,
          waitForPort: async () => true,
          listListenPidsFn: () => [],
          scanListenPidsFn: () => ({ ok: true, pids: [] }),
          isAliveFn: () => false,
          probeProxy: p => proxyServes(p),
          probeProxyIdentity: async () => null,
          // `ocx service repair` would re-activate the task here; the manager's own
          // spawn is what carries no lease token.
          runService: () => {
            child = spawnServiceChild(box, port);
            return { status: 0, signal: null, timedOut: false };
          },
          spawnStart: () => { directStarts += 1; },
          spawnDetachedStartFn: () => {
            directStarts += 1;
            return fakeChild();
          },
          killProxyFn: () => {},
          preparePortForPinnedStartFn: () => {},
          waitForGhostListenClearFn: async () => ({ ok: true, accessDenied: false }),
          releaseForServiceManagerFn: lease?.releaseForServiceManager,
          reacquireForDirectStartFn: lease?.reacquireForDirectStart,
        });
        return true;
      },
    );
    expect(outcome).toEqual({ kind: "ran", value: true });
    // Served means the manager's child took the lease, bound and published.
    expect(child, "the service refresh should spawn the managed child").toBeDefined();
    expect(child!.exitCode).toBeNull();
    expect(childLogs.join("")).not.toContain("mutation lease");
    expect(proxyPublished(box, port)).toBe(true);
    expect(directStarts).toBe(0);
  }, watchdogMs(150_000));

  test("a claim landing during the released refresh window vetoes the fallthrough", async () => {
    const box = sandbox();
    const port = await freePort();
    const job = writeJob(box.ocxHome);
    let claimed = false;
    let leasedAtRefresh: boolean | undefined;
    let spawned = 0;
    let killed = 0;
    const resolve = (): ServiceOwnershipResolution => claimed
      ? { kind: "owned", ownership: { owner: "desktop", installId: "app-install-a", consentGeneration: 1 }, revision: 2 }
      : { kind: "none", revision: 0 };
    const outcome = await runUpdateRestartWithOwnershipLease(resolve, async lease =>
      restartAfterUpdateForTests(job, { port, hostname: "127.0.0.1" }, {
        platform: "win32",
        serviceInstalledFn: () => true,
        serviceViableFn: () => true,
        // The refresh ran (and failed) while the lease was released; a desktop
        // claim landed inside that window.
        runService: () => {
          leasedAtRefresh = existsSync(box.lockDir);
          claimed = true;
          return { status: 1, signal: null, timedOut: false };
        },
        releaseForServiceManagerFn: lease.releaseForServiceManager,
        reacquireForDirectStartFn: lease.reacquireForDirectStart,
        waitForPort: async () => true,
        listListenPidsFn: () => [],
        scanListenPidsFn: () => ({ ok: true, pids: [] }),
        isAliveFn: () => false,
        probeProxy: async () => false,
        probeProxyIdentity: async () => null,
        spawnStart: () => { spawned += 1; },
        spawnDetachedStartFn: () => {
          spawned += 1;
          return fakeChild();
        },
        killProxyFn: () => { killed += 1; },
        preparePortForPinnedStartFn: () => {},
        waitForGhostListenClearFn: async () => ({ ok: true, accessDenied: false }),
      }));
    expect(outcome).toEqual({ kind: "ran", value: false });
    expect(leasedAtRefresh).toBe(false);
    expect(spawned).toBe(0);
    expect(killed).toBe(0);
    const saved = readUpdateJob(job.id);
    expect(saved?.status).toBe("succeeded");
    expect(saved?.restarted).toBe(false);
    expect(saved?.log.some(line => line.includes("app-install-a"))).toBe(true);
  });

  test("the fallthrough re-acquires the lease and holds it through reclaim and the direct start", async () => {
    const box = sandbox();
    const port = await freePort();
    const job = writeJob(box.ocxHome);
    const lockState: boolean[] = [];
    const contention: Array<number | null> = [];
    let leasedAtRefresh: boolean | undefined;
    let spawnCount = 0;
    const outcome = await runUpdateRestartWithOwnershipLease(
      () => ({ kind: "none", revision: 0 }),
      async lease => {
        await restartAfterUpdateForTests(job, { port, hostname: "127.0.0.1" }, {
          platform: "win32",
          serviceInstalledFn: () => true,
          serviceViableFn: () => true,
          runService: () => {
            leasedAtRefresh = existsSync(box.lockDir);
            return { status: 1, signal: null, timedOut: false };
          },
          releaseForServiceManagerFn: lease.releaseForServiceManager,
          reacquireForDirectStartFn: lease.reacquireForDirectStart,
          // Called twice: the pre-service reclaim under the original lease, then the
          // direct-start reclaim under the reacquired one.
          waitForPort: async () => {
            lockState.push(existsSync(box.lockDir));
            contention.push(contenderAcquire(box));
            return true;
          },
          listListenPidsFn: () => [],
          scanListenPidsFn: () => ({ ok: true, pids: [] }),
          isAliveFn: () => false,
          probeProxy: async () => true,
          probeProxyIdentity: async () => null,
          spawnDetachedStartFn: () => {
            spawnCount += 1;
            return fakeChild();
          },
          killProxyFn: () => {},
          preparePortForPinnedStartFn: () => {},
          waitForGhostListenClearFn: async () => ({ ok: true, accessDenied: false }),
        });
        return true;
      },
    );
    expect(outcome).toEqual({ kind: "ran", value: true });
    expect(leasedAtRefresh).toBe(false);
    expect(lockState).toEqual([true, true]);
    expect(contention.every(status => status !== 0)).toBe(true);
    expect(spawnCount).toBe(1);
    expect(existsSync(box.lockDir)).toBe(false);
  }, watchdogMs(30_000));

  test("a lease held through the refresh window fails closed before any kill or start, and the job fails", async () => {
    const box = sandbox();
    const port = await freePort();
    const job = writeJob(box.ocxHome);
    let spawned = 0;
    let killed = 0;
    const outcome = await runUpdateRestartWithOwnershipLease(
      () => ({ kind: "none", revision: 0 }),
      async lease =>
        restartAfterUpdateForTests(job, { port, hostname: "127.0.0.1" }, {
          platform: "win32",
          serviceInstalledFn: () => true,
          serviceViableFn: () => true,
          // A claimant that acquired the freed lease during the refresh window and
          // keeps holding it past the bounded re-acquire deadline.
          runService: () => {
            spawnHolder(box);
            return { status: 1, signal: null, timedOut: false };
          },
          releaseForServiceManagerFn: lease.releaseForServiceManager,
          reacquireForDirectStartFn: lease.reacquireForDirectStart,
          waitForPort: async () => true,
          listListenPidsFn: () => [],
          scanListenPidsFn: () => ({ ok: true, pids: [] }),
          isAliveFn: () => false,
          probeProxy: async () => false,
          probeProxyIdentity: async () => null,
          spawnStart: () => { spawned += 1; },
          spawnDetachedStartFn: () => {
            spawned += 1;
            return fakeChild();
          },
          killProxyFn: () => { killed += 1; },
          preparePortForPinnedStartFn: () => {},
          waitForGhostListenClearFn: async () => ({ ok: true, accessDenied: false }),
        }),
    );
    expect(outcome).toEqual({ kind: "ran", value: false });
    expect(spawned).toBe(0);
    expect(killed).toBe(0);
    const saved = readUpdateJob(job.id);
    // The refresh produced no serving proxy and nothing was started, so this is not a success.
    expect(saved?.status).toBe("failed");
    expect(saved?.restarted).toBe(false);
    expect(saved?.error).toContain("no proxy was started");
    expect(saved?.log.some(line => line.includes("left running"))).toBe(false);
    expect(saved?.log.some(line => line.includes("lease claimed"))).toBe(true);
  }, watchdogMs(45_000));

  test("the lease covers the veto, frees on request, re-acquires, and vetoAgain re-reads ownership", async () => {
    const box = sandbox();
    let claimed = false;
    const resolve = (): ServiceOwnershipResolution => claimed
      ? { kind: "owned", ownership: { owner: "desktop", installId: "app-install-a", consentGeneration: 1 }, revision: 2 }
      : { kind: "none", revision: 0 };
    const outcome = await runUpdateRestartWithOwnershipLease(resolve, async lease => {
      expect(existsSync(box.lockDir)).toBe(true);
      expect(process.env[OWNERSHIP_MUTATION_LEASE_TOKEN_ENV]).toBeTruthy();
      expect(lease.vetoAgain()).toBeNull();
      lease.releaseForServiceManager();
      expect(existsSync(box.lockDir)).toBe(false);
      expect(process.env[OWNERSHIP_MUTATION_LEASE_TOKEN_ENV]).toBeUndefined();
      // Idempotent: the wrapper's own finally must not throw on a released lease.
      lease.releaseForServiceManager();
      // Re-acquire re-locks and re-arms the delegation token before the veto re-read.
      expect(lease.reacquireForDirectStart()).toBeNull();
      expect(existsSync(box.lockDir)).toBe(true);
      expect(process.env[OWNERSHIP_MUTATION_LEASE_TOKEN_ENV]).toBeTruthy();
      expect(contenderAcquire(box)).not.toBe(0);
      claimed = true;
      expect(lease.reacquireForDirectStart()).toEqual({ notice: expect.stringContaining("app-install-a"), failed: false });
      expect(lease.vetoAgain()).toContain("app-install-a");
      return "ok";
    });
    expect(outcome).toEqual({ kind: "ran", value: "ok" });
    expect(existsSync(box.lockDir)).toBe(false);
    expect(process.env[OWNERSHIP_MUTATION_LEASE_TOKEN_ENV]).toBeUndefined();
  });

  test("an owned runtime still vetoes before the restart runs", async () => {
    const box = sandbox();
    let ran = false;
    const outcome = await runUpdateRestartWithOwnershipLease(
      () => ({ kind: "owned", ownership: { owner: "desktop", installId: "app-a", consentGeneration: 1 }, revision: 1 }),
      async () => {
        ran = true;
        return true;
      },
    );
    expect(outcome.kind).toBe("veto");
    if (outcome.kind === "veto") expect(outcome.notice).toContain("app-a");
    expect(ran).toBe(false);
    expect(existsSync(box.lockDir)).toBe(false);
  });
});


describe("lease fixture containment and cleanup controls", () => {
  let previousAuthority: string;
  for (const index of [0, 1]) {
    test(`case ${index + 1} owns a distinct parent and child authority`, async () => {
      const box = sandbox();
      expect(await serviceManagerChildAuthority(box)).toBe(box.authority);
      expect(box.authority).not.toBe(previousAuthority);
      previousAuthority = box.authority;
      expect(process.env.OCX_REAL_HOME).toBe(realHome);
      expect(process.env.OCX_TEST_HOME_GUARD).toBe("1");
      expect(process.env.CODEX_SQLITE_HOME).toBe(box.codexHome);
    }, watchdogMs(15_000));
  }

  test("EOF releases the real lease with acknowledgment and a reaped child", async () => {
    const box = sandbox();
    const holder = spawnHolder(box);
    expect(existsSync(box.lockDir)).toBe(true);
    await cleanupChild(holder);
    expect(holder.process.exitCode).toBe(0);
    expect(holder.cleanupProven).toBe(true);
    expect(canRemoveSandbox(box)).toBe(true);
    expect(holder.reaped && holder.drained).toBe(true);
    expect(readFileSync(holder.released!, "utf8")).toBe(String(holder.process.pid));
    expect(existsSync(box.lockDir)).toBe(false);
    expect(contenderAcquire(box)).toBe(0);
  }, watchdogMs(20_000));

  test("an additional drain error cannot be consumed as an expected graceful failure", async () => {
    const box = sandbox();
    const holder = spawnHolder(box, "ignore-eof");
    holder.drains.push(Promise.reject(new Error("injected drain failure")));
    void Promise.allSettled(holder.drains);
    const error = await cleanupChild(holder, isolationBudgetMs(200)).catch(error => error);
    expect(() => expectOnlyCleanupFailure(error, "fixture child graceful exit timed out")).toThrow();
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors.map((failure: Error) => failure.message)).toEqual([
      "fixture child graceful exit timed out", "injected drain failure",
    ]);
    expect(holder.reaped && holder.drained && holder.forced).toBe(true);
    expect(holder.cleanupProven).toBe(false);
    expect(canRemoveSandbox(box)).toBe(false);
    // This control consumes exactly its two deliberately injected failures, never arbitrary errors.
    holder.failureObserved = true;
    expect(canRemoveSandbox(box)).toBe(true);
  }, watchdogMs(20_000));

  test("a delayed second drain rejection cannot hide behind the expected cleanup pair", async () => {
    const box = sandbox();
    const holder = spawnHolder(box, "ignore-eof");
    const late = new Promise<never>((_, reject) => {
      holder.abort.signal.addEventListener("abort", () => {
        void Promise.resolve().then(() => reject(new Error("unexpected delayed stdout failure")));
      }, { once: true });
    });
    holder.drains.push(Promise.reject(new Error("injected drain failure")), late);
    void Promise.allSettled(holder.drains);
    const error = await cleanupChild(holder, isolationBudgetMs(200)).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    const messages = error.errors.map((failure: Error) => failure.message);
    expect(() => expect(messages).toEqual([
      "fixture child graceful exit timed out", "injected drain failure",
    ])).toThrow();
    expect(messages).toEqual([
      "fixture child graceful exit timed out", "injected drain failure", "unexpected delayed stdout failure",
    ]);
    expect(holder.reaped && holder.drained && holder.forced).toBe(true);
    expect(canRemoveSandbox(box)).toBe(false);
    holder.failureObserved = true;
  }, watchdogMs(20_000));

  test("drain cleanup excludes only its own cancellation reason", async () => {
    const box = sandbox();
    const holder = spawnHolder(box);
    const cancellation = new Promise<never>((_, reject) => {
      holder.abort.signal.addEventListener("abort", () => reject(holder.abort.signal.reason), { once: true });
    });
    const foreignAbort = new Promise<never>((_, reject) => {
      holder.abort.signal.addEventListener("abort", () => reject(new DOMException("unrelated stream abort", "AbortError")), { once: true });
    });
    holder.drains.push(Promise.reject(new Error("first drain failure")), cancellation, foreignAbort);
    void Promise.allSettled(holder.drains);
    const error = await cleanupChild(holder).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors.map((failure: Error) => failure.message)).toEqual(["first drain failure", "unrelated stream abort"]);
    expect(holder.reaped && holder.drained).toBe(true);
    expect(holder.forced).toBe(false);
    expect(canRemoveSandbox(box)).toBe(false);
    holder.failureObserved = true;
  }, watchdogMs(20_000));

  test("a drain timeout retains the later independent rejection", async () => {
    const box = sandbox();
    const holder = spawnHolder(box);
    const independent = new Promise<never>((_, reject) => {
      holder.abort.signal.addEventListener("abort", () => reject(new Error("late failure after drain timeout")), { once: true });
    });
    const cancellation = new Promise<never>((_, reject) => {
      holder.abort.signal.addEventListener("abort", () => reject(holder.abort.signal.reason), { once: true });
    });
    holder.drains.push(independent, cancellation);
    void Promise.allSettled(holder.drains);
    const error = await cleanupChild(holder).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors.map((failure: Error) => failure.message)).toEqual([
      "fixture child drains timed out", "late failure after drain timeout",
    ]);
    expect(holder.reaped && holder.drained).toBe(true);
    expect(canRemoveSandbox(box)).toBe(false);
    holder.failureObserved = true;
  }, watchdogMs(20_000));

  for (const behavior of ["ignore-eof", "missing-ack"] as const) {
    test(`${behavior} fails graceful cleanup even after bounded fallback`, async () => {
      const box = sandbox();
      const holder = spawnHolder(box, behavior);
      const error = await cleanupChild(holder, isolationBudgetMs(200)).catch(error => error);
      expectOnlyCleanupFailure(error, behavior === "ignore-eof"
        ? "fixture child graceful exit timed out"
        : "holder graceful release lacked acknowledgment, exit 0, or exact lock absence");
      expect(holder.reaped && holder.drained).toBe(true);
      expect(existsSync(holder.released!)).toBe(false);
      expect(existsSync(box.lockDir)).toBe(behavior === "ignore-eof");
      expect(holder.forced).toBe(behavior === "ignore-eof");
      if (behavior === "missing-ack") expect(holder.process.exitCode).toBe(0);
      expect(holder.cleanupProven).toBe(false);
      expect(canRemoveSandbox(box)).toBe(false);
      // Only this negative control consumes its expected rejection; ordinary teardown retains failures.
      holder.failureObserved = true;
      expect(canRemoveSandbox(box)).toBe(true);
    }, watchdogMs(20_000));
  }
});
