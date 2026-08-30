import { expect, test } from "bun:test";
import {
  claudeDesktopPolicyHealth,
  probeClaudeDesktopPolicy,
  type ClaudeDesktopPolicyProbeRunner,
} from "../src/claude/desktop-policy";

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
