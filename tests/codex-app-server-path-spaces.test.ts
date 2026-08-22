import { describe, expect, test } from "bun:test";

import {
  isCodexAppServerCommandLine,
  listCodexAppServerProcesses,
} from "../src/codex/app-server-processes";

describe("Codex app-server flattened command lines", () => {
  test("matches unquoted official executable paths containing spaces", () => {
    expect(isCodexAppServerCommandLine("/opt/Example Tools/codex app-server", "/opt/Example Tools/codex")).toBe(true);
    expect(isCodexAppServerCommandLine("node /opt/Example Tools/codex-code-mode-host --session 1")).toBe(false);
    expect(isCodexAppServerCommandLine("node worker.js codex app-server")).toBe(false);
    expect(isCodexAppServerCommandLine("node worker.js codex-code-mode-host")).toBe(false);
  });

  test("does not discard PID 1 injected app-server snapshots", () => {
    expect(listCodexAppServerProcesses({
      listSnapshots: () => [{ pid: 1, commandLine: "codex app-server" }],
    })).toEqual([{ pid: 1, commandLine: "codex app-server" }]);
  });
});
