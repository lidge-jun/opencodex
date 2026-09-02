import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withCodexLogGuardLock } from "../src/codex/log-guard/lock";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

describe("Codex Log Guard lock", () => {
  test("fails fast on same-database contention without using history H", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-log-guard-lock-"));
    roots.push(root);
    const lockPath = join(root, "log-guard-lock.sqlite");
    const codexHome = join(root, "codex-home");
    const logsDb = join(root, "logs_2.sqlite");
    const deps = { resolveDatabasePath: () => lockPath };

    const outer = withCodexLogGuardLock(codexHome, logsDb, () => {
      return withCodexLogGuardLock(codexHome, logsDb, () => "inner", deps);
    }, deps);

    expect(outer.kind).toBe("completed");
    if (outer.kind !== "completed") return;
    expect(outer.value).toEqual({ kind: "unavailable", reason: "busy" });
  });
});
