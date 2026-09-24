import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { repoRoot } from "../helpers/repo-root";
import { atomicJson, createGuardian, parseIntent, recoveryActionSucceeded } from "../../scripts/ocx-recovery-guardian/main.cjs";
import { RecoveryPolicy } from "../../scripts/ocx-recovery-guardian/policy.cjs";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "ocx-guardian-main-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const config = join(home, "recovery-guardian.json");
  await atomicJson(config, { version: 1, enabled: true, projectRoot: repoRoot(), openCodexHome: home, codexHome: home,
    listenPort: port, primaryPort: 10100, fallback: { origin: "http://127.0.0.1:20128", models: {}, key: { kind: "or-protected" } },
    repair: { origin: "http://127.0.0.1:11434/v1", key: { kind: "ollama-local" } } });
  return { home, config, intent: join(home, "recovery-intent.json") };
}

test("manual intent and action receipt are strict, not exit-code success", () => {
  expect(parseIntent(null, 100).mode).toBe("stopped");
  expect(parseIntent({ version: 1, at: 0, mode: "running" }, 100).valid).toBe(true);
  expect(parseIntent({ version: 1, at: 100, mode: "maintenance", until: 99999999 }, 100).valid).toBe(false);
  expect(recoveryActionSucceeded({ ok: true, value: { action: "refused" } })).toBe(false);
  expect(recoveryActionSucceeded({ ok: true, value: { action: "started" } })).toBe(true);
});

test("concurrent state writes remain complete JSON without temporary-file collisions", async () => {
  const f = await fixture();
  const target = join(f.home, "state.json");
  await Promise.all(Array.from({ length: 16 }, (_, n) => atomicJson(target, { n })));
  expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ n: 15 });
});

test("the steady tick rewrites the budget file only when its content would change", async () => {
  const f = await fixture();
  let now = 100000;
  await atomicJson(f.intent, { version: 1, mode: "running", at: now });
  const guardian = await createGuardian(f.config, { now: () => now, policyOptions: { recoveryStableMs: 1000 }, alive: () => true,
    inspect: async () => ({ ok: true, value: { owned: true, pid: 42, start: "ticks", launcherPid: 43, launcherStart: "ticks" } }),
    probe: async () => ({ ok: true, pid: 42 }) });
  cleanup.push(guardian.close);
  const budget = join(f.home, "recovery-budget.json");
  const epoch = new Date(1000);
  await guardian.tick();
  const tickOnce = async () => {
    // The written bytes are identical either way, so only the file identity can show
    // whether the queue replaced it. An epoch mtime is far outside any granularity.
    utimesSync(budget, epoch, epoch);
    now += 1000;
    await guardian.tick();
    return statSync(budget).mtimeMs;
  };
  expect(await tickOnce()).toBe(1000);
  expect(await tickOnce()).toBe(1000);
  await atomicJson(f.intent, { version: 1, mode: "stopped", at: ++now });
  expect(await tickOnce()).not.toBe(1000);
});

test("real guardian entrypoint recovers once, records failed receipt, dispatches GLM, honors manual stop", async () => {
  const f = await fixture();
  let now = 100000, healthy = true, actions = 0, repairs = 0;
  await atomicJson(f.intent, { version: 1, mode: "running", at: now });
  const guardian = await createGuardian(f.config, { now: () => now, policyOptions: { startupGraceMs: 0 }, alive: () => true,
    inspect: async () => ({ ok: true, value: { owned: true, pid: 42, start: "ticks", launcherPid: 43, launcherStart: "ticks" } }),
    probe: async () => ({ ok: healthy, pid: 42 }),
    action: async () => { actions++; return { ok: true, value: { action: "refused", reason: "stop-uncertain" } }; },
    repair: async () => { repairs++; return { outcome: "no_candidate", candidateCount: 0, requestCount: 1 }; } });
  cleanup.push(guardian.close);
  await guardian.tick();
  expect(guardian.state().primaryReady).toBe(false);
  now += 30000; await guardian.tick();
  expect(guardian.state().primaryReady).toBe(true);
  healthy = false;
  for (let n = 0; n < 12; n++) { now += 2000; await guardian.tick(); await guardian.drain(); }
  await guardian.drain();
  expect(actions).toBe(1);
  expect(repairs).toBe(1);
  expect(guardian.state().recoveryBlocked).toBe(true);
  expect(guardian.state().lastRecovery.ok).toBe(false);
  expect(guardian.state().lastRepair.outcome).toBe("no_candidate");
  await atomicJson(f.intent, { version: 1, mode: "stopped", at: ++now });
  await guardian.tick();
  expect(guardian.state().state).toBe("stopped");
  const response = await fetch(`http://127.0.0.1:${guardian.server.port}/v1/models`);
  expect(response.status).toBe(503);
  expect((await response.json()).error.code).toBe("gateway_stopped");
});

