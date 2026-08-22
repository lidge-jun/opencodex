import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Database } from "bun:sqlite";

import {
  bumpConfigGeneration,
  mutatePersistedConfig,
  observeConfigGeneration,
  readConfigGeneration,
  saveConfig,
  saveConfigPreservingClaudeCode,
  withExpectedConfigGenerationSync,
} from "../src/config";
import type { OcxConfig } from "../src/types";

const CHILD_TIMEOUT_MS = 10_000;
const configModuleUrl = pathToFileURL(join(import.meta.dir, "../src/config.ts")).href;
const generationGuardRaceScript = `
  import { existsSync, writeFileSync } from "node:fs";
  import { withExpectedConfigGenerationSync } from ${JSON.stringify(configModuleUrl)};

  const payload = JSON.parse(process.env.OCX_TEST_PAYLOAD);
  const waitFor = path => {
    const deadline = Date.now() + ${CHILD_TIMEOUT_MS};
    while (!existsSync(path)) {
      if (Date.now() >= deadline) throw new Error(\`timed out waiting for \${path}\`);
      Bun.sleepSync(5);
    }
  };
  writeFileSync(payload.readyPath, "ready");
  waitFor(payload.releasePath);

  const result = withExpectedConfigGenerationSync({ value: 0 }, () => {
    writeFileSync(payload.callbackPath, payload.id);
    waitFor(payload.peerOutcomePath);
    return payload.id;
  });
  writeFileSync(payload.outcomePath, JSON.stringify(result));
  process.stdout.write(JSON.stringify(result));
`;

let testRoot = "";
let previousCodexHome: string | undefined;
let previousOpencodexHome: string | undefined;

function config(port = 10100): OcxConfig {
  return { port, providers: {}, defaultProvider: "openai" };
}

