import { expect, test } from "bun:test";
import {
  claudeDesktopPolicyHealth,
  classifyExecFileProbeResult,
  createCachedClaudeDesktopPolicyProbe,
  getCachedClaudeDesktopPolicy,
  probeClaudeDesktopPolicyAsync,
  probeClaudeDesktopPolicy,
  type ClaudeDesktopPolicyProbeRunner,
} from "../../src/claude/desktop-policy";

function result(overrides: Partial<ReturnType<ClaudeDesktopPolicyProbeRunner>> = {}) {
  return {
    status: 0,
    stdout: "",
    timedOut: false,
    spawnFailed: false,
    ...overrides,
  };
}

test("a present Windows Claude policy degrades Desktop 3P health", () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const state = probeClaudeDesktopPolicy({
    platform: "win32",
    resolveSystemDirectory: () => "/trusted/System32",
    run: (file, args) => {
      calls.push({ file, args });
      return result({ status: 0, stdout: "registry output stays private" });
    },
  });

  expect(state).toBe("present");
  expect(claudeDesktopPolicyHealth(state)).toMatchObject({
    ok: false,
    status: "warning",
    state: "present",
  });
  expect(calls).toEqual([{
    file: "\\trusted\\System32\\reg.exe",
    args: ["query", "HKLM\\SOFTWARE\\Policies\\Claude", "/reg:64"],
  }]);
});

test("Windows policy probing constructs the trusted executable with Windows path semantics", () => {
  let executable = "";
  probeClaudeDesktopPolicy({
    platform: "win32",
    resolveSystemDirectory: () => "C:\\trusted\\System32",
    run: (file) => {
      executable = file;
      return result();
    },
  });

  expect(executable).toBe("C:\\trusted\\System32\\reg.exe");
});

test("an unreadable Windows Claude policy stays unknown and degrades health", () => {
  let calls = 0;
  const state = probeClaudeDesktopPolicy({
    platform: "win32",
    resolveSystemDirectory: () => "/trusted/System32",
    run: (_file, args) => {
      calls += 1;
      return result({
        status: 1,
        ...(args[1] === "HKLM\\SOFTWARE\\Policies"
          ? {
              status: 0,
              stdout: [
                "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies",
                "    privatePolicyName REG_SZ private-value",
                "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Claude",
              ].join("\r\n"),
            }
          : {}),
      });
    },
  });
  const health = claudeDesktopPolicyHealth(state);

  expect(calls).toBe(2);
  expect(state).toBe("unknown");
  expect(state).not.toBe("absent");
  expect(health).toMatchObject({ ok: false, status: "warning", state: "unknown" });
  expect(JSON.stringify(health)).not.toContain("privatePolicyName");
  expect(JSON.stringify(health)).not.toContain("private-value");
});

test("a missing policy is absent only after its parent is readable", () => {
  let calls = 0;
  const state = probeClaudeDesktopPolicy({
    platform: "win32",
    resolveSystemDirectory: () => "/trusted/System32",
    run: () => {
      calls += 1;
      return calls === 1
        ? result({ status: 1 })
        : result({ status: 0, stdout: "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies" });
    },
  });

  expect(calls).toBe(2);
  expect(state).toBe("absent");
  expect(claudeDesktopPolicyHealth(state)).toMatchObject({ ok: true, status: "ok" });
});

test("non-Windows policy probing is not applicable and never spawns", () => {
  let spawned = false;
  let resolved = false;
  const state = probeClaudeDesktopPolicy({
    platform: "darwin",
    resolveSystemDirectory: () => {
      resolved = true;
      return "/unused";
    },
    run: () => {
      spawned = true;
      return result();
    },
  });

  expect(state).toBe("not_applicable");
  expect(claudeDesktopPolicyHealth(state)).toMatchObject({ ok: true, status: "ok" });
  expect(spawned).toBe(false);
  expect(resolved).toBe(false);
});

test("the asynchronous policy probe does not synchronously block the caller", async () => {
  let release!: (value: ReturnType<typeof result>) => void;
  const pending = new Promise<ReturnType<typeof result>>((resolve) => { release = resolve; });
  const probe = probeClaudeDesktopPolicyAsync({
    platform: "win32",
    resolveSystemDirectory: () => "C:\\trusted\\System32",
    run: () => pending,
  });

  let settled = false;
  void probe.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  release(result({ status: 0 }));
  expect(await probe).toBe("present");
});

