import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  LOGIN_SHELL_PATH_CACHE_MS,
  loginShellPathArgs,
  mergePathLists,
  parseLoginShellPath,
  readLoginShellPath,
  resetLoginShellPathCacheForTests,
  withLoginShellPath,
} from "../../src/server/login-shell-path";

afterEach(() => resetLoginShellPathCacheForTests());

/** A fake shell: prints `stdout`, then exits with `code` unless it hangs. */
function fakeShell(stdout: string, options: { code?: number; hang?: boolean } = {}) {
  const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv; detached: unknown }[] = [];
  const spawn = ((command: string, args: string[], spawnOptions: { env: NodeJS.ProcessEnv; detached: unknown }) => {
    calls.push({ command, args, env: spawnOptions.env, detached: spawnOptions.detached });
    const child = new EventEmitter() as ChildProcess;
    const out = new PassThrough();
    Object.assign(child, { stdout: out, pid: 4242 });
    queueMicrotask(() => {
      out.write(stdout);
      if (!options.hang) setTimeout(() => child.emit("exit", options.code ?? 0), 0);
    });
    return child;
  }) as never;
  return { spawn, calls };
}

const framed = (path: string) => `motd noise\n__OCX_LOGIN_PATH_BEGIN__${path}__OCX_LOGIN_PATH_END__\n`;

describe("login-shell PATH for the dashboard shim installer (#6971)", () => {
  test("only the framed PATH is trusted, and every entry must be absolute", () => {
    expect(parseLoginShellPath(framed("/opt/homebrew/bin:/Users/me/.bun/bin:/usr/bin"))).toBe("/opt/homebrew/bin:/Users/me/.bun/bin:/usr/bin");
    expect(parseLoginShellPath("no markers /opt/homebrew/bin")).toBeNull();
    expect(parseLoginShellPath(framed("relative/bin:/usr/bin"))).toBeNull();
    expect(parseLoginShellPath(framed(""))).toBeNull();
  });

  test("fish joins its PATH list explicitly; POSIX shells print \$PATH", () => {
    expect(loginShellPathArgs("/opt/homebrew/bin/fish").at(-1)).toContain("(string join : $PATH)");
    expect(loginShellPathArgs("/bin/zsh").slice(0, 3)).toEqual(["-l", "-i", "-c"]);
    expect(loginShellPathArgs("/bin/zsh").at(-1)).toContain('"$PATH"');
  });

  test("the shell's entries go first and the process PATH is kept behind them", () => {
    expect(mergePathLists("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin")).toBe("/opt/homebrew/bin:/usr/bin:/bin");
  });

  test("a successful read runs a detached login shell with a minimal env and is cached", async () => {
    const shell = fakeShell(framed("/opt/homebrew/bin:/usr/bin"));
    const killed: number[] = [];
    const env = { HOME: "/Users/me", PATH: "/usr/bin:/bin", OPENAI_API_KEY: "secret" };
    const merged = await withLoginShellPath(env, { platform: "darwin", shell: "/bin/zsh", spawn: shell.spawn, killGroup: pid => killed.push(pid) });
    expect(merged.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    expect(merged.OPENAI_API_KEY).toBe("secret");
    expect(shell.calls).toHaveLength(1);
    expect(shell.calls[0]!.detached).toBe(true);
    expect(shell.calls[0]!.env.OPENAI_API_KEY).toBeUndefined();
    expect(killed).toEqual([4242]);
    await readLoginShellPath({ platform: "darwin", shell: "/bin/zsh", spawn: shell.spawn, killGroup: () => {} });
    expect(shell.calls).toHaveLength(1);
  });

  test("a hung startup file is killed at the deadline and the failure is cached", async () => {
    const shell = fakeShell("still loading", { hang: true });
    const killed: number[] = [];
    let clock = 1_000;
    const deps = { platform: "linux" as const, shell: "/bin/bash", spawn: shell.spawn, killGroup: (pid: number) => killed.push(pid), timeoutMs: 20, now: () => clock };
    expect(await readLoginShellPath(deps)).toBeNull();
    expect(killed).toEqual([4242]);
    expect(await readLoginShellPath(deps)).toBeNull();
    expect(shell.calls).toHaveLength(1);
    clock += LOGIN_SHELL_PATH_CACHE_MS;
    await readLoginShellPath(deps);
    expect(shell.calls).toHaveLength(2);
  });

  test("a failing shell, no shell, or Windows leaves the environment unchanged", async () => {
    const env = { PATH: "/usr/bin:/bin" };
    expect(await withLoginShellPath(env, { platform: "darwin", shell: "/bin/zsh", spawn: fakeShell(framed("/opt/x"), { code: 1 }).spawn, killGroup: () => {} })).toBe(env);
    resetLoginShellPathCacheForTests();
    expect(await withLoginShellPath(env, { platform: "darwin", shell: null })).toBe(env);
    resetLoginShellPathCacheForTests();
    expect(await withLoginShellPath(env, { platform: "win32", spawn: () => { throw new Error("must not spawn"); } })).toBe(env);
  });
});

