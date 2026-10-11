import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";
import { linuxServiceBootHint } from "../../src/service/linux-linger";

const source = readFileSync(repoPath("src/service/systemd.ts"), "utf8");

describe("systemd install cleanup status hardening", () => {
  test("only treats literal not-found as confirmed unit absence", () => {
    expect(source).toContain('if (!loadState) throw new Error("systemd service status could not be verified.");');
    expect(source).toContain('return loadState === "not-found" ? null : loadState;');
    expect(source).not.toContain('return !loadState || loadState === "not-found" ? null : loadState;');
  });
});

describe("Linux service boot guidance", () => {
  test("enabled lingering avoids the repeated enable hint and uses a bounded read-only probe", () => {
    const calls: unknown[][] = [];
    const hint = linuxServiceBootHint({ user: () => "fixture-user", run: ((...args: unknown[]) => {
      calls.push(args); return "Linger=yes\n";
    }) as never });
    expect(hint).toContain("already enabled");
    expect(hint).not.toContain("enable-linger");
    expect(calls).toEqual([["loginctl", ["show-user", "fixture-user", "-p", "Linger"], {
      encoding: "utf8", timeout: 750, maxBuffer: 16 * 1024, stdio: ["ignore", "pipe", "pipe"],
    }]]);
  });

  test("disabled lingering suggests enable-linger without claiming diagnosis failed", () => {
    const hint = linuxServiceBootHint({ user: () => "fixture-user", run: (() => "Linger=no\n") as never });
    expect(hint).toContain("loginctl enable-linger $USER");
    expect(hint).not.toContain("could not be verified");
  });

  test("missing tooling, timeouts, denied probes and malformed output explain uncertainty", () => {
    for (const output of ["", "yes", "Linger=maybe", "Linger=yes\nLinger=no"]) {
      expect(linuxServiceBootHint({ user: () => "fixture-user", run: (() => output) as never }))
        .toContain("could not be verified");
    }
    for (const code of ["ENOENT", "ETIMEDOUT", "EACCES"]) {
      const hint = linuxServiceBootHint({ user: () => "fixture-user", run: (() => {
        throw Object.assign(new Error("probe unavailable"), { code });
      }) as never });
      expect(hint).toContain("could not be verified");
      expect(hint).toContain("if disabled");
      expect(hint).toContain("loginctl enable-linger $USER");
    }
    expect(linuxServiceBootHint({ user: () => { throw new Error("unknown user"); },
      run: (() => { throw new Error("must not run"); }) as never })).toContain("could not be verified");
  });

  test("install uses the diagnostic hint instead of an unconditional enable request", () => {
    const cli = readFileSync(repoPath("src/service/cli.ts"), "utf8");
    expect(cli).toContain('if (process.platform === "linux") console.log(linuxServiceBootHint());');
    expect(cli).not.toContain('console.log("   For auto-start on boot: loginctl enable-linger $USER")');
  });
});
