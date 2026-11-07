/**
 * Escaping of literal service homes in each generated service definition. Every case pins a
 * home that carries a character the target syntax would otherwise rewrite.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as serviceState from "../../src/service/state";
import { buildPlist, buildUnit, buildWindowsServiceScript, expectedLaunchdCommand, installLaunchd, probeLaunchdLoadState, restartLaunchdJob, resolvedProxyEnv, runLaunchctl } from "../../src/service";
import { buildServiceShellCommand, resolveServiceListenPort } from "../../src/service/definition";
import { parseSystemdUnitHomes } from "../../src/service/systemd-env";

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
    expect(pins).toBe(`CODEX_HOME='${codexHome}' OPENCODEX_HOME='${opencodexHome}' ${PIN_END}`);
    if (process.platform !== "win32") {
      const output = execFileSync("/bin/sh", ["-c", pins + ' printf "%s\\n%s\\n" "$CODEX_HOME" "$OPENCODEX_HOME"'], {
        env: { PATH: "/usr/bin:/bin", HOME: "/should-not-appear", USER: "nobody" },
        encoding: "utf8",
      });
      expect(output.split("\n").slice(0, 2)).toEqual([codexHome, opencodexHome]);
    }
  });

  test("Environment= keeps $ literal and escapes only specifiers", () => {
    const unit = withHomes(codexHome, opencodexHome, () => buildUnit([], { launcher: "/usr/local/bin/ocx" }));
    // Environment= performs no variable expansion, so "$$" there would reach the proxy as two dollars.
    expect(unit).toContain('Environment="CODEX_HOME=/tmp/a${HOME}b $USER %%h dir"');
    expect(unit).toContain('Environment="OPENCODEX_HOME=/tmp/o$$x %%n\\\\q"');
  });

  test("a unit whose values carry tab, CR and LF reads back through the ownership parser", () => {
    // The ownership probe validates every Environment= line, so one value the writer escapes but
    // the parser cannot decode would make the whole unit unknown and fence native-main admission.
    const tabbedCodexHome = "/tmp/codex\thome\rx";
    const tabbedOpenCodexHome = "/tmp/open\ncodex %h";
    const unit = withHomes(tabbedCodexHome, tabbedOpenCodexHome, () => buildUnit(
      [{ name: "HTTPS_PROXY", value: "http://proxy.test:8080/\tpath" }],
      { launcher: "/usr/local/bin/ocx" },
    ));
    expect(unit).toContain('Environment="HTTPS_PROXY=http://proxy.test:8080/\\tpath"');
    expect(parseSystemdUnitHomes(unit)).toEqual({
      kind: "parsed",
      homes: { codexHome: tabbedCodexHome, opencodexHome: tabbedOpenCodexHome },
    });
  });
});

describe("launchd live-job comparison", () => {
  const homes = { codexHome: "/pinned/codex", opencodexHome: "/pinned/opencodex" };

  test("the expected command carries the pinned home assignments and that home's token file", () => {
    const command = expectedLaunchdCommand(14001, { state: null, entry: { bun: "/b/bun", cli: "/c/cli.ts" }, homes });
    expect(command).toBe("CODEX_HOME='/pinned/codex' OPENCODEX_HOME='/pinned/opencodex' " + PIN_END + " "
      + buildServiceShellCommand("/b/bun", "/c/cli.ts", 14001, join(homes.opencodexHome, "service-api-token")));
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

/**
 * The values a plist parser returns. plutil keeps a literal CR, but a conforming XML 1.0
 * parser (Python's plistlib, for one) normalizes it to LF, so every value is checked with a
 * minimal XML reader that applies that line-end rule and the predefined and numeric entity
 * references, and also with plutil when the host has it.
 */
type PlistParser = "xml" | "plutil";
const PLIST_PARSERS: PlistParser[] = existsSync("/usr/bin/plutil") ? ["xml", "plutil"] : ["xml"];

