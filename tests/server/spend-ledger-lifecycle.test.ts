/**
 * The failed-start rollback owns two things at once: stopping whatever came up, and giving the
 * state directory back. Doing the second before the first has finished is what single-writer
 * ownership exists to prevent, and it cannot be observed from a passing startup.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSpendLedgerServerLifecycle } from "../../src/server/index/spend-ledger-lifecycle";
import { spendLedgerOwnerSnapshot } from "../../src/lib/spend-ledger-owner";
import { resetSharedSpendLedgerForTest, sharedSpendLedger } from "../../src/lib/spend-reservation-ledger";
import { getDefaultConfig, reconcileLiveConfigFromDisk, saveConfig } from "../../src/config";
import { reconcileLiveStateStores, setLiveStateStoreConfig } from "../../src/lib/state-store-registrations";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let root = "";
let home = "";
let previousHome: string | undefined;
const stopOrder: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-spend-lifecycle-"));
  home = join(root, "state");
  previousHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  stopOrder.length = 0;
  resetSharedSpendLedgerForTest();
});

afterEach(() => {
  resetSharedSpendLedgerForTest();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(root);
});

/** A listener whose stop stays pending until the case says otherwise, like a real drain. */
function controlledListener(name: string, mode: "resolve" | "reject" = "resolve") {
  let settle: () => void = () => {};
  const stopped = new Promise<void>((resolve, reject) => {
    settle = () => { if (mode === "reject") reject(new Error(`${name} stop failed`)); else resolve(); };
  });
  stopped.catch(() => { /* the rollback owns this rejection; the case must not be unhandled */ });
  return {
    settle,
    server: {
      stop(_closeActiveConnections?: boolean): Promise<void> {
        stopOrder.push(name);
        return stopped;
      },
    },
  };
}

/** Let the rollback's allSettled continuation run without inventing a duration. */
async function drainContinuations(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

test("a failed start keeps the lease until every listener has actually stopped", async () => {
  const lifecycle = acquireSpendLedgerServerLifecycle(home);
  const first = controlledListener("first");
  const second = controlledListener("second");
  lifecycle.track(first.server);
  lifecycle.track(second.server);
  expect(spendLedgerOwnerSnapshot().ownership).toBe("held");

  const rollback = lifecycle.releaseAfterFailedStart();
  // Newest first, and both asked before anything is awaited.
  expect(stopOrder).toEqual(["second", "first"]);
  await drainContinuations();
  // Still held: neither stop has settled, so a listener could still be serving.
  expect(spendLedgerOwnerSnapshot().ownership).toBe("held");

  first.settle();
  await drainContinuations();
  expect(spendLedgerOwnerSnapshot().ownership).toBe("held");

  second.settle();
  await rollback;
  expect(spendLedgerOwnerSnapshot().ownership).toBe("unheld");
});

test("a listener whose stop rejects still stops the rest and still returns the directory", async () => {
  const lifecycle = acquireSpendLedgerServerLifecycle(home);
  const failing = controlledListener("failing", "reject");
  const healthy = controlledListener("healthy");
  lifecycle.track(healthy.server);
  lifecycle.track(failing.server);

  const rollback = lifecycle.releaseAfterFailedStart();
  expect(stopOrder).toEqual(["failing", "healthy"]);

  failing.settle();
  await drainContinuations();
  // One refusal does not strand the directory, and it does not skip the other listener either.
  expect(spendLedgerOwnerSnapshot().ownership).toBe("held");

  healthy.settle();
  await expect(rollback).rejects.toThrow("failed-start listener rollback was uncertain");
  expect(spendLedgerOwnerSnapshot().ownership).toBe("held");
  // Explicit test cleanup. Production keeps this owner until process exit because the
  // rejected stop cannot prove the listener released its socket.
  lifecycle.release();
  expect(spendLedgerOwnerSnapshot().ownership).toBe("unheld");
});

test("live provider mutations and disk adoption refresh spend policy from the active roster", () => {
  const lifecycle = acquireSpendLedgerServerLifecycle(home);
  const config = { ...getDefaultConfig(), defaultProvider: "stable", spend: { pool: { maxTokens: 100 } },
    providers: { stable: { adapter: "openai-chat" as const, baseUrl: "https://example.test/v1", apiKey: "fixture-key" } } };
  setLiveStateStoreConfig(config);
  lifecycle.configure(config.spend, undefined, Object.keys(config.providers));
  try {
    const ledger = sharedSpendLedger();
    expect(ledger.reserve({ sendId: "retained", scopes: { poolId: "stable" }, inputTokens: 20, outputCeilingTokens: 0 }).reserved).toBe(true);
    ledger.markDispatched("retained");
    ledger.settle("retained", { inputTokens: 20, outputTokens: 0 });
    expect(ledger.reserve({ sendId: "unassigned", scopes: { poolId: "added" }, inputTokens: 10, outputCeilingTokens: 0 }).reserved).toBe(true);
    ledger.markDispatched("unassigned");
    ledger.settle("unassigned", { inputTokens: 10, outputTokens: 0 });
    expect(ledger.snapshot("pool", "stable")?.settled).toBe(30);
    const added = { ...config.providers.stable };
    Object.assign(config.providers, { added });
    config.spend.pool.maxTokens = 120;
    reconcileLiveStateStores();
    expect(ledger.policy.canonicalProviderIds).toEqual(["stable", "added"]);
    expect(ledger.policy.pool.maxTokens).toBe(120);
    expect(ledger.snapshot("pool", "stable")?.settled).toBe(20);

    Reflect.deleteProperty(config.providers, "added");
    reconcileLiveStateStores();
    expect(ledger.policy.canonicalProviderIds).toEqual(["stable"]);
    expect(ledger.snapshot("pool", "stable")?.settled).toBe(30);
    saveConfig(config);
    const baseline = structuredClone(config);
    saveConfig({ ...baseline, providers: { ...baseline.providers, fromdisk: added }, spend: { pool: { maxTokens: 140 } } });
    // Detached reads/writes do not make disk-only providers live.
    expect(ledger.policy.canonicalProviderIds).toEqual(["stable"]);
    reconcileLiveConfigFromDisk(config, baseline);
    reconcileLiveStateStores();
    expect(ledger.policy.canonicalProviderIds).toEqual(["stable", "fromdisk"]);
    expect(ledger.policy.pool.maxTokens).toBe(140);
    expect(ledger.snapshot("pool", "stable")?.settled).toBe(30);
  } finally {
    lifecycle.release();
  }
});

test("live refresh with no spend ceiling creates neither journal nor salt", () => {
  const lifecycle = acquireSpendLedgerServerLifecycle(home);
  const config = getDefaultConfig();
  delete config.spend;
  delete config.spendPoolAliases;
  setLiveStateStoreConfig(config);
  try {
    reconcileLiveStateStores();
    expect(existsSync(join(home, "spend-ledger.jsonl"))).toBe(false);
    expect(existsSync(join(home, "spend-ledger.salt"))).toBe(false);
  } finally {
    lifecycle.release();
  }
});
