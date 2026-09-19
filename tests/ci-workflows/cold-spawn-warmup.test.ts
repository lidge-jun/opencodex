import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  COLD_SPAWN_WARMUP_DEADLINE_MS,
  COLD_SPAWN_WARMUP_HOOK_BUDGET_MS,
  moduleGraphSpecifiers,
  resetColdSpawnWarmupForTests,
  warmColdSpawn,
  warmModuleGraph,
} from "../helpers/cold-spawn-warmup";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";
import {
  analyzeWarmupRegistration,
  dispositionComplaints,
  type WarmupDisposition,
} from "../helpers/warmup-registration";

/**
 * Three things are checked here, and they answer different questions.
 *
 * The scan answers "did anyone add another one". A test that hands `INTERNAL_DEADLINE_MS` to a child
 * process timeout is measuring that child's cold module-graph load inside the assertion, which is
 * the defect in #4956's cold-start class: the first child of a graph can take an order of magnitude
 * longer than the next, so the verdict depends on what else ran in the shard. Every such file has to
 * appear below with a disposition, so the next one is classified when it lands rather than after it
 * fails on a Windows shard.
 *
 * The dispositions answer "is the file recorded as warmed still warmed". That used to be a
 * substring test for the helper's path, which #5060 showed accepts an unused import, a comment or a
 * string literal as proof — each of them survives deleting the beforeAll call that did the work, so
 * the measured child pays the cold load again with a green guard in front of it.
 * tests/helpers/warmup-registration.ts replaces the substring with a judge that recognises four
 * shapes exactly and refuses every other construct by name; its own regression set is
 * tests/ci-workflows/warmup-registration.test.ts. A refused shape is not a blocked file: a
 * disposition records the construct in `unmodeled` and the refusal itself stays under test. The
 * judge reads shape, not execution — the execution oracle is the [cold-spawn-warmup] completion
 * line the helper prints on every hosted run.
 *
 * The unit tests answer "does the warm-up still warm the right thing". A warm-up that names its
 * modules by hand decays silently, so `moduleGraphSpecifiers` derives them from the child's own
 * source instead. These cases pin the properties that makes that derivation trustworthy: it follows
 * the source, it sees require and dynamic import as well as static import, it drops erased types, and
 * it fails closed when it finds nothing.
 */

type Disposition = WarmupDisposition;

/**
 * Every test file that bounds a spawned child with `INTERNAL_DEADLINE_MS`.
 *
 * `warmed: true` means the file pays that graph's cold load in a `beforeAll` through
 * `tests/helpers/cold-spawn-warmup.ts`. `warmed: false` needs a reason that survives review.
 */
const DISPOSITIONS: Readonly<Record<string, Disposition>> = {
  "tests/ci-workflows/test-runner.test.ts": {
    warmed: true,
    why: "one throwaway lane pays Bun's test-runner bootstrap before the captured-output lane is timed",
  },
  "tests/cli/cli-connect-readiness.test.ts": {
    warmed: true,
    why: "two graphs: the connect eval, and the observed ladder that also loads src/codex/runtime",
  },
  "tests/cli/cli-models.test.ts": {
    warmed: true,
    why: "every ocx subcommand here loads the same src/cli/index.ts static graph",
  },
  "tests/clients/client-connect.test.ts": {
    warmed: true,
    why: "three graphs: the state eval, the connect-transaction eval, and the generated lifecycle fixture",
  },
  "tests/codex-integration/main-account-hard-lock-auth.test.ts": {
    warmed: true,
    why: "two helper entries, the second reaching src/server and src/server/responses/core",
  },
  "tests/codex-integration/main-quota-provenance.test.ts": {
    warmed: true,
    why: "the first resetAt iteration loads src/codex/quota.ts and src/codex/main-account-cache.ts",
  },
  "tests/codex-integration/codex-shim.test.ts": {
    warmed: false,
    why:
      "Its Windows children are a cmd.exe or PowerShell driver tree, so the cold cost is shell and "
      + "process startup rather than a repository module graph, and an import scan has nothing to warm. "
      + "The file also sits exactly on its file-size ratchet cap of 2388 lines in "
      + "tests/fixtures/file-size-baseline.json, and that cap only moves downward, so a warm-up cannot "
      + "be added here without unrelated deletions. Left for a separate change.",
  },
};

