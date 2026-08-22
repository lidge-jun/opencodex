import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { resolveCodexHistoryJobTarget } from "../src/codex/history-job";
import { historyBackupPathFor } from "../src/codex/history-provider";
import { resolveCodexLogsDbPath, resolveCodexSqliteHome, resolveCodexStateDbPath } from "../src/codex/paths";

const originalCodexHome = process.env.CODEX_HOME;
const originalSqliteHome = process.env.CODEX_SQLITE_HOME;
const roots: string[] = [];

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (originalSqliteHome === undefined) delete process.env.CODEX_SQLITE_HOME;
  else process.env.CODEX_SQLITE_HOME = originalSqliteHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codex SQLite home resolution", () => {
  test("uses config, environment, and Codex home precedence", () => {
    const env = { CODEX_SQLITE_HOME: "/state/from-env" };
    expect(resolveCodexSqliteHome({
      codexHome: "/state/codex-home",
      env,
      readConfig: () => 'sqlite_home = "/state/from-config"\n',
    })).toBe(resolve("/state/from-config"));

    expect(resolveCodexSqliteHome({
      codexHome: "/state/codex-home",
      env,
      readConfig: () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    })).toBe(resolve("/state/from-env"));

    expect(resolveCodexSqliteHome({
      codexHome: "/state/codex-home",
      env: {},
      readConfig: () => "",
    })).toBe("/state/codex-home");
  });

  test("fails closed when the authoritative config cannot be read", () => {
    const readError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    expect(() => resolveCodexSqliteHome({
      codexHome: "/state/codex-home",
      env: { CODEX_SQLITE_HOME: "/state/from-env" },
      readConfig: () => { throw readError; },
    })).toThrow("Codex config could not be read while resolving sqlite_home");
  });

  test("fails closed when sqlite_home is present but invalid", () => {
    for (const config of [
      "sqlite_home = 123\n",
      "sqlite_home = [\"/state/a\"]\n",
      "sqlite_home = \"\"\n",
      "sqlite_home = \"unterminated\n",
    ]) {
      expect(() => resolveCodexSqliteHome({
        codexHome: "/state/codex-home",
        env: { CODEX_SQLITE_HOME: "/state/from-env" },
        readConfig: () => config,
      })).toThrow("Codex config has an invalid sqlite_home setting");
    }
  });

  test("accepts a valid quoted root sqlite_home key", () => {
    expect(resolveCodexSqliteHome({
      codexHome: "/state/codex-home",
      env: { CODEX_SQLITE_HOME: "/state/from-env" },
      readConfig: () => '"sqlite_home" = "/state/from-quoted-key"\n',
    })).toBe(resolve("/state/from-quoted-key"));
  });

  test("resolves relative SQLite homes from the current working directory", () => {
    const deps = {
      codexHome: "/state/codex-home",
      env: { CODEX_SQLITE_HOME: "../sqlite" },
      cwd: () => "/work/project",
      readConfig: () => "",
    };
    // Spelled through `resolve`/`join` like every other case in this file: the
    // assertion is that a relative setting is anchored to the cwd, not that the
    // result is POSIX-shaped. Hardcoding "/work/sqlite" made this the one case
    // that failed on Windows, where the same resolution yields "C:\\work\\sqlite".
    const expectedHome = resolve("/work/sqlite");
    expect(resolveCodexSqliteHome(deps)).toBe(expectedHome);
    expect(resolveCodexStateDbPath(deps)).toBe(join(expectedHome, "state_5.sqlite"));
    expect(resolveCodexLogsDbPath(deps)).toBe(join(expectedHome, "logs_2.sqlite"));
  });

  test("history jobs resolve the selected database and backup identity at call time", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-sqlite-home-"));
    roots.push(root);
    const codexHome = join(root, "codex");
    const envSqliteHome = join(root, "env-sqlite");
    const configSqliteHome = join(root, "config-sqlite");
    mkdirSync(codexHome);
    mkdirSync(envSqliteHome);
    mkdirSync(configSqliteHome);
    process.env.CODEX_HOME = codexHome;
    process.env.CODEX_SQLITE_HOME = envSqliteHome;
    writeFileSync(join(codexHome, "config.toml"), `sqlite_home = ${JSON.stringify(configSqliteHome)}\n`);

    const configured = resolveCodexHistoryJobTarget();
    expect(configured.canonicalStateDbPath).toBe(join(configSqliteHome, "state_5.sqlite"));
    expect(configured.canonicalBackupPath).toBe(historyBackupPathFor(configured.canonicalStateDbPath));

    unlinkSync(join(codexHome, "config.toml"));
    const fromEnv = resolveCodexHistoryJobTarget();
    expect(fromEnv.canonicalStateDbPath).toBe(join(envSqliteHome, "state_5.sqlite"));
    expect(fromEnv.canonicalBackupPath).toBe(historyBackupPathFor(fromEnv.canonicalStateDbPath));
  });
});
