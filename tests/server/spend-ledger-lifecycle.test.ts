/**
 * The failed-start rollback owns two things at once: stopping whatever came up, and giving the
 * state directory back. Doing the second before the first has finished is what single-writer
 * ownership exists to prevent, and it cannot be observed from a passing startup.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSpendLedgerServerLifecycle } from "../../src/server/index/spend-ledger-lifecycle";
import { spendLedgerOwnerSnapshot } from "../../src/lib/spend-ledger-owner";
import { resetSharedSpendLedgerForTest } from "../../src/lib/spend-reservation-ledger";
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

  lifecycle.releaseAfterFailedStart();
  // Newest first, and both asked before anything is awaited.
  expect(stopOrder).toEqual(["second", "first"]);
  await drainContinuations();
  // Still held: neither stop has settled, so a listener could still be serving.
  expect(spendLedgerOwnerSnapshot().ownership).toBe("held");

  first.settle();
  await drainContinuations();
  expect(spendLedgerOwnerSnapshot().ownership).toBe("held");

  second.settle();
  await drainContinuations();
  expect(spendLedgerOwnerSnapshot().ownership).toBe("unheld");
});

test("a listener whose stop rejects still stops the rest and still returns the directory", async () => {
  const lifecycle = acquireSpendLedgerServerLifecycle(home);
  const failing = controlledListener("failing", "reject");
  const healthy = controlledListener("healthy");
  lifecycle.track(healthy.server);
  lifecycle.track(failing.server);

  lifecycle.releaseAfterFailedStart();
  expect(stopOrder).toEqual(["failing", "healthy"]);

  failing.settle();
  await drainContinuations();
  // One refusal does not strand the directory, and it does not skip the other listener either.
  expect(spendLedgerOwnerSnapshot().ownership).toBe("held");

  healthy.settle();
  await drainContinuations();
  expect(spendLedgerOwnerSnapshot().ownership).toBe("unheld");
});
