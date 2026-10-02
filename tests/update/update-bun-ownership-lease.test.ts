import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readUpdateRuntimeTarget, withUpdateOwnershipLease } from "../../src/update/ownership-transaction";
import { createTempHome } from "../helpers/temp-home";
import { helperPath, repoPath, repoRoot } from "../helpers/repo-root";

type Event = { phase: string; contenderBlocked?: boolean; delegated?: boolean; canJoin?: boolean; reacquired?: boolean; parentToken?: boolean; pidBound?: boolean; healthy?: boolean; childPid?: number };
async function run(scenario: string) {
  const home = createTempHome("ocx-bun-update-lease-");
  try {
    mkdirSync(home.codexHome);
    writeFileSync(home.path("config.json"), JSON.stringify({ port: 23456, providers: {} }));
    const child = Bun.spawn([process.execPath, helperPath("update-bun-ownership-child.ts"), home.root, scenario], {
      cwd: repoRoot(), env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const receipt = out.split("\n").find(line => line.startsWith("UPDATE_LEASE_PROBE:"));
    expect(receipt, out + err).toBeDefined();
    const trace = JSON.parse(receipt!.slice("UPDATE_LEASE_PROBE:".length)) as Event[];
    const pid = trace.at(-1)?.childPid;
    if (pid) {
      const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
      const deadline = Date.now() + 2_000;
      while (alive() && Date.now() < deadline) await Bun.sleep(20);
      expect(alive(), "owned recovery fixture must exit").toBe(false);
    }
    return { exit, trace, log: out + err };
  } finally { home.remove(); }
}

test.skipIf(process.platform === "win32")("the actual Bun updater leases stop through replacement and strips package capabilities", async () => {
  const result = await run("success");
  expect(result.exit, result.log).toBe(0);
  for (const phase of ["stop", "replacement"]) {
    const event = result.trace.find(row => row.phase === phase);
    expect(event, result.log).toBeDefined();
    expect(event?.contenderBlocked).toBe(true);
    expect(event?.delegated).toBe(phase !== "replacement");
    expect(event?.canJoin).toBe(phase !== "replacement");
  }
  // `service repair` spawns the proxy through the OS manager, outside this process
  // tree — the lease is released first (#5760), so a contender is no longer blocked
  // and a token-less child acquires for itself; the stale delegated token is
  // self-corrected by the failed join.
  const recovery = result.trace.find(row => row.phase === "recovery");
  expect(recovery, result.log).toMatchObject({ contenderBlocked: false, delegated: true, canJoin: true });
  expect(result.trace.at(-1)).toMatchObject({ phase: "after", reacquired: true, parentToken: false });
}, 30_000);

test.skipIf(process.platform === "win32").each(["package-fail", "stop-throw", "replacement-throw", "recovery-throw"])("%s keeps recovery owned and releases before exit", async scenario => {
  const result = await run(scenario);
  expect(result.exit, result.log).not.toBe(0);
  // Service recovery releases the lease before the manager-mediated start (#5760);
  // contenderBlocked flips to false at that boundary, and the still-delegated token
  // falls back to a normal acquire (canJoin).
  const recovery = result.trace.find(row => row.phase === "recovery");
  expect(recovery, result.log).toMatchObject({ contenderBlocked: false, delegated: true, canJoin: true });
  expect(result.trace.at(-1)).toMatchObject({ reacquired: true, parentToken: false });
}, 30_000);

test.skipIf(process.platform === "win32").each(["foreign-owner", "unknown-runtime"])("%s refuses automatic recovery", async scenario => {
  const result = await run(scenario);
  expect(result.exit, result.log).not.toBe(0);
  expect(result.trace.some(row => row.phase === "recovery")).toBe(false);
  expect(result.trace.at(-1)).toMatchObject({ reacquired: true, parentToken: false });
}, 30_000);

test("current runtime observation distinguishes absent, malformed and a replacement target", () => {
  const home = createTempHome("ocx-update-target-");
  try {
    const path = join(home.root, "runtime-port.json");
    expect(readUpdateRuntimeTarget(path, "127.0.0.1")).toEqual({ kind: "absent" });
    for (const raw of ["{", "null", '{"pid":1,"port":0}', '{"pid":1,"port":42,"hostname":false}']) {
      writeFileSync(path, raw); expect(readUpdateRuntimeTarget(path, "127.0.0.1")).toEqual({ kind: "unknown" });
    }
    writeFileSync(path, JSON.stringify({ pid: 7, port: 4567, hostname: "::1" }));
    expect(readUpdateRuntimeTarget(path, "127.0.0.1")).toEqual({ kind: "target", target: { pid: 7, port: 4567, hostname: "::1" } });
    expect(readFileSync(path, "utf8")).toContain("4567");
  } finally { home.remove(); }
});

test("the transaction release frees the lease for a child outside the process tree", async () => {
  const home = createTempHome("ocx-bun-lease-release-");
  try {
    const authority = join(home.root, "authority.json");
    writeFileSync(authority, "{}\n");
    const leaseModule = pathToFileURL(repoPath("src/service/ownership-mutation-lease.mjs")).href;
    // A real acquirer in a fresh process — what a Task Scheduler / launchd / systemd
    // `ocx start` child faces, including no delegated token.
    const probe = () => spawnSync(process.execPath, ["-e", `
      const { acquireOwnershipMutationLease } = await import(${JSON.stringify(leaseModule)});
      try { const lease = acquireOwnershipMutationLease([process.env.FIXTURE_AUTHORITY], { waitMs: 0 });
        lease.release(); process.exit(0); } catch { process.exit(17); }
    `], { env: { ...process.env, FIXTURE_AUTHORITY: authority }, timeout: 15_000 }).status;
    await withUpdateOwnershipLease([authority], async mutation => {
      expect(probe()).toBe(17);
      mutation.release();
      expect(probe()).toBe(0);
      // Idempotent: the wrapper's own finally must not trip on a released lease.
      mutation.release();
      expect(probe()).toBe(0);
      // The stale delegated token self-corrects: the env-token join fails after
      // release, so the child falls back to a normal acquire.
      const delegated = spawnSync(process.execPath, ["-e", `
        const { acquireOwnershipMutationLease } = await import(${JSON.stringify(leaseModule)});
        try { const lease = acquireOwnershipMutationLease([process.env.FIXTURE_AUTHORITY], { waitMs: 0 });
          lease.release(); process.exit(0); } catch { process.exit(17); }
      `], { env: { ...process.env, ...mutation.controlEnvironment(), FIXTURE_AUTHORITY: authority }, timeout: 15_000 }).status;
      expect(delegated).toBe(0);
      // reacquire() re-locks so post-refresh direct-start mutations stay serialized.
      mutation.reacquire();
      expect(probe()).toBe(17);
      mutation.release();
      expect(probe()).toBe(0);
      mutation.reacquire();
      expect(probe()).toBe(17);
    });
    expect(probe()).toBe(0);
  } finally { home.remove(); }
}, 30_000);

test("the Bun updater releases the lease before each service-manager-mediated start (#5760)", () => {
  const source = readFileSync(join(repoRoot(), "src/update/index.ts"), "utf8");
  // recoverStoppedRuntime: the service branch releases before the repair spawn,
  // then re-acquires before the fallback's ownership re-read authorizes a direct start.
  const recoveryFn = source.indexOf("const recoverStoppedRuntime");
  const recoveryRelease = source.indexOf("mutation.release();", recoveryFn);
  const recoverySpawn = source.indexOf("serviceReinstallArgs()", recoveryFn);
  expect(recoveryRelease).toBeGreaterThan(recoveryFn);
  expect(recoveryRelease).toBeLessThan(recoverySpawn);
  const recoveryReacquire = source.indexOf("mutation.reacquire();", recoveryFn);
  const fallbackReRead = source.indexOf("const nowOwned", recoveryFn);
  expect(recoveryReacquire).toBeGreaterThan(recoverySpawn);
  expect(recoveryReacquire).toBeLessThan(fallbackReRead);
  // Post-install refresh: the kill-authorizing reclaim still runs under the lease,
  // then the lease is released before the repair spawn, and re-acquired before the
  // fallback's ownership re-read authorizes a direct start.
  const postInstall = source.indexOf("postInstallPlan.mayRestoreService");
  const reclaim = source.indexOf("reclaimListenPort(", postInstall);
  const postRelease = source.indexOf("mutation.release();", postInstall);
  const postSpawn = source.indexOf("serviceReinstallArgs()", postInstall);
  expect(postRelease).toBeGreaterThan(reclaim);
  expect(postRelease).toBeLessThan(postSpawn);
  const postReacquire = source.indexOf("mutation.reacquire();", postSpawn);
  const postReRead = source.indexOf("const nowOwned", postInstall);
  expect(postReacquire).toBeLessThan(postReRead);
  // After the package swap, a lease that stays claimed is reported with manual recovery and a
  // non-zero exit instead of escaping into the unexpected-failure recovery.
  const guarded = source.slice(source.lastIndexOf("try {", postReacquire), source.indexOf("const nowOwned", postReacquire));
  expect(guarded).toMatch(/^try \{\s*mutation\.reacquire\(\);\s*\} catch \{/);
  expect(guarded).toContain("no proxy was started");
  expect(guarded).toContain("return 1;");
});

test.skipIf(process.platform === "win32")("unmanaged recovery joins the lease and waits for PID-bound health", async () => {
  const result = await run("direct-success");
  expect(result.exit, result.log).toBe(1); // The failed package install is still a failure.
  expect(result.trace.find(row => row.phase === "direct")).toMatchObject({ contenderBlocked: true, delegated: true, canJoin: true });
  expect(result.trace.find(row => row.phase === "health")).toMatchObject({ contenderBlocked: true, pidBound: true, healthy: true });
  expect(result.trace.at(-1)).toMatchObject({ reacquired: true, parentToken: false });
}, 30_000);

test.skipIf(process.platform === "win32").each(["direct-spawn-error", "direct-timeout", "direct-foreign"])("%s releases authority without claiming healthy recovery", async scenario => {
  const result = await run(scenario);
  expect(result.exit, result.log).toBe(1);
  expect(result.trace.find(row => row.phase === "direct")).toMatchObject({ contenderBlocked: true, delegated: true, canJoin: true });
  expect(result.trace.some(row => row.phase === "health" && row.healthy)).toBe(false);
  if (scenario === "direct-foreign") expect(result.trace.some(row => row.phase === "health" && row.pidBound)).toBe(true);
  expect(result.trace.at(-1)).toMatchObject({ reacquired: true, parentToken: false });
}, 30_000);
