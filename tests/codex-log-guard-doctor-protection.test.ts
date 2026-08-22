import { describe, expect, test } from "bun:test";

import { formatCodexLogGuardDoctor, printCodexLogGuardDoctor } from "../src/cli/codex-log-guard-doctor";
import type { CodexLogGuardStatus } from "../src/codex/log-guard/protection";

function status(state: CodexLogGuardStatus["protection"]): CodexLogGuardStatus {
  return {
    generatedAt: 1,
    externalSqliteHome: false,
    snapshot: "checkpointed",
    files: { databaseBytes: 4096, walBytes: 0, shmBytes: 0 },
    schema: { state: "compatible" },
    capabilities: {
      inspection: { state: "supported" },
      protection: { state: "supported" },
      reclaim: { state: "supported" },
    },
    metrics: null,
    protection: state,
  };
}

describe("Codex Log Guard doctor protection output", () => {
  test("reports active compat protection without attempting repair", () => {
    const text = formatCodexLogGuardDoctor(status({
      desiredMode: "compat",
      observedMode: "compat",
      state: "active",
    })).join("\n");
    expect(text).toContain("protection active (compat)");
    expect(text).not.toContain("Repairing");
  });

  test("warns on drift and tells the user the explicit repair command", () => {
    const text = formatCodexLogGuardDoctor(status({
      desiredMode: "compat",
      observedMode: "off",
      state: "drifted",
    })).join("\n");
    expect(text).toContain("protection drifted");
    expect(text).toContain("ocx storage codex-logs repair");
  });

  test("reports disabled protection as informational", () => {
    const text = formatCodexLogGuardDoctor(status({
      desiredMode: "off",
      observedMode: "off",
      state: "off",
    })).join("\n");
    expect(text).toContain("protection off");
  });

  test("redacts injected inspector failures without falling through to the real Codex home", () => {
    const lines: string[] = [];
    printCodexLogGuardDoctor({
      inspect: () => { throw new Error("synthetic-inspector-failure"); },
      log: line => lines.push(line),
    });
    const text = lines.join("\n");
    expect(text).toContain("inspection unavailable");
    expect(text).not.toContain("synthetic-inspector-failure");
  });
});