async function waitForPaths(paths: readonly string[]): Promise<void> {
  const deadline = Date.now() + CHILD_TIMEOUT_MS;
  while (!paths.every(existsSync)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${paths.join(", ")}`);
    await Bun.sleep(5);
  }
}

async function collectGuardRaceChild(
  child: ReturnType<typeof Bun.spawn>,
): Promise<Record<string, unknown>> {
  const timeout = setTimeout(() => child.kill(), CHILD_TIMEOUT_MS);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    return JSON.parse(stdout) as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

beforeEach(() => {
  previousCodexHome = process.env.CODEX_HOME;
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  testRoot = mkdtempSync(join(tmpdir(), "ocx-config-generation-"));
  process.env.CODEX_HOME = testRoot;
  process.env.OPENCODEX_HOME = testRoot;
});

afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  rmSync(testRoot, { recursive: true, force: true });
});

test("observe-only generation reports a missing database without creating or chmodding paths", () => {
  const absentParent = join(testRoot, "missing-parent");
  const absentHome = join(absentParent, "opencodex-home");
  const rootBefore = statSync(testRoot, { bigint: true });
  process.env.CODEX_HOME = absentHome;
  process.env.OPENCODEX_HOME = absentHome;

  const absentObservation = observeConfigGeneration();
  expect(existsSync(join(absentHome, "config-mutation.sqlite"))).toBeFalse();
  expect(existsSync(absentHome)).toBeFalse();
  expect(existsSync(absentParent)).toBeFalse();
  // Missing storage is now its own state. The original concern behind folding it
  // into `unavailable` — that a look-only caller must not receive something it
  // could mistake for a known-good zero — is unchanged and still honored:
  // `absent` authorizes nothing by itself. Only a caller holding the config
  // transaction may promote it, and only by reading a real zero in there.
  // Refusing outright was not neutral either: it meant refusing every Codex
  // write on any home whose config predates this database.
  expect(absentObservation).toEqual({ kind: "absent" });
  const rootAfter = statSync(testRoot, { bigint: true });
  expect(rootAfter.mode).toBe(rootBefore.mode);

  const existingHome = join(testRoot, "existing-home");
  mkdirSync(existingHome, { mode: 0o751 });
  chmodSync(existingHome, 0o751);
  const existingMode = statSync(existingHome).mode & 0o777;
  process.env.CODEX_HOME = existingHome;
  process.env.OPENCODEX_HOME = existingHome;

  const existingObservation = observeConfigGeneration();
  expect(existsSync(join(existingHome, "config-mutation.sqlite"))).toBeFalse();
  expect(statSync(existingHome).mode & 0o777).toBe(existingMode);
  expect(existingObservation).toEqual({ kind: "absent" });
});

test("observe-only generation reads an existing value without modifying its database", () => {
  saveConfig(config());
  saveConfig(config(20200));
  const databasePath = join(testRoot, "config-mutation.sqlite");
  const before = statSync(databasePath, { bigint: true });

  expect(observeConfigGeneration()).toEqual({
    kind: "ready",
    generation: { value: 2 },
  });

  const after = statSync(databasePath, { bigint: true });
  expect({ inode: after.ino, mtime: after.mtimeNs, size: after.size }).toEqual({
    inode: before.ino,
    mtime: before.mtimeNs,
    size: before.size,
  });
});

test("observe-only generation returns typed outcomes for malformed and unreadable databases", () => {
  const databasePath = join(testRoot, "config-mutation.sqlite");
  writeFileSync(databasePath, "not sqlite", "utf8");

  expect(observeConfigGeneration()).toEqual({ kind: "unavailable", reason: "database" });
  expect(observeConfigGeneration()).not.toEqual({ kind: "ready", generation: { value: 0 } });

  rmSync(databasePath);
  mkdirSync(databasePath);
  expect(observeConfigGeneration()).toEqual({ kind: "unavailable", reason: "database" });
});

test("an initial read creates the singleton generation at zero", () => {
  expect(readConfigGeneration()).toEqual({
    kind: "ready",
    generation: { value: 0 },
  });
});

test("a cooperating save bumps once and an unchanged save does not bump", () => {
  saveConfig(config());
  expect(readConfigGeneration()).toEqual({
    kind: "ready",
    generation: { value: 1 },
  });

  saveConfig(config());
  expect(readConfigGeneration()).toEqual({
    kind: "ready",
    generation: { value: 1 },
  });

  saveConfig(config(20200));
  expect(readConfigGeneration()).toEqual({
    kind: "ready",
    generation: { value: 2 },
  });
});

test("every cooperating writer bumps only when its committed bytes change", () => {
  saveConfig(config());

  expect(mutatePersistedConfig(persisted => {
    persisted.port = 20200;
    return { changed: true, value: persisted.port };
  })).toEqual({ status: "committed", value: 20200 });
  expect(readConfigGeneration()).toMatchObject({ generation: { value: 2 } });

  expect(mutatePersistedConfig(persisted => (
    { changed: false, value: persisted.port }
  ))).toEqual({ status: "unchanged", value: 20200 });
  expect(readConfigGeneration()).toMatchObject({ generation: { value: 2 } });

  saveConfigPreservingClaudeCode(config(30300));
  expect(readConfigGeneration()).toMatchObject({ generation: { value: 3 } });
  saveConfigPreservingClaudeCode(config(30300));
  expect(readConfigGeneration()).toMatchObject({ generation: { value: 3 } });
});

test("a stale expected value conflicts without changing the winner", () => {
  const admitted = readConfigGeneration();
  expect(admitted.kind).toBe("ready");
  if (admitted.kind !== "ready") throw new Error("generation unavailable");

  saveConfig(config());
  expect(bumpConfigGeneration(admitted.generation)).toEqual({
    kind: "conflict",
    current: { value: 1 },
  });
  expect(readConfigGeneration()).toEqual({
    kind: "ready",
    generation: { value: 1 },
  });
});

test("the generation guard joins the existing mutation transaction", () => {
  const result = withExpectedConfigGenerationSync({ value: 0 }, () => {
    saveConfig(config());
    return "committed-with-nested-writer";
  });

  expect(result).toEqual({
    kind: "matched",
    generation: { value: 0 },
    value: "committed-with-nested-writer",
  });
  expect(readConfigGeneration()).toEqual({
    kind: "ready",
    generation: { value: 1 },
  });
});

test("the generation guard never invokes its callback on a mismatch", () => {
  saveConfig(config());
  let callbackRuns = 0;

  expect(withExpectedConfigGenerationSync({ value: 0 }, () => {
    callbackRuns += 1;
    return "must-not-run";
  })).toEqual({ kind: "conflict", current: { value: 1 } });
  expect(callbackRuns).toBe(0);
});

test("two real processes racing one generation run exactly one callback", async () => {
  const releasePath = join(testRoot, "race-release");
  const ids = ["a", "b"] as const;
  const children = ids.map((id, index) => {
    const peerId = ids[1 - index]!;
    const payload = {
      id,
      readyPath: join(testRoot, `${id}.ready`),
      releasePath,
      callbackPath: join(testRoot, `${id}.callback`),
      outcomePath: join(testRoot, `${id}.outcome`),
      peerOutcomePath: join(testRoot, `${peerId}.outcome`),
    };
    return Bun.spawn([process.execPath, "--eval", generationGuardRaceScript], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        HOME: testRoot,
        OPENCODEX_HOME: testRoot,
        OCX_TEST_PAYLOAD: JSON.stringify(payload),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  });

  await waitForPaths([join(testRoot, "a.ready"), join(testRoot, "b.ready")]);
  writeFileSync(releasePath, "go");
  const results = await Promise.all(children.map(collectGuardRaceChild));

  expect(results.filter(result => result.kind === "matched")).toHaveLength(1);
  expect(results.filter(result => (
    result.kind === "conflict"
    || (result.kind === "unavailable" && result.reason === "busy")
  ))).toHaveLength(1);
  expect(["a", "b"].filter(id => existsSync(join(testRoot, `${id}.callback`)))).toHaveLength(1);
  expect(readConfigGeneration()).toEqual({
    kind: "ready",
    generation: { value: 0 },
  });
});

test("a throwing guard callback rolls back and releases the transaction", () => {
  expect(() => withExpectedConfigGenerationSync({ value: 0 }, () => {
    throw new Error("guard callback failed");
  })).toThrow("guard callback failed");

  expect(() => saveConfig(config())).not.toThrow();
  expect(readConfigGeneration()).toEqual({
    kind: "ready",
    generation: { value: 1 },
  });
});

test("busy and unavailable databases return typed outcomes instead of throwing", () => {
  expect(readConfigGeneration().kind).toBe("ready");
  const databasePath = join(testRoot, "config-mutation.sqlite");
  const holder = new Database(databasePath, { readwrite: true, create: false });
  holder.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  try {
    expect(readConfigGeneration()).toEqual({ kind: "unavailable", reason: "busy" });
    expect(bumpConfigGeneration({ value: 0 })).toEqual({ kind: "unavailable", reason: "busy" });
    expect(withExpectedConfigGenerationSync({ value: 0 }, () => "must-not-run"))
      .toEqual({ kind: "unavailable", reason: "busy" });
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
  }

  // A file used as the home can retain a failed-open handle on Windows and
  // prevent teardown. A directory at the database path is equally unavailable.
  const unavailableHome = join(testRoot, "unavailable-home");
  mkdirSync(join(unavailableHome, "config-mutation.sqlite"), { recursive: true });
  process.env.CODEX_HOME = unavailableHome;
  process.env.OPENCODEX_HOME = unavailableHome;
  expect(readConfigGeneration()).toEqual({ kind: "unavailable", reason: "database" });
  expect(bumpConfigGeneration({ value: 0 })).toEqual({ kind: "unavailable", reason: "database" });
  expect(withExpectedConfigGenerationSync({ value: 0 }, () => "must-not-run"))
    .toEqual({ kind: "unavailable", reason: "database" });
});
