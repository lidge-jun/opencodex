import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  RemoteWorkspaceExecutor,
  createLinuxRemoteWorkspaceCommandRunner,
  createNativeRemoteWorkspaceCommandRunner,
  createPlatformRemoteWorkspaceCommandRunner,
  linuxRemoteWorkspaceCommandArgv,
  linuxRemoteWorkspaceCommandRunnerAvailable,
  nativeRemoteWorkspaceCommandRunnerAvailable,
  pinRemoteWorkspaceNativeHelper,
} from "../src/remote-control";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ocx-remote-bwrap-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const outside = join(root, "outside-secret.txt");
  mkdirSync(join(workspace, "project"), { recursive: true });
  writeFileSync(outside, "must-not-be-visible");
  return { root, workspace, outside };
}

function fakeNativeHelper(root: string, response: Record<string, unknown>, requestPath?: string) {
  const path = join(root, "ocx-remote-helper-test");
  const encodedResponse = JSON.stringify(response).replaceAll("'", "'\\''");
  const requestCapture = requestPath
    ? `input=$(cat); printf '%s' "$input" > '${requestPath.replaceAll("'", "'\\''")}'`
    : "cat >/dev/null";
  writeFileSync(path, `#!/bin/sh\nset -eu\n${requestCapture}\nprintf '%s\\n' '${encodedResponse}'\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return pinRemoteWorkspaceNativeHelper(path);
}

describe("remote workspace Linux command sandbox", () => {
  test("builds a minimal bubblewrap argv with one writable workspace", () => {
    const state = fixture();
    const argv = linuxRemoteWorkspaceCommandArgv({
      command: ["/bin/sh", "-lc", "pwd"],
      root: state.workspace,
      cwd: join(state.workspace, "project"),
      timeoutMs: 1_000,
      maxOutputBytes: 4_096,
    }, { bubblewrapPath: process.execPath });
    expect(argv[0]).toBe(process.execPath);
    expect(argv).toContain("--unshare-net");
    expect(argv).toContain("--clearenv");
    expect(argv).toContain("--bind");
    expect(argv).toContain(state.workspace);
    expect(argv).toContain("/workspace/project");
    expect(argv).not.toContain(state.outside);
  });

  test("runs inside the selected root and cannot see an adjacent host file", async () => {
    if (!linuxRemoteWorkspaceCommandRunnerAvailable()) return;
    const state = fixture();
    const deviceId = randomUUID();
    const executor = new RemoteWorkspaceExecutor({
      deviceId,
      roots: [{ id: "root", path: state.workspace }],
      commandRunner: createLinuxRemoteWorkspaceCommandRunner(),
    });
    const result = await executor.invoke({
      requestId: randomUUID(),
      sessionId: randomUUID(),
      executorDeviceId: deviceId,
      rootId: "root",
      tool: "exec",
      arguments: {
        command: [
          "/bin/sh",
          "-lc",
          `test ! -e ${JSON.stringify(state.outside)} && printf sandboxed > marker.txt && pwd`,
        ],
        cwd: "project",
        timeoutMs: 5_000,
      },
    });
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ exitCode: 0, cwd: "project" });
    expect(JSON.stringify(result.value)).toContain("/workspace/project");
    expect(readFileSync(join(state.workspace, "project", "marker.txt"), "utf8")).toBe("sandboxed");
  });

  test("keeps exec disabled where an equivalent platform sandbox is unavailable", () => {
    expect(createPlatformRemoteWorkspaceCommandRunner({ platform: "win32" })).toBeUndefined();
    expect(createPlatformRemoteWorkspaceCommandRunner({ platform: "darwin" })).toBeUndefined();
  });

  test("advertises native exec only after a digest-pinned confinement probe", () => {
    const state = fixture();
    const helper = fakeNativeHelper(state.root, { version: 1, ok: true, probe: true });
    let probeRequest: unknown;
    expect(nativeRemoteWorkspaceCommandRunnerAvailable({
      helper,
      platform: "darwin",
      writableRoots: [state.workspace],
      probe(request) {
        probeRequest = request;
        return { version: 1, ok: true, probe: true };
      },
    })).toBe(true);
    expect(probeRequest).toEqual({ version: 1, operation: "probe" });
    expect(createPlatformRemoteWorkspaceCommandRunner({
      platform: "win32",
      native: {
        helper,
        writableRoots: [state.workspace],
        probe: () => ({ version: 1, ok: false, error: "not confined" }),
      },
    })).toBeUndefined();
    writeFileSync(helper.path, "replaced", { mode: 0o700 });
    expect(nativeRemoteWorkspaceCommandRunnerAvailable({
      helper,
      platform: "darwin",
      writableRoots: [state.workspace],
      probe: () => ({ version: 1, ok: true, probe: true }),
    })).toBe(false);
  });

  test("sends native command authority over bounded stdin and decodes one strict result", async () => {
    const state = fixture();
    const requestPath = join(state.root, "request.json");
    const helper = fakeNativeHelper(state.root, {
      version: 1,
      ok: true,
      exitCode: 7,
      stdoutBase64: Buffer.from("native stdout").toString("base64"),
      stderrBase64: Buffer.from("native stderr").toString("base64"),
    }, requestPath);
    const runner = createNativeRemoteWorkspaceCommandRunner({
      helper,
      platform: "darwin",
      writableRoots: [state.workspace],
      probe: () => ({ version: 1, ok: true, probe: true }),
    });
    const result = await runner.run({
      command: ["/usr/bin/printf", "hello world"],
      root: state.workspace,
      cwd: join(state.workspace, "project"),
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    });
    expect(result).toEqual({ exitCode: 7, stdout: "native stdout", stderr: "native stderr" });
    const request = JSON.parse(readFileSync(requestPath, "utf8"));
    expect(request).toEqual({
      version: 1,
      operation: "run",
      root: state.workspace,
      cwd: join(state.workspace, "project"),
      command: ["/usr/bin/printf", "hello world"],
      toolchainRoots: [],
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
      networkAccess: false,
    });
    expect(JSON.stringify(request)).not.toContain(process.env.OPENAI_API_KEY ?? "__no_api_key__");
  });

  test("rejects widened or malformed native helper responses", async () => {
    const state = fixture();
    const helper = fakeNativeHelper(state.root, {
      version: 1,
      ok: true,
      exitCode: 0,
      stdoutBase64: "@@not-base64@@",
      stderrBase64: "",
    });
    const runner = createNativeRemoteWorkspaceCommandRunner({
      helper,
      platform: "win32",
      writableRoots: [state.workspace],
      probe: () => ({ version: 1, ok: true, probe: true }),
    });
    await expect(runner.run({
      command: ["cmd.exe"],
      root: state.workspace,
      cwd: state.workspace,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    })).rejects.toThrow("invalid stdout");
  });

  test("never advertises or invokes a native helper from inside a writable workspace", async () => {
    const state = fixture();
    const helper = fakeNativeHelper(state.workspace, {
      version: 1,
      ok: true,
      exitCode: 0,
      stdoutBase64: "",
      stderrBase64: "",
    });
    expect(createPlatformRemoteWorkspaceCommandRunner({
      platform: "darwin",
      native: {
        helper,
        writableRoots: [state.workspace],
        probe: () => ({ version: 1, ok: true, probe: true }),
      },
    })).toBeUndefined();

  });

  test("binds every native command to the runner's construction-time writable roots", async () => {
    const state = fixture();
    const other = join(state.root, "other-workspace");
    mkdirSync(other);
    const helper = fakeNativeHelper(state.root, {
      version: 1,
      ok: true,
      exitCode: 0,
      stdoutBase64: "",
      stderrBase64: "",
    });
    const runner = createNativeRemoteWorkspaceCommandRunner({
      helper,
      platform: "darwin",
      writableRoots: [state.workspace],
      probe: () => ({ version: 1, ok: true, probe: true }),
    });
    await expect(runner.run({
      command: ["/usr/bin/true"],
      root: other,
      cwd: other,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    })).rejects.toThrow("outside the native runner grant");
  });

  test("revalidates approved toolchain roots and rejects a later symlink substitution", () => {
    const state = fixture();
    const realToolchain = join(state.root, "real-toolchain");
    const substituted = join(state.root, "toolchain");
    mkdirSync(realToolchain);
    symlinkSync(realToolchain, substituted, process.platform === "win32" ? "junction" : "dir");
    expect(() => linuxRemoteWorkspaceCommandArgv({
      command: ["true"],
      root: state.workspace,
      cwd: state.workspace,
      timeoutMs: 1_000,
      maxOutputBytes: 4_096,
    }, {
      bubblewrapPath: process.execPath,
      toolchainRoots: [substituted],
    })).toThrow("remain a real directory");
  });

  test("rejects a pre-existing hardlink before starting a workspace command", async () => {
    const state = fixture();
    linkSync(state.outside, join(state.workspace, "outside-alias"));
    const runner = createLinuxRemoteWorkspaceCommandRunner({
      bubblewrapPath: process.execPath,
      spawn: (() => { throw new Error("sandbox spawn must not be reached"); }) as typeof Bun.spawn,
    });
    await expect(runner.run({
      command: ["/bin/true"],
      root: state.workspace,
      cwd: state.workspace,
      timeoutMs: 1_000,
      maxOutputBytes: 4_096,
    })).rejects.toThrow("hard-linked file");
    expect(readFileSync(state.outside, "utf8")).toBe("must-not-be-visible");
  });

  test("the production Linux runner exposes only the current OCX Bun file, not its host directory", async () => {
    if (process.platform !== "linux" || !linuxRemoteWorkspaceCommandRunnerAvailable()) return;
    const state = fixture();
    const argv = linuxRemoteWorkspaceCommandArgv({
      command: ["bun", "--version"],
      root: state.workspace,
      cwd: state.workspace,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    }, { runtimeExecutablePath: process.execPath });
    expect(argv).toContain("/ocx-runtime/bin/bun");
    expect(argv).toContain(realpathSync(process.execPath));
    expect(argv).not.toContain(dirname(realpathSync(process.execPath)));
    expect(argv).not.toContain(process.env.HOME ?? "__missing_home__");
    const runner = createPlatformRemoteWorkspaceCommandRunner();
    if (!runner) throw new Error("Linux Remote Workspace runner was not detected");
    const result = await runner.run({
      command: ["bun", "--version"],
      root: state.workspace,
      cwd: state.workspace,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(Bun.version);
  });
});
