import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { helperPath, repoRoot } from "../helpers/repo-root";

// Exercise the default cache reader's real subprocess from a compiled executable.
// A unit test of selfLaunchArgv alone misses a caller that still passes $bunfs source.
test("packaged startup probe is fresh before and after replacing its bundled executable", () => {
  const scratch = mkdtempSync(join(tmpdir(), "ocx-packaged-startup-"));
  try {
    const name = process.platform === "win32" ? "ocx.exe" : "ocx";
    const built = join(scratch, `build-${name}`);
    const bundled = join(scratch, "OpenCodex.app", "Contents", "MacOS", name);
    mkdirSync(join(bundled, ".."), { recursive: true });
    const build = Bun.spawnSync([process.execPath, "build", "--compile", helperPath("startup-health-packaged-child.ts"), "--outfile", built], {
      cwd: repoRoot(), stdout: "pipe", stderr: "pipe", timeout: 60_000,
    });
    expect(build.exitCode, build.stderr.toString()).toBe(0);
    if (process.platform === "darwin") {
      // Match build-standalone: Bun's linker signature may omit its embedded payload.
      const sign = Bun.spawnSync(["/usr/bin/codesign", "--force", "--sign", "-", built], { stdout: "pipe", stderr: "pipe" });
      expect(sign.exitCode, sign.stderr.toString()).toBe(0);
    }
    for (let install = 0; install < 2; install++) {
      copyFileSync(built, bundled);
      const home = join(scratch, `home-${install}`);
      mkdirSync(join(home, ".codex"), { recursive: true });
      const result = Bun.spawnSync([bundled, "cached"], {
        cwd: scratch, env: { ...process.env, HOME: home, USERPROFILE: home,
          OPENCODEX_HOME: join(home, ".opencodex"), CODEX_HOME: join(home, ".codex") },
        stdout: "pipe", stderr: "pipe", timeout: 25_000,
      });
      expect(result.exitCode, JSON.stringify({ signal: result.signalCode, error: result.error?.message, stderr: result.stderr.toString() })).toBe(0);
      const health = JSON.parse(result.stdout.toString().trim().split(/\r?\n/).at(-1)!);
      expect(health).toMatchObject({ status: "native", diagnosticStale: false, rebootSafe: true });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
