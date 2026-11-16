/**
 * Google Antigravity sign-in can get the Google account disabled, so every way of adding an
 * Antigravity account requires an explicit acknowledgement. The dashboard and CLI ask first;
 * these tests pin the part none of them can skip: the management API refuses an Antigravity
 * login or import whose body does not carry the acknowledgement, before any flow or credential
 * state exists, and leaves every other provider alone.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import * as oauth from "../../src/oauth";
import { getAccountSet } from "../../src/oauth/store";
import { saveConfig } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import {
  ANTIGRAVITY_RISK_ACK_FIELD,
  ANTIGRAVITY_RISK_CLI_FLAG,
  ANTIGRAVITY_RISK_REFUSAL_CODE,
  ANTIGRAVITY_RISK_WARNING,
  ANTIGRAVITY_TOS_BAN_MESSAGE,
  hasAntigravityRiskAcknowledgement,
  requiresAntigravityRiskAcknowledgement,
  resolveAntigravityRiskAcknowledgement,
} from "../../src/oauth/antigravity-risk";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { ManagementRequest as Request } from "../helpers/management-auth";
import { handleLogin } from "../../src/oauth/login-cli";

const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };
const previousHome = process.env.OPENCODEX_HOME;
let TEST_DIR: string;

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool" } },
  };
}

beforeEach(() => {
  setIcaclsRunnerForTests(() => ICACLS_OK);
  setAsyncIcaclsRunnerForTests(async () => ICACLS_OK);
  TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-antigravity-risk-"));
  process.env.OPENCODEX_HOME = TEST_DIR;
});

afterEach(async () => {
  await flushConfigDirHardeningForTests();
  setIcaclsRunnerForTests(null);
  setAsyncIcaclsRunnerForTests(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(TEST_DIR);
});

function post(path: string, body: unknown): Request {
  return new Request("http://localhost" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function send(cfg: OcxConfig, req: Request, principal = "gui-session") {
  return await handleManagementAPI(req, new URL(req.url), cfg, {}, principal);
}

describe("acknowledgement contract", () => {
  test("only google-antigravity requires it, and only a literal true satisfies it", () => {
    expect(requiresAntigravityRiskAcknowledgement("google-antigravity")).toBe(true);
    expect(requiresAntigravityRiskAcknowledgement(" Google-Antigravity ")).toBe(true);
    for (const other of ["anthropic", "meta-muse", "xai", "kiro", "gemini", ""]) {
      expect(requiresAntigravityRiskAcknowledgement(other)).toBe(false);
    }
    expect(hasAntigravityRiskAcknowledgement({ [ANTIGRAVITY_RISK_ACK_FIELD]: true })).toBe(true);
    for (const value of [false, "true", 1, null, undefined, {}]) {
      expect(hasAntigravityRiskAcknowledgement({ [ANTIGRAVITY_RISK_ACK_FIELD]: value })).toBe(false);
    }
    expect(hasAntigravityRiskAcknowledgement(null)).toBe(false);
    expect(hasAntigravityRiskAcknowledgement("acknowledgeAntigravityRisk")).toBe(false);
  });

  test("the CLI warning names the ban message, the account scope and the safer path", () => {
    expect(ANTIGRAVITY_RISK_WARNING).toContain(ANTIGRAVITY_TOS_BAN_MESSAGE);
    expect(ANTIGRAVITY_RISK_WARNING).toContain("permanently disable Gemini and Antigravity access");
    expect(ANTIGRAVITY_RISK_WARNING).toContain("Never use your main");
    expect(ANTIGRAVITY_RISK_WARNING).toContain("Gemini API key");
  });

  test("the prompt accepts only an explicit yes and always shows the warning", async () => {
    const run = async (flag: boolean, interactive: boolean, answer: string | Error, agentDriven = false) => {
      const warned: string[] = [];
      const asked: string[] = [];
      const decision = await resolveAntigravityRiskAcknowledgement({
        flag, interactive, agentDriven,
        warn: text => warned.push(text),
        ask: async question => {
          asked.push(question);
          if (answer instanceof Error) throw answer;
          return answer;
        },
      });
      expect(warned).toEqual([ANTIGRAVITY_RISK_WARNING]);
      return { decision, asked: asked.length };
    };
    expect(await run(true, false, "")).toEqual({ decision: "accepted", asked: 0 });
    expect(await run(true, true, "n")).toEqual({ decision: "accepted", asked: 0 });
    expect(await run(false, false, "y")).toEqual({ decision: "noninteractive", asked: 0 });
    for (const yes of ["y", "Y", " yes ", "YES"]) expect((await run(false, true, yes)).decision).toBe("accepted");
    for (const no of ["", "n", "no", "sure", "yess"]) expect((await run(false, true, no)).decision).toBe("declined");
    expect((await run(false, true, new Error("stdin closed"))).decision).toBe("declined");
    // An agent is refused before the flag or a prompt can decide.
    expect(await run(true, true, "y", true)).toEqual({ decision: "agent", asked: 0 });
  });
});

describe("POST /api/oauth/login", () => {
  test.each([
    ["login", {}],
    ["add-account", { addAccount: true }],
    ["reauth", { reauth: true }],
  ] as const)("Antigravity %s is refused without the acknowledgement, for every principal", async (_mode, flags) => {
    const cfg = config();
    saveConfig(cfg);
    const login = spyOn(oauth, "startLoginFlow").mockResolvedValue({ url: "https://accounts.google.test/auth" });
    try {
      for (const principal of ["gui-session", "admin-token"]) {
        for (const ack of [undefined, false, "true"]) {
          const body = { provider: "google-antigravity", ...flags, openBrowser: false, ...(ack === undefined ? {} : { [ANTIGRAVITY_RISK_ACK_FIELD]: ack }) };
          const response = await send(cfg, post("/api/oauth/login", body), principal);
          expect(response?.status).toBe(403);
          const json = await response?.json() as { code?: string; error?: string };
          expect(json.code).toBe(ANTIGRAVITY_RISK_REFUSAL_CODE);
          expect(json.error).toContain(ANTIGRAVITY_RISK_CLI_FLAG);
        }
      }
      expect(login).not.toHaveBeenCalled();
    } finally { login.mockRestore(); }
  });

  test("with the acknowledgement the Antigravity flow starts, and other providers never need it", async () => {
    const cfg = config();
    saveConfig(cfg);
    const login = spyOn(oauth, "startLoginFlow").mockResolvedValue({ url: "https://accounts.google.test/auth" });
    try {
      const accepted = await send(cfg, post("/api/oauth/login", { provider: "google-antigravity", openBrowser: false, [ANTIGRAVITY_RISK_ACK_FIELD]: true }));
      expect(accepted?.status).toBe(200);
      expect(login).toHaveBeenCalledTimes(1);
      expect(login.mock.calls[0]![0]).toBe("google-antigravity");

      const other = await send(cfg, post("/api/oauth/login", { provider: "xai", openBrowser: false }), "admin-token");
      expect(other?.status).toBe(200);
      expect(login).toHaveBeenLastCalledWith("xai", expect.anything(), expect.anything());
    } finally { login.mockRestore(); }
  });
});

describe("POST /api/oauth/accounts/import", () => {
  test("an Antigravity import is refused without the acknowledgement before the document is read", async () => {
    const cfg = config();
    saveConfig(cfg);
    const document = [{ email: "person@example.test", refresh_token: "synthetic-refresh" }];
    for (const ack of [undefined, false, "yes"]) {
      const body = { provider: "google-antigravity", format: "cockpit-tools", document, ...(ack === undefined ? {} : { [ANTIGRAVITY_RISK_ACK_FIELD]: ack }) };
      const response = await send(cfg, post("/api/oauth/accounts/import", body));
      expect(response?.status).toBe(403);
      expect(await response?.json()).toEqual({ code: ANTIGRAVITY_RISK_REFUSAL_CODE });
    }
    expect(getAccountSet("google-antigravity")).toBeNull();
  });

  test("with the acknowledgement the import proceeds to its own validation", async () => {
    const cfg = config();
    saveConfig(cfg);
    const response = await send(cfg, post("/api/oauth/accounts/import", {
      provider: "google-antigravity", format: "cockpit-tools", document: "not-an-array", [ANTIGRAVITY_RISK_ACK_FIELD]: true,
    }));
    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({ code: "invalid_document" });
  });
});

/**
 * `ocx login` runs the OAuth flow in-process, so no management API check stands behind it: the
 * prompt is the only gate, and these cases prove it holds before the flow starts.
 */
