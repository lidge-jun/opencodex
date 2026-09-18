import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertServiceEnvironmentMatchesInstall, parseServiceInstallState } from "../../src/service";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const TEST_DIR = join(import.meta.dir, ".tmp-service-sqlite-home-test");
const previousOpenCodexHome = process.env.OPENCODEX_HOME;
const previousCodexHome = process.env.CODEX_HOME;
const previousCodexSqliteHome = process.env.CODEX_SQLITE_HOME;

afterEach(() => {
  if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpenCodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousCodexSqliteHome === undefined) delete process.env.CODEX_SQLITE_HOME;
  else process.env.CODEX_SQLITE_HOME = previousCodexSqliteHome;
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
});

function writeInstallState(state: Record<string, unknown>): void {
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  writeFileSync(join(TEST_DIR, "service-state.json"), JSON.stringify(state) + "\n");
}

describe("service install state Codex SQLite home binding", () => {
  test("rejects lifecycle operations against a different Codex SQLite home than service install", () => {
    process.env.CODEX_HOME = join(TEST_DIR, "codex-home");
    delete process.env.CODEX_SQLITE_HOME;
    writeInstallState({
      version: 2,
      codexHome: process.env.CODEX_HOME,
      codexSqliteHome: join(TEST_DIR, "installed-sqlite-home"),
      opencodexHome: TEST_DIR,
      backend: "scheduler",
    });

    expect(() => assertServiceEnvironmentMatchesInstall()).toThrow("Codex SQLite home");
  });

  test("accepts lifecycle operations when the recorded Codex SQLite home still matches", () => {
    const codexHome = join(TEST_DIR, "codex-home");
    process.env.CODEX_HOME = codexHome;
    delete process.env.CODEX_SQLITE_HOME;
    writeInstallState({
      version: 2,
      codexHome,
      // With no sqlite_home config and no CODEX_SQLITE_HOME the effective home is codexHome.
      codexSqliteHome: codexHome,
      opencodexHome: TEST_DIR,
      backend: "scheduler",
    });

    expect(() => assertServiceEnvironmentMatchesInstall()).not.toThrow();
  });

  test("accepts a matching CODEX_SQLITE_HOME override and rejects a divergent one", () => {
    const codexHome = join(TEST_DIR, "codex-home");
    const sqliteHome = join(TEST_DIR, "sqlite-home");
    process.env.CODEX_HOME = codexHome;
    process.env.CODEX_SQLITE_HOME = sqliteHome;
    writeInstallState({
      version: 2,
      codexHome,
      codexSqliteHome: sqliteHome,
      opencodexHome: TEST_DIR,
      backend: "scheduler",
    });
    expect(() => assertServiceEnvironmentMatchesInstall()).not.toThrow();

    process.env.CODEX_SQLITE_HOME = join(TEST_DIR, "other-sqlite-home");
    expect(() => assertServiceEnvironmentMatchesInstall()).toThrow("Codex SQLite home");
  });

  test("parses codexSqliteHome and rejects an empty value", () => {
    const valid = {
      version: 2,
      codexHome: "C:\\codex",
      opencodexHome: "C:\\opencodex",
      backend: "scheduler",
    };
    expect(parseServiceInstallState({ ...valid, codexSqliteHome: "C:\\codex-sqlite" })?.codexSqliteHome).toBe("C:\\codex-sqlite");
    expect(parseServiceInstallState({ ...valid, codexSqliteHome: "" })).toBeNull();
  });
});
