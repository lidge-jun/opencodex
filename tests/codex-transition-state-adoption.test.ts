import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openCodexCoordinatorTransaction } from "../src/codex/transition-state";
import {
  resolveCodexCoordinatorDatabasePath,
  resolveEffectiveUserIdentity,
} from "../src/codex/user-identity";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const CHILD = join(import.meta.dir, "helpers", "codex-adoption-crash-child.ts");
let root = "";
let codexHome = "";
let opencodexHome = "";
let coordinatorPath = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-adoption-crash-"));
  codexHome = mkdtempSync(join(root, "codex-"));
  opencodexHome = mkdtempSync(join(root, "opencodex-"));
  process.env.CODEX_HOME = codexHome;
  process.env.OPENCODEX_HOME = opencodexHome;
  coordinatorPath = resolveCodexCoordinatorDatabasePath(
    resolveEffectiveUserIdentity(),
    realpathSync.native(codexHome),
  );
});

afterEach(() => {
  delete process.env.CODEX_HOME;
  delete process.env.OPENCODEX_HOME;
  rmSync(coordinatorPath, { force: true });
  removeTreeWithRetry(root);
});

for (const checkpoint of ["temp-created", "temp-committed", "published"] as const) {
  test(`a kill at ${checkpoint} leaves the home adoptable`, () => {
    const child = spawnSync(process.execPath, [CHILD], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        OPENCODEX_HOME: opencodexHome,
        OCX_ADOPTION_CRASH_PAYLOAD: JSON.stringify({ coordinatorPath, checkpoint }),
      },
      encoding: "utf8",
    });
    expect(child.status).toBe(86);
    expect(existsSync(coordinatorPath)).toBe(checkpoint === "published");

    const resumed = openCodexCoordinatorTransaction(coordinatorPath, { direction: "apply" });
    try {
      const state = resumed.version();
      expect(state).toEqual({ nativeGeneration: 0, currentTxId: null });
      const expectation = resumed.expectation();
      const update = resumed.capability.beginTransition(state, {
        txId: expectation.txId,
        direction: "apply",
        authoritySnapshotId: "resume-authority",
        nextRetryAt: "2026-08-26T00:00:00.000Z",
      });
      expect(update).toMatchObject({ kind: "updated", state: { nativeGeneration: 1 } });
      resumed.assertPublished(expectation);
      resumed.commit();
    } finally {
      resumed.close();
    }
  });
}

test("Windows fsync of a coordinator file needs a writable fd", () => {
  const probe = join(root, "fsync-probe");
  writeFileSync(probe, "x");
  const readonlyFd = openSync(probe, "r");
  try {
    if (process.platform === "win32") {
      expect(() => fsyncSync(readonlyFd)).toThrow(/EPERM|operation not permitted/);
    } else {
      fsyncSync(readonlyFd);
    }
  } finally {
    closeSync(readonlyFd);
  }
  const writableFd = openSync(probe, "r+");
  try {
    fsyncSync(writableFd);
  } finally {
    closeSync(writableFd);
  }
});

test("adoption publishes a coordinator database on this platform", () => {
  const adopted = openCodexCoordinatorTransaction(coordinatorPath, { direction: "apply" });
  try {
    expect(existsSync(coordinatorPath)).toBe(true);
    expect(adopted.version()).toEqual({ nativeGeneration: 0, currentTxId: null });
    adopted.commit();
  } finally {
    adopted.close();
  }
});
