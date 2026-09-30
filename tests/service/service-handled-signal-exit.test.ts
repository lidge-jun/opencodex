import { describe, expect, test } from "bun:test";
import { constants as osConstants } from "node:os";
import { readFileSync } from "node:fs";
import { handledSignalExitCode } from "../../src/lib/handled-signal-exit";
import { repoPath } from "../helpers/repo-root";

describe("handled signal exit code", () => {
  test("a launchd-managed job exits unsuccessfully on a handled signal so KeepAlive restarts it", () => {
    const managed = { OCX_SERVICE: "1", OCX_SERVICE_MANAGED: "1" };
    expect(handledSignalExitCode("SIGTERM", managed, "darwin")).toBe(128 + osConstants.signals.SIGTERM);
    expect(handledSignalExitCode("SIGINT", managed, "darwin")).toBe(128 + osConstants.signals.SIGINT);
    expect(handledSignalExitCode("SIGHUP", managed, "darwin")).toBe(128 + osConstants.signals.SIGHUP);
    expect(handledSignalExitCode(undefined, managed, "darwin")).toBe(128 + osConstants.signals.SIGTERM);
  });

  test("every other run keeps its clean exit", () => {
    expect(handledSignalExitCode("SIGTERM", { OCX_SERVICE: "1", OCX_SERVICE_MANAGED: "1" }, "linux")).toBe(0);
    expect(handledSignalExitCode("SIGTERM", { OCX_SERVICE: "1", OCX_SERVICE_MANAGED: "1" }, "win32")).toBe(0);
    // A companion or foreground proxy carries at most OCX_SERVICE=1.
    expect(handledSignalExitCode("SIGTERM", { OCX_SERVICE: "1" }, "darwin")).toBe(0);
    expect(handledSignalExitCode("SIGTERM", {}, "darwin")).toBe(0);
  });

  test("both runtimes route their signal shutdown through it and the plist stays failure-only", () => {
    const cli = readFileSync(repoPath("src/cli/index.ts"), "utf8");
    expect(cli).toContain("process.exit(restored && shutdownSucceeded ? handledSignalExitCode(signal) : 1);");
    const client = readFileSync(repoPath("src/client/runtime.ts"), "utf8");
    expect(client).toContain("process.exit(handledSignalExitCode(signal));");
    const launchd = readFileSync(repoPath("src/service/launchd.ts"), "utf8");
    expect(launchd).toContain("<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>");
  });
});