test("an incident record stops accumulating once the write-only backlog outgrows the newest few", async () => {
  const f = await fixture();
  let now = 100000, healthy = true, repairs = 0;
  await atomicJson(f.intent, { version: 1, mode: "running", at: now });
  // Back-dated names sort before this fixture's clock (~00:02:04 after the drive below),
  // so the fresh incident is the newest entry by construction.
  const incidentsRoot = join(f.home, "recovery-incidents");
  const backlog = Array.from({ length: 25 }, (_, i) => `1970-01-01T00-00-${String(i + 1).padStart(2, "0")}-000Z-1`);
  for (const name of backlog) mkdirSync(join(incidentsRoot, name), { recursive: true });
  // Anything the guardian did not name must neither spend the budget nor be deleted: one
  // trailing-sorting entry would otherwise evict a real incident, and a `notes.txt` would
  // silently shrink how much history survives.
  mkdirSync(join(incidentsRoot, "zz-notes"), { recursive: true });
  writeFileSync(join(incidentsRoot, "notes.txt"), "keep me");
  const guardian = await createGuardian(f.config, { now: () => now, policyOptions: { startupGraceMs: 0 }, alive: () => true,
    inspect: async () => ({ ok: true, value: { owned: true, pid: 42, start: "ticks", launcherPid: 43, launcherStart: "ticks" } }),
    probe: async () => ({ ok: healthy, pid: 42 }),
    action: async () => ({ ok: true, value: { action: "refused", reason: "stop-uncertain" } }),
    repair: async () => { repairs++; return { outcome: "no_candidate", candidateCount: 0, requestCount: 1 }; } });
  cleanup.push(guardian.close);
  await guardian.tick();
  now += 30000; await guardian.tick();
  healthy = false;
  for (let n = 0; n < 12; n++) { now += 2000; await guardian.tick(); await guardian.drain(); }
  await guardian.drain();
  expect(repairs).toBe(1);

  const kept = readdirSync(incidentsRoot);
  const known = new Set(backlog);
  const generated = kept.filter(name => known.has(name) || /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+$/.test(name));
  expect(generated).toHaveLength(20);
  expect(kept).toContain("zz-notes");
  expect(kept).toContain("notes.txt");
  expect(generated.filter(name => !known.has(name))).toHaveLength(1);
  expect(generated).toContain(backlog[24]);
  expect(generated).not.toContain(backlog[0]);
  expect(generated).not.toContain(backlog[4]);
});

