import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("ocx init piped stdin (#754)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  test("exits cleanly when stdin closes before the first prompt answer", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-init-eof-"));
    dirs.push(home);
    const cli = join(import.meta.dir, "..", "src", "cli", "index.ts");
    const proc = Bun.spawn({
      cmd: [process.execPath, cli, "init"],
      env: { ...process.env, OPENCODEX_HOME: home },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.end();
    const exit = await Promise.race([
      proc.exited,
      new Promise<number>((_, reject) => setTimeout(() => reject(new Error("init did not exit after stdin EOF")), 8_000)),
    ]);
    expect(exit).toBe(1);
    const stderr = await new Response(proc.stderr).text();
    expect(stderr.toLowerCase()).toMatch(/stdin (closed|reached eof)/);
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });
});
