import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { isDeferralCurrent, maybeShowStarPrompt, setStarPromptDepsForTests } from "../src/cli/star-prompt";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const NOW = Date.parse("2026-08-02T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function record(daysAgo: number, version: string): string {
  return `${new Date(NOW - daysAgo * DAY).toISOString()} ${version}`;
}

describe("isDeferralCurrent", () => {
  test("no record or a malformed record never suppresses the relay", () => {
    expect(isDeferralCurrent(null, "2.10.0", NOW)).toBe(false);
    expect(isDeferralCurrent("garbage", "2.10.0", NOW)).toBe(false);
    expect(isDeferralCurrent("not-a-date 2.10.0", "2.10.0", NOW)).toBe(false);
  });

  test("a real version already asked on suppresses for that whole version", () => {
    expect(isDeferralCurrent(record(30, "2.10.0"), "2.10.0", NOW)).toBe(true);
  });

  test("a newer version within the week stays quiet, an older record re-asks", () => {
    expect(isDeferralCurrent(record(3, "2.9.1"), "2.10.0", NOW)).toBe(true);
    expect(isDeferralCurrent(record(8, "2.9.1"), "2.10.0", NOW)).toBe(false);
  });

  test("an unreadable version falls back to the weekly bound only", () => {
    // A "?" record must not stick forever via the same-version rule.
    expect(isDeferralCurrent(record(30, "?"), "?", NOW)).toBe(false);
    expect(isDeferralCurrent(record(3, "?"), "?", NOW)).toBe(true);
  });

  test("future-dated records fail toward re-asking", () => {
    const future = `${new Date(NOW + 30 * DAY).toISOString()} 2.9.1`;
    expect(isDeferralCurrent(future, "2.10.0", NOW)).toBe(false);
  });

  test("a future-dated record with a MATCHING version also fails toward re-asking", () => {
    // Clock rollback must not suppress the deferral for the version forever.
    const future = `${new Date(NOW + 30 * DAY).toISOString()} 2.10.0`;
    expect(isDeferralCurrent(future, "2.10.0", NOW)).toBe(false);
  });
});

describe("maybeShowStarPrompt deferral flow (behavior)", () => {
  let home: string;
  const priorHome = process.env.OPENCODEX_HOME;
  const priorThread = process.env.CODEX_THREAD_ID;
  const stdinTTY = process.stdin.isTTY;
  const stdoutTTY = process.stdout.isTTY;
  const AGENT_ENV_VARS = [
    "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT",
    "CODEX_THREAD_ID", "CODEX_SHELL", "CODEX_CI", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED",
    "CURSOR_TRACE_ID", "CURSOR_SESSION_TOKEN", "CURSOR_AGENT",
    "AIDER_CHAT", "OPENCODE_BIN_PATH", "GEMINI_CLI",
    "REPL_ID", "CI", "GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "JENKINS_URL", "TEAMCITY_VERSION", "CODESPACES",
  ];
  const savedAgentEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-star-deferral-"));
    process.env.OPENCODEX_HOME = home;
    for (const name of AGENT_ENV_VARS) {
      savedAgentEnv.set(name, process.env[name]);
      delete process.env[name];
    }
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });

  afterEach(() => {
    setStarPromptDepsForTests(null);
    for (const name of AGENT_ENV_VARS) {
      const value = savedAgentEnv.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    Object.defineProperty(process.stdin, "isTTY", { value: stdinTTY, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: stdoutTTY, configurable: true });
    if (priorThread === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = priorThread;
    if (priorHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = priorHome;
    removeTreeWithRetry(home);
  });

  test("agent deferral fires once per version, never writes the marker, and a human run still prompts", async () => {
    process.env.CODEX_THREAD_ID = "agent-session";
    setStarPromptDepsForTests({
      ghAvailable: () => true,
      interactiveConfirm: async () => false,
    });
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await maybeShowStarPrompt();
      const firstCalls = log.mock.calls.length;
      expect(firstCalls).toBeGreaterThan(0);
      // The deferral record exists; the one-time marker does NOT.
      expect(existsSync(join(home, ".star-deferred"))).toBe(true);
      expect(existsSync(join(home, ".star-prompted"))).toBe(false);
      expect(readFileSync(join(home, ".star-deferred"), "utf-8")).toContain(" ");

      // Second agent-driven start: suppressed by the record.
      log.mockClear();
      await maybeShowStarPrompt();
      expect(log.mock.calls.length).toBe(0);
      expect(existsSync(join(home, ".star-prompted"))).toBe(false);

      // A hand-typed run still gets the real question (marker written, ask called).
      delete process.env.CODEX_THREAD_ID;
      let asked = 0;
      setStarPromptDepsForTests({
        ghAvailable: () => true,
        interactiveConfirm: async () => {
          asked += 1;
          return false;
        },
      });
      await maybeShowStarPrompt();
      expect(asked).toBe(1);
      expect(existsSync(join(home, ".star-prompted"))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });
});