test("a corroborated generation is re-resolved before its launcher identity can go stale", async () => {
  const f = await fixture();
  let now = 100000, inspections = 0;
  await atomicJson(f.intent, { version: 1, mode: "running", at: now });
  // `uptime` grows with the fake clock so the boot instant derived from it stays constant.
  // Without that, advancing `now` alone would break corroboration and the test would pass
  // whether or not the decay bound exists — it proved vacuous both ways on the first run.
  const guardian = await createGuardian(f.config, { now: () => now, policyOptions: { startupGraceMs: 0 }, alive: () => true,
    inspect: async () => { inspections += 1; return { ok: true, value: { owned: true, pid: 42, start: "ticks", launcherPid: 43, launcherStart: "ticks" } }; },
    probe: async () => ({ ok: true, pid: 42, uptime: (now - 70000) / 1000 }) });
  cleanup.push(guardian.close);
  await guardian.tick();
  expect(inspections).toBe(1);
  // Same pid, same boot instant, and the budget spent: without a decay bound this is the
  // state that freezes `snapshot` forever, so a launcher that exited behind us would keep
  // handing `recover()` an expected pid that no longer exists.
  now += 61_000; await guardian.tick();
  expect(inspections).toBe(2);
  // The refresh re-arms adoption, so the next tick is settled again rather than inspecting
  // once per tick the way the pre-fix code did.
  now += 2000; await guardian.tick();
  expect(inspections).toBe(2);
});

test("the opening inspection is adopted, not paid for twice, and a new pid is still inspected", async () => {
  const f = await fixture();
  let now = 100000, inspections = 0, healthPid = 42;
  await atomicJson(f.intent, { version: 1, mode: "running", at: now });
  const guardian = await createGuardian(f.config, { now: () => now, policyOptions: { startupGraceMs: 0 }, alive: () => true,
    inspect: async () => { inspections += 1; return { ok: true, value: { owned: true, pid: 42, start: "ticks", launcherPid: 43, launcherStart: "ticks" } }; },
    probe: async () => ({ ok: true, pid: healthPid, uptime: 30 }) });
  cleanup.push(guardian.close);
  expect(inspections).toBe(1);
  await guardian.tick();
  // The boot instant derived from this probe corroborates the snapshot the opening
  // inspection already took, so a second ~5 s spawn here would be pure waste.
  expect(inspections).toBe(1);
  now += 2000; await guardian.tick();
  expect(inspections).toBe(1);
  // A pid change is a different process generation and must still be resolved.
  healthPid = 44;
  now += 2000; await guardian.tick();
  expect(inspections).toBe(2);
});

test("first start and new running intent require a fresh stable-ready interval", async () => {
  const f = await fixture();
  let now = 100000;
  await atomicJson(f.intent, { version: 1, mode: "running", at: now });
  const guardian = await createGuardian(f.config, { now: () => now, policyOptions: { recoveryStableMs: 4000 }, alive: () => true,
    inspect: async () => ({ ok: true, value: { owned: true, pid: 42, start: "ticks", launcherPid: 43, launcherStart: "ticks" } }),
    probe: async () => ({ ok: true, pid: 42 }) });
  cleanup.push(guardian.close);
  await guardian.tick();
  expect(guardian.state().primaryReady).toBe(false);
  now += 2000; await guardian.tick();
  expect(guardian.state().primaryReady).toBe(false);
  now += 2000; await guardian.tick();
  expect(guardian.state().primaryReady).toBe(true);
  await atomicJson(f.intent, { version: 1, mode: "running", at: ++now });
  await guardian.tick();
  expect(guardian.state().primaryReady).toBe(false);
  now += 4000; await guardian.tick();
  expect(guardian.state().primaryReady).toBe(true);
});

