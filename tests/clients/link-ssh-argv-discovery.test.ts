import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { quoteRemote, REMOTE_OCX_SCRIPT, remoteOcxArgv } from "../../src/link/ssh-argv";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { spawnTestChild } from "../helpers/spawn-test-child";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

const roots: string[] = [];
// Keep any fixture whose child or inherited output pipes have not settled.
const activeRoots = new Set<string>();
afterEach(() => {
  for (const root of roots.splice(0)) if (!activeRoots.has(root)) removeTreeWithRetry(root);
});

function executable(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

function fixture(platform = "Darwin") {
  const home = mkdtempSync(join(tmpdir(), "ocx-ssh discovery-"));
  roots.push(home);
  const paths = [
    join(home, ".opencodex-desktop/bin/ocx"),
    join(home, "Applications/OpenCodex.app/Contents/MacOS/ocx"),
    join(home, "usr/bin/ocx"),
    join(home, "remote-bin/ocx"),
    join(home, "second-bin/ocx"),
    join(home, ".bun/bin/ocx"),
    join(home, ".local/bin/ocx"),
    join(home, "homebrew/bin/ocx"),
    join(home, "local/bin/ocx"),
  ];
  executable(join(home, "remote-bin/uname"), `printf '%s\\n' '${platform}'`);
  symlinkSync("/bin/sh", join(home, "remote-bin/sh"));
  const script = REMOTE_OCX_SCRIPT
    .replaceAll("/Applications/OpenCodex.app/Contents/MacOS/ocx", paths[1]!)
    .replaceAll("/usr/bin/ocx", paths[2]!)
    .replaceAll("/opt/homebrew/bin", join(home, "homebrew/bin"))
    .replaceAll("/usr/local/bin", join(home, "local/bin"));
  return {
    home, paths,
    async run(args = ["link", "port"]) {
      const argv = remoteOcxArgv(args);
      argv[2] = script;
      // Real candidate probes need a live parent loop and a separate reap budget.
      activeRoots.add(home);
      const result = await spawnTestChild(["/bin/sh", "-c", quoteRemote(argv)], {
        cwd: home,
        env: { HOME: home, PATH: `${home}/remote-bin:${home}/second-bin` },
        deadlineMs: 15_000,
      });
      if (result.reaped && result.pipesClosed) activeRoots.delete(home);
      expect(result.timedOut).toBe(false);
      expect(result.reaped).toBe(true);
      expect(result.pipesClosed).toBe(true);
      expect(result.signal).toBeNull();
      return result;
    },
    install(index: number, fails = false) {
      executable(paths[index]!, fails
        ? "if [ \"$1\" = --version ]; then printf 'env: node: missing\\n' >&2; exit 127; fi\nprintf 'broken candidate ran\\n'; exit 1"
        : `if [ "$1" = --version ]; then printf 'ocx 2.84.0\\n'; exit 0; fi\nprintf '%s\\n' '${index}'\nprintf '%s\\0' "$@"`);
    },
  };
}

test.skipIf(process.platform === "win32").each([0, 1, 2, 3, 4, 5, 6, 7, 8])("remote sh chooses candidate %i in Desktop/system/PATH order, skipping failed versions", async winner => {
    const f = fixture(winner % 2 ? "Linux" : "Darwin");
    for (let index = 0; index < 9; index++) f.install(index, index < winner);
    const args = ["link", "issue", "--alias", "it's x", "two\nlines", "火🔥", "x;$(echo no)", "", "--json"];
    const result = await f.run(args);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${winner}\n${args.join("\0")}\0`);
    expect(result.stderr).toBe("");
}, SPAWN_BUDGET_MS);

test.skipIf(process.platform === "win32")("remote sh skips absent and non-executable Desktop candidates", async () => {
  const f = fixture();
  mkdirSync(dirname(f.paths[0]!), { recursive: true });
  writeFileSync(f.paths[0]!, "unusable", { mode: 0o644 });
  f.install(2);
  const result = await f.run();
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("2\nlink\0port\0");
}, SPAWN_BUDGET_MS);

test.skipIf(process.platform === "win32").each([["absent", false], ["broken", true]] as const)("remote sh reports missing when candidates are %s", async (_label, broken) => {
  const f = fixture();
  if (broken) for (let index = 0; index < 9; index++) f.install(index, true);
  const result = await f.run();
  expect(result.exitCode).toBe(127);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
}, SPAWN_BUDGET_MS);

test.skipIf(process.platform === "win32").each(["Windows_NT", "MSYS_NT-10.0-22631", "MINGW64_NT-10.0", "MINGW32_NT-6.1", "CYGWIN_NT-10.0"])("remote sh refuses %s before invoking any ocx candidate", async platform => {
    const f = fixture(platform);
    for (const path of f.paths) executable(path, "printf 'ocx must not run\\n' >&2; exit 1");
    const result = await f.run(["--version"]);
    expect(result.exitCode).toBe(125);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
}, SPAWN_BUDGET_MS);
