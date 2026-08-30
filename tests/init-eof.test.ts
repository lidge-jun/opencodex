import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function waitForOutput(
  stream: ReadableStream<Uint8Array>,
  expected: string,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (!output.includes(expected)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`init exited before writing ${JSON.stringify(expected)}`);
      output += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

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
    const stderrPromise = new Response(proc.stderr).text();
    try {
      // Synchronize on the behavior under test, not Windows process startup/import time.
      // EOF now arrives while readline is waiting for the first answer.
      await waitForOutput(proc.stdout, "Select default provider (number):");
      proc.stdin.end();

      expect(await proc.exited).toBe(1);
      const stderr = await stderrPromise;
      expect(stderr.toLowerCase()).toMatch(/stdin (closed|reached eof)/);
      expect(existsSync(join(home, "config.json"))).toBe(false);
    } finally {
      if (proc.exitCode === null) proc.kill();
      await proc.exited.catch(() => {});
    }
  }, 30_000);
});
