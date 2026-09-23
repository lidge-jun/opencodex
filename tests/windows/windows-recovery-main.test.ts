import { afterEach, expect, test } from "bun:test";
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