test("the execFile translation classifies exit codes, timeouts, and spawn failures", () => {
  const probeError = (code: number | string, extra = {}) =>
    Object.assign(new Error("probe failed"), { code, ...extra });

  expect(classifyExecFileProbeResult(null, Buffer.from("output"))).toEqual({
    status: 0, stdout: "output", timedOut: false, spawnFailed: false,
  });
  // A missing key and a query failure surface as numeric exit codes, not errno names.
  expect(classifyExecFileProbeResult(probeError(1), undefined))
    .toEqual({ status: 1, stdout: "", timedOut: false, spawnFailed: false });
  expect(classifyExecFileProbeResult(probeError(5), undefined))
    .toEqual({ status: 5, stdout: "", timedOut: false, spawnFailed: false });
  expect(classifyExecFileProbeResult(probeError("ENOENT"), undefined))
    .toEqual({ status: null, stdout: "", timedOut: false, spawnFailed: true });
  expect(classifyExecFileProbeResult(probeError("ETIMEDOUT"), undefined))
    .toEqual({ status: null, stdout: "", timedOut: true, spawnFailed: false });
  expect(classifyExecFileProbeResult(Object.assign(new Error("killed"), { killed: true }), undefined))
    .toEqual({ status: null, stdout: "", timedOut: true, spawnFailed: false });
});

test("the asynchronous probe confirms a missing key through its readable parent", async () => {
  const calls: string[] = [];
  const state = await probeClaudeDesktopPolicyAsync({
    platform: "win32",
    resolveSystemDirectory: () => "C:\\trusted\\System32",
    run: (_file, args) => {
      calls.push(args[1]!);
      return Promise.resolve(args[1] === "HKLM\\SOFTWARE\\Policies"
        ? result({ status: 0, stdout: "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies" })
        : result({ status: 1 }));
    },
  });

  expect(calls).toEqual(["HKLM\\SOFTWARE\\Policies\\Claude", "HKLM\\SOFTWARE\\Policies"]);
  expect(state).toBe("absent");
});

test("the asynchronous probe keeps an unreadable key unknown when its parent lists it", async () => {
  const state = await probeClaudeDesktopPolicyAsync({
    platform: "win32",
    resolveSystemDirectory: () => "C:\\trusted\\System32",
    run: (_file, args) => Promise.resolve(args[1] === "HKLM\\SOFTWARE\\Policies"
      ? result({
          status: 0,
          stdout: [
            "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies",
            "    privatePolicyName REG_SZ private-value",
            "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Claude",
          ].join("\r\n"),
        })
      : result({ status: 1 })),
  });

  expect(state).toBe("unknown");
});

test("the asynchronous probe reports unknown when the spawn itself fails", async () => {
  const state = await probeClaudeDesktopPolicyAsync({
    platform: "win32",
    resolveSystemDirectory: () => "C:\\trusted\\System32",
    run: () => Promise.resolve(result({ status: null, spawnFailed: true })),
  });

  expect(state).toBe("unknown");
});

test("cached status probes still honor a custom system-directory resolver", async () => {
  let resolved = false;
  const state = await getCachedClaudeDesktopPolicy({
    platform: "win32",
    resolveSystemDirectory: () => {
      resolved = true;
      return "C:\\nonexistent-opencodex-test-dir";
    },
  });

  expect(resolved).toBe(true);
  expect(state).toBe("unknown");
});

test("status policy probes coalesce concurrent refreshes and cache the result", async () => {
  let calls = 0;
  let clock = 0;
  let release!: (state: "present") => void;
  const pending = new Promise<"present">((resolve) => { release = resolve; });
  const cachedProbe = createCachedClaudeDesktopPolicyProbe(async () => {
    calls += 1;
    return pending;
  }, 30_000, () => clock);

  const first = cachedProbe();
  const concurrent = cachedProbe();
  expect(calls).toBe(1);
  release("present");
  expect(await Promise.all([first, concurrent])).toEqual(["present", "present"]);
  clock = 29_999;
  expect(await cachedProbe()).toBe("present");
  expect(calls).toBe(1);
});