function parsePlistStrings(plist: string, parser: PlistParser = "xml"): { env: Record<string, string>; args: string[] } {
  if (parser === "plutil") {
    const file = join(mkdtempSync(join(tmpdir(), "ocx-plist-parse-")), "job.plist");
    writeFileSync(file, plist, "utf8");
    const parsed = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));
    return { env: parsed.EnvironmentVariables, args: parsed.ProgramArguments };
  }
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  const text = (raw: string): string => raw.replace(/\r\n?/g, "\n").replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (_m, ref: string) =>
    ref.startsWith("#x") ? String.fromCodePoint(parseInt(ref.slice(2), 16))
      : ref.startsWith("#") ? String.fromCodePoint(Number(ref.slice(1)))
        : named[ref]!);
  const envBlock = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(plist)?.[1] ?? "";
  const env = Object.fromEntries([...envBlock.matchAll(/<key>([^<]*)<\/key><string>([^<]*)<\/string>/g)].map(m => [text(m[1]!), text(m[2]!)]));
  const argBlock = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1] ?? "";
  return { env, args: [...argBlock.matchAll(/<string>([^<]*)<\/string>/g)].map(m => text(m[1]!)) };
}

describe("launchd plist string encoding", () => {
  test("homes and proxy values with CR, tab, LF and XML punctuation parse back unchanged", () => {
    const codexHome = "/tmp/a\rb";
    const opencodexHome = "/tmp/o\tp\nq & <r> \"s\" 't'";
    const proxyValue = "http://proxy\r\n.example:8080/?a=1&b=<2>";
    const plist = withHomes(codexHome, opencodexHome, () => buildPlist([{ name: "HTTPS_PROXY", value: proxyValue }]));
    for (const parser of PLIST_PARSERS) {
      const { env, args } = parsePlistStrings(plist, parser);
      expect({ parser, env: [env.CODEX_HOME, env.OPENCODEX_HOME, env.HTTPS_PROXY] })
        .toEqual({ parser, env: [codexHome, opencodexHome, proxyValue] });
      // The exec line keeps the same homes once launchd hands it to /bin/sh.
      const pins = args[2]!.slice(0, args[2]!.indexOf(PIN_END) + PIN_END.length);
      const quotedOpenCodexHome = opencodexHome.replace(/'/g, "'\\''");
      expect(pins).toBe(`CODEX_HOME='${codexHome}' OPENCODEX_HOME='${quotedOpenCodexHome}' ${PIN_END}`);
      if (process.platform !== "win32") {
        const output = execFileSync("/bin/sh", ["-c", pins + ' printf "%s\\0%s" "$CODEX_HOME" "$OPENCODEX_HOME"'], { encoding: "utf8" });
        expect({ parser, homes: output.split("\0") }).toEqual({ parser, homes: [codexHome, opencodexHome] });
      }
    }
  });

  test("a value XML 1.0 cannot carry is refused by name", () => {
    for (const bad of ["/tmp/a\u0001b", "/tmp/a\u000bb", "/tmp/a\ufffeb", "/tmp/a\ud800b"]) {
      expect(() => withHomes(bad, "/tmp/o", () => buildPlist([]))).toThrow(/CODEX_HOME.*XML/);
    }
    expect(() => withHomes("/tmp/c", "/tmp/o", () => buildPlist([{ name: "HTTPS_PROXY", value: "secret\u001fvalue" }])))
      .toThrow(/HTTPS_PROXY/);
    expect(() => withHomes("/tmp/c", "/tmp/o", () => buildPlist([{ name: "HTTPS_PROXY", value: "secret\u001fvalue" }])))
      .not.toThrow(/secret/);
    // A valid surrogate pair is an ordinary character.
    expect(() => withHomes("/tmp/\u{1F600}", "/tmp/o", () => buildPlist([]))).not.toThrow();
  });
});

describe("launchd status from a shell with other homes", () => {
  /**
   * Run with both homes really exported, as a shell would: OPENCODEX_HOME also moves the
   * service token file, which the home resolvers alone do not.
   */
  function withShellHomes<T>(codexHome: string, opencodexHome: string, body: () => T): T {
    const previous = { codex: process.env.CODEX_HOME, opencodex: process.env.OPENCODEX_HOME };
    process.env.CODEX_HOME = codexHome;
    process.env.OPENCODEX_HOME = opencodexHome;
    try {
      return withHomes(codexHome, opencodexHome, body);
    } finally {
      if (previous.codex === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous.codex;
      process.env.OPENCODEX_HOME = previous.opencodex;
    }
  }

  test("a job matching the installed plist reads as current, not stale", () => {
    const installedCodex = "/installed/codex & home";
    const installedOpencodex = "/installed/opencodex";
    const plist = withShellHomes(installedCodex, installedOpencodex, () => buildPlist([]));
    const liveCommand = parsePlistStrings(plist).args[2]!;
    expect(liveCommand).toContain(`'${join(installedOpencodex, "service-api-token")}'`);
    const launchdPath = serviceState.plistPath();
    const original = fs.readFileSync;
    const read = spyOn(fs, "readFileSync").mockImplementation(((path: any, ...args: any[]) =>
      path === launchdPath ? plist : original(path, ...args)) as typeof fs.readFileSync);
    try {
      // The status shell exports different homes; only the plist on disk describes the job.
      const verdict = withShellHomes("/status-shell/codex", "/status-shell/opencodex", () => probeLaunchdLoadState({
        uid: 501,
        launchctl: () => ({ ok: true, stdout: "arguments = {\n  /bin/sh\n  -lc\n  " + liveCommand + "\n}", stderr: "", status: 0 }),
      }));
      expect(verdict).toEqual({ state: "loaded-current", domain: "gui/501" });
    } finally {
      read.mockRestore();
    }
  });

  test("a restart from such a shell compares the job against the installed homes", () => {
    const plist = withShellHomes("/installed/codex", "/installed/opencodex", () => buildPlist([]));
    const liveCommand = parsePlistStrings(plist).args[2]!;
    const launchctl = ((args: string[]) => args[0] === "print"
      ? { ok: true, stdout: "arguments = {\n  /bin/sh\n  -lc\n  " + liveCommand + "\n}", stderr: "", status: 0 }
      : { ok: true, stdout: "", stderr: "", status: 0 }) as typeof runLaunchctl;
    const expected: string[] = [];
    const probe = ((opts: Parameters<typeof probeLaunchdLoadState>[0]) => {
      expected.push(opts!.expectedCommand!());
      return probeLaunchdLoadState({ ...opts, uid: 501, launchctl });
    }) as typeof probeLaunchdLoadState;
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      withShellHomes("/restart-shell/codex", "/restart-shell/opencodex", () => {
        expect(() => restartLaunchdJob({ launchctl, probe, readPlist: () => plist })).not.toThrow();
      });
    } finally {
      log.mockRestore();
    }
    expect(expected[0]).toBe(liveCommand);
  });

  test("recorded install state supplies the homes when the plist carries none", () => {
    const entry = { bun: "/b/bun", cli: "/c/cli.ts" };
    const state = { version: 2 as const, codexHome: "/recorded/codex", opencodexHome: "/recorded/opencodex", backend: "scheduler" as const };
    const command = withHomes("/status-shell/codex", "/status-shell/opencodex", () =>
      expectedLaunchdCommand(14001, { state, entry, readPlist: () => "<plist/>" }));
    expect(command).toStartWith("CODEX_HOME='/recorded/codex' OPENCODEX_HOME='/recorded/opencodex' ");
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

  test("the token file and log stay under the pinned OpenCodex home, not a profile variable", () => {
    // The task may run with another USERPROFILE than the installing shell. OPENCODEX_HOME is
    // written as a literal, so the token file must be too, or the two can name different profiles.
    const profile = join(tmpdir(), "ocx-task-profile");
    const previous = { profile: process.env.USERPROFILE, opencodex: process.env.OPENCODEX_HOME };
    process.env.USERPROFILE = profile;
    process.env.OPENCODEX_HOME = join(profile, ".opencodex");
    try {
      const script = withHomes(join(profile, ".codex"), join(profile, ".opencodex"), () => buildWindowsServiceScript());
      expect(script).toContain(`set "OPENCODEX_HOME=${join(profile, ".opencodex")}"`);
      expect(script).toContain(`set "OCX_API_TOKEN_FILE=${join(profile, ".opencodex", "service-api-token")}"`);
      expect(script).toContain(`set "OCX_SERVICE_LOG=${serviceState.serviceLogPath()}"`);
      expect(serviceState.serviceLogPath().startsWith(join(profile, ".opencodex"))).toBe(true);
      expect(script).not.toMatch(/set "(OCX_API_TOKEN_FILE|OCX_SERVICE_LOG|CODEX_SQLITE_HOME)=%/);
    } finally {
      if (previous.profile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previous.profile;
      process.env.OPENCODEX_HOME = previous.opencodex;
    }
  });
});
