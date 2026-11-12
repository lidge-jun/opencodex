import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleConfigCommand } from "../../src/cli/config-command";
import { maybeShowStarPrompt, setStarPromptDepsForTests } from "../../src/cli/star-prompt";
import {
  TELEMETRY_CLI_DISCLOSURE_LINES,
  TELEMETRY_DEFERRAL_FILE,
  handleTelemetryCommand,
  maybeShowTelemetryPrompt,
  setTelemetryPromptDepsForTests,
} from "../../src/cli/telemetry";
import { getDefaultConfig, initializePersistedConfigIfMissing } from "../../src/config";
import { observeInitialConfigState, readConfigDiagnostics } from "../../src/config/diagnostics";
import { buildTelemetryStatusSnapshot } from "../../src/telemetry/routes";
import { resolveTelemetryStatus } from "../../src/telemetry/consent";
import {
  ensureTelemetryInstallId,
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
      // D4: Non-TTY or OCX_SERVICE refuses enable with tty_required pointing to the dashboard:
      setTelemetryPromptDepsForTests({ isTty: () => false });
      const nonTtyCode = await handleTelemetryCommand(["enable", "--json"]);
      expect(nonTtyCode).toBe(1);
      const nonTtyBody = JSON.parse(log.mock.calls.map(c => String(c[0])).join("\n")) as { code: string; error: string };
      expect(nonTtyBody.code).toBe("tty_required");
      expect(nonTtyBody.error.toLowerCase()).toContain("dashboard");
      expect(readConfigDiagnostics().config.telemetry).toBeUndefined();

      log.mockClear();
      process.env.OCX_SERVICE = "1";
      setTelemetryPromptDepsForTests({ isTty: () => true });
      const serviceCode = await handleTelemetryCommand(["enable", "--json"]);
      expect(serviceCode).toBe(1);
      expect(log.mock.calls.map(c => String(c[0])).join("\n")).toContain("tty_required");
      delete process.env.OCX_SERVICE;

      // Interactive human terminal: prints disclosure block, prompts with defaultYes=true, and records accepted:
      log.mockClear();
      let confirmQuestion = "";
      let confirmDefaultYes: boolean | undefined;
      let disclosureBeforePrompt = "";
      setTelemetryPromptDepsForTests({
        isTty: () => true,
        interactiveConfirm: async opts => {
          disclosureBeforePrompt = log.mock.calls.map(c => String(c[0])).join("\n");
          confirmQuestion = opts.question;
          confirmDefaultYes = opts.defaultYes;
          return true;
        },
      });
      const enableCode = await handleTelemetryCommand(["enable", "--json"]);
      expect(enableCode).toBe(0);
      expect(confirmDefaultYes).toBe(true);
      expect(confirmQuestion).toContain("Share anonymous usage statistics?");
      expect(disclosureBeforePrompt).toBe(TELEMETRY_CLI_DISCLOSURE_LINES.join("\n"));
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
      delete process.env.OCX_SERVICE;
      log.mockRestore();
      err.mockRestore();
    }
  });

  test("D6: ocx config set/unset refuse telemetry and import preserves persisted telemetry for every caller (human and agent)", async () => {
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
      // 1a. Human caller (not agent-driven) on undecided install -> imported telemetry is ignored, disk stays undecided:
      expect(await handleConfigCommand(["import", importAccepted, "--yes"])).toBe(0);
      expect(readConfigDiagnostics().config.telemetry).toBeUndefined();
      expect(warn.mock.calls.map(c => String(c[0])).join("\n")).toContain("ocx telemetry");

      // 1b. Agent-driven caller on undecided install -> imported telemetry is ignored, disk stays undecided:
      warn.mockClear();
      process.env.CODEX_THREAD_ID = "agent-import";
      expect(await handleConfigCommand(["import", importAccepted, "--yes"])).toBe(0);
      expect(readConfigDiagnostics().config.telemetry).toBeUndefined();
      expect(warn.mock.calls.map(c => String(c[0])).join("\n")).toContain("ocx telemetry");

      // 2. Declined on disk -> both human and agent callers preserve declined whether input has telemetry or omits it:
      expect(await handleTelemetryCommand(["disable", "--json"])).toBe(0);
      const declinedBefore = readConfigDiagnostics().config.telemetry;
      expect(declinedBefore?.decision).toBe("declined");

      expect(await handleConfigCommand(["import", importAccepted, "--yes"])).toBe(0);
      expect(readConfigDiagnostics().config.telemetry).toEqual(declinedBefore);

      delete process.env.CODEX_THREAD_ID;
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

      // Interactive human run prints the disclosure block before prompting with defaultYes: true and records accepted:
      delete process.env.CODEX_THREAD_ID;
      let observedDefaultYes: boolean | undefined;
      let printedBeforeConfirm = "";
      setTelemetryPromptDepsForTests({
        isTty: () => true,
        interactiveConfirm: async opts => {
          printedBeforeConfirm = log.mock.calls.map(c => String(c[0])).join("\n");
          observedDefaultYes = opts.defaultYes;
          return opts.defaultYes;
        },
      });
      await maybeShowTelemetryPrompt();
      expect(observedDefaultYes).toBe(true);
      expect(printedBeforeConfirm).toBe(TELEMETRY_CLI_DISCLOSURE_LINES.join("\n"));
      // D5: Pin required elements of the disclosure text:
      expect(printedBeforeConfirm).toContain("telemetry.opencodex.me");
      expect(printedBeforeConfirm).toContain("Never sent: prompts, model outputs");
      expect(printedBeforeConfirm).toContain("opencodex.me/dashboard");
      expect(printedBeforeConfirm).toContain("ocx telemetry status --json");
      expect(printedBeforeConfirm).toContain("ocx telemetry disable");
      expect(printedBeforeConfirm).toContain("OCX_TELEMETRY=0");
      expect(printedBeforeConfirm).toContain("DO_NOT_TRACK=1");
      expect(printedBeforeConfirm).toContain("Proxy details");
      const telemetry = readConfigDiagnostics().config.telemetry;
      expect(telemetry?.decision).toBe("accepted");
      expect(typeof telemetry?.decidedAt).toBe("string");
      expect(typeof telemetry?.noticeShownAt).toBe("string");
      expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).telemetry.decision).toBe("accepted");
    } finally {
      log.mockRestore();
    }
  });

  test("disable on a fresh install keeps the install fresh for ocx init and the decline survives config creation", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      // The Windows installer's opt-out (or a privacy-minded user) declines before any config exists.
      unlinkSync(join(home, "config.json"));
      expect(await handleTelemetryCommand(["disable", "--json"])).toBe(0);
      // No config.json is created, so `ocx init` still runs provider setup.
      expect(existsSync(join(home, "config.json"))).toBe(false);
      expect(observeInitialConfigState()).toBe("missing");
      expect((await buildTelemetryStatusSnapshot(readConfigDiagnostics().config, { env: {}, configDir: home }))).toMatchObject({
        effective: false,
        decision: "declined",
      });

      // The first config is created later (init, OAuth login, dashboard); the decline still holds.
      expect(initializePersistedConfigIfMissing(getDefaultConfig())).toBe("created");
      expect(readConfigDiagnostics().config.telemetry?.decision).toBeUndefined();
      expect((await buildTelemetryStatusSnapshot(readConfigDiagnostics().config, { env: {}, configDir: home })).effective).toBe(false);
      let fetchCalls = 0;
      const tick = await runTelemetryTick({
        configDir: home,
        env: {},
        now: Date.parse("2026-11-12T12:00:00.000Z"),
        fetch: (async () => {
          fetchCalls += 1;
          return new Response("{}", { status: 202 });
        }) as unknown as typeof fetch,
      });
      expect(tick.sent).toBe(false);
      expect(fetchCalls).toBe(0);

      // A decision written into the config later wins and clears the pending one.
      expect(await handleTelemetryCommand(["disable", "--json"])).toBe(0);
      expect(readConfigDiagnostics().config.telemetry?.decision).toBe("declined");
    } finally {
      log.mockRestore();
    }
  });

  test("D9: enable and disable exit non-zero with no success line and preserve telemetry-id.json when config.json is unavailable", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { identity } = ensureTelemetryInstallId(home);
      expect(existsSync(telemetryIdPath(home))).toBe(true);

      // Corrupt config.json so mutatePersistedConfig returns { status: "unavailable", reason: "malformed" }:
      writeFileSync(join(home, "config.json"), "{ malformed json\n", "utf8");

      const disableCode = await handleTelemetryCommand(["disable"]);
      expect(disableCode).not.toBe(0);
      expect(log.mock.calls).toHaveLength(0);
      expect(err.mock.calls.map(c => String(c[0])).join("\n")).toContain("config.json is invalid");
      // Install id must NOT be deleted when the decline failed to persist:
      expect(existsSync(telemetryIdPath(home))).toBe(true);
      expect(readTelemetryInstallId(home)?.installId).toBe(identity.installId);

      log.mockClear();
      err.mockClear();
      setTelemetryPromptDepsForTests({
        isTty: () => true,
        interactiveConfirm: async () => true,
      });
      const enableCode = await handleTelemetryCommand(["enable"]);
      expect(enableCode).not.toBe(0);
      // Only the disclosure block was printed before confirm; no "Anonymous telemetry enabled." success line:
      expect(log.mock.calls.map(c => String(c[0])).join("\n")).not.toContain("Anonymous telemetry enabled");
      expect(err.mock.calls.map(c => String(c[0])).join("\n")).toContain("config.json is invalid");
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });

  test("D12: README.md, translated READMEs, and code-signing.md state the telemetry privacy policy accurately", () => {
    for (const rel of [
      "README.md",
      "readme/README.fr.md",
      "readme/README.ja.md",
      "readme/README.ko.md",
      "readme/README.ru.md",
      "readme/README.tr.md",
      "readme/README.zh-CN.md",
      "readme/README.zh-TW.md",
      "docs-site/src/content/docs/reference/code-signing.md",
    ]) {
      const text = readFileSync(repoPath(rel), "utf8");
      expect(text).not.toContain("will not transfer any information to other networked systems");
      expect(text).toContain("telemetry.opencodex.me");
      expect(text).toContain("ocx telemetry disable");
      expect(text).toContain("OCX_TELEMETRY=0");
      expect(text).toContain("DO_NOT_TRACK=1");
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
