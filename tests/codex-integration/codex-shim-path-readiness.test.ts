import { afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findFirstCodexOnPath } from "../../src/codex/shim-path-resolution";
import { buildUnixCodexShim, buildWindowsCodexShim, buildWindowsPowerShellCodexShim } from "../../src/codex/shim-templates";
import { COLD_SPAWN_WARMUP_HOOK_BUDGET_MS, warmModuleGraph } from "../helpers/cold-spawn-warmup";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const roots: string[] = [];
const marker = "opencodex codex autostart shim";
afterEach(() => {
  mock.restore();
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "ocx-shim-readiness-"));
  roots.push(root);
  const first = join(root, "first");
  const later = join(root, "later");
  fs.mkdirSync(first);
  fs.mkdirSync(later);
  const command = join(first, "codex");
  const fallback = join(later, "codex");
  fs.writeFileSync(fallback, `#!/bin/sh\n# ${marker}\n`, { mode: 0o755 });
  const pathValue = [first, later].join(delimiter);
  return { root, first, later, command, fallback, pathValue };
}

// Absolute filesystem paths, not file:// hrefs: the warm-up's import scan keeps specifiers
// that are absolute paths, and the spawned --eval children resolve either form identically.
const shimModule = fileURLToPath(new URL("../../src/codex/shim.ts", import.meta.url));
const scannerModule = fileURLToPath(new URL("../../src/codex/shim-path-resolution.ts", import.meta.url));
const readinessModule = fileURLToPath(new URL("../../src/cli/codex-shim-readiness.ts", import.meta.url));

// The union of the repository module graphs this file's --eval children load; the other eval
// scripts below import a subset of the same three specifiers.
const READINESS_EVAL_SCRIPT = `
  const { diagnoseCodexShim } = await import(${JSON.stringify(shimModule)});
  const { findFirstCodexOnPath } = await import(${JSON.stringify(scannerModule)});
  const { inspectCodexShimForConnect } = await import(${JSON.stringify(readinessModule)});
  console.log(JSON.stringify({ diagnosis: diagnoseCodexShim(), command: findFirstCodexOnPath(), readiness: inspectCodexShimForConnect() }));
`;