describe("ocx login google-antigravity", () => {
  async function runLogin(opts: { flag?: boolean; interactive: boolean; answer?: string; provider?: string; agent?: boolean }) {
    const started: string[] = [];
    const asked: string[] = [];
    const errors: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation((...parts: unknown[]) => { errors.push(parts.join(" ")); });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`process.exit:${code}`); }) as never);
    let exit: string | undefined;
    try {
      await handleLogin(opts.provider ?? "google-antigravity", {
        runLogin: (async (provider: string) => { started.push(provider); }) as never,
        openUrl: async () => ({ status: "started" }),
        warn: () => {},
        isInteractive: () => opts.interactive,
        agentDriven: () => opts.agent === true,
        ask: async question => { asked.push(question); return opts.answer ?? ""; },
      }, { acceptAntigravityRisk: opts.flag === true });
    } catch (error) {
      exit = error instanceof Error ? error.message : String(error);
    } finally {
      exitSpy.mockRestore(); logSpy.mockRestore(); errorSpy.mockRestore();
    }
    return { started, asked, errors: errors.join("\n"), exit };
  }

  test("a non-interactive run without the flag is refused before the flow starts", async () => {
    const result = await runLogin({ interactive: false });
    expect(result.exit).toBe("process.exit:1");
    expect(result.started).toEqual([]);
    expect(result.asked).toEqual([]);
    expect(result.errors).toContain(ANTIGRAVITY_TOS_BAN_MESSAGE);
    expect(result.errors).toContain(ANTIGRAVITY_RISK_REFUSAL_CODE);
  });

  test("a terminal must answer y; the flag skips the prompt but not the warning", async () => {
    const declined = await runLogin({ interactive: true, answer: "n" });
    expect(declined.exit).toBe("process.exit:1");
    expect(declined.started).toEqual([]);
    expect(declined.asked).toHaveLength(1);

    const accepted = await runLogin({ interactive: true, answer: "y" });
    expect(accepted.exit).toBeUndefined();
    expect(accepted.started).toEqual(["google-antigravity"]);

    const flagged = await runLogin({ interactive: false, flag: true });
    expect(flagged.exit).toBeUndefined();
    expect(flagged.started).toEqual(["google-antigravity"]);
    expect(flagged.asked).toEqual([]);
    expect(flagged.errors).toContain(ANTIGRAVITY_TOS_BAN_MESSAGE);
  });

  test("a coding agent or CI runner is refused even with the flag or a y answer", async () => {
    for (const run of [{ flag: true, interactive: false }, { interactive: true, answer: "y" }]) {
      const result = await runLogin({ ...run, agent: true });
      expect(result.exit).toBe("process.exit:1");
      expect(result.started).toEqual([]);
      expect(result.asked).toEqual([]);
      expect(result.errors).toContain("coding agent or CI runner");
    }
  });

  test("other providers neither prompt nor accept the flag", async () => {
    const other = await runLogin({ interactive: false, provider: "xai" });
    expect(other.exit).toBeUndefined();
    expect(other.started).toEqual(["xai"]);
    expect(other.errors).not.toContain("Antigravity");

    const misplaced = await runLogin({ interactive: false, provider: "xai", flag: true });
    expect(misplaced.exit).toBe("process.exit:1");
    expect(misplaced.started).toEqual([]);
    expect(misplaced.errors).toContain(ANTIGRAVITY_RISK_CLI_FLAG);
  });
});
