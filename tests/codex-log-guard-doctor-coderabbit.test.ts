import { describe, expect, test } from "bun:test";

import { formatCodexLogGuardDoctor } from "../src/cli/codex-log-guard-doctor";
import type { CodexLogGuardStatus } from "../src/codex/log-guard/protection";

function status(schema: CodexLogGuardStatus["schema"]): CodexLogGuardStatus {
  const supported = schema.state === "compatible";
  const reason = schema.state === "compatible" ? undefined : schema.reason;
  return {
    generatedAt: 1,
    codexHome: "/private/codex",
    sqliteHome: "/private/sqlite",
    databasePath: "/private/sqlite/logs_2.sqlite",
    externalSqliteHome: true,
    snapshot: "checkpointed",
    files: { databaseBytes: 0, walBytes: 0, shmBytes: 0 },
    schema,
    capabilities: {
      inspection: { state: "supported" },
      protection: supported ? { state: "supported" } : { state: "unsupported", reason: reason! },
      reclaim: supported ? { state: "supported" } : { state: "unsupported", reason: reason! },
    },
    metrics: null,
    protection: {
      desiredMode: "compat",
      observedMode: "off",
      state: supported ? "drifted" : "unsupported",
    },
  };
}

describe("CodeRabbit doctor regressions", () => {
  test("missing database still reports protection unavailable", () => {
    const text = formatCodexLogGuardDoctor(status({ state: "missing", reason: "database_missing" })).join("\n");
    expect(text).toContain("protection unavailable");
    expect(text).toContain("logs_2.sqlite is not present");
  });

  test("unreadable database still reports protection unavailable", () => {
    const text = formatCodexLogGuardDoctor(status({ state: "unreadable", reason: "database_unreadable" })).join("\n");
    expect(text).toContain("protection unavailable");
    expect(text).toContain("logs_2.sqlite is unreadable");
  });
});
