import { expect } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { acquireSpendLedgerOwner } from "../../src/lib/spend-ledger-owner";
import { createEndpointCase, installEndpointHooks, ownCleanup, test, testDir } from "../helpers/claude-endpoint-lifetime";

installEndpointHooks();

test("endpoint teardown aborts and joins the expired body before restoring its home", async () => {
  let restored = false, finalized = false, stops = 0, releases = 0;
  let releaseStop!: () => void;
  const heldStop = new Promise<void>(resolve => { releaseStop = resolve; });
  const owner = createEndpointCase(async () => { restored = true; });
  const server = owner.ownServer({ stop: async (_force?: boolean) => { stops++; await heldStop; } });
  owner.ownCleanup(() => { expect(finalized).toBe(true); releases++; });
  const body = owner.run(async () => {
    try { await new Promise<void>((_, reject) => owner.signal.addEventListener("abort", () => reject(owner.signal.reason), { once: true })); }
    finally { await server.stop(true); finalized = true; }
  });
  await Promise.resolve();
  const closing = owner.close();
  expect(owner.close()).toBe(closing);
  expect(owner.signal.aborted).toBe(true);
  expect(restored).toBe(false);
  expect(releases).toBe(0);
  expect(() => owner.assertClosed()).toThrow("did not settle");
  releaseStop();
  await closing;
  await body.catch(() => {});
  expect(stops).toBe(1);
  expect(finalized).toBe(true);
  expect(restored).toBe(true);
  expect(releases).toBe(1);
  owner.assertClosed();
});

test("endpoint stop failure attempts every owner and keeps the next-case fence closed", async () => {
  let restored = false, secondStopped = false;
  const owner = createEndpointCase(async () => { restored = true; });
  owner.ownServer({ stop() { throw new Error("fixture stop failed"); } });
  owner.ownServer({ stop() { secondStopped = true; } });
  await expect(owner.close()).rejects.toThrow("endpoint shutdown failed");
  expect(secondStopped).toBe(true);
  expect(restored).toBe(false);
  expect(() => owner.assertClosed()).toThrow("did not settle");
});

test("endpoint drain deadline never restores a home while the body remains live", async () => {
  let restored = false, releaseBody!: () => void;
  const held = new Promise<void>(resolve => { releaseBody = resolve; });
  const owner = createEndpointCase(async () => { restored = true; }, 5);
  const body = owner.run(() => held);
  try {
    await expect(owner.close()).rejects.toThrow("endpoint case drain timed out");
    expect(restored).toBe(false);
    expect(() => owner.assertClosed()).toThrow("did not settle");
  } finally { releaseBody(); await body; }
});

test("endpoint shutdown releases the real ledger before a different home can acquire it", async () => {
  const firstHome = join(testDir, "ledger-a"), nextHome = join(testDir, "ledger-b");
  mkdirSync(firstHome); mkdirSync(nextHome);
  const lease = acquireSpendLedgerOwner(firstHome);
  const release = ownCleanup(() => lease.release());
  let releaseStop!: () => void;
  const held = new Promise<void>(resolve => { releaseStop = resolve; });
  const owner = createEndpointCase(async () => {});
  owner.ownServer({ stop: async () => { await held; release(); } });
  const closing = owner.close();
  try { expect(() => acquireSpendLedgerOwner(nextHome)).toThrow("different state directory"); }
  finally { releaseStop(); await closing; }
  const next = acquireSpendLedgerOwner(nextHome);
  try { expect(next).toBeDefined(); } finally { next.release(); }
});

test("endpoint teardown joins a handle constructed after the body was aborted", async () => {
  const construct = Promise.withResolvers<void>(), stop = Promise.withResolvers<void>();
  let restored = false, stops = 0;
  const owner = createEndpointCase(async () => { restored = true; });
  const body = owner.run(async () => {
    await construct.promise;
    owner.ownServer({ stop: async () => { stops++; await stop.promise; } });
  });
  const closing = owner.close();
  construct.resolve();
  await expect(body).rejects.toThrow("endpoint case is closing");
  expect(stops).toBe(1);
  expect(restored).toBe(false);
  stop.resolve(); await closing;
  expect(restored).toBe(true);
  owner.assertClosed();
});

test("endpoint teardown releases a lease acquired after the body was aborted", async () => {
  const acquire = Promise.withResolvers<void>();
  let released = 0, bodySettled = false;
  const owner = createEndpointCase(async () => {});
  const body = owner.run(async () => {
    try { await acquire.promise; owner.ownCleanup(() => { expect(bodySettled).toBe(true); released++; }); }
    finally { bodySettled = true; }
  });
  const closing = owner.close(); acquire.resolve();
  await expect(body).rejects.toThrow("endpoint case is closing");
  await closing;
  expect(released).toBe(1);
  owner.assertClosed();
});
