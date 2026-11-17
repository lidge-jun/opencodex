import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALL_LATER_EDITS_KEPT,
  NO_OPENCODEX_ROUTING,
  SEED_CONFIG,
  makeRestoreHomes,
  runRestoreChild,
} from "../helpers/codex-restore-child";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

/**
 * INV-RESTORE-02: restore never reverts config.toml changes made after injection.
 *
 * Every restore entry point runs in a child under temporary CODEX_HOME, OPENCODEX_HOME and HOME:
 * inject, let "Codex" change hook trust, project trust, a plugin flag and a root key, then restore.
 * Each path must keep every later change and take out only what OpenCodex wrote. The race cases
 * land a write after a restore decided its bytes and before it publishes them.
 */
describe("INV-RESTORE-02 restore keeps every change made after injection", () => {
  let root: string;
  beforeEach(() => { root = makeRestoreHomes("ocx-restore-later-edits-"); });
  afterEach(() => removeTreeWithRetry(root));

  // Each path's own success flag: a stop reports success, a recovery reports that it restored.
  const outcome: Record<string, [string, unknown]> = {
    "stop-sync": ["success", true],
    "stop-async": ["configState", "ok"],
    "start-recovery": ["restored", true],
    "client-recovery": ["restored", true],
    "disconnect-recovery": ["complete", true],
    "reinject-stop": ["success", true],
  };
  for (const [path, [flag, value]] of Object.entries(outcome)) {
    test(path + " keeps later Codex edits and removes only OpenCodex routing", () => {
      const { report } = runRestoreChild(root, path);
      expect(report.kept).toEqual(ALL_LATER_EDITS_KEPT);
      expect(report.routing).toEqual(NO_OPENCODEX_ROUTING);
      expect(report[flag]).toBe(value);
    }, SPAWN_BUDGET_MS);
  }

  for (const path of ["untouched-stop", "untouched-start"]) {
    test(path + " restores an untouched config byte for byte", () => {
      const { report } = runRestoreChild(root, path);
      expect(report.configSha256).toBe(createHash("sha256").update(SEED_CONFIG).digest("hex"));
      expect(report.journal).toBe(false);
    }, SPAWN_BUDGET_MS);
  }

  test("a stale journal left by a field-level stop changes nothing and is cleared at the next start", () => {
    const { report, stderr } = runRestoreChild(root, "stale-journal");
    expect(report.configSha256).toBe(report.beforeSha256 as string);
    expect(report.kept).toEqual(ALL_LATER_EDITS_KEPT);
    expect(report.journal).toBe(false);
    expect(stderr).not.toContain("incomplete");
    expect(stderr).not.toContain("did not shut down cleanly");
  }, SPAWN_BUDGET_MS);
});

describe("INV-RESTORE-02 restore never overwrites a write that lands while it is restoring", () => {
  let root: string;
  beforeEach(() => { root = makeRestoreHomes("ocx-restore-race-"); });
  afterEach(() => removeTreeWithRetry(root));

  for (const scenario of ["race-replay", "race-strip"]) {
    for (const variant of ["in-place", "rename"]) {
      test(scenario + " keeps a concurrent " + variant + " write and refuses instead of publishing", () => {
        const { report } = runRestoreChild(root, scenario, variant);
        expect(report.concurrentKept).toBe(true);
        expect(report.success).toBe(false);
        // The refusal kept the journal, so a retry can still restore.
        expect(report.journal).toBe(true);
        if (scenario === "race-strip" && variant === "rename") {
          // The journal step had already removed the generated profile, and a replaced config.toml
          // forbids every publication in the section; that one file is named, nothing else.
          expect(report.unrestored).toEqual(["profile", "journal"]);
        } else {
          expect(report.retryable).toBe(true);
        }
      }, SPAWN_BUDGET_MS);
    }
  }

  test("the provider-table retention write refuses when config.toml changed after it was read", () => {
    const { report } = runRestoreChild(root, "race-retain", "in-place");
    expect(report.concurrentKept).toBe(true);
    expect(report.threw).toBe(true);
    expect(readFileSync(join(root, "codex", "config.toml"), "utf8")).not.toContain("[model_providers.opencodex]");
  }, SPAWN_BUDGET_MS);
});
