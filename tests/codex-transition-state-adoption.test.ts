import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openCodexCoordinatorTransaction } from "../src/codex/transition-state";
import {
  resolveCodexCoordinatorDatabasePath,
  resolveEffectiveUserIdentity,
} from "../src/codex/user-identity";

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
  rmSync(root, { recursive: true, force: true });
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
