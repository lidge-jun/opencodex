import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { resolveCodexCoordinatorDatabasePath, resolveEffectiveUserIdentity } from "../../src/codex/user-identity";

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

/** Continue reading after prompt inspection; Response rejects an already disturbed stream. */
async function remainingOutput(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return output + decoder.decode();
      output += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

describe("ocx init piped stdin (#754)", () => {
  const dirs: string[] = [];
  const coordinators: string[] = [];
  const makeHome = () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-init-eof-"));
    dirs.push(home);
    mkdirSync(join(home, "native"), { mode: 0o700 });
    return home;
  };
  const launch = (home: string, command = "init", bootstrap?: string) => Bun.spawn({
    cmd: bootstrap ? [process.execPath, "--eval", bootstrap] : [process.execPath, repoPath("src", "cli", "index.ts"), command],
    cwd: repoRoot(),
    env: {
      ...process.env, OPENCODEX_HOME: home, CODEX_HOME: join(home, "native"),
      HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "xdg"),
      APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"),
    },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const stop = async (proc: ReturnType<typeof launch>) => {
    if (proc.exitCode === null) proc.kill();
    await proc.exited.catch(() => {});
  };
  const reachPortPrompt = async (proc: ReturnType<typeof launch>) => {
    for (const [question, answer] of [
      ["Select default provider (number):", "999"],
      ["Provider name:", "init-fixture"],
      ["Base URL (e.g. http://localhost:11434/v1):", "https://example.test/v1"],
      ["Adapter [openai-chat]:", ""],
      ["API key (optional):", "fixture-init-key"],
      ["Default model:", "fixture-model"],
    ]) {
      await waitForOutput(proc.stdout, question!);
      proc.stdin.write(answer + "\n");
      await proc.stdin.flush();
    }
    await waitForOutput(proc.stdout, "Proxy port [10100]:");
  };
  afterEach(() => {
    for (const path of coordinators.splice(0)) {
      for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    }
    while (dirs.length) removeTreeWithRetry(dirs.pop()!);
  });

  test("exits cleanly when stdin closes before the first prompt answer", async () => {
    const home = makeHome();
    const proc = launch(home);
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
      await stop(proc);
    }
  }, 30_000);

  test.each(["init", "setup"])("%s preserves existing config before asking for input", async command => {
    const home = makeHome();
    const bytes = '\uFEFF{ "port":21002, "providers":{}, "defaultProvider":"openai", "customNote":"keep" }\n';
    writeFileSync(join(home, "config.json"), bytes);
    const proc = launch(home, command);
    const stdout = remainingOutput(proc.stdout);
    const stderr = new Response(proc.stderr).text();
    try {
      expect(await proc.exited).toBe(0);
      expect(await stdout).toContain("Keeping existing config");
      expect(await stderr).not.toContain("fixture-init-key");
      expect(readFileSync(join(home, "config.json"), "utf8")).toBe(bytes);
      expect(readdirSync(home).filter(name => name.startsWith("config.json"))).toEqual(["config.json"]);
    } finally { await stop(proc); }
  }, 30_000);

  test.each(["", "broken config\n", '{"port":"invalid"}'])("invalid existing config is preserved: %j", async bytes => {
    const home = makeHome();
    writeFileSync(join(home, "config.json"), bytes);
    const proc = launch(home);
    const stdout = remainingOutput(proc.stdout);
    const stderr = new Response(proc.stderr).text();
    try {
      expect(await proc.exited).toBe(1);
      expect(await stdout).not.toContain("Select default provider");
      expect(await stderr).toContain("preserved");
      expect(readFileSync(join(home, "config.json"), "utf8")).toBe(bytes);
      expect(readdirSync(home).filter(name => name.startsWith("config.json"))).toEqual(["config.json"]);
    } finally { await stop(proc); }
  }, 30_000);

  test("a creator during the wizard wins without backup cleanup or integration prompts", async () => {
    const home = makeHome();
    const backup = join(home, "config.json.pre-openai-tiers-v2.bak");
    writeFileSync(backup, "keep even stale backup on refusal");
    const proc = launch(home);
    const stderr = new Response(proc.stderr).text();
    try {
      await reachPortPrompt(proc);
      const winner = '{"port":21002,"providers":{},"defaultProvider":"openai","winner":true}\n';
      writeFileSync(join(home, "config.json"), winner, { flag: "wx" });
      proc.stdin.write("21001\n");
      await proc.stdin.flush();
      const stdout = remainingOutput(proc.stdout);
      expect(await proc.exited).toBe(1);
      expect(await stderr).toContain("keeping it");
      const rest = await stdout;
      expect(rest).not.toMatch(/Inject into|autostart shim|Setup complete/);
      expect(readFileSync(join(home, "config.json"), "utf8")).toBe(winner);
      expect(readFileSync(backup, "utf8")).toBe("keep even stale backup on refusal");
    } finally { await stop(proc); }
  }, 30_000);

  test("EOF at the final pre-publication prompt preserves backups and creates no config", async () => {
    const home = makeHome();
    const backup = join(home, "config.json.pre-openai-tiers-v2.bak");
    writeFileSync(backup, "keep backup on cancellation");
    const proc = launch(home);
    const stderr = new Response(proc.stderr).text();
    try {
      await reachPortPrompt(proc);
      proc.stdin.end();
      expect(await proc.exited).toBe(1);
      expect(await stderr).toContain("stdin reached EOF");
      expect(existsSync(join(home, "config.json"))).toBe(false);
      expect(readFileSync(backup, "utf8")).toBe("keep backup on cancellation");
    } finally { await stop(proc); }
  }, 30_000);

  test.each(["permissions", "link", "link-residue"])("publication recovery guidance reaches the CLI (%s)", async failure => {
    const home = makeHome();
    const backup = join(home, "config.json.pre-openai-tiers-v2.bak");
    writeFileSync(backup, "preserve backup on publication failure");
    const bootstrap = `
      import { mock } from "bun:test";
      const configApi = { ...await import("./src/config.ts") };
      const failure = ${JSON.stringify(failure)};
      const io = failure === "permissions"
        ? { harden() { throw new Error("private permission detail"); } }
        : {
            link() { throw Object.assign(new Error("private link detail"), { code: "EPERM" }); },
            ...(failure === "link-residue" ? { unlink() { throw new Error("private cleanup detail"); } } : {}),
          };
      mock.module("./src/config.ts", () => ({
        ...configApi,
        initializePersistedConfigIfMissing(config) {
          return configApi.initializePersistedConfigIfMissing(config, io);
        },
      }));
      const { runInit } = await import("./src/cli/init.ts");
      await runInit();
    `;
    const proc = launch(home, "init", bootstrap);
    const stderr = new Response(proc.stderr).text();
    try {
      await reachPortPrompt(proc);
      proc.stdin.write("21001\n");
      await proc.stdin.flush();
      const stdout = remainingOutput(proc.stdout);
      expect(await proc.exited).toBe(1);
      const diagnostic = await stderr;
      expect(diagnostic).toContain("OPENCODEX_HOME");
      expect(diagnostic).toContain("ocx init");
      expect(diagnostic).not.toMatch(/fixture-init-key|private (permission|link|cleanup) detail/);
      if (failure === "permissions") {
        expect(diagnostic).toContain("permissions could not be secured");
        expect(diagnostic).not.toContain("Config may already exist");
      } else {
        expect(diagnostic).toContain("hard-link publication");
        expect(diagnostic).toContain("Config may already exist; inspect it before retrying");
      }
      expect(diagnostic.includes("A temporary file could not be removed")).toBe(failure === "link-residue");
      expect(await stdout).not.toMatch(/Inject into|autostart shim|Setup complete/);
      expect(existsSync(join(home, "config.json"))).toBe(false);
      expect(readFileSync(backup, "utf8")).toBe("preserve backup on publication failure");
    } finally { await stop(proc); }
  }, 30_000);

  // Windows process.kill does not deliver a POSIX SIGINT to readline.
  test.skipIf(process.platform === "win32")("SIGINT settles a pending prompt without creating config", async () => {
    const home = makeHome();
    const proc = launch(home);
    const stderr = new Response(proc.stderr).text();
    try {
      await waitForOutput(proc.stdout, "Select default provider (number):");
      proc.kill("SIGINT");
      expect(await proc.exited).toBe(130);
      expect(await stderr).toContain("Setup cancelled");
      expect(existsSync(join(home, "config.json"))).toBe(false);
    } finally { await stop(proc); }
  }, 30_000);

  // This wraps only observation/error reporting around the REAL lock and injector.
  // The holder releases on the signal event, after runInit consumes cancellation.
  for (const wrapping of ["throw", "result"] as const) {
    test.skipIf(process.platform === "win32")(`SIGINT while injection is queued preserves native bytes (${wrapping})`, async () => {
      const home = makeHome();
      const nativeHome = join(home, "native");
      const nativeConfig = join(nativeHome, "config.toml");
      const sentinel = 'model = "gpt-5"\n# queued-init-sentinel\n';
      writeFileSync(nativeConfig, sentinel);
      coordinators.push(resolveCodexCoordinatorDatabasePath(resolveEffectiveUserIdentity(), realpathSync.native(nativeHome)));
      const bootstrap = `
        import { mock } from "bun:test";
        import { realpathSync } from "node:fs";
        const configApi = await import("./src/config.ts");
        const transition = await import("./src/codex/transition-state.ts");
        const identity = await import("./src/codex/user-identity.ts");
        configApi.withConfigMutationLockSync(() => {});
        if (transition.readCodexTransitionState().kind !== "ready") throw new Error("native coordinator setup failed");
        const path = identity.resolveCodexCoordinatorDatabasePath(identity.resolveEffectiveUserIdentity(), realpathSync.native(process.env.CODEX_HOME));
        const blocker = transition.openCodexCoordinatorTransaction(path);
        const lockApi = { ...await import("./src/codex/codex-write-lock.ts") };
        mock.module("./src/codex/codex-write-lock.ts", () => ({
          ...lockApi,
          withCodexWriteLock(options, commit) {
            let entered = false;
            const pending = lockApi.withCodexWriteLock(options, context => {
              entered = true;
              console.log("INIT_NATIVE_COMMIT_REACHED");
              return commit(context);
            });
            // The real async lock runs synchronously up to its first busy retry.
            if (entered) throw new Error("native holder was bypassed");
            console.log("INIT_NATIVE_LOCK_WAITING");
            return pending;
          },
        }));
        const injectApi = { ...await import("./src/codex/inject.ts") };
        mock.module("./src/codex/inject.ts", () => ({
          ...injectApi,
          async injectCodexConfig(...args) {
            try { return await injectApi.injectCodexConfig(...args); }
            catch {
              if (${JSON.stringify(wrapping)} === "throw") throw new Error("WRAPPED_INJECTION_RESULT");
              return { success: false, message: "WRAPPED_INJECTION_RESULT" };
            }
          },
        }));
        process.once("SIGINT", () => queueMicrotask(() => {
          blocker.rollback(); blocker.close();
          console.log("INIT_NATIVE_HOLDER_RELEASED");
        }));
        process.argv = [process.execPath, "init-fixture", "init"];
        await import("./src/cli/index.ts");
      `;
      const proc = launch(home, "init", bootstrap);
      const stderr = new Response(proc.stderr).text();
      try {
        await reachPortPrompt(proc);
        proc.stdin.write("21001\n");
        await proc.stdin.flush();
        await waitForOutput(proc.stdout, "Inject into Codex config.toml? [Y/n]:");
        const created = readFileSync(join(home, "config.json"), "utf8");
        proc.stdin.write("y\n");
        await proc.stdin.flush();
        await waitForOutput(proc.stdout, "INIT_NATIVE_LOCK_WAITING");
        expect(readFileSync(nativeConfig, "utf8")).toBe(sentinel);
        proc.kill("SIGINT");
        const stdout = remainingOutput(proc.stdout);
        expect(await proc.exited).toBe(130);
        const rest = await stdout;
        expect(rest).toContain("INIT_NATIVE_HOLDER_RELEASED");
        expect(rest).toContain("INIT_NATIVE_COMMIT_REACHED");
        expect(rest).not.toMatch(/WRAPPED_INJECTION_RESULT|Install Codex autostart shim|Setup complete|✅/);
        expect(await stderr).toContain("Setup cancelled. The created config has been kept.");
        expect(readFileSync(nativeConfig, "utf8")).toBe(sentinel);
        expect(readFileSync(join(home, "config.json"), "utf8")).toBe(created);
        expect(existsSync(join(nativeHome, "opencodex.config.toml"))).toBe(false);
        expect(existsSync(join(nativeHome, "opencodex-journal.json"))).toBe(false);
        expect(existsSync(join(home, "codex-shim.json"))).toBe(false);
      } finally { await stop(proc); }
    }, 30_000);
  }

  test.each([false, true])("successful creation survives later cancellation=%s", async cancel => {
    const home = makeHome();
    const proc = launch(home);
    const stderr = new Response(proc.stderr).text();
    try {
      await reachPortPrompt(proc);
      proc.stdin.write("21001\n");
      await proc.stdin.flush();
      await waitForOutput(proc.stdout, "Inject into Codex config.toml? [Y/n]:");
      const created = readFileSync(join(home, "config.json"), "utf8");
      if (cancel) proc.stdin.end();
      else {
        proc.stdin.write("n\n");
        await proc.stdin.flush();
        await waitForOutput(proc.stdout, "Install Codex autostart shim? [Y/n]:");
        proc.stdin.write("n\n");
        await proc.stdin.flush();
      }
      const stdout = remainingOutput(proc.stdout);
      expect(await proc.exited).toBe(cancel ? 1 : 0);
      const rest = await stdout;
      if (cancel) {
        expect(await stderr).toContain("created config has been kept");
        expect(rest).not.toContain("Setup complete");
      } else expect(rest).toContain("Setup complete");
      expect(readFileSync(join(home, "config.json"), "utf8")).toBe(created);
      expect(JSON.parse(created)).toMatchObject({ port: 21001, defaultProvider: "init-fixture" });
      expect(existsSync(join(home, "native", "config.toml"))).toBe(false);
      expect(existsSync(join(home, "codex-shim.json"))).toBe(false);
    } finally { await stop(proc); }
  }, 30_000);
});