test("accepted replacement that never becomes ready dispatches GLM before a second recovery", async () => {
  const f = await fixture();
  let now = 100000, healthy = true, actions = 0, repairs = 0;
  await atomicJson(f.intent, { version: 1, mode: "running", at: now });
  const guardian = await createGuardian(f.config, { now: () => now,
    policyOptions: { startupGraceMs: 0, recoveryStableMs: 1000 }, alive: () => true,
    inspect: async () => ({ ok: true, value: { owned: true, pid: 42, start: "ticks", launcherPid: 43, launcherStart: "ticks" } }),
    probe: async () => ({ ok: healthy, pid: 42 }),
    action: async () => { actions++; return { ok: true, value: { action: "started" } }; },
    repair: async () => { repairs++; return { outcome: "no_candidate", candidateCount: 0, requestCount: 1 }; } });
  cleanup.push(guardian.close);
  await guardian.tick(); now += 1000; await guardian.tick();
  expect(guardian.state().primaryReady).toBe(true);
  healthy = false;
  for (let n = 0; n < 12 && actions === 0; n++) {
    now += 2000; await guardian.tick(); await guardian.drain();
  }
  expect(actions).toBe(1);
  expect(repairs).toBe(0);
  expect(guardian.state().lastRecovery.ok).toBe(true);
  expect(guardian.state().recoveryBlocked).toBe(false);
  expect(guardian.state().primaryReady).toBe(false);
  now += 1000; await guardian.tick(); await guardian.drain();
  expect(repairs).toBe(1);
  expect(actions).toBe(1);
  expect(guardian.state().primaryReady).toBe(false);
  now++; await guardian.tick(); await guardian.drain();
  expect(repairs).toBe(1);
  expect(actions).toBe(1);
});

test("same PID is not ownership proof when the process identity changes", async () => {
  const f = await fixture();
  let now = 100000, owned = true, start = "old-ticks";
  await atomicJson(f.intent, { version: 1, mode: "running", at: now });
  const guardian = await createGuardian(f.config, { now: () => now, policyOptions: { recoveryStableMs: 1000 }, alive: () => true,
    inspect: async () => ({ ok: true, value: { owned, pid: 42, start, launcherPid: 43, launcherStart: "ticks" } }),
    probe: async () => ({ ok: true, pid: 42 }) });
  cleanup.push(guardian.close);
  await guardian.tick(); now += 1000; await guardian.tick();
  expect(guardian.state().primaryReady).toBe(true);
  owned = false; start = "foreign-ticks"; now += 1000;
  await guardian.tick();
  expect(guardian.state().primaryReady).toBe(false);
  expect(guardian.state().state).toBe("foreign");
  owned = true; start = "new-owned-ticks"; now += 1000;
  await guardian.tick();
  expect(guardian.state().primaryReady).toBe(false);
  now += 1000; await guardian.tick();
  expect(guardian.state().primaryReady).toBe(true);
});

test("a corroborated healthy generation is not re-inspected and a pid reuse wrap is", async () => {
  const f = await fixture();
  const BOOT = 50000;
  let now = 100000, owned = true, boot = BOOT, inspections = 0;
  await atomicJson(f.intent, { version: 1, mode: "running", at: now });
  const guardian = await createGuardian(f.config, { now: () => now, policyOptions: { recoveryStableMs: 1000 }, alive: () => true,
    inspect: async () => { inspections += 1; return { ok: true, value: { owned, pid: 42, start: `${boot}-ticks`, launcherPid: 43, launcherStart: "ticks" } }; },
    probe: async () => ({ ok: true, pid: 42, uptime: (now - boot) / 1000 }) });
  cleanup.push(guardian.close);
  await guardian.tick(); now += 1000; await guardian.tick();
  expect(guardian.state().primaryReady).toBe(true);
  const steady = inspections;
  now += 1000; await guardian.tick(); now += 1000; await guardian.tick();
  // The WMI inspection costs a PowerShell spawn, and a healthy steady state on the same
  // process generation must not pay one every couple of seconds.
  expect(inspections).toBe(steady);
  expect(guardian.state().primaryReady).toBe(true);
  // Windows hands the same pid to a new process: the answer on the port is identical and
  // only the boot instant says otherwise, so an unowned generation cannot stay admitted.
  owned = false; boot = now - 500; now += 1000;
  await guardian.tick();
  expect(inspections).toBe(steady + 1);
  expect(guardian.state().primaryReady).toBe(false);
  expect(guardian.state().state).toBe("foreign");
});

