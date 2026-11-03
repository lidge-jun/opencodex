/**
 * Escaping of literal service homes in each generated service definition. Every case pins a
 * home that carries a character the target syntax would otherwise rewrite.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as serviceState from "../../src/service/state";
import { buildPlist, buildUnit, buildWindowsServiceScript, expectedLaunchdCommand, installLaunchd, probeLaunchdLoadState, resolvedProxyEnv, runLaunchctl } from "../../src/service";
import { buildServiceShellCommand, resolveServiceListenPort } from "../../src/service/definition";

const previousOpenCodexHome = process.env.OPENCODEX_HOME;
beforeEach(() => {
  const sandbox = mkdtempSync(join(tmpdir(), "ocx-service-escaping-"));
  mkdirSync(join(sandbox, ".opencodex"), { recursive: true });
  process.env.OPENCODEX_HOME = join(sandbox, ".opencodex");
});
afterEach(() => {
  if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpenCodexHome;
});

function withHomes<T>(codexHome: string, opencodexHome: string, body: () => T): T {
  const codex = spyOn(serviceState, "currentCodexHome").mockImplementation(() => codexHome);
  const windowsCodex = spyOn(serviceState, "currentWindowsServiceCodexHome").mockImplementation(() => codexHome);
  const opencodex = spyOn(serviceState, "currentOpenCodexHome").mockImplementation(() => opencodexHome);
  try {
    return body();
  } finally {
    codex.mockRestore();
    windowsCodex.mockRestore();
    opencodex.mockRestore();
  }
}

/**
 * Decode one double-quoted ExecStart= word the way systemd does: C-style escapes and
 * quotes at parse time, "%%" from specifier resolution, and "$$" from variable expansion
 * at exec time. Any other "%" or "$" would be rewritten by systemd, so it fails here.
 */
function decodeSystemdExecWord(word: string): string {
  const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", "\\": "\\", '"': '"' };
  let out = "";
  for (let i = 0; i < word.length; i++) {
    const ch = word[i]!;
    const next = word[i + 1];
    if (ch === "\\") {
      if (next === undefined || !(next in escapes)) throw new Error("unsupported escape \\" + next);
      out += escapes[next];
      i++;
    } else if (ch === "%" || ch === "$") {
      if (next !== ch) throw new Error("systemd would expand " + ch + (next ?? ""));
      out += ch;
      i++;
    } else {
      out += ch;
    }
  }
  return out;
}

const PIN_END = "export CODEX_HOME OPENCODEX_HOME;";

describe("systemd unit escaping", () => {
  const codexHome = "/tmp/a${HOME}b $USER %h dir";
  const opencodexHome = "/tmp/o$$x %n\\q";

  test("ExecStart passes literal homes with $, ${VAR}, %h and spaces through to the shell", () => {
    const unit = withHomes(codexHome, opencodexHome, () => buildUnit([], { launcher: "/usr/local/bin/ocx" }));
    const execStart = /^ExecStart=(.*)$/m.exec(unit)?.[1] ?? "";
    const word = /^"\/bin\/sh" -lc "((?:[^"\\]|\\.)*)"$/.exec(execStart)?.[1];
    expect(word).toBeDefined();
    const command = decodeSystemdExecWord(word!);
    const pins = command.slice(0, command.indexOf(PIN_END) + PIN_END.length);
    const output = execFileSync("/bin/sh", ["-c", pins + ' printf "%s\\n%s\\n" "$CODEX_HOME" "$OPENCODEX_HOME"'], {
      env: { PATH: "/usr/bin:/bin", HOME: "/should-not-appear", USER: "nobody" },
      encoding: "utf8",
    });
    expect(output.split("\n").slice(0, 2)).toEqual([codexHome, opencodexHome]);
  });

  test("Environment= keeps $ literal and escapes only specifiers", () => {
    const unit = withHomes(codexHome, opencodexHome, () => buildUnit([], { launcher: "/usr/local/bin/ocx" }));
    // Environment= performs no variable expansion, so "$$" there would reach the proxy as two dollars.
    expect(unit).toContain('Environment="CODEX_HOME=/tmp/a${HOME}b $USER %%h dir"');
    expect(unit).toContain('Environment="OPENCODEX_HOME=/tmp/o$$x %%n\\\\q"');
  });
});

describe("launchd live-job comparison", () => {
  const homes = { codexHome: "/pinned/codex", opencodexHome: "/pinned/opencodex" };

  test("the expected command carries the pinned home assignments", () => {
    const command = expectedLaunchdCommand(14001, { state: null, entry: { bun: "/b/bun", cli: "/c/cli.ts" }, homes });
    expect(command).toBe("CODEX_HOME='/pinned/codex' OPENCODEX_HOME='/pinned/opencodex' " + PIN_END + " "
      + buildServiceShellCommand("/b/bun", "/c/cli.ts", 14001));
  });

  test("an upgraded plist with a live job from the older plist is reloaded, not a no-op", () => {
    const plistPath = join(mkdtempSync(join(tmpdir(), "ocx-launchd-escaping-")), "com.opencodex.proxy.plist");
    // Real directories: the install writes its state under the pinned OpenCodex home.
    const opencodexHome = process.env.OPENCODEX_HOME!;
    withHomes(join(opencodexHome, "..", "codex"), opencodexHome, () => {
      // The plist on disk already pins the homes; launchd still runs the pre-upgrade line.
      writeFileSync(plistPath, buildPlist(resolvedProxyEnv()), "utf8");
      const { bun, cli } = serviceState.cliEntry();
      const olderLine = buildServiceShellCommand(bun, cli, resolveServiceListenPort());
      const argv: string[][] = [];
      const launchctl = ((args: string[]) => {
        argv.push([...args]);
        if (args[0] === "print") return { ok: false, stdout: "", stderr: "Could not find service", status: 113 };
        return { ok: true, stdout: "", stderr: "", status: 0 };
      }) as typeof runLaunchctl;
      const printsOlderJob = ((args: string[]) => args[0] === "print"
        ? { ok: true, stdout: "arguments = {\n  /bin/sh\n  -lc\n  " + olderLine + "\n}", stderr: "", status: 0 }
        : launchctl(args)) as typeof runLaunchctl;
      let probes = 0;
      const probe = ((opts: Parameters<typeof probeLaunchdLoadState>[0]) => probes++ === 0
        ? probeLaunchdLoadState({ ...opts, launchctl: printsOlderJob })
        : { state: "loaded-current" as const, domain: "gui/501" }) as typeof probeLaunchdLoadState;

      const outcome = installLaunchd({ launchctl, plistPath, probe, sleepSync: () => {} });
      expect(outcome.reloaded).toBe(true);
      expect(argv.map(args => args[0])).toContain("bootstrap");
    });
  });
});

describe("Windows wrapper escaping", () => {
  test("quoted set values keep ^ and ! literal and double %", () => {
    const home = "C:\\Users\\a^b\\100%!x\\.codex";
    const script = withHomes(home, "C:\\Users\\a^b\\.opencodex", () => buildWindowsServiceScript());
    // Inside set "NAME=value" cmd reads ^ literally, so a doubled caret names another directory.
    expect(script).toContain('set "CODEX_HOME=C:\\Users\\a^b\\100%%!x\\.codex"');
    expect(script).toContain('set "OPENCODEX_HOME=C:\\Users\\a^b\\.opencodex"');
    expect(script).not.toContain("a^^b");
    // "!" stays literal only while delayed expansion is off, before any assignment.
    expect(script.indexOf("setlocal EnableExtensions DisableDelayedExpansion")).toBeLessThan(script.indexOf('set "CODEX_HOME='));
  });
});
