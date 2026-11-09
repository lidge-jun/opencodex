import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTelemetryCommand } from "../../src/cli/telemetry";
import { setTelemetryProfileCliDepsForTests } from "../../src/cli/telemetry-profile";
import { setProfileClientOverridesForTests } from "../../src/telemetry/profile/client";
import { telemetryProfilePath } from "../../src/telemetry/profile/paths";
import { resetProfileServiceCachesForTests } from "../../src/telemetry/profile/service";
import { writeTelemetryProfileState } from "../../src/telemetry/profile/state";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const AGENT_ENV_VARS = [
  "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT",
  "CODEX_THREAD_ID", "CODEX_SHELL", "CODEX_CI", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED",
  "CURSOR_TRACE_ID", "CURSOR_SESSION_TOKEN", "CURSOR_AGENT",
  "AIDER_CHAT", "OPENCODE_BIN_PATH", "GEMINI_CLI",
  "REPL_ID", "CI", "GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "JENKINS_URL", "TEAMCITY_VERSION", "CODESPACES",
] as const;
const SECRET = "ocxp_" + "c".repeat(43);
const noProxy = { findLiveProxy: async () => null };

describe("ocx telemetry profile", () => {
  let home: string;
  let collectorCalls: string[];
  let logs: string[];
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-cli-profile-"));
    for (const key of ["OPENCODEX_HOME", "OCX_TELEMETRY", "DO_NOT_TRACK", "OCX_SERVICE", ...AGENT_ENV_VARS]) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.OPENCODEX_HOME = home;
    resetProfileServiceCachesForTests();
    writeFileSync(join(home, "config.json"), JSON.stringify({
      port: 10100,
      defaultProvider: "openai",
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
      telemetry: { decision: "accepted", decidedAt: "2026-10-01T00:00:00.000Z", noticeShownAt: "2026-10-01T00:00:00.000Z" },
    }));
    collectorCalls = [];
    setProfileClientOverridesForTests({
      baseUrl: "https://collector.test",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        collectorCalls.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
        if (init?.method === "POST") {
          return Response.json({ ok: true, profile: { handle: "jun", displayName: "Jun", avatar: "blue" }, secret: SECRET }, { status: 201 });
        }
        return Response.json({ ok: true, deleted: true });
      }) as typeof fetch,
    });
    logs = [];
    spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args.join(" ")); });
    spyOn(console, "error").mockImplementation((...args: unknown[]) => { logs.push(args.join(" ")); });
  });

  afterEach(() => {
    (console.log as unknown as { mockRestore(): void }).mockRestore();
    (console.error as unknown as { mockRestore(): void }).mockRestore();
    setTelemetryProfileCliDepsForTests(null);
    setProfileClientOverridesForTests(null);
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    removeTreeWithRetry(home);
  });

  test("connect refuses agent-driven and non-interactive callers before asking or sending", async () => {
    let asked = false;
    setTelemetryProfileCliDepsForTests({ isTty: () => true, interactiveConfirm: async () => { asked = true; return true; } });
    process.env.CODEX_THREAD_ID = "agent";
    expect(await handleTelemetryCommand(["profile", "connect", "--handle", "jun", "--json"], noProxy)).toBe(1);
    expect(logs.join("\n")).toContain("agent_consent_required");
    delete process.env.CODEX_THREAD_ID;
    setTelemetryProfileCliDepsForTests({ isTty: () => false, interactiveConfirm: async () => { asked = true; return true; } });
    expect(await handleTelemetryCommand(["profile", "connect", "--handle", "jun"], noProxy)).toBe(1);
    expect(logs.join("\n")).toContain("tty_required");
    expect(asked).toBe(false);
    expect(collectorCalls).toHaveLength(0);
  });

  test("connect asks with default no; declining sends nothing", async () => {
    let defaultYes: boolean | undefined;
    setTelemetryProfileCliDepsForTests({ isTty: () => true, interactiveConfirm: async options => { defaultYes = options.defaultYes; return false; } });
    expect(await handleTelemetryCommand(["profile", "connect", "--handle", "jun"], noProxy)).toBe(1);
    expect(defaultYes).toBe(false);
    expect(logs.join("\n")).toContain("Public usage profile (opt-in");
    expect(collectorCalls).toHaveLength(0);
    expect(existsSync(telemetryProfilePath(home))).toBe(false);
  });

  test("connect refuses before prompting when anonymous telemetry is off", async () => {
    let asked = false;
    setTelemetryProfileCliDepsForTests({ isTty: () => true, interactiveConfirm: async () => { asked = true; return true; } });
    process.env.OCX_TELEMETRY = "0";
    expect(await handleTelemetryCommand(["profile", "connect", "--handle", "jun"], noProxy)).toBe(1);
    expect(asked).toBe(false);
    expect(logs.join("\n")).toContain("telemetry_off");
    expect(logs.join("\n")).not.toContain("Public usage profile (opt-in");
  });

  test("an interactive person connects; status never prints the secret", async () => {
    setTelemetryProfileCliDepsForTests({ isTty: () => true, interactiveConfirm: async () => true });
    expect(await handleTelemetryCommand(["profile", "connect", "--handle", "jun", "--name", "Jun"], noProxy)).toBe(0);
    expect(collectorCalls).toEqual(["POST /v1/profiles"]);
    logs.length = 0;
    // The fake collector answers the rank read with an unrelated body: status still succeeds.
    expect(await handleTelemetryCommand(["profile", "status", "--json"], noProxy)).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("\"handle\": \"jun\"");
    expect(out).not.toContain(SECRET);
  });

  test("disconnect is always allowed, including for agents with the proxy stopped", async () => {
    writeTelemetryProfileState({
      version: 1, handle: "jun", displayName: "Jun", avatar: "blue", secret: SECRET,
      connectedAt: "2026-11-01T00:00:00.000Z", connectedDay: "2026-11-01", sentDays: {},
      lastSentDay: null, lastSentAt: null, retryAfterUntil: null, pendingDelete: false, revoked: false,
    }, home);
    process.env.CODEX_THREAD_ID = "agent";
    expect(await handleTelemetryCommand(["profile", "disconnect", "--json"], noProxy)).toBe(0);
    expect(collectorCalls).toEqual(["DELETE /v1/profiles/me"]);
    expect(existsSync(telemetryProfilePath(home))).toBe(false);
    expect(logs.join("\n")).toContain("\"status\": \"deleted\"");
  });
});