/**
 * A child-process timeout fed `INTERNAL_DEADLINE_MS`, however it is spelled: bare, subtracted from
 * `SPAWN_BUDGET_MS`, behind a platform ternary, or interpolated into a generated fixture. The window
 * is bounded so an unrelated later mention on the same page cannot match.
 */
const DEADLINE_AS_SPAWN_TIMEOUT = /timeout:[\s\S]{0,120}?INTERNAL_DEADLINE_MS/;

function testFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) testFiles(path, found);
    else if (entry.name.endsWith(".test.ts")) found.push(path);
  }
  return found;
}

function filesBoundingASpawnWithTheDeadline(): string[] {
  return testFiles(repoPath("tests"))
    // This file is excluded because the pattern's own source text matches it, which would make the
    // guard demand a disposition for the guard.
    .filter(path => path !== import.meta.path)
    .filter(path => DEADLINE_AS_SPAWN_TIMEOUT.test(readFileSync(path, "utf8")))
    .map(path => relative(repoRoot(), path).split("\\").join("/"))
    .sort();
}

function judgeWarmup(path: string) {
  const file = repoPath(path);
  return analyzeWarmupRegistration(file, readFileSync(file, "utf8"));
}

describe("cold-spawn warm-up coverage", () => {
  test("every file that times a spawned child against the deadline has a disposition", () => {
    expect(filesBoundingASpawnWithTheDeadline()).toEqual(Object.keys(DISPOSITIONS).sort());
  });

  test("every disposition still describes the file it is recorded against", () => {
    // Warmed means one of the four accepted shapes is here and nothing on the binding path was
    // refused; unwarmed means the file does not reach the helper at all, which is asked of the
    // whole file rather than of its bindings, because a namespace import or a barrel binds no name
    // this judge follows and would otherwise read as an absence.
    const wrong = Object.entries(DISPOSITIONS)
      .flatMap(([path, disposition]) => dispositionComplaints(path, disposition, judgeWarmup(path)));
    expect(wrong).toEqual([]);
  });

  test("anything other than a plainly warmed file says why, at length", () => {
    for (const [path, disposition] of Object.entries(DISPOSITIONS)) {
      if (disposition.warmed && disposition.unmodeled === undefined) continue;
      expect({ path, reason: disposition.why.length > 80 }).toEqual({ path, reason: true });
    }
  });
});

describe("the warm-up budget is derived, not chosen", () => {
  test("the hook gets the spawn budget and the child gets what teardown and reap leave", () => {
    expect(COLD_SPAWN_WARMUP_HOOK_BUDGET_MS).toBe(SPAWN_BUDGET_MS);
    expect(COLD_SPAWN_WARMUP_DEADLINE_MS).toBe(SPAWN_BUDGET_MS - 20_000);
    // #4948 derived 25s by hand for one file. It has to stay that value, or the reserve this helper
    // documents for removeTreeWithRetry and for reaping the child is no longer what it claims.
    expect(COLD_SPAWN_WARMUP_DEADLINE_MS).toBe(25_000);
  });
});

