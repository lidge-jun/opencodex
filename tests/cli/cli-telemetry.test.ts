import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleConfigCommand } from "../../src/cli/config-command";
import { maybeShowStarPrompt, setStarPromptDepsForTests } from "../../src/cli/star-prompt";
import {
  TELEMETRY_DEFERRAL_FILE,
  handleTelemetryCommand,
  maybeShowTelemetryPrompt,
  setTelemetryPromptDepsForTests,
} from "../../src/cli/telemetry";
import { readConfigDiagnostics } from "../../src/config/diagnostics";
import {
  readTelemetryInstallId,
  resetTelemetryInstallIdMemoForTests,
  telemetryIdPath,
} from "../../src/telemetry/install-id";
import { runTelemetryTick } from "../../src/telemetry/scheduler";
import { repoPath } from "../helpers/repo-root";
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
    setStarPromptDepsForTests(null);
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

      const tick = await runTelemetryTick({
        configDir: home,
        env: {},
        now: Date.now() + 2 * 86_400_000,
        fetch: (async () => new Response(JSON.stringify({ ok: true }), { status: 202 })) as unknown as typeof fetch,
      });
      expect(tick.sent).toBe(true);
      const rawInstallId = readTelemetryInstallId(home)!.installId;
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
      for (const entry of readdirSync(home)) {
        const full = join(home, entry);
        if (lstatSync(full).isFile()) {
          expect(readFileSync(full, "utf8")).not.toContain(rawInstallId);
        }
      }
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

      const importAccepted = join(home, "imported-accepted.json");
      writeFileSync(
        importAccepted,
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
      // Direction 1: undecided on disk -> agent import does not inject telemetry
      expect(await handleConfigCommand(["import", importAccepted, "--yes"])).toBe(0);
      expect(readConfigDiagnostics().config.telemetry).toBeUndefined();
      expect(warn.mock.calls.map(c => String(c[0])).join("\n")).toContain("ocx telemetry");

      // Direction 2: declined on disk -> agent import preserves declined whether input has telemetry or omits it
      expect(await handleTelemetryCommand(["disable", "--json"])).toBe(0);
      const declinedBefore = readConfigDiagnostics().config.telemetry;
      expect(declinedBefore?.decision).toBe("declined");

      expect(await handleConfigCommand(["import", importAccepted, "--yes"])).toBe(0);
      expect(readConfigDiagnostics().config.telemetry).toEqual(declinedBefore);

      const importWithoutTelemetry = join(home, "imported-no-telemetry.json");
      writeFileSync(
        importWithoutTelemetry,
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
        }),
        "utf8",
      );
      expect(await handleConfigCommand(["import", importWithoutTelemetry, "--yes"])).toBe(0);
      expect(readConfigDiagnostics().config.telemetry).toEqual(declinedBefore);
    } finally {
      log.mockRestore();
      warn.mockRestore();
      err.mockRestore();
    }
  });

  test("agent-driven start prints notice once per version and writes no noticeShownAt or decision; interactive prompt defaults to yes", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      // A symlinked .telemetry-deferred marker is neither trusted on read nor followed on write:
      const victim = join(home, "deferral-victim.txt");
      writeFileSync(victim, "preserve-deferral-victim", "utf8");
      const deferralPath = join(home, TELEMETRY_DEFERRAL_FILE);
      symlinkSync(victim, deferralPath);

      process.env.CODEX_THREAD_ID = "agent-start";
      setTelemetryPromptDepsForTests({ isTty: () => true });
      await maybeShowTelemetryPrompt();
      expect(log.mock.calls.length).toBe(1);
      expect(readFileSync(victim, "utf8")).toBe("preserve-deferral-victim");
      expect(lstatSync(deferralPath).isSymbolicLink()).toBe(false);
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

  test("service/cli.ts does not duplicate maybeShowTelemetryPrompt after maybeShowStarPrompt and the prompt runs once", async () => {
    const serviceCliSource = readFileSync(repoPath("src", "service", "cli.ts"), "utf8");
    expect(serviceCliSource).toContain("await maybeShowStarPrompt()");
    expect(serviceCliSource).not.toContain("maybeShowTelemetryPrompt");

    let telemetryPromptCount = 0;
    setStarPromptDepsForTests({ isTty: () => true, ghAvailable: () => false });
    setTelemetryPromptDepsForTests({
      isTty: () => true,
      interactiveConfirm: async opts => {
        telemetryPromptCount += 1;
        return opts.defaultYes;
      },
    });
    await maybeShowStarPrompt();
    expect(telemetryPromptCount).toBe(1);
  });
});