test("a fresh running intent clears a stale uncertain-stop block", async () => {
  const f = await fixture();
  let now = 100000;
  const blockedFile = join(f.home, "recovery-blocked.json");
  await atomicJson(blockedFile, { version: 1, at: 1, reason: "stop_result_uncertain" });
  await atomicJson(f.intent, { version: 1, mode: "running", at: now });
  const guardian = await createGuardian(f.config, { now: () => now, alive: () => true,
    inspect: async () => ({ ok: true, value: { owned: true, pid: 42, start: "ticks", launcherPid: 43, launcherStart: "ticks" } }),
    probe: async () => ({ ok: true, pid: 42 }) });
  cleanup.push(guardian.close);
  await guardian.tick();
  // The intent this companion started on is not new authorization: it may be the
  // very transaction the previous process died inside of.
  expect(guardian.state().recoveryBlocked).toBe(true);
  await atomicJson(f.intent, { version: 1, mode: "running", at: ++now });
  await guardian.tick();
  expect(guardian.state().recoveryBlocked).toBe(false);
  expect(existsSync(blockedFile)).toBe(false);
});

test("manual stop during asynchronous diagnosis preparation prevents external dispatch", async () => {
  const f = await fixture();
  let now = 100000, repairs = 0;
  await atomicJson(f.intent, { version: 1, mode: "running", at: now });
  const guardian = await createGuardian(f.config, { now: () => now, policyOptions: { startupGraceMs: 0 }, alive: () => true,
    inspect: async () => ({ ok: true, value: { owned: true, pid: 42, start: "ticks", launcherPid: 43, launcherStart: "ticks" } }),
    probe: async () => ({ ok: false, pid: 42 }),
    action: async () => ({ ok: true, value: { action: "refused", reason: "stop-uncertain" } }),
    beforeRepairDispatch: async () => atomicJson(f.intent, { version: 1, mode: "stopped", at: ++now }),
    repair: async () => { repairs++; return { outcome: "no_candidate" }; } });
  cleanup.push(guardian.close);
  for (let n = 0; n < 12; n++) { now += 2000; await guardian.tick(); await guardian.drain(); }
  expect(repairs).toBe(0);
  expect(guardian.state().primaryReady).toBe(false);
});

test("manual stop aborts in-flight GLM work instead of starting its fallback", async () => {
  const f = await fixture();
  let now = 100000, dispatched = false, cancelled = false;
  await atomicJson(f.intent, { version: 1, mode: "running", at: now });
  const guardian = await createGuardian(f.config, { now: () => now, policyOptions: { startupGraceMs: 0 }, alive: () => true,
    inspect: async () => ({ ok: true, value: { owned: true, pid: 42, start: "ticks", launcherPid: 43, launcherStart: "ticks" } }),
    probe: async () => ({ ok: false, pid: 42 }),
    action: async () => ({ ok: true, value: { action: "refused", reason: "stop-uncertain" } }),
    repair: async ({ signal }: { signal: AbortSignal }) => {
      dispatched = true;
      if (!signal) return { outcome: "failed", failureClass: "MISSING_SIGNAL" };
      return new Promise(resolve => signal.addEventListener("abort", () => {
        cancelled = true; resolve({ outcome: "failed", failureClass: "CANCELLED" });
      }, { once: true }));
    } });
  cleanup.push(guardian.close);
  for (let n = 0; n < 13 && !dispatched; n++) {
    now += 2000; await guardian.tick(); await new Promise(resolve => setTimeout(resolve, 20));
  }
  expect(dispatched).toBe(true);
  await atomicJson(f.intent, { version: 1, mode: "stopped", at: ++now });
  await guardian.tick(); await guardian.drain();
  expect(cancelled).toBe(true);
  expect(guardian.state().lastRepair.failureClass).toBe("CANCELLED");
});