describe("connect readiness PATH inspection", () => {
  // The file's --eval children load the readiness graph under the run's private transpiler
  // cache, so the first one's cold module load lands inside its own 3000ms bound. Pay it
  // once in setup instead; see tests/helpers/cold-spawn-warmup.ts.
  beforeAll(async () => {
    await warmModuleGraph({ graph: "codex-shim-path-readiness/eval", source: READINESS_EVAL_SCRIPT });
  }, COLD_SPAWN_WARMUP_HOOK_BUDGET_MS);

  test.skipIf(process.platform === "win32").each([
    { kind: "ordinary file", shim: false, symlink: false, executable: false },
    { kind: "shim file", shim: true, symlink: false, executable: false },
    { kind: "ordinary symlink", shim: false, symlink: true, executable: false },
    { kind: "shim symlink", shim: true, symlink: true, executable: false },
    { kind: "ordinary executable", shim: false, symlink: false, executable: true },
    { kind: "shim executable", shim: true, symlink: false, executable: true },
  ])("$kind agrees with shell command lookup", ({ shim, symlink, executable }) => {
    const f = fixture();
    const content = (isShim: boolean) => `#!/bin/sh\n${isShim ? `# ${marker}\n` : ""}exit 0\n`;
    const target = symlink ? join(f.root, "package-codex") : f.command;
    fs.writeFileSync(target, content(shim), { mode: executable ? 0o755 : 0o644 });
    if (symlink) fs.symlinkSync(target, f.command);
    fs.writeFileSync(f.fallback, content(!shim));
    const env = { ...process.env, PATH: f.pathValue, OPENCODEX_HOME: join(f.root, "home") };
    const shell = spawnSync("/bin/sh", ["-c", "command -v codex"], { env, encoding: "utf8", timeout: 3000 });
    expect(shell.error).toBeUndefined();
    expect(shell.status).toBe(0);
    const expectedPath = executable ? f.command : f.fallback;
    const expectedShim = executable ? shim : !shim;
    expect(shell.stdout.trim()).toBe(expectedPath);
    const script = `
      const { findFirstCodexOnPath } = await import(${JSON.stringify(scannerModule)});
      const { inspectCodexShimForConnect } = await import(${JSON.stringify(readinessModule)});
      console.log(JSON.stringify({
        candidate: findFirstCodexOnPath({ wsl: false }),
        result: inspectCodexShimForConnect({
          diagnose: () => ({ installed: true, healthy: true, summary: "fixture" }),
        }),
      }));
    `;
    const child = spawnSync(process.execPath, ["--eval", script], {
      env, encoding: "utf8", timeout: 3000, killSignal: "SIGKILL",
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    const output = JSON.parse(child.stdout);
    expect(output.candidate).toEqual({ path: shell.stdout.trim(), isShim: expectedShim });
    expect(output.result.status).toBe(expectedShim ? "ready" : "missing");
  });

  test.skipIf(process.platform === "win32")("a non-executable shim alone is not a PATH command", () => {
    const f = fixture();
    fs.writeFileSync(f.command, `#!/bin/sh\n# ${marker}\n`, { mode: 0o644 });
    const shell = spawnSync("/bin/sh", ["-c", "command -v codex"], {
      env: { ...process.env, PATH: f.first }, timeout: 3000,
    });
    expect(shell.error).toBeUndefined();
    expect(shell.status).not.toBe(0);
    expect(findFirstCodexOnPath({ pathValue: f.first, wsl: false })).toBeNull();
  });

  test.skipIf(process.platform !== "win32")("Windows PATHEXT lookup does not require POSIX execute access", () => {
    const f = fixture();
    const cmd = `${f.command}.cmd`;
    fs.writeFileSync(cmd, `@echo off\r\nREM ${marker}\r\n`, { mode: 0o644 });
    fs.writeFileSync(`${f.command}.exe`, "ordinary launcher", { mode: 0o644 });
    const previous = process.env.PATHEXT;
    const access = spyOn(fs, "accessSync").mockImplementation(() => { throw new Error("POSIX access check"); });
    try {
      process.env.PATHEXT = ".CMD;.EXE";
      expect(findFirstCodexOnPath({ pathValue: f.pathValue, wsl: false })).toEqual({ path: cmd, isShim: true });
      expect(access).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = previous;
    }
  });

  test("a real healthy tracked shim outside PATH does not imply connect readiness", () => {
    const f = fixture();
    const home = join(f.root, "home");
    fs.mkdirSync(home);
    const backup = `${f.fallback}.opencodex-real`;
    fs.writeFileSync(backup, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(f.fallback, buildUnixCodexShim(backup, "/fixture/ocx", "/fixture/cli.ts", "standalone", "/fixture/token"), { mode: 0o755 });
    fs.writeFileSync(join(home, "codex-shim.json"), JSON.stringify({
      platform: process.platform, wrapperPath: f.fallback, originalPath: f.fallback, backupPath: backup,
    }));
    const env = { ...process.env, OPENCODEX_HOME: home, PATH: f.first };
    if (process.platform !== "win32") {
      const shell = spawnSync("/bin/sh", ["-c", "command -v codex"], { env, timeout: 3000 });
      expect(shell.error).toBeUndefined();
      expect(shell.status).not.toBe(0);
    }
    const child = spawnSync(process.execPath, ["--eval", READINESS_EVAL_SCRIPT], { env, encoding: "utf8", timeout: 3000, killSignal: "SIGKILL" });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    const output = JSON.parse(child.stdout);
    expect(output.diagnosis).toMatchObject({ installed: true, healthy: true });
    expect(output.command).toBeNull();
    expect(output.readiness.status).toBe("missing");
    expect(output.readiness.message).toContain("installed but not active");
  });

  test.skipIf(process.platform === "win32").each(["fifo", "symlink", "replacement"])(
    "%s cannot block connect readiness or hide a later launcher", mode => {
      const f = fixture();
      const fifo = join(f.root, "pipe");
      expect(spawnSync("mkfifo", [fifo], { timeout: 3000 }).status).toBe(0);
      if (mode === "fifo") fs.renameSync(fifo, f.command);
      else if (mode === "symlink") fs.symlinkSync(fifo, f.command);
      else fs.writeFileSync(f.command, "ordinary launcher", { mode: 0o755 });
      const script = `
        import * as fs from "node:fs";
        import { spyOn } from "bun:test";
        const { findFirstCodexOnPath } = await import(${JSON.stringify(scannerModule)});
        const { inspectCodexShimForConnect } = await import(${JSON.stringify(readinessModule)});
        const command = ${JSON.stringify(f.command)};
        let replaced = false, rejectedDescriptor = false, closedRejectedDescriptor = false;
        if (${JSON.stringify(mode)} === "replacement") {
          const stat = fs.statSync, fstat = fs.fstatSync, close = fs.closeSync;
          let rejectedFd;
          spyOn(fs, "statSync").mockImplementation((path, ...args) => {
            const result = stat(path, ...args);
            if (path === command && !replaced) {
              fs.renameSync(${JSON.stringify(fifo)}, command);
              replaced = true;
            }
            return result;
          });
          spyOn(fs, "fstatSync").mockImplementation((...args) => {
            const result = fstat(...args);
            if (result.isFIFO()) { rejectedDescriptor = true; rejectedFd = args[0]; }
            return result;
          });
          spyOn(fs, "closeSync").mockImplementation(fd => {
            close(fd);
            if (fd === rejectedFd) closedRejectedDescriptor = true;
          });
        }
        process.env.PATH = ${JSON.stringify(f.pathValue)};
        const candidate = findFirstCodexOnPath({ wsl: false });
        const result = inspectCodexShimForConnect({
          diagnose: () => ({ installed: true, healthy: true, summary: "fixture" }),
        });
        console.log(JSON.stringify({ candidate, result, replaced, rejectedDescriptor, closedRejectedDescriptor }));
      `;
      // A runner timeout cannot interrupt a blocked synchronous open; the parent kills the child.
      const child = spawnSync(process.execPath, ["--eval", script], {
        timeout: 3000, killSignal: "SIGKILL", encoding: "utf8",
        env: { ...process.env, OPENCODEX_HOME: join(f.root, "home") },
      });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      const output = JSON.parse(child.stdout);
      expect(output.candidate).toEqual({ path: f.fallback, isShim: true });
      expect(output.result.status).toBe("ready");
      if (mode === "replacement") {
        expect(output.replaced).toBe(true);
        expect(output.rejectedDescriptor).toBe(true);
        expect(output.closedRejectedDescriptor).toBe(true);
      }
    },
  );

  test.each(["unix", "cmd", "powershell", "ordinary"])("recognizes %s launcher headers", flavor => {
    const f = fixture();
    const args = ["/fixture/codex-real", "/fixture/ocx", "/fixture/cli.ts", "standalone"] as const;
    const content = flavor === "unix" ? buildUnixCodexShim(...args, "/fixture/token")
      : flavor === "cmd" ? buildWindowsCodexShim(...args)
      : flavor === "powershell" ? buildWindowsPowerShellCodexShim(...args)
      : "#!/bin/sh\nexit 0\n";
    fs.writeFileSync(f.command, content, { mode: 0o755 });
    expect(findFirstCodexOnPath({ pathValue: f.pathValue, wsl: false }))
      .toEqual({ path: f.command, isShim: flavor !== "ordinary" });
  });

  test.skipIf(process.platform === "win32")("preserves npm command and fnm directory symlinks", () => {
    const f = fixture();
    const packageFile = join(f.root, "codex.js");
    fs.writeFileSync(packageFile, `#!/bin/sh\n# ${marker}\n`, { mode: 0o755 });
    fs.symlinkSync(packageFile, f.command);
    const temporaryBin = join(f.root, "fnm_multishells");
    fs.symlinkSync(f.first, temporaryBin);
    for (const directory of [f.first, temporaryBin]) {
      expect(findFirstCodexOnPath({ pathValue: directory, wsl: false }))
        .toEqual({ path: join(directory, "codex"), isShim: true });
    }
  });

  test("does not search beyond the 16 KiB header or skip that first command", () => {
    const f = fixture();
    fs.writeFileSync(f.command, `${" ".repeat(16 * 1024)}${marker}`, { mode: 0o755 });
    expect(findFirstCodexOnPath({ pathValue: f.pathValue, wsl: false }))
      .toEqual({ path: f.command, isShim: false });
  });

  test("handles short reads and closes the descriptor", () => {
    const f = fixture();
    fs.writeFileSync(f.command, `#!/bin/sh\n# ${marker}\n`, { mode: 0o755 });
    const realRead = fs.readSync;
    const read = spyOn(fs, "readSync").mockImplementation(((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) =>
      realRead(fd, buffer, offset, Math.min(length, 3), position)) as typeof fs.readSync);
    const close = spyOn(fs, "closeSync");
    expect(findFirstCodexOnPath({ pathValue: f.pathValue, wsl: false }))
      .toEqual({ path: f.command, isShim: true });
    expect(read.mock.calls.length).toBeGreaterThan(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("a failed regular-file read preserves shadowing and closes its descriptor", () => {
    const f = fixture();
    fs.writeFileSync(f.command, "ordinary launcher", { mode: 0o755 });
    spyOn(fs, "readSync").mockImplementation(() => { throw new Error("synthetic read failure"); });
    const close = spyOn(fs, "closeSync");
    expect(findFirstCodexOnPath({ pathValue: f.pathValue, wsl: false }))
      .toEqual({ path: f.command, isShim: false });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
