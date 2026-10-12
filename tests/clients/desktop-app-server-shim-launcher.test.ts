import { describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { OPENAI_TEAM_ID, untrustedChatgptBundleReason, type BundleTrustDeps } from "../../src/chatgpt/app-server-shim/bundle-trust";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildChatgptShimLauncher,
  chatgptShimLauncherPath,
  resolveChatgptCodexBinary,
  writeChatgptShimLauncher,
} from "../../src/chatgpt/app-server-shim/launcher";
import { selfLaunchArgv } from "../../src/lib/self-launch-argv";
import { helperPath, repoPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const bashAvailable = process.platform !== "win32"
  && spawnSync("/bin/bash", ["-c", "exit 0"]).status === 0;
const substitutionAvailable = bashAvailable
  && spawnSync("/bin/bash", ["-c", "printf ok > >(cat)"], { encoding: "utf8" }).stdout === "ok";
const executionTest = substitutionAvailable ? test : test.skip;
const executable = (dir: string, name: string, body: string) => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};
function withDir(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "ocx-shim-test-"));
  try { run(dir); } finally { removeTreeWithRetry(dir); }
}
const internalArgs = ["internal", "chatgpt-app-server-filter"];

describe("experimental app-server launcher", () => {
  test("source and compiled argv re-enter the CLI with shell-safe quoting", () => {
    for (const standalone of [false, true]) {
      const argv = ["/runtime with 'quote", ...selfLaunchArgv(internalArgs, {
        isStandaloneExecutable: standalone, sourceEntrypoint: "/source with space/index.ts",
      })];
      const launcher = buildChatgptShimLauncher(argv, "/real with space");
      expect(launcher).toContain("'internal' 'chatgpt-app-server-filter'");
      expect(launcher.includes("'/source with space/index.ts'")).toBe(!standalone);
      expect(launcher).toContain("'\\''");
      expect(launcher).toContain('--self-test >/dev/null 2>&1');
      expect(launcher).toContain('"$(uname -s)" = "Darwin"');
      expect(launcher).toContain('exec "$REAL" "$@" > >(exec "${FILTER[@]}")');
    }
  });

  test("writer creates the launcher under the selected config dir with mode 0755", () => withDir(dir => {
    const path = writeChatgptShimLauncher(dir);
    expect(path).toBe(chatgptShimLauncherPath(dir));
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o755);
  }));

  test("the bundled binary is derived from the discovered bundle root, not the conventional path", () => {
    const root = "/Users/example/Applications/ChatGPT.app";
    const current = `${root}/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`;
    const legacy = `${root}/Contents/Resources/codex`;
    expect(resolveChatgptCodexBinary(root, path => path === current || path === legacy)).toBe(current);
    expect(resolveChatgptCodexBinary(root, path => path === legacy)).toBe(legacy);
    expect(resolveChatgptCodexBinary(root, () => false)).toBeNull();
  });

  test("every probed bundle path stays POSIX, so a Windows host builds the same candidates", () => {
    const probed: string[] = [];
    resolveChatgptCodexBinary("/Users/example/Applications/ChatGPT.app", path => { probed.push(path); return false; });
    expect(probed.length).toBeGreaterThan(0);
    for (const path of probed) {
      expect(path).not.toContain("\\");
      expect(path.startsWith("/Users/example/Applications/ChatGPT.app/Contents/")).toBe(true);
    }
  });

  test("the writer embeds the binary it is given", () => withDir(dir => {
    const real = "/Volumes/Apps/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
    const path = writeChatgptShimLauncher(dir, real);
    expect(readFileSync(path, "utf8")).toContain(`REAL='${real}'`);
  }));

  const linkTest = process.platform === "win32" ? test.skip : test;
  linkTest("the writer replaces a symbolic link at the launcher path instead of following it", () => withDir(dir => {
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "keep", { mode: 0o600 });
    symlinkSync(victim, chatgptShimLauncherPath(dir));
    const path = writeChatgptShimLauncher(dir);
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(readFileSync(victim, "utf8")).toBe("keep");
    expect(statSync(victim).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter(name => name.endsWith(".tmp"))).toEqual([]);
  }));

  test("a launcher whose bundled binary disappeared says so and exits", () => withDir(dir => {
    if (!bashAvailable) return;
    const launcher = executable(dir, "launcher.sh", buildChatgptShimLauncher([join(dir, "filter")], join(dir, "gone")));
    const out = spawnSync("/bin/bash", [launcher], { encoding: "utf8", timeout: 5000 });
    expect(out.status).toBe(127);
    expect(out.stderr).toContain("ocx chatgpt restore");
  }));

  // Stub uname activates the macOS precondition on Linux without requiring the actual app.
  const environment = (dir: string) => {
    executable(dir, "uname", 'echo Darwin');
    return { ...process.env, PATH: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}` };
  };
  for (const scenario of ["missing runtime", "failing self-test", "passing self-test"] as const) {
    const scenarioTest = (scenario === "passing self-test" ? substitutionAvailable : bashAvailable) ? test : test.skip;
    scenarioTest(scenario, () => withDir(dir => {
      const real = executable(dir, "real with 'quote.sh", 'echo "PID:$$ ARGS:$*"\nread -r line\necho "STDIN:$line"\necho "to-stderr" >&2\nexit 7');
      const filter = scenario === "missing runtime" ? join(dir, "missing") : executable(dir, "filter.sh",
        `if [ "$1" = --self-test ]; then exit ${scenario === "failing self-test" ? 1 : 0}; fi\nsed 's/STDIN/FILTERED/'`);
      const launcher = executable(dir, "launcher.sh", buildChatgptShimLauncher([filter], real));
      const out = spawnSync("/bin/bash", [launcher, "app-server", "--flag"], {
        encoding: "utf8", input: "hello\n", env: environment(dir), timeout: 5000,
      });
      expect(out.status).toBe(7);
      expect(out.stdout).toBe(`PID:${out.pid} ARGS:app-server --flag\n${scenario === "passing self-test" ? "FILTERED" : "STDIN"}:hello\n`);
      expect(out.stderr).toBe("to-stderr\n");
    }));
  }

  executionTest("the real hidden CLI filter passes preflight and rewrites the gate", () => withDir(dir => {
    const real = executable(dir, "real.sh", `printf '%s\\n' '{"id":1,"result":{"ordinaryUsageAllowed":false,"rateLimits":{"primary":{"usedPercent":100}}}}'`);
    const argv = [process.execPath, ...selfLaunchArgv(internalArgs, {
      isStandaloneExecutable: false, sourceEntrypoint: repoPath("src/cli/index.ts"),
    })];
    const launcher = executable(dir, "launcher.sh", buildChatgptShimLauncher(argv, real));
    const out = spawnSync("/bin/bash", [launcher, "app-server"], { encoding: "utf8", env: environment(dir), timeout: 10000 });
    expect(out.status).toBe(0);
    const result = JSON.parse(out.stdout).result;
    expect(result.ordinaryUsageAllowed).toBe(true);
    expect(result.rateLimits.primary.usedPercent).toBe(100);
  }));

  executionTest("a filter exit after successful preflight closes the pipe and terminates a mock server", () => withDir(dir => {
    const real = executable(dir, "real.sh", 'trap "exit 23" PIPE\nwhile :; do printf "%s\\n" "mock server stdout" || exit 23; done');
    const filter = executable(dir, "filter.sh", 'if [ "$1" = --self-test ]; then exit 0; fi\nexit 1');
    const launcher = executable(dir, "launcher.sh", buildChatgptShimLauncher([filter], real));
    const out = spawnSync("/bin/bash", [launcher], { encoding: "utf8", env: environment(dir), timeout: 5000 });
    expect(out.error).toBeUndefined();
    expect(out.status).toBe(23);
  }));
});

describe("bundle trust before the launcher is written", () => {
  const root = "/Applications/ChatGPT.app";
  const binary = `${root}/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`;
  const deps = (over: Partial<{ owner: number; mode: number; team: string; verify: number }> = {}): BundleTrustDeps => ({
    uid: 501,
    stat: path => ({
      uid: over.owner ?? 501,
      mode: over.mode ?? 0o755,
      isFile: path === binary,
      isDirectory: path !== binary,
      isSymbolicLink: false,
    }),
    codesign: args => args[0] === "--verify"
      ? { status: over.verify ?? 0, output: "" }
      : { status: 0, output: `Identifier=codex\nTeamIdentifier=${over.team ?? OPENAI_TEAM_ID}\n` },
  });

  test("an OpenAI-signed bundle owned by this user is trusted", () => {
    expect(untrustedChatgptBundleReason(root, binary, deps())).toBeNull();
    expect(untrustedChatgptBundleReason(root, binary, deps({ owner: 0 }))).toBeNull();
  });

  test("another user's, writable, unsigned or foreign-signed bundles are refused", () => {
    expect(untrustedChatgptBundleReason(root, binary, deps({ owner: 502 }))).toContain("another user");
    expect(untrustedChatgptBundleReason(root, binary, deps({ mode: 0o777 }))).toContain("writable");
    expect(untrustedChatgptBundleReason(root, binary, deps({ verify: 1 }))).toContain("code-signature");
    expect(untrustedChatgptBundleReason(root, binary, deps({ team: "ABCDE12345" }))).toContain("not signed by OpenAI");
    expect(untrustedChatgptBundleReason(root, "/tmp/codex", deps())).toContain("outside the bundle");
  });
});


describe("restore validates the discovered app before any quit or open", () => {
  const run = (scenario: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-shim-command-"));
    try {
      writeFileSync(join(dir, "launcher.sh"), "preserve until restore succeeds");
      const result = spawnSync(process.execPath, [helperPath("desktop-app-server-shim-command-child.ts"), dir, JSON.stringify(scenario)], {
        encoding: "utf8", timeout: 10000, env: { ...process.env, CODEX_CLI_PATH: "inherited-override" },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      return { ...JSON.parse(result.stdout.trim().split("\n").at(-1)!), stdout: result.stdout, stderr: result.stderr } as {
        code: number; calls: Array<{ command: string; args: string[]; override?: string }>;
        launcherExists: boolean; root: string; shell: string; binary: string; stdout: string; stderr: string;
      };
    } finally { removeTreeWithRetry(dir); }
  };
  for (const trust of ["foreign-owner", "foreign-parent", "writable", "unsigned", "foreign-team", "symlink"]) {
    test(`restore refuses ${trust} before quit or open`, () => {
      const result = run({ trust, running: true, flag: false, missingBinary: true });
      expect(result.code).toBe(1);
      expect(result.launcherExists).toBe(true);
      expect(result.stderr).toContain("Refusing to restore");
      expect(result.calls.filter(call => ["pgrep", "ps", "/usr/bin/osascript", "/usr/bin/open"].includes(call.command))).toEqual([]);
    });
  }
  test("valid restore works with the flag off and no bundled app-server", () => {
    const result = run({ flag: false, missingBinary: true, running: true });
    expect(result.code).toBe(0);
    expect(result.launcherExists).toBe(false);
    expect(result.calls.filter(call => call.command === "/usr/bin/codesign" && call.args[0] === "--verify").map(call => call.args.at(-1))).toEqual([result.root, result.shell]);
    const quit = result.calls.findIndex(call => call.command === "/usr/bin/osascript");
    const open = result.calls.findIndex(call => call.command === "/usr/bin/open");
    expect(quit).toBeGreaterThan(0);
    expect(open).toBeGreaterThan(quit);
    expect(result.calls[open]).toEqual({ command: "/usr/bin/open", args: ["-a", result.root] });
  });
  test("admin-writable parents need a successful local admin-group lookup", () => {
    const trusted = run({ adminParent: true });
    expect(trusted.code).toBe(0);
    expect(trusted.calls.find(call => call.command === "/usr/bin/dscl")?.args).toEqual([".", "-read", "/Groups/admin", "PrimaryGroupID"]);
    const unknown = run({ adminParent: true, adminLookupFails: true });
    expect(unknown.code).toBe(1);
    expect(unknown.launcherExists).toBe(true);
    expect(unknown.calls.some(call => call.command === "/usr/bin/open")).toBe(false);
  });
  test("failed open preserves the launcher", () => {
    const result = run({ openFails: true });
    expect(result.code).toBe(1);
    expect(result.launcherExists).toBe(true);
    expect(result.calls.some(call => call.command === "/usr/bin/open")).toBe(true);
  });
  test("no installed app still removes only the launcher and returns an error", () => {
    const result = run({ noInstall: true });
    expect(result.code).toBe(1);
    expect(result.launcherExists).toBe(false);
    expect(result.calls).toEqual([]);
  });
  test("status remains read-only even when bundle trust would fail", () => {
    const result = run({ sub: "status", trust: "foreign-owner", running: true });
    expect(result.code).toBe(0);
    expect(result.launcherExists).toBe(true);
    expect(result.calls.map(call => call.command)).toEqual(["pgrep", "ps"]);
  });
  test("a launch refused over a dropped chatgptDesktop block names the failing field", () => {
    const result = run({ sub: "launch", flag: false, configRaw: JSON.stringify({ chatgptDesktop: { appServerShim: "yes" } }) });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("chatgptDesktop.appServerShim");
    expect(result.stderr).toContain("whole chatgptDesktop block is ignored");
    expect(result.calls).toEqual([]);
  });
  test("status names a dropped chatgptDesktop block next to the off flag", () => {
    const result = run({ sub: "status", configRaw: JSON.stringify({ chatgptDesktop: { appServerShim: true, unblockSend: true } }) });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('app-server shim (experimental): off (config.json chatgptDesktop: Unrecognized key: "unblockSend"');
    expect(result.stdout).toContain("the whole chatgptDesktop block is ignored)");
  });
  test("status shows a plain off for a valid, absent or unreadable block", () => {
    for (const configRaw of [undefined, "{}", JSON.stringify({ chatgptDesktop: { appServerShim: false } }), "{not json"]) {
      const result = run({ sub: "status", ...(configRaw === undefined ? {} : { configRaw }) });
      const input = `configRaw=${configRaw === undefined ? "<no file>" : JSON.stringify(configRaw)}`;
      expect(result.code, input).toBe(0);
      expect(result.stdout, input).toContain("app-server shim (experimental): off\n");
    }
  });
  test("a launch refused with no dropped block keeps the ordinary opt-in message", () => {
    const result = run({ sub: "launch", flag: false, configRaw: "{}" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("set chatgptDesktop.appServerShim: true before launching");
    expect(result.stderr).not.toContain("whole chatgptDesktop block is ignored");
  });
  test("launch still requires opt-in and an app-server binary", () => {
    for (const scenario of [{ flag: false }, { flag: true, missingBinary: true }]) {
      const result = run({ sub: "launch", ...scenario });
      expect(result.code).toBe(1);
      expect(result.calls).toEqual([]);
    }
    const result = run({ sub: "launch", flag: true });
    expect(result.code).toBe(0);
    expect(result.calls.filter(call => call.command === "/usr/bin/codesign" && call.args[0] === "--verify").map(call => call.args.at(-1))).toEqual([result.root, result.binary]);
    expect(result.calls.find(call => call.command === "/usr/bin/open")?.args[2]).toBe("--env");
  });
});


describe("bundle ancestor replacement boundary", () => {
  const root = resolve("/Applications/ChatGPT.app");
  const parentPath = dirname(root);
  const shell = join(root, "Contents", "MacOS", "ChatGPT");
  function check(parent: Partial<NonNullable<ReturnType<BundleTrustDeps["stat"]>>> = {}, adminGroupId: number | null = 80) {
    const observed: string[] = [];
    const reason = untrustedChatgptBundleReason(root, undefined, {
      uid: 501, adminGroupId: adminGroupId ?? undefined,
      stat(path) {
        observed.push(path);
        return { uid: path === shell || path.startsWith(`${root}${sep}`) || path === root ? 501 : 0,
          gid: 80, mode: 0o755, isFile: path === shell, isDirectory: path !== shell, isSymbolicLink: false,
          ...(path === parentPath ? parent : {}),
        };
      },
      codesign: () => ({ status: 0, output: `TeamIdentifier=${OPENAI_TEAM_ID}\n` }),
    });
    return { reason, observed };
  }
  test("ordinary owned ancestry is checked through the filesystem root", () => {
    const result = check();
    expect(result.reason).toBeNull();
    expect(result.observed.slice(-2)).toEqual([parentPath, dirname(parentPath)]);
  });
  test("root-owned admin-group installation directories retain compatibility", () => {
    expect(check({ mode: 0o775 }).reason).toBeNull();
    expect(check({ mode: 0o775, gid: 456 }, 456).reason).toBeNull();
    expect(check({ mode: 0o775, gid: 20 }).reason).toContain("writable");
    expect(check({ mode: 0o775 }, null).reason).toContain("writable");
  });
  test("trusted sticky parents protect an owned child; foreign owners do not", () => {
    expect(check({ mode: 0o1777 }).reason).toBeNull();
    expect(check({ uid: 501, mode: 0o1777 }).reason).toBeNull();
    expect(check({ uid: 502, mode: 0o1777 }).reason).toContain("another user");
  });
  test("foreign-owned, writable, and symbolic-link ancestors are refused", () => {
    expect(check({ uid: 502 }).reason).toContain("another user");
    expect(check({ mode: 0o777 }).reason).toContain("writable");
    expect(check({ uid: 501, mode: 0o775 }).reason).toContain("writable");
    expect(check({ isSymbolicLink: true }).reason).toContain("ancestor directory");
  });
});
