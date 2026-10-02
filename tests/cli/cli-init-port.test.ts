import { describe, expect, test } from "bun:test";
import * as init from "../../src/cli/init";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

describe("setup port validation", () => {
  test.each([["", 10100], ["   ", 10100], ["1", 1], ["65535", 65535], [" 10101 ", 10101]] as const)("accepts %j", (raw, expected) => {
    expect(init.parseInitPort(raw)).toBe(expected);
  });
  test.each(["0", "-1", "65536", "10100oops", "1.5", "1e3", "0x100", "oops", "9007199254740993"])("rejects %j before publication", raw => {
    expect(init.parseInitPort(raw)).toBeNull();
  });
  test("the actual wizard refuses a truncated port before writing config", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-invalid-port-"));
    mkdirSync(join(home, "native"));
    const proc = Bun.spawn([process.execPath, "--eval", 'import {runInit} from ' + JSON.stringify(repoPath("src", "cli", "init.ts")) + '; await runInit();'], {
      cwd: repoRoot(), env: { ...process.env, OPENCODEX_HOME: home, CODEX_HOME: join(home, "native"), HOME: home, USERPROFILE: home,
        APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"), XDG_CONFIG_HOME: join(home, "xdg") },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const stderr = new Response(proc.stderr).text();
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    const answers = [
      ["Select default provider (number):", "999"], ["Provider name:", "port-fixture"],
      ["Base URL (e.g. http://localhost:11434/v1):", "https://example.test/v1"],
      ["Adapter [openai-chat]:", ""], ["API key (optional):", ""], ["Default model:", "fixture"],
      ["Proxy port [10100]:", "10100oops"], ["Inject into Codex config.toml? [Y/n]:", "n"],
      ["Install Codex autostart shim? [Y/n]:", "n"],
    ];
    let output = "", answered = 0;
    const timer = setTimeout(() => proc.kill(), 20_000);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        output += decoder.decode(value, { stream: true });
        const next = answers[answered];
        if (next && output.includes(next[0]!)) {
          proc.stdin.write(next[1] + "\n"); await proc.stdin.flush(); answered++;
        }
      }
      expect({ answered, stderr: await stderr, output }).toMatchObject({ answered: 7 });
      expect(await proc.exited).toBe(1);
      expect(await stderr).toContain("Proxy port must be");
      expect(existsSync(join(home, "config.json"))).toBe(false);
    } finally {
      clearTimeout(timer); if (proc.exitCode === null) proc.kill();
      await proc.exited; reader.releaseLock(); removeTreeWithRetry(home);
    }
  }, 30_000);
});
