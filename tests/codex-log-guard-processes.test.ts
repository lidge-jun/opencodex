import { describe, expect, test } from "bun:test";

import {
  isCodexWriterCommandLine,
  listRunningCodexProcesses,
} from "../src/codex/log-guard/processes";

describe("Codex Log Guard process gate", () => {
  test("matches official Codex writer command lines without broad codex substring matching", () => {
    expect(isCodexWriterCommandLine("codex")).toBe(true);
    expect(isCodexWriterCommandLine("/usr/local/bin/codex exec --json")).toBe(true);
    expect(isCodexWriterCommandLine("codex --model gpt-5 app-server")).toBe(true);
    expect(isCodexWriterCommandLine("/opt/codex-x86_64-unknown-linux-musl exec")).toBe(true);
    expect(isCodexWriterCommandLine("codex-code-mode-host")).toBe(true);
    expect(isCodexWriterCommandLine("node /opt/codex-code-mode-host")).toBe(true);
    expect(isCodexWriterCommandLine("/opt/Example Tools/codex exec --json", "/opt/Example Tools/codex")).toBe(true);
    expect(isCodexWriterCommandLine("node /opt/Example Tools/codex-code-mode-host")).toBe(false);
    expect(isCodexWriterCommandLine("node worker.js codex exec")).toBe(false);
    expect(isCodexWriterCommandLine("node worker.js codex-code-mode-host")).toBe(false);
    expect(isCodexWriterCommandLine("bun /repo/opencodex/src/cli/index.ts storage codex-logs protect")).toBe(false);
    expect(isCodexWriterCommandLine("hermes-codex-bridge-mcp")).toBe(false);
  });

  test("fails closed when enumeration throws", () => {
    expect(listRunningCodexProcesses({
      platform: "linux",
      listSnapshots: () => { throw new Error("procfs unavailable"); },
    })).toEqual({ state: "unknown", reason: "enumeration_failed" });
  });

  test("reports PID 1 when it is an official Codex writer", () => {
    expect(listRunningCodexProcesses({
      platform: "linux",
      listSnapshots: () => [{ pid: 1, commandLine: "codex exec --json" }],
    })).toEqual({
      state: "ok",
      processes: [{ pid: 1, commandLine: "codex exec --json" }],
    });
  });

  test("deduplicates matching current-user writer processes", () => {
    const result = listRunningCodexProcesses({
      platform: "linux",
      listSnapshots: () => [
        { pid: 10, commandLine: "codex exec" },
        { pid: 10, commandLine: "codex exec" },
        { pid: 11, commandLine: "node worker.js codex exec" },
        { pid: 12, commandLine: "codex app-server" },
      ],
    });
    expect(result).toEqual({
      state: "ok",
      processes: [
        { pid: 10, commandLine: "codex exec" },
        { pid: 12, commandLine: "codex app-server" },
      ],
    });
  });
});
