import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cmdAccount } from "../src/cli/account";
import { apiError } from "../src/cli/account-api";
import { nativeMainCodexLoginInvocation } from "../src/cli/account-main";

const originalLog = console.log;
const originalError = console.error;
const originalCodexHome = process.env.CODEX_HOME;
const tempRoots: string[] = [];

function tempConfigDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(path);
  return path;
}

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

describe("ocx account main", () => {
  test("cleanup guidance requires a literal true signal", () => {
    const errors: string[] = [];
    console.error = (...values: unknown[]) => errors.push(values.join(" "));

    expect(apiError({ error: "validation failed" }, "fallback")).toBe(1);
    expect(apiError({ error: "validation failed", cleanupRequired: "true" }, "fallback")).toBe(1);
    expect(errors).toEqual([
      "Error: validation failed",
      "Error: validation failed",
    ]);

    expect(apiError({ error: "validation failed", cleanupRequired: true }, "fallback")).toBe(1);
    expect(errors.at(-1)).toBe("Warning: native-login staging cleanup is still required; run 'ocx account main doctor'.");
  });

  test("official login honors an explicit Windows runtime outside PATH through ComSpec", () => {
    const codexShim = "C:\\Portable Codex\\codex.cmd";
    const comSpec = "C:\\Windows\\System32\\cmd.exe";
    const env = {
      CODEX_CLI_PATH: codexShim,
      PATH: "",
      PATHEXT: ".CMD",
      ComSpec: comSpec,
    };
    const invocation = nativeMainCodexLoginInvocation("win32", {
      env,
      exists: path => path.toLowerCase() === codexShim.toLowerCase(),
      existsSync: path => path.toLowerCase() === codexShim.toLowerCase(),
      execFileSync: (file, args) => {
        expect(file).toBe(comSpec);
        expect(args.at(-1)).toContain("codex.cmd");
        return "codex-cli 9.9.9";
      },
      configDir: tempConfigDir("ocx-native-profile-explicit-runtime-"),
    });

    expect(invocation.file).toBe(comSpec);
    expect(invocation.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(invocation.args[3]).toContain("codex.cmd");
    expect(invocation.args[3]).toContain('^"login^"');
    expect(invocation.options).toEqual({ windowsVerbatimArguments: true });
  });

  test("official login honors a persisted runtime outside PATH", () => {
    const runtime = "C:\\Portable Codex\\codex.exe";
    const configDir = tempConfigDir("ocx-native-profile-persisted-runtime-");
    writeFileSync(join(configDir, "codex-runtime.json"), `${JSON.stringify({
      version: 1,
      command: runtime,
      source: "configured",
      selectedVersion: "8.8.8",
      updatedAt: "2026-08-03T00:00:00.000Z",
    })}\n`);

    const invocation = nativeMainCodexLoginInvocation("win32", {
      env: { PATH: "", PATHEXT: ".EXE" },
      exists: path => path.toLowerCase() === runtime.toLowerCase(),
      existsSync: path => path.toLowerCase() === runtime.toLowerCase(),
      execFileSync: (file, args) => {
        expect(file).toBe(runtime);
        expect(args).toEqual(["--version"]);
        return "codex-cli 8.8.8";
      },
      configDir,
    });

    expect(invocation).toEqual({ file: runtime, args: ["login"], options: {} });
  });

  test("mutating human output uses the server's effective home while add keeps the auth envelope off HTTP", async () => {
    const stagingHome = join(tmpdir(), "ocx-native-profile-stage");
    const effectiveHome = join(tmpdir(), "ocx-native-profile-effective-home");
    const clientHome = join(tmpdir(), "ocx-native-profile-client-home");
    process.env.CODEX_HOME = clientHome;
    const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
    const output: string[] = [];
    const errors: string[] = [];
    console.log = (...values: unknown[]) => output.push(values.join(" "));
    console.error = (...values: unknown[]) => errors.push(values.join(" "));
    let loginHome = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const requestBody = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      requests.push({ path: url.pathname, body: requestBody });
      if (url.pathname.endsWith("/register")) {
        return Response.json({ effectiveCodexHome: effectiveHome, profile: { id: "p1", label: "personal", identityHint: "account-87654321", state: "active" } });
      }
      if (url.pathname.endsWith("/stage") && !url.pathname.endsWith("/finish")) {
        return Response.json({ stageId: "11111111-1111-4111-8111-111111111111", writerToken: "writer-token-11111111111111111111111111111111", stagingCodexHome: stagingHome, effectiveCodexHome: effectiveHome, leaseExpiresAt: Date.now() + 30 * 60_000, heartbeatIntervalMs: 5_000 });
      }
      if (url.pathname.endsWith("/stage/finish")) {
        return Response.json({ effectiveCodexHome: effectiveHome, profile: { id: "p2", label: "work", identityHint: "account-12345678", state: "inactive" } });
      }
      if (url.pathname.endsWith("/switch")) {
        return Response.json({ ok: true, effectiveCodexHome: effectiveHome, activeProfile: { id: "p2", label: "work", identityHint: "account-12345678", state: "active" }, restartRequired: true });
      }
      if (url.pathname.endsWith("/recover")) {
        return Response.json({ ok: true, recovered: true, action: "rollback-source", effectiveCodexHome: effectiveHome, restartRequired: false });
      }
      return Response.json({ ok: true });
    };
    const deps = {
      baseUrl: "http://127.0.0.1:10100",
      fetchImpl,
      runCodexLoginImpl: async (home: string) => { loginHome = home; return 0; },
    };

    expect(await cmdAccount(["main", "register", "personal"], deps)).toBe(0);
    expect(await cmdAccount(["main", "add", "work"], deps)).toBe(0);
    expect(loginHome).toBe(stagingHome);
    expect(requests.find(request => request.path.endsWith("/stage/finish"))?.body).toEqual({
      stageId: "11111111-1111-4111-8111-111111111111",
      writerToken: "writer-token-11111111111111111111111111111111",
      label: "work",
    });
    expect(JSON.stringify(requests)).not.toContain("access_token");
    expect(JSON.stringify(requests)).not.toContain("refresh_token");

    const before = requests.length;
    expect(await cmdAccount(["main", "switch", "work"], deps)).toBe(1);
    expect(requests).toHaveLength(before);
    expect(errors.join("\n")).toContain("--yes");

    expect(await cmdAccount(["main", "switch", "work", "--yes"], deps)).toBe(0);
    expect(requests.at(-1)?.body).toEqual({ target: "work", confirmedStopped: true });
    expect(output.join("\n")).toContain("Restart Codex App/CLI");

    const recoveryBefore = requests.length;
    expect(await cmdAccount(["main", "recover", "--rollback"], deps)).toBe(1);
    expect(requests).toHaveLength(recoveryBefore);
    expect(await cmdAccount(["main", "recover", "--rollback", "--yes"], deps)).toBe(0);
    expect(requests.at(-1)?.body).toEqual({ rollback: true, confirmedStopped: true });
    expect(output).toContain(`Registered 'personal' for ${effectiveHome}.`);
    expect(output).toContain(`Added encrypted native profile 'work' for ${effectiveHome}.`);
    expect(output).toContain(`Native Codex login for ${effectiveHome} is now 'work'. Restart Codex App/CLI before continuing.`);
    expect(output).toContain(`Recovery completed for ${effectiveHome}: rollback-source.`);
    expect(errors).toContain(`Effective CODEX_HOME: ${effectiveHome}`);
    expect([...output, ...errors].join("\n")).not.toContain(clientHome);
  });

  test("JSON mutating output preserves the server's canonical effective home", async () => {
    const effectiveHome = join(tmpdir(), "ocx-native-profile-json-effective-home");
    process.env.CODEX_HOME = join(tmpdir(), "ocx-native-profile-json-client-home");
    const responses: Record<string, Record<string, unknown>> = {
      register: { effectiveCodexHome: effectiveHome, profile: { id: "p1", label: "personal", identityHint: "account-87654321", state: "active" } },
      switch: { ok: true, effectiveCodexHome: effectiveHome, activeProfile: { id: "p2", label: "work", identityHint: "account-12345678", state: "active" }, restartRequired: true },
      recover: { ok: true, recovered: false, externallyRefreshed: false, effectiveCodexHome: effectiveHome },
    };
    const output: string[] = [];
    console.log = (...values: unknown[]) => output.push(values.join(" "));
    const fetchImpl: typeof fetch = async input => {
      const operation = new URL(String(input)).pathname.split("/").at(-1)!;
      return Response.json(responses[operation]);
    };
    const deps = { baseUrl: "http://127.0.0.1:10100", fetchImpl };

    const commands = [
      { args: ["main", "register", "personal", "--json"], result: responses.register },
      { args: ["main", "switch", "work", "--yes", "--json"], result: responses.switch },
      { args: ["main", "recover", "--json"], result: responses.recover },
    ];
    for (const command of commands) {
      output.length = 0;
      expect(await cmdAccount(command.args, deps)).toBe(0);
      expect(JSON.parse(output.join("\n"))).toEqual(command.result);
      expect(JSON.parse(output.join("\n")).effectiveCodexHome).toBe(effectiveHome);
    }
  });

  test("add sends an idempotent cancel fallback after a non-200 finish response", async () => {
    const stagingHome = join(tmpdir(), "ocx-native-profile-stage-non-200");
    const requests: string[] = [];
    const errors: string[] = [];
    console.error = (...values: unknown[]) => errors.push(values.join(" "));
    const fetchImpl: typeof fetch = async input => {
      const path = new URL(String(input)).pathname;
      requests.push(path);
      if (path.endsWith("/stage") && !path.endsWith("/finish")) {
        return Response.json({ stageId: "22222222-2222-4222-8222-222222222222", writerToken: "writer-token-22222222222222222222222222222222", stagingCodexHome: stagingHome, leaseExpiresAt: Date.now() + 30 * 60_000, heartbeatIntervalMs: 5_000 });
      }
      if (path.endsWith("/stage/finish")) {
        return Response.json({ error: "validation failed", code: "AUTH_INVALID" }, { status: 409 });
      }
      return Response.json({ ok: true });
    };

    expect(await cmdAccount(["main", "add", "work"], {
      baseUrl: "http://127.0.0.1:10100",
      fetchImpl,
      runCodexLoginImpl: async () => 0,
    })).toBe(1);
    expect(requests).toEqual([
      "/api/native-main-profiles/stage",
      "/api/native-main-profiles/stage/heartbeat",
      "/api/native-main-profiles/stage/finish",
      "/api/native-main-profiles/stage/cancel",
    ]);
    expect(errors).toContain("Error: validation failed");
    expect(errors).not.toContain("Warning: native-login staging cleanup is still required; run 'ocx account main doctor'.");
  });

  test("add sends an idempotent cancel fallback when the finish response disconnects", async () => {
    const stagingHome = join(tmpdir(), "ocx-native-profile-stage-disconnect");
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async input => {
      const path = new URL(String(input)).pathname;
      requests.push(path);
      if (path.endsWith("/stage") && !path.endsWith("/finish")) {
        return Response.json({ stageId: "44444444-4444-4444-8444-444444444444", writerToken: "writer-token-44444444444444444444444444444444", stagingCodexHome: stagingHome, leaseExpiresAt: Date.now() + 30 * 60_000, heartbeatIntervalMs: 5_000 });
      }
      if (path.endsWith("/stage/finish")) throw new TypeError("connection closed before response");
      return Response.json({ ok: true });
    };

    expect(await cmdAccount(["main", "add", "work"], {
      baseUrl: "http://127.0.0.1:10100",
      fetchImpl,
      runCodexLoginImpl: async () => 0,
    })).toBe(1);
    expect(requests).toEqual([
      "/api/native-main-profiles/stage",
      "/api/native-main-profiles/stage/heartbeat",
      "/api/native-main-profiles/stage/finish",
      "/api/native-main-profiles/stage/cancel",
    ]);
  });

  test("add cancels server staging when official login aborts", async () => {
    const stagingHome = join(tmpdir(), "ocx-native-profile-stage-abort");
    const effectiveHome = join(tmpdir(), "ocx-native-profile-effective-home-abort");
    const requests: string[] = [];
    const errors: string[] = [];
    console.error = (...values: unknown[]) => errors.push(values.join(" "));
    const fetchImpl: typeof fetch = async input => {
      const path = new URL(String(input)).pathname;
      requests.push(path);
      if (path.endsWith("/stage") && !path.endsWith("/finish")) {
        return Response.json({ stageId: "33333333-3333-4333-8333-333333333333", writerToken: "writer-token-33333333333333333333333333333333", stagingCodexHome: stagingHome, effectiveCodexHome: effectiveHome, leaseExpiresAt: Date.now() + 30 * 60_000, heartbeatIntervalMs: 5_000 });
      }
      return Response.json({ ok: true });
    };

    expect(await cmdAccount(["main", "add", "work"], {
      baseUrl: "http://127.0.0.1:10100",
      fetchImpl,
      runCodexLoginImpl: async () => { throw new Error("login aborted"); },
    })).toBe(1);
    expect(requests).toEqual([
      "/api/native-main-profiles/stage",
      "/api/native-main-profiles/stage/heartbeat",
      "/api/native-main-profiles/stage/cancel",
    ]);
    expect(errors).toContain(`Effective CODEX_HOME: ${effectiveHome}`);
  });

  test("heartbeats only while the configured Codex login child is alive", async () => {
    const stagingHome = join(tmpdir(), "ocx-native-profile-stage-heartbeat-child");
    const writerToken = "writer-token-child-lifetime-111111111111111111111111";
    const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>(resolve => { resolveExit = resolve; });
    let resolveTwoHeartbeats!: () => void;
    const twoHeartbeats = new Promise<void>(resolve => { resolveTwoHeartbeats = resolve; });
    const fetchImpl: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      requests.push({ path, body });
      if (path.endsWith("/stage") && !path.endsWith("/finish")) {
        return Response.json({
          stageId: "55555555-5555-4555-8555-555555555555",
          writerToken,
          stagingCodexHome: stagingHome,
          leaseExpiresAt: Date.now() + 30 * 60_000,
          heartbeatIntervalMs: 10,
        });
      }
      if (path.endsWith("/stage/heartbeat")) {
        if (requests.filter(request => request.path.endsWith("/stage/heartbeat")).length >= 2) resolveTwoHeartbeats();
        return Response.json({ ok: true, leaseExpiresAt: Date.now() + 30 * 60_000 });
      }
      if (path.endsWith("/stage/finish")) return Response.json({ effectiveCodexHome: "test-home", profile: {}, plaintextMayRemain: false });
      return Response.json({ ok: true, removed: true, plaintextMayRemain: false });
    };

    const running = cmdAccount(["main", "add", "work"], {
      baseUrl: "http://127.0.0.1:10100",
      fetchImpl,
      stageHeartbeatIntervalMinMs: 10,
      spawnCodexLoginImpl: () => ({ exited, kill: () => {} }),
    });
    await twoHeartbeats;
    resolveExit(0);
    expect(await running).toBe(0);
    const heartbeatCount = requests.filter(request => request.path.endsWith("/stage/heartbeat")).length;
    await Bun.sleep(35);
    expect(requests.filter(request => request.path.endsWith("/stage/heartbeat"))).toHaveLength(heartbeatCount);
    expect(requests.find(request => request.path.endsWith("/stage/finish"))?.body).toEqual({
      stageId: "55555555-5555-4555-8555-555555555555",
      writerToken,
      label: "work",
    });
  });

  test("a stalled heartbeat is aborted before lease expiry, kills login, and cancels staging", async () => {
    const stagingHome = join(tmpdir(), "ocx-native-profile-stage-heartbeat-deadline");
    const requests: string[] = [];
    let now = 10_000;
    const leaseExpiresAt = now + 60_000;
    let deadlineCallback!: () => void;
    let scheduledDeadlineMs = -1;
    let deadlineCleared = false;
    const timerHandle = {} as ReturnType<typeof setTimeout>;
    const stageLeaseClock = {
      now: () => now,
      setTimeout: (callback: () => void, ms: number) => {
        deadlineCallback = callback;
        scheduledDeadlineMs = ms;
        return timerHandle;
      },
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => {
        expect(timer).toBe(timerHandle);
        deadlineCleared = true;
      },
    };
    let heartbeatSignal: AbortSignal | undefined;
    let resolveHeartbeatStarted!: () => void;
    const heartbeatStarted = new Promise<void>(resolve => { resolveHeartbeatStarted = resolve; });
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>(resolve => { resolveExit = resolve; });
    let killCount = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push(path);
      if (path.endsWith("/stage") && !path.endsWith("/finish")) {
        return Response.json({
          stageId: "66666666-6666-4666-8666-666666666666",
          writerToken: "writer-token-heartbeat-deadline-11111111111111111111",
          stagingCodexHome: stagingHome,
          leaseExpiresAt,
          heartbeatIntervalMs: 10,
        });
      }
      if (path.endsWith("/stage/heartbeat")) {
        heartbeatSignal = init?.signal ?? undefined;
        resolveHeartbeatStarted();
        return new Promise<Response>(() => {});
      }
      if (path.endsWith("/stage/cancel")) {
        return Response.json({ ok: true, removed: true, plaintextMayRemain: false });
      }
      throw new Error(`Unexpected request: ${path}`);
    };

    const running = cmdAccount(["main", "add", "work"], {
      baseUrl: "http://127.0.0.1:10100",
      fetchImpl,
      stageHeartbeatIntervalMinMs: 10,
      stageLeaseClock,
      spawnCodexLoginImpl: () => ({
        exited,
        kill: () => {
          killCount += 1;
          resolveExit(1);
        },
      }),
    });
    await heartbeatStarted;
    expect(scheduledDeadlineMs).toBe(30_000);
    now = leaseExpiresAt - 30_000;
    deadlineCallback();

    expect(await running).toBe(1);
    expect(deadlineCleared).toBeTrue();
    expect(killCount).toBe(1);
    expect(heartbeatSignal?.aborted).toBeTrue();
    expect(requests).toEqual([
      "/api/native-main-profiles/stage",
      "/api/native-main-profiles/stage/heartbeat",
      "/api/native-main-profiles/stage/cancel",
    ]);
  });
});
