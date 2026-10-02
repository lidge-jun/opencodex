import { describe, expect, test } from "bun:test";
import * as init from "../../src/cli/init";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const PORT_PROMPT = "Proxy port [10100]:";
const BEFORE_PORT: Array<[string, string]> = [
  ["Select default provider (number):", "999"], ["Provider name:", "port-fixture"],
  ["Base URL (e.g. http://localhost:11434/v1):", "https://example.test/v1"],
  ["Adapter [openai-chat]:", ""], ["API key (optional):", ""], ["Default model:", "fixture"],
];
type Step = [prompt: string, action: string | "<EOF>" | "<SIGINT>"];

/** Drives the real wizard; each prompt is matched only in output not yet consumed, so a repeated prompt needs a fresh occurrence. */
async function runWizard(steps: Step[]) {
  const home = mkdtempSync(join(tmpdir(), "ocx-init-port-"));
  mkdirSync(join(home, "native"));
  const proc = Bun.spawn([process.execPath, "--eval", "import {runInit} from " + JSON.stringify(repoPath("src", "cli", "init.ts")) + "; await runInit();"], {
    cwd: repoRoot(), env: { ...process.env, OPENCODEX_HOME: home, CODEX_HOME: join(home, "native"), HOME: home, USERPROFILE: home,
      APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"), XDG_CONFIG_HOME: join(home, "xdg") },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const stderr = new Response(proc.stderr).text();
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "", cursor = 0, answered = 0;
  const timer = setTimeout(() => proc.kill(), 20_000);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
      for (let next = steps[answered]; next; next = steps[answered]) {
        const at = output.indexOf(next[0], cursor);
        if (at < 0) break;
        cursor = at + next[0].length;
        answered++;
        if (next[1] === "<EOF>") proc.stdin.end();
        else if (next[1] === "<SIGINT>") proc.kill("SIGINT");
        else { proc.stdin.write(next[1] + "\n"); await proc.stdin.flush(); }
      }
    }
    const exitCode = await proc.exited;
    const configPath = join(home, "config.json");
    return { answered, exitCode, output, stderr: await stderr, config: existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) as { port?: number } : undefined };
  } finally {
    clearTimeout(timer); if (proc.exitCode === null) proc.kill();
    await proc.exited; reader.releaseLock(); removeTreeWithRetry(home);
  }
}

const portPrompts = (output: string) => output.split(PORT_PROMPT).length - 1;

describe("setup port validation", () => {
  test.each([["", 10100], ["   ", 10100], ["1", 1], ["65535", 65535], [" 10101 ", 10101]] as const)("accepts %j", (raw, expected) => {
    expect(init.parseInitPort(raw)).toBe(expected);
  });
  test.each(["0", "-1", "65536", "10100oops", "1.5", "1e3", "0x100", "oops", "9007199254740993"])("rejects %j before publication", raw => {
    expect(init.parseInitPort(raw)).toBeNull();
  });

  test("an invalid port is asked again and the valid retry is saved", async () => {
    const run = await runWizard([...BEFORE_PORT, [PORT_PROMPT, "10100oops"], [PORT_PROMPT, "10101"],
      ["Inject into Codex config.toml? [Y/n]:", "n"], ["Install Codex autostart shim? [Y/n]:", "n"]]);
    expect(run).toMatchObject({ answered: 10, exitCode: 0 });
    expect(run.stderr).toContain("Proxy port must be a whole decimal number from 1 to 65535. Please try again.");
    expect(portPrompts(run.output)).toBe(2);
    expect(run.config?.port).toBe(10101);
  }, 30_000);

  test("EOF at the repeated port prompt cancels without saving", async () => {
    const run = await runWizard([...BEFORE_PORT, [PORT_PROMPT, "1.5"], [PORT_PROMPT, "<EOF>"]]);
    expect(run).toMatchObject({ answered: 8, exitCode: 1 });
    expect(run.stderr).toContain("Please try again");
    expect(run.stderr).toContain("stdin reached EOF");
    expect(run.config).toBeUndefined();
  }, 30_000);

  // Windows process.kill does not deliver a POSIX SIGINT to readline.
  test.skipIf(process.platform === "win32")("SIGINT at the repeated port prompt cancels without saving", async () => {
    const run = await runWizard([...BEFORE_PORT, [PORT_PROMPT, "0"], [PORT_PROMPT, "<SIGINT>"]]);
    expect(run).toMatchObject({ answered: 8, exitCode: 130 });
    expect(run.stderr).toContain("Setup cancelled");
    expect(run.config).toBeUndefined();
  }, 30_000);
});
