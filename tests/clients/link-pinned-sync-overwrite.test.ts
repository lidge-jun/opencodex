import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { remotePinnedSyncArgv, ROUTE_OVERWRITE_MIN_CHILD_VERSION } from "../../src/link/ssh-argv";
import { POWERSHELL_ENCODED_MAX, windowsScriptData } from "../../src/link/remote-windows";
import { classifySyncResult } from "../../src/cli/sync-fanout";

/**
 * --overwrite-conflict and --overwrite-client reach only a Child that honours them: an older ocx
 * ignores unknown sync flags and would report the plain sync as success, and ocx-child refuses them.
 */
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const linkId = "lnk_0123456789abcdef";

function isolated(argv: string[]): string[] {
  argv[2] = argv[2]!.replace('export PATH="$PATH:$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"', 'export PATH="$PATH"')
    .replace('"/Applications/OpenCodex.app/Contents/MacOS/ocx"', '"$HOME/missing-app"').replace('"/usr/bin/ocx"', '"$HOME/missing-system"');
  return argv;
}
function fake(path: string, version: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$HOME/calls"\nif [ "$1" = --version ]; then printf '%s\\n' '${version}'; exit 0; fi\nprintf 'synced\\n'\n`);
  chmodSync(path, 0o755);
}
function run(argv: string[], setup: (home: string) => void) {
  const home = mkdtempSync(join(tmpdir(), "ocx-overwrite-gate-")); dirs.push(home);
  const bin = join(home, "bin"); mkdirSync(bin);
  for (const command of ["sh", "uname", "mktemp", "sleep", "cat", "awk", "wc", "rm"]) symlinkSync(Bun.which(command)!, join(bin, command));
  setup(home);
  const proc = Bun.spawnSync(isolated(argv), { env: { HOME: home, OPENCODEX_HOME: join(home, "ocx-home"), CODEX_HOME: join(home, "codex-home"), TMPDIR: home, PATH: bin }, stdout: "pipe", stderr: "pipe" });
  const calls = join(home, "calls");
  return { code: proc.exitCode, stderr: proc.stderr.toString().trim(), calls: existsSync(calls) ? readFileSync(calls, "utf8") : "" };
}
const desktop = (version: string) => (home: string) => fake(join(home, ".opencodex-desktop", "bin", "ocx"), version);

test("the overwrite gate names the first release that honours the flags", () => {
  expect(ROUTE_OVERWRITE_MIN_CHILD_VERSION).toBe("2.100.0");
});

test.skipIf(process.platform === "win32").each(["2.99.0", "2.93.0", "2.100.0-preview.1"])("an overwrite sync refuses an ocx %s that would ignore the flags", version => {
  const result = run(remotePinnedSyncArgv(linkId, "posix", true, "pi"), desktop(version));
  expect(result).toEqual({ code: 121, stderr: "ocx-fanout:child-ocx-lacks-overwrite", calls: "--version\n" });
  expect(classifySyncResult({ code: 121, stdout: "", stderr: `${result.stderr}\n` })).toEqual({ state: "skipped", reason: "child-ocx-lacks-overwrite" });
});

test.skipIf(process.platform === "win32")("an overwrite sync forwards the flags to a Child that honours them, and plain sync keeps the old gate", () => {
  expect(run(remotePinnedSyncArgv(linkId, "posix", true, "pi"), desktop("2.100.0")))
    .toEqual({ code: 0, stderr: "ocx-fanout:selected:2.100.0", calls: `--version\nsync --expect-link ${linkId} --json --overwrite-conflict --overwrite-client pi\n` });
  expect(run(remotePinnedSyncArgv(linkId, "posix"), desktop("2.93.0")))
    .toEqual({ code: 0, stderr: "ocx-fanout:selected:2.93.0", calls: `--version\nsync --expect-link ${linkId} --json\n` });
});

test.skipIf(process.platform === "win32")("an overwrite sync never runs ocx-child, while a plain sync still reaches it", () => {
  const ephemeral = (home: string) => {
    fake(join(home, ".local", "bin", "ocx-child"), "2.98.0");
    mkdirSync(join(home, "ocx-home", "child"), { recursive: true });
    writeFileSync(join(home, "ocx-home", "child", "state.json"), "{}");
  };
  expect(run(remotePinnedSyncArgv(linkId, "posix", true), ephemeral)).toEqual({ code: 121, stderr: "ocx-fanout:child-ephemeral-no-overwrite", calls: "" });
  expect(classifySyncResult({ code: 121, stdout: "", stderr: "ocx-fanout:child-ephemeral-no-overwrite\n" })).toEqual({ state: "skipped", reason: "child-ephemeral-no-overwrite" });
  expect(run(remotePinnedSyncArgv(linkId, "posix"), ephemeral)).toEqual({ code: 0, stderr: "ocx-fanout:selected:2.98.0", calls: `--version\nsync --expect-link ${linkId} --json\n` });
});

function windowsScript(argv: string[]): string {
  expect(argv[5]!.length).toBeLessThanOrEqual(POWERSHELL_ENCODED_MAX);
  const outer = Buffer.from(argv[5]!, "base64").toString("utf16le");
  const packed = /\$ocxPacked='([^']+)'/.exec(outer)![1]!;
  return inflateRawSync(Buffer.from(Array.from(packed, ch => ch.charCodeAt(0) - 256))).toString("utf8");
}

test("the Windows overwrite sync carries the same gate and ocx-child refusal within the SSH budget", () => {
  const overwrite = windowsScript(remotePinnedSyncArgv(linkId, "windows", true, "pi"));
  expect(overwrite).toContain("$b=@('2','100','0')");
  expect(overwrite).toContain("[Console]::Error.WriteLine('ocx-fanout:child-ocx-lacks-overwrite')");
  expect(overwrite).toContain("StartsWith('ocx-child')){[Console]::Error.WriteLine('ocx-fanout:child-ephemeral-no-overwrite');exit 121}");
  // The gate passing proves nothing about the payload: assert the Child is asked for this link
  // and both overwrite options, so a builder that drops one cannot still satisfy the gate checks.
  expect(windowsScriptData(overwrite)?.args)
    .toEqual(["sync", "--expect-link", linkId, "--json", "--overwrite-conflict", "--overwrite-client", "pi"]);
  const plain = windowsScript(remotePinnedSyncArgv(linkId, "windows"));
  expect(plain).toContain("$b=@('2','93','0')");
  expect(plain).toContain("ocx-fanout:child-ocx-lacks-expect-link");
  expect(plain).not.toContain("child-ephemeral-no-overwrite");
});
