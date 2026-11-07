import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleConfigCommand } from "../../src/cli/config-command";
import {
  TELEMETRY_DEFERRAL_FILE,
  handleTelemetryCommand,
  maybeShowTelemetryPrompt,
  setTelemetryPromptDepsForTests,
} from "../../src/cli/telemetry";
import { readConfigDiagnostics } from "../../src/config/diagnostics";
import {
  ensureTelemetryInstallId,
  resetTelemetryInstallIdMemoForTests,
  telemetryIdPath,
} from "../../src/telemetry/install-id";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const AGENT_ENV_VARS = [
  "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT",
  "CODEX_THREAD_ID", "CODEX_SHELL", "CODEX_CI", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED",
  "CURSOR_TRACE_ID", "CURSOR_SESSION_TOKEN", "CURSOR_AGENT",
  "AIDER_CHAT", "OPENCODE_BIN_PATH", "GEMINI_CLI",
  "REPL_ID", "CI", "GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "JENKINS_URL", "TEAMCITY_VERSION", "CODESPACES",
] as const;

describe("ocx telemetry CLI and interactive prompt", () => {
  let home: string;
  const prevHome = process.env.OPENCODEX_HOME;
  const prevTelemetry = process.env.OCX_TELEMETRY;
  const prevDnt = process.env.DO_NOT_TRACK;
  const savedAgentEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-cli-telemetry-"));
    process.env.OPENCODEX_HOME = home;
    delete process.env.OCX_TELEMETRY;
    delete process.env.DO_NOT_TRACK;
    for (const key of AGENT_ENV_VARS) {
      savedAgentEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    resetTelemetryInstallIdMemoForTests();
    setTelemetryPromptDepsForTests(null);
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        port: 10100,
        defaultProvider: "openai",
        providers: {
          openai: {
            adapter: "openai-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            authMode: "forward",
          },
        },
      }, null, 2) + "\n",
      "utf8",
    );
  });

  afterEach(() => {
    setTelemetryPromptDepsForTests(null);
    resetTelemetryInstallIdMemoForTests();
    for (const [key, value] of savedAgentEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (prevHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = prevHome;
    if (prevTelemetry === undefined) delete process.env.OCX_TELEMETRY;
    else process.env.OCX_TELEMETRY = prevTelemetry;
    if (prevDnt === undefined) delete process.env.DO_NOT_TRACK;
    else process.env.DO_NOT_TRACK = prevDnt;
    removeTreeWithRetry(home);
  });

  test("status --json falls back to local snapshot when proxy is unreachable", async () => {
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      const code = await handleTelemetryCommand(["status", "--json"], {
        fetch: (async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch,
      });
      expect(code).toBe(0);
      const parsed = JSON.parse(lines.join("\n")) as { effective: boolean; reason: string; preview: { schemaVersion: number } };
      expect(parsed.effective).toBe(false);
      expect(parsed.reason).toBe("awaiting-notice");
      expect(parsed.preview.schemaVersion).toBe(1);
    } finally {
      log.mockRestore();
    }
  });

  test("enable and disable mutate config.json; enable refuses when agent-driven while disable succeeds", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const enableCode = await handleTelemetryCommand(["enable", "--json"]);
      expect(enableCode).toBe(0);
      expect(readConfigDiagnostics().config.telemetry?.decision).toBe("accepted");

      ensureTelemetryInstallId(home);
      expect(existsSync(telemetryIdPath(home))).toBe(true);

      // Agent-driven session:
      process.env.CODEX_THREAD_ID = "agent-123";
      log.mockClear();
      const refusedCode = await handleTelemetryCommand(["enable", "--json"]);
      expect(refusedCode).toBe(1);
      expect(log.mock.calls.map(c => String(c[0])).join("\n")).toContain("agent_consent_required");

      // Disable is always allowed, even when agent-driven:
      const disableCode = await handleTelemetryCommand(["disable", "--json"]);
      expect(disableCode).toBe(0);
      expect(readConfigDiagnostics().config.telemetry?.decision).toBe("declined");
      expect(existsSync(telemetryIdPath(home))).toBe(false);
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });

  test("ocx config set/unset refuse telemetry and import drops telemetry when agent-driven", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await handleConfigCommand(["set", "telemetry.decision", "accepted"])).not.toBe(0);
      expect(await handleConfigCommand(["unset", "telemetry"])).not.toBe(0);

      const importFile = join(home, "imported.json");
      writeFileSync(
        importFile,
        JSON.stringify({
          port: 10100,
          defaultProvider: "openai",
          providers: {
            openai: {
              adapter: "openai-responses",
              baseUrl: "https://chatgpt.com/backend-api/codex",
              authMode: "forward",
            },
          },
          telemetry: { decision: "accepted", decidedAt: "2026-11-06T00:00:00.000Z" },
        }),
        "utf8",
      );
      process.env.CODEX_THREAD_ID = "agent-import";
      expect(await handleConfigCommand(["import", importFile, "--yes"])).toBe(0);
      expect(readConfigDiagnostics().config.telemetry).toBeUndefined();
      expect(warn.mock.calls.map(c => String(c[0])).join("\n")).toContain("ocx telemetry");
    } finally {
      log.mockRestore();
      warn.mockRestore();
      err.mockRestore();
    }
  });

  test("agent-driven start prints notice once per version and writes no noticeShownAt or decision; interactive prompt defaults to yes", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      process.env.CODEX_THREAD_ID = "agent-start";
      setTelemetryPromptDepsForTests({ isTty: () => true });
      await maybeShowTelemetryPrompt();
      expect(log.mock.calls.length).toBe(1);
      expect(existsSync(join(home, TELEMETRY_DEFERRAL_FILE))).toBe(true);
      expect(readConfigDiagnostics().config.telemetry).toBeUndefined();

      // Second agent-driven run on the same version stays quiet:
      log.mockClear();
      await maybeShowTelemetryPrompt();
      expect(log.mock.calls.length).toBe(0);
      expect(readConfigDiagnostics().config.telemetry).toBeUndefined();

      // Interactive human run prompts with defaultYes: true and records accepted:
      delete process.env.CODEX_THREAD_ID;
      let observedDefaultYes: boolean | undefined;
      setTelemetryPromptDepsForTests({
        isTty: () => true,
        interactiveConfirm: async opts => {
          observedDefaultYes = opts.defaultYes;
          return opts.defaultYes;
        },
      });
      await maybeShowTelemetryPrompt();
      expect(observedDefaultYes).toBe(true);
      const telemetry = readConfigDiagnostics().config.telemetry;
      expect(telemetry?.decision).toBe("accepted");
      expect(typeof telemetry?.decidedAt).toBe("string");
      expect(typeof telemetry?.noticeShownAt).toBe("string");
      expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).telemetry.decision).toBe("accepted");
    } finally {
      log.mockRestore();
    }
  });
});
