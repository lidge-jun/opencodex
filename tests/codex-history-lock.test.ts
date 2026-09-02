import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  assertHistoryWritePermit,
  isHistoryWritePermitLive,
  withHistoryWriteSerialization,
  type HistoryWritePermit,
} from "../src/codex/history-lock";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const repoRoot = resolve(import.meta.dir, "..");
const sandboxes: string[] = [];

interface Sandbox {
  readonly root: string;
  readonly codexHome: string;
  readonly stateDb: string;
  readonly env: Record<string, string>;
}

function makeSandbox(prefix: string): Sandbox {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  sandboxes.push(root);
  const codexHome = join(root, "codex-home");
  const home = join(root, "user-home");
  const runtime = join(root, "runtime");
  for (const path of [codexHome, home, runtime]) {
    mkdirSync(path, { recursive: true });
    chmodSync(path, 0o700);
  }
  const stateDb = join(codexHome, "state_5.sqlite");
  writeFileSync(stateDb, "");
  return {
    root,
    codexHome,
    stateDb,
    env: {
      ...Object.fromEntries(Object.entries(process.env)
        .filter((entry): entry is [string, string] => entry[1] !== undefined)),
      CODEX_HOME: codexHome,
      HOME: home,
      USERPROFILE: home,
      TMPDIR: runtime,
      TEMP: runtime,
      TMP: runtime,
      XDG_RUNTIME_DIR: runtime,
    },
  };
}

afterEach(() => {
  for (const root of sandboxes.splice(0)) removeTreeWithRetry(root);
});

async function waitForPath(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await Bun.sleep(5);
  }
}

test("H excludes a second process across the whole history unit", async () => {
  const sandbox = makeSandbox("ocx-history-lock-");
  const ready = join(sandbox.root, "held");
  const release = join(sandbox.root, "release");

  // A real second process holds H and parks inside the callback, which is where
  // the DB, manifest and rollout writes all happen.
  const holder = Bun.spawn([process.execPath, "--eval", `
    import { existsSync, writeFileSync } from "node:fs";
    const { withHistoryWriteSerialization } = await import("./src/codex/history-lock.ts");
    const outcome = withHistoryWriteSerialization(
      ${JSON.stringify(sandbox.codexHome)},
      ${JSON.stringify(sandbox.stateDb)},
      () => {
        writeFileSync(${JSON.stringify(ready)}, "held");
        const waiter = new Int32Array(new SharedArrayBuffer(4));
        while (!existsSync(${JSON.stringify(release)})) Atomics.wait(waiter, 0, 0, 10);
      },
    );
    if (outcome.kind !== "completed") throw new Error(JSON.stringify(outcome));
  `], { cwd: repoRoot, env: sandbox.env, stdout: "pipe", stderr: "pipe" });

  try {
    await waitForPath(ready);

    // Contention is fail-fast and typed, never a block: holding H across an
    // unbounded wait is the stall this phase exists to remove.
    let ran = false;
    const contended = withHistoryWriteSerialization(
      sandbox.codexHome,
      sandbox.stateDb,
      () => { ran = true; },
    );
    expect(contended).toEqual({ kind: "unavailable", reason: "busy" });
    expect(ran).toBe(false);
  } finally {
    writeFileSync(release, "release");
    expect(await holder.exited).toBe(0);
  }

  // Once the holder is gone the lock is available again.
  const after = withHistoryWriteSerialization(sandbox.codexHome, sandbox.stateDb, () => "ok");
  expect(after).toEqual({ kind: "completed", value: "ok" });
}, 30_000);

test("a permit is refused once its acquisition released, and for a foreign state database", () => {
  const sandbox = makeSandbox("ocx-history-permit-");
  const other = join(sandbox.codexHome, "other_state.sqlite");

  let leaked!: HistoryWritePermit;
  const outcome = withHistoryWriteSerialization(sandbox.codexHome, sandbox.stateDb, permit => {
    leaked = permit;
    // Live and correct inside the acquisition.
    expect(isHistoryWritePermitLive(permit)).toBe(true);
    assertHistoryWritePermit(permit, sandbox.stateDb);
    // Right permit, wrong database: authority is per state DB, not per process.
    expect(() => assertHistoryWritePermit(permit, other)).toThrow(/different Codex state database/);
    return "done";
  });
  expect(outcome).toEqual({ kind: "completed", value: "done" });

  // The reason the permit is a registry entry rather than a type: a leaked
  // permit type-checks perfectly, so only a runtime check can refuse it.
  expect(isHistoryWritePermitLive(leaked)).toBe(false);
  expect(() => assertHistoryWritePermit(leaked, sandbox.stateDb)).toThrow(/released acquisition/);

  // A forged value of the right type is refused too.
  expect(() => assertHistoryWritePermit({} as HistoryWritePermit, sandbox.stateDb))
    .toThrow(/not minted by the serialization owner/);
});

test("a permit is revoked even when the callback throws", () => {
  const sandbox = makeSandbox("ocx-history-throw-");
  let leaked!: HistoryWritePermit;

  expect(() => withHistoryWriteSerialization(sandbox.codexHome, sandbox.stateDb, permit => {
    leaked = permit;
    throw new Error("callback failed");
  })).toThrow("callback failed");

  // Revocation happens in a `finally`, so the throwing path cannot leave a live
  // permit behind after the lock is gone.
  expect(isHistoryWritePermitLive(leaked)).toBe(false);

  // And the lock itself was released rather than wedged.
  expect(withHistoryWriteSerialization(sandbox.codexHome, sandbox.stateDb, () => "free"))
    .toEqual({ kind: "completed", value: "free" });
});

test("two different state databases under one home do not exclude each other", () => {
  const sandbox = makeSandbox("ocx-history-sibling-");
  const second = join(sandbox.codexHome, "second_state.sqlite");
  writeFileSync(second, "");

  // H is keyed by the state database, so work against a different history
  // database proceeds while this acquisition is held.
  const outcome = withHistoryWriteSerialization(sandbox.codexHome, sandbox.stateDb, () => {
    return withHistoryWriteSerialization(sandbox.codexHome, second, () => "sibling");
  });
  expect(outcome).toEqual({ kind: "completed", value: { kind: "completed", value: "sibling" } });
});
