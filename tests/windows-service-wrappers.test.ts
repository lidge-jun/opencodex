/**
 * The scheduler-wrapper killer must terminate THIS installation's wrappers and
 * nothing else.
 *
 * Two copies of this logic existed. src/service.ts matched canonical full paths
 * as complete command-line tokens; src/update/job.ts matched the bare filenames
 * with -like '*name*'. On a machine with two OpenCodex homes under one account,
 * a dashboard update for home A could force-terminate home B's wrapper, and any
 * unrelated process whose command line contained either filename matched too.
 *
 * The killer spawns PowerShell and reports nothing, so the generated script is
 * the only observable surface. Asserting that the script merely *contains*
 * IndexOf/before/after would pass for a broken matcher that kept those tokens,
 * so these cases port the rule to JS and run real command lines through it. The
 * port is pinned to the shipped script by `matchRuleMatchesScript` below: if
 * the PowerShell changes shape, that test fails and this file must be revisited.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { windowsWrapperKillScript } from "../src/lib/windows-service-wrappers";

const read = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8");

const HOME_A = "C:\\Users\\ocx\\.opencodex";
const HOME_B = "C:\\Users\\ocx\\other-home\\.opencodex";
const script = (home: string) => join(home, "opencodex-service.cmd");
const launcher = (home: string) => join(home, "opencodex-service-launcher.vbs");

/**
 * The shipped rule, in JS: find the pattern case-insensitively, then require the
 * characters on both sides to be whitespace or a quote (start/end of the line
 * counts as whitespace). Mirrors the PowerShell at
 * src/lib/windows-service-wrappers.ts.
 */
function killsCommandLine(commandLine: string, patterns: readonly string[]): boolean {
  const boundary = /[\s"']/;
  for (const pattern of patterns) {
    const at = commandLine.toLowerCase().indexOf(pattern.toLowerCase());
    if (at < 0) continue;
    const before = at > 0 ? commandLine[at - 1]! : " ";
    const end = at + pattern.length;
    const after = end < commandLine.length ? commandLine[end]! : " ";
    if (boundary.test(before) && boundary.test(after)) return true;
  }
  return false;
}

const patterns = [script(HOME_A), launcher(HOME_A)];

describe("which command lines the wrapper killer stops", () => {
  test("this installation's own wrappers are killed", () => {
    expect(killsCommandLine(`cmd.exe /c "${script(HOME_A)}"`, patterns)).toBe(true);
    expect(killsCommandLine(`wscript.exe "${launcher(HOME_A)}" //B`, patterns)).toBe(true);
    // Unquoted, as Task Scheduler may present it.
    expect(killsCommandLine(`cmd.exe /c ${script(HOME_A)}`, patterns)).toBe(true);
  });

  test("another OpenCodex home under the same account survives", () => {
    // The defect this replaces: -like '*opencodex-service.cmd*' matched here.
    expect(killsCommandLine(`cmd.exe /c "${script(HOME_B)}"`, patterns)).toBe(false);
    expect(killsCommandLine(`wscript.exe "${launcher(HOME_B)}" //B`, patterns)).toBe(false);
  });

  test("a longer path that merely ends with our path is not a token", () => {
    expect(killsCommandLine(`cmd.exe /c "C:\\backup\\${script(HOME_A)}"`, patterns)).toBe(false);
  });

  test("a path that merely starts with ours is not a token", () => {
    expect(killsCommandLine(`cmd.exe /c "${script(HOME_A)}.bak"`, patterns)).toBe(false);
  });

  test("an unrelated process merely naming the file is not killed", () => {
    expect(killsCommandLine("notepad.exe opencodex-service.cmd", patterns)).toBe(false);
    expect(killsCommandLine('findstr /c:"opencodex-service-launcher.vbs" log.txt', patterns)).toBe(false);
  });

  test("matching is case-insensitive, as Windows paths are", () => {
    expect(killsCommandLine(`cmd.exe /c "${script(HOME_A).toUpperCase()}"`, patterns)).toBe(true);
  });
});

describe("the generated script still implements that rule", () => {
  test("matchRuleMatchesScript", () => {
    // Pins the JS port above to the shipped PowerShell. If the script stops
    // using ordinal-insensitive IndexOf plus both boundary checks, the port is
    // no longer a faithful model and the cases above prove nothing.
    const ps = windowsWrapperKillScript(patterns);
    expect(ps).toContain("IndexOf($p, [System.StringComparison]::OrdinalIgnoreCase)");
    expect(ps).toContain("$before = if ($i -gt 0)");
    expect(ps).toContain("$after = if ($end -lt $c.Length)");
    expect(ps).toContain("if ($before -match");
    expect(ps).toContain("-and $after -match");
    expect(ps).not.toContain("-like");
  });

  test("the script carries this home's canonical paths, not bare filenames", () => {
    const ps = windowsWrapperKillScript(patterns);
    expect(ps).toContain(script(HOME_A));
    expect(ps).toContain(launcher(HOME_A));
    expect(ps).not.toContain(script(HOME_B));
    expect(ps).not.toContain("@('opencodex-service.cmd'");
  });

  test("the caller's own process is always excluded", () => {
    expect(windowsWrapperKillScript(patterns)).toContain("$_.ProcessId -eq $PID");
  });

  test("a path containing a quote is escaped, not injected", () => {
    const odd = "C:\\Users\\o'brien\\.opencodex\\opencodex-service.cmd";
    expect(windowsWrapperKillScript([odd])).toContain("C:\\Users\\o''brien\\.opencodex\\opencodex-service.cmd");
  });
});

describe("both teardown paths use the shared killer", () => {
  test("neither file keeps a private matcher", () => {
    for (const rel of ["src/service.ts", "src/update/job.ts"]) {
      const src = read(rel);
      expect(src).toContain("killWindowsSchedulerWrappers");
      expect(src).not.toContain("-like ('*' + $p + '*')");
      expect(src).not.toContain("$pats = @('opencodex-service.cmd'");
    }
  });
});