describe("the warmed graph is read from the child, not named by hand", () => {
  const resolveDir = repoRoot();

  test("it follows the source, so a moved import moves the warm-up with it", () => {
    expect(moduleGraphSpecifiers('import "./src/codex/history-lock.ts";', resolveDir))
      .toEqual([join(resolveDir, "src/codex/history-lock.ts")]);
    expect(moduleGraphSpecifiers('import "./src/codex/moved/history-lock.ts";', resolveDir))
      .toEqual([join(resolveDir, "src/codex/moved/history-lock.ts")]);
  });

  test("require and dynamic import count, because the children use both", () => {
    // cli-connect-readiness reaches src/codex/runtime through require, and the history-lock children
    // reach their module through a top-level await import. A scan that saw only import statements
    // would report success while warming nothing either of them loads.
    expect(moduleGraphSpecifiers('const x = require("./src/cli/connect");', resolveDir))
      .toEqual([join(resolveDir, "src/cli/connect")]);
    expect(moduleGraphSpecifiers('const m = await import("./src/oauth/store.ts");', resolveDir))
      .toEqual([join(resolveDir, "src/oauth/store.ts")]);
  });

  test("erased types are not modules, and builtins are not worth warming", () => {
    expect(moduleGraphSpecifiers('import type { T } from "./src/config"; export const v = 1;', resolveDir))
      .toEqual([]);
    expect(moduleGraphSpecifiers('import { readFileSync } from "node:fs"; import { test } from "bun:test";', resolveDir))
      .toEqual([]);
  });

  test("a specifier is resolved against the directory the child resolves it against", () => {
    expect(moduleGraphSpecifiers('import "../../src/codex/shim";', repoPath("tests", "helpers")))
      .toEqual([join(repoRoot(), "src/codex/shim")]);
  });

  test("the same module twice is one warm-up", () => {
    expect(moduleGraphSpecifiers('import "./src/config"; const c = require("./src/config");', resolveDir))
      .toEqual([join(resolveDir, "src/config")]);
  });

  test("a hoisted prologue is scanned even when it is only a top-level await import", () => {
    // codex-retained-root-serialization's catalog-sync prologue is exactly this one statement. A
    // fragment with no import or export of its own can be read as a script, where top-level await
    // does not parse, so the scan has to establish module context for itself.
    expect(moduleGraphSpecifiers('const { syncCatalogModels } = await import("./src/codex/catalog/sync.ts");', resolveDir))
      .toEqual([join(resolveDir, "src/codex/catalog/sync.ts")]);
  });

  test("a CLI entry's shebang does not stop the scan", () => {
    // src/cli/index.ts opens with one, and a shebang is valid only on the first line. Establishing
    // module context in front of it produced a syntax error and warmed nothing at all, which is the
    // failure mode this whole helper exists to make impossible.
    expect(moduleGraphSpecifiers('#!/usr/bin/env bun\nimport "./src/cli/status";', resolveDir))
      .toEqual([join(resolveDir, "src/cli/status")]);
    const entry = repoPath("src", "cli", "index.ts");
    expect(moduleGraphSpecifiers(readFileSync(entry, "utf8"), repoPath("src", "cli")).length)
      .toBeGreaterThan(20);
  });

  test("a real child entry resolves to real repository modules", () => {
    const entry = repoPath("tests", "helpers", "codex-write-lock-child.ts");
    const specifiers = moduleGraphSpecifiers(readFileSync(entry, "utf8"), repoPath("tests", "helpers"));
    expect(specifiers).toContain(join(repoRoot(), "src/codex/codex-write-lock"));
  });
});

describe("warm-up failure policy", () => {
  test("a scan that finds nothing to warm is a setup failure, not a silent no-op", async () => {
    resetColdSpawnWarmupForTests();
    // This is the shape a decayed warm-up takes: the call still runs, the child still exits, and
    // nothing is warmed. It has to be loud, because the flake it stops leaving behind is not.
    await expect(warmModuleGraph({
      graph: "cold-spawn-warmup-test/no-repository-modules",
      source: 'import { test } from "bun:test"; export const value = 1;',
    })).rejects.toThrow("scanned no repository module");
  });

  test("one warm-up per graph per process, and a failure is not retried", async () => {
    resetColdSpawnWarmupForTests();
    let calls = 0;
    const count = async () => {
      await warmColdSpawn("cold-spawn-warmup-test/memo", () => { calls += 1; });
    };
    await count();
    await count();
    await count();
    expect(calls).toBe(1);

    let failures = 0;
    const fail = async () => {
      await warmColdSpawn("cold-spawn-warmup-test/failure", () => {
        failures += 1;
        throw new Error("warm-up child refused");
      });
    };
    await expect(fail()).rejects.toThrow("warm-up child refused");
    await expect(fail()).rejects.toThrow("warm-up child refused");
    expect(failures).toBe(1);
  });

  test("an entry-less, source-less warm-up names the graph it could not resolve", async () => {
    resetColdSpawnWarmupForTests();
    await expect(warmModuleGraph({ graph: "cold-spawn-warmup-test/unresolvable" }))
      .rejects.toThrow("needs either an entry or a source");
  });

  test("a real module graph loads, and reports what it loaded", async () => {
    resetColdSpawnWarmupForTests();
    // The end-to-end path: scan a child source, spawn one Bun child, import what it named, exit.
    await warmModuleGraph({
      graph: "cold-spawn-warmup-test/real",
      entry: repoPath("tests", "helpers", "codex-write-lock-child.ts"),
    });
  }, COLD_SPAWN_WARMUP_HOOK_BUDGET_MS);
});
