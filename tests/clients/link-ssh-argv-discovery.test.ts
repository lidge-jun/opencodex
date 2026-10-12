import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { quoteRemote, REMOTE_OCX_SCRIPT, remoteOcxArgv } from "../../src/link/ssh-argv";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTreeWithRetry(root); });

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
    run(args = ["link", "port"]) {
      const argv = remoteOcxArgv(args);
      argv[2] = script;
      return Bun.spawnSync(["/bin/sh", "-c", quoteRemote(argv)], {
        env: { HOME: home, PATH: `${home}/remote-bin:${home}/second-bin` },
      });
    },
    install(index: number, fails = false) {
      executable(paths[index]!, fails
        ? "if [ \"$1\" = --version ]; then printf 'env: node: missing\\n' >&2; exit 127; fi\nprintf 'broken candidate ran\\n'; exit 1"
        : `if [ "$1" = --version ]; then printf 'ocx 2.84.0\\n'; exit 0; fi\nprintf '%s\\n' '${index}'\nprintf '%s\\0' "$@"`);
    },
  };
}

test.skipIf(process.platform === "win32").each([0, 1, 2, 3, 4, 5, 6, 7, 8])("remote sh chooses candidate %i in Desktop/system/PATH order, skipping failed versions", winner => {
    const f = fixture(winner % 2 ? "Linux" : "Darwin");
    for (let index = 0; index < 9; index++) f.install(index, index < winner);
    const args = ["link", "issue", "--alias", "it's x", "two\nlines", "火🔥", "x;$(echo no)", "", "--json"];
    const result = f.run(args);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toEqual(new TextEncoder().encode(`${winner}\n${args.join("\0")}\0`));
    expect(result.stderr.toString()).toBe("");
});

test.skipIf(process.platform === "win32")("remote sh skips absent and non-executable Desktop candidates", () => {
  const f = fixture();
  mkdirSync(dirname(f.paths[0]!), { recursive: true });
  writeFileSync(f.paths[0]!, "unusable", { mode: 0o644 });
  f.install(2);
  const result = f.run();
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("2\nlink\0port\0");
});

test.skipIf(process.platform === "win32")("remote sh reports missing when all candidates are absent or fail --version", () => {
  for (const broken of [false, true]) {
    const f = fixture();
    if (broken) for (let index = 0; index < 9; index++) f.install(index, true);
    const result = f.run();
    expect(result.exitCode).toBe(127);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe("");
  }
});

test.skipIf(process.platform === "win32")("remote sh refuses Windows-like platforms before invoking any ocx candidate", () => {
  for (const platform of ["Windows_NT", "MSYS_NT-10.0-22631", "MINGW64_NT-10.0", "MINGW32_NT-6.1", "CYGWIN_NT-10.0"]) {
    const f = fixture(platform);
    for (const path of f.paths) executable(path, "printf 'ocx must not run\\n' >&2; exit 1");
    const result = f.run(["--version"]);
    expect(result.exitCode).toBe(125);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe("");
  }
});