test("observation errors withdraw primary admission", async () => {
  const f = await fixture();
  let now = 100000, fail = false;
  await atomicJson(f.intent, { version: 1, mode: "running", at: now });
  const guardian = await createGuardian(f.config, { now: () => now, policyOptions: { recoveryStableMs: 1000 }, alive: () => true,
    inspect: async () => { if (fail) throw Error("local inspection failure"); return { ok: true, value: { owned: true, pid: 42, start: "ticks", launcherPid: 43, launcherStart: "ticks" } }; },
    probe: async () => ({ ok: true, pid: 42 }) });
  cleanup.push(guardian.close);
  await guardian.tick(); now += 1000; await guardian.tick();
  expect(guardian.state().primaryReady).toBe(true);
  fail = true; now += 1000;
  await expect(guardian.tick()).rejects.toThrow("local inspection failure");
  expect(guardian.state().primaryReady).toBe(false);
});

test("an unchanged observation does not rewrite the status file", async () => {
  const f = await fixture();
  let now = 100000;
  await atomicJson(f.intent, { version: 1, mode: "running", at: now });
  const guardian = await createGuardian(f.config, { now: () => now, policyOptions: { recoveryStableMs: 1000 }, alive: () => true,
    inspect: async () => ({ ok: true, value: { owned: true, pid: 42, start: "ticks", launcherPid: 43, launcherStart: "ticks" } }),
    probe: async () => ({ ok: true, pid: 42 }) });
  cleanup.push(guardian.close);
  const statusFile = join(f.home, "recovery-status.json");
  await guardian.tick(); now += 1000; await guardian.tick();
  expect(guardian.state().primaryReady).toBe(true);
  const written = await readFile(statusFile, "utf8");
  now += 1000; await guardian.tick(); now += 1000; await guardian.tick();
  expect(await readFile(statusFile, "utf8")).toBe(written);
  // What the file records still reaches disk the moment it changes.
  await atomicJson(f.intent, { version: 1, mode: "stopped", at: ++now });
  await guardian.tick();
  expect(JSON.parse(await readFile(statusFile, "utf8")).state).toBe("stopped");
});

test("companion restart cannot replay a previously in-flight recovery command", async () => {
  const f = await fixture();
  const now = 100000;
  await atomicJson(f.intent, { version: 1, mode: "running", at: now - 1000 });
  const prior = new RecoveryPolicy();
  prior.markRecoveryStarted(now - 500);
  await atomicJson(join(f.home, "recovery-budget.json"), prior.exportSafeState(now));
  let actions = 0;
  const guardian = await createGuardian(f.config, { now: () => now, alive: () => true,
    inspect: async () => ({ ok: true, value: { owned: true, pid: 42, start: "ticks", launcherPid: 43, launcherStart: "ticks" } }),
    probe: async () => ({ ok: false, pid: 42 }),
    action: async () => { actions++; return { ok: true, value: { action: "started" } }; },
    repair: async () => ({ outcome: "no_candidate", candidateCount: 0, requestCount: 1 }) });
  cleanup.push(guardian.close);
  await guardian.tick(); await guardian.drain();
  expect(guardian.state().recoveryBlocked).toBe(true);
  expect(actions).toBe(0);
});

test("recovered readiness needs stable interval before main gateway uses primary again", async () => {
  const f = await fixture();
  let now = 100000, healthy = true;
  await atomicJson(f.intent, { version: 1, mode: "running", at: now });
  const guardian = await createGuardian(f.config, { now: () => now, policyOptions: { startupGraceMs: 1000, recoveryStableMs: 2000 }, alive: () => true,
    inspect: async () => ({ ok: true, value: { owned: true, pid: 42, start: "ticks", launcherPid: 43, launcherStart: "ticks" } }),
    probe: async () => ({ ok: healthy, pid: 42 }),
    action: async () => ({ ok: true, value: { action: "started" } }) });
  cleanup.push(guardian.close);
  await guardian.tick(); healthy = false;
  for (let n = 0; n < 11; n++) { now += 2000; await guardian.tick(); await guardian.drain(); }
  healthy = true; now += 1000; await guardian.tick();
  expect(guardian.state().primaryReady).toBe(false);
  now += 2000; await guardian.tick();
  expect(guardian.state().primaryReady).toBe(true);
});
