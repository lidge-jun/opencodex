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
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
  "XDG_RUNTIME_DIR",
  "OCX_TEST_HOME_GUARD",
  "OCX_REAL_HOME",
  OWNERSHIP_MUTATION_LEASE_TOKEN_ENV,
] as const;

let saved: Record<string, string | undefined> = {};
let sandboxes: Sandbox[] = [];
let children: ChildProcess[] = [];
let childLogs: string[] = [];
let childDrains: Promise<unknown>[] = [];

/** The real home this process was started under, for the spawned child's guard. */
const realHome = dirname(protectedHomeForTests());

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "ocx-restart-lease-"));
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
  process.env.XDG_RUNTIME_DIR = join(root, "runtime");
  process.env.OCX_TEST_HOME_GUARD = "1";
  process.env.OCX_REAL_HOME = realHome;
  delete process.env[OWNERSHIP_MUTATION_LEASE_TOKEN_ENV];
  // The authority differs by platform: on Windows USERPROFILE tracks this sandbox so
  // the kept last entry is home/.opencodex; on POSIX homedir() ignores $HOME and the
  // armed home guard drops that legacy entry, leaving the OPENCODEX_HOME record.
  const authority = serviceStatePaths().at(-1)!;
  const box = { root, home, ocxHome, codexHome, authority, lockDir: leasePathFor(authority) };
  sandboxes.push(box);
  return box;
}

/** The environment a Task Scheduler / launchd / systemd child actually gets: stored, no token. */
function serviceManagerChildEnvironment(box: Sandbox): NodeJS.ProcessEnv {
  const home = process.platform === "win32" ? box.home : realHome;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: box.codexHome,
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

function spawnServiceChild(box: Sandbox, port: number): ChildProcess {
  const child = Bun.spawn(
    [process.execPath, repoPath("src/cli/index.ts"), "start", "--port", String(port)],
    {
      cwd: box.root,
      env: serviceManagerChildEnvironment(box),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  children.push(child as unknown as ChildProcess);
  const decoder = new TextDecoder();
  const tee = (chunk: Uint8Array) => childLogs.push(decoder.decode(chunk));
  childDrains.push(
    (child.stdout as ReadableStream).pipeTo(new WritableStream({ write: tee })).catch(() => {}),
    (child.stderr as ReadableStream).pipeTo(new WritableStream({ write: tee })).catch(() => {}),
  );
  return child as unknown as ChildProcess;
}

const LEASE_MODULE_URL = pathToFileURL(repoPath("src/service/ownership-mutation-lease.mjs")).href;
const SERVICE_STATE_MODULE_URL = pathToFileURL(repoPath("src/service/state.ts")).href;

async function serviceManagerChildAuthority(box: Sandbox): Promise<string> {
  const child = Bun.spawn([process.execPath, "-e", `
    const { serviceStatePaths } = await import(${JSON.stringify(SERVICE_STATE_MODULE_URL)});
    process.stdout.write(serviceStatePaths().at(-1) ?? "");
  `], {
    cwd: box.root,
    env: serviceManagerChildEnvironment(box),
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child as unknown as ChildProcess);
  const [exitCode, authority, error] = await Promise.all([
    child.exited,
    new Response(child.stdout as ReadableStream<Uint8Array>).text(),
    new Response(child.stderr as ReadableStream<Uint8Array>).text(),
  ]);
  if (exitCode !== 0) throw new Error(`service-state authority probe failed (${exitCode}): ${error.trim()}`);
  return authority.trim();
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
});

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.pid) child.kill();
  }
  for (const child of children) {
    if (child.exitCode === null) await child.exited.catch(() => {});
  }
  children = [];
  childDrains = [];
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const box of sandboxes) removeTreeWithRetry(box.root);
  sandboxes = [];
  childLogs = [];
});

describe("the restart veto lease frees a service-manager child (#5760)", () => {
  test("a supervised `ocx start` outside the process tree dies at a held lease — the mechanic the release exists for", async () => {
    const box = sandbox();
    expect(await serviceManagerChildAuthority(box)).toBe(box.authority);
    const port = await freePort();
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
    const port = await freePort();
    writeFileSync(join(box.ocxHome, "config.json"), JSON.stringify({
      port,
      hostname: "127.0.0.1",
      codexAutoStart: false,
      clientIntegrations: { codex: false, grok: false, "claude-desktop": false },
      claudeCode: { systemEnv: false },
      providers: {},
      defaultProvider: "openai",
    }));
    const job = writeJob(box.ocxHome);
    let child: ChildProcess | undefined;
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
            const holder = Bun.spawn([process.execPath, "-e", `
              const { acquireOwnershipMutationLease } = await import(${JSON.stringify(LEASE_MODULE_URL)});
              const lease = acquireOwnershipMutationLease([process.env.FIXTURE_AUTHORITY]);
              await Bun.sleep(13_000);
              lease.release();
            `], {
              env: { ...process.env, FIXTURE_AUTHORITY: authorityPath(box) },
              stdout: "ignore",
              stderr: "ignore",
            });
            children.push(holder as unknown as ChildProcess);
            const deadline = Date.now() + 5_000;
            while (!existsSync(box.lockDir) && Date.now() < deadline) Bun.sleepSync(20);
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
