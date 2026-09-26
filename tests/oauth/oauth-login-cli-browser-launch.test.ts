/**
 * #5261 remainder: the two CLI logins that still discarded the launcher's answer.
 *
 * The landed half taught `openUrl` to say whether anything started, and the Codex account login
 * to print it. `ocx login <oauth-provider>` and `ocx login <key-provider>` kept calling
 * `void openUrl(...)`, so on a host with no browser both printed a URL, claimed to be opening
 * it, and then asked a question that assumes it opened. The user waits at a prompt that looks
 * like progress.
 *
 * What these assert is the ORDER, not merely the presence of a warning. The OAuth controller
 * does not await `onAuth`, so the launcher answers after the login flow has moved on — on a
 * callback-server provider, after it has already drawn a readline prompt. A warning that lands
 * there is written over the line the user is typing on, which is why "it warns eventually" is
 * not the contract.
 *
 * Nothing here opens a browser or attaches to stdin: both are injected, which is the only way
 * two events can be observed in sequence at all.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { handleKeyLogin, handleOAuthLogin, type LoginCliDeps } from "../../src/oauth/login-cli";
import { KEY_LOGIN_PROVIDERS } from "../../src/oauth/key-providers";
import { listOAuthProviders } from "../../src/oauth";
import { BROWSER_LAUNCH_FAILED_NOTICE, createBrowserLaunchReport } from "../../src/lib/browser-launch-notice";
import { BROWSER_LAUNCH_FAILED_HINT } from "../../src/cli/account-auth";
import { repoPath } from "../helpers/repo-root";
import { readFileSync } from "node:fs";
import type { OpenUrlResult } from "../../src/lib/open-url";
import type { OAuthCredentials } from "../../src/oauth/types";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let logSpy: { mockRestore(): void } | null = null;

type FakeRunLogin = NonNullable<LoginCliDeps["runLogin"]>;

/** Named from the roster rather than typed in, so a renamed provider cannot leave this passing. */
function anyOAuthProvider(): string {
  const [first] = listOAuthProviders();
  if (!first) throw new Error("no OAuth providers are registered");
  return first;
}

/** A key provider whose baseUrl needs no placeholder resolution, so one prompt ends the flow. */
function anyDirectKeyProvider(): string {
  const found = Object.entries(KEY_LOGIN_PROVIDERS).find(([, def]) => !/\{[^}]*\}/.test(def.baseUrl));
  if (!found) throw new Error("no key-login provider has a resolved baseUrl");
  return found[0];
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-login-launch-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-login-launch-"));
  process.env.OPENCODEX_HOME = testDir;
  // The one row exists so the config validates; it is deliberately not the provider under test,
  // which keeps the post-login live-reload notify from looking for a proxy. An empty table would
  // fail validation and be silently replaced by the packaged default, whose contents this has no
  // reason to depend on.
  saveConfig({
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "login-launch-stub",
    providers: {
      "login-launch-stub": {
        adapter: "openai-chat",
        baseUrl: "https://stub.invalid/v1",
        apiKey: "sk-login-launch-stub",
      },
    },
  } as OcxConfig);
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy?.mockRestore();
  logSpy = null;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
  testDir = "";
});

describe("CLI OAuth login reports the browser launch (#5261)", () => {
  test("Mirasim --code - reads the verification code from the prompt instead of argv", async () => {
    let receivedCode: string | undefined;
    const prompts: string[] = [];
    const login: FakeRunLogin = async (_provider, _ctrl, opts) => {
      receivedCode = opts?.mirasimCode;
      return {} as OAuthCredentials;
    };

    await handleOAuthLogin("mirasim", {
      runLogin: login,
      openUrl: async () => ({ status: "started" }),
      ask: async question => { prompts.push(question); return "654321"; },
    }, { mirasimEmail: "user@example.com", mirasimCode: "-" });

    expect(receivedCode).toBe("654321");
    expect(prompts).toEqual(["Enter the Mirasim sign-in code: "]);
  });

  test("a browser that never opened is on screen before the paste prompt", async () => {
    const events: string[] = [];
    let settleLaunch: (result: OpenUrlResult) => void = () => {};
    const launch = new Promise<OpenUrlResult>(resolve => { settleLaunch = resolve; });
    const login: FakeRunLogin = async (_provider, ctrl) => {
      ctrl.onAuth?.({ url: "https://accounts.example.test/authorize?state=1" });
      // The launcher answers only after onAuth has returned. That gap is the defect: the old
      // code had already discarded the promise by this point.
      settleLaunch({ status: "failed", reason: "launcher-exit" });
      expect(await ctrl.onManualCodeInput?.()).toBe("pasted-code");
      return {} as OAuthCredentials;
    };

    await handleOAuthLogin(anyOAuthProvider(), {
      runLogin: login,
      openUrl: () => launch,
      warn: message => { events.push(`warn:${message}`); },
      ask: async () => { events.push("ask"); return "pasted-code"; },
    });

    expect(events).toEqual([`warn:\n${BROWSER_LAUNCH_FAILED_NOTICE}`, "ask"]);
  });

  test("a browser that did open adds nothing to the prompt", async () => {
    // A non-regression guard rather than proof of the fix: it passed before this change too, and
    // it is here so the new warning cannot start firing on a launch that worked.
    const events: string[] = [];
    const login: FakeRunLogin = async (_provider, ctrl) => {
      ctrl.onAuth?.({ url: "https://accounts.example.test/authorize?state=2" });
      await ctrl.onManualCodeInput?.();
      return {} as OAuthCredentials;
    };

    await handleOAuthLogin(anyOAuthProvider(), {
      runLogin: login,
      openUrl: async () => ({ status: "started" }),
      warn: message => { events.push(`warn:${message}`); },
      ask: async () => { events.push("ask"); return "pasted-code"; },
    });

    expect(events).toEqual(["ask"]);
  });

  test("a polling flow that never prompts is still told the launch failed", async () => {
    // Device and polling providers publish a URL and then wait. Nothing asks a question, so
    // nothing there would have waited on the launcher; the answer is still owed before the
    // login claims to have worked.
    const events: string[] = [];
    const login: FakeRunLogin = async (_provider, ctrl) => {
      ctrl.onAuth?.({ url: "https://device.example.test/activate", deviceCode: "WDJB-MJHT" });
      ctrl.onProgress?.("Waiting for approval...");
      return {} as OAuthCredentials;
    };

    await handleOAuthLogin(anyOAuthProvider(), {
      runLogin: login,
      openUrl: async () => ({ status: "failed", reason: "spawn-error" }),
      warn: () => { events.push("warn"); },
      ask: async () => { events.push("ask"); return ""; },
    });

    expect(events).toEqual(["warn"]);
  });

  test("a launcher that throws is reported, not turned into a failed login", async () => {
    // openUrl documents that it never rejects, but this seam accepts any launcher. A rejection
    // here used to travel out through settled(), which a polling flow does not await until the
    // whole login has finished — so it would surface as an unhandled rejection and take down a
    // login that could still have completed by hand.
    const events: string[] = [];
    const login: FakeRunLogin = async (_provider, ctrl) => {
      ctrl.onAuth?.({ url: "https://accounts.example.test/authorize?state=3" });
      ctrl.onProgress?.("Waiting for browser authentication...");
      return {} as OAuthCredentials;
    };

    await handleOAuthLogin(anyOAuthProvider(), {
      runLogin: login,
      openUrl: async () => { throw new Error("launcher blew up"); },
      warn: () => { events.push("warn"); },
      ask: async () => { events.push("ask"); return ""; },
    });

    expect(events).toEqual(["warn"]);
  });
});

describe("CLI key login reports the dashboard launch (#5261)", () => {
  test("a dashboard that never opened is on screen before the key prompt", async () => {
    const events: string[] = [];
    const errors: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
      errors.push(parts.join(" "));
    });
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);

    try {
      await expect(handleKeyLogin(anyDirectKeyProvider(), {
        openUrl: async () => ({ status: "failed", reason: "launcher-exit" }),
        warn: () => { events.push("warn"); },
        // An empty key ends the flow immediately after the prompt. The key path beyond it is
        // already covered where it lives; what this case is about is what precedes the question.
        ask: async () => { events.push("ask"); return ""; },
      })).rejects.toThrow("process.exit:1");
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(events).toEqual(["warn", "ask"]);
    expect(errors).toContain("No key entered.");
  });
});

describe("the launch report is one sentence and one order", () => {
  test("settled() cannot resolve before the warning is written", async () => {
    const events: string[] = [];
    let settleLaunch: (result: OpenUrlResult) => void = () => {};
    const launch = new Promise<OpenUrlResult>(resolve => { settleLaunch = resolve; });
    const report = createBrowserLaunchReport(() => { events.push("warn"); });

    report.track(launch);
    const waited = report.settled().then(() => { events.push("prompt"); });
    settleLaunch({ status: "failed", reason: "invalid-url" });
    await waited;

    expect(events).toEqual(["warn", "prompt"]);
  });

  test("a report with nothing tracked resolves rather than hanging", async () => {
    const events: string[] = [];
    await createBrowserLaunchReport(() => { events.push("warn"); }).settled();
    expect(events).toEqual([]);
  });

  test("the Codex account hint extends the shared notice instead of holding its own copy", () => {
    // Asserting only that the strings agree would pass on a second copy that happens to match
    // today, which is the state this replaced. The source is read as well, so the sentence has
    // exactly one home and a later edit to it cannot reach two thirds of the logins.
    expect(BROWSER_LAUNCH_FAILED_HINT.startsWith(BROWSER_LAUNCH_FAILED_NOTICE)).toBe(true);
    expect(BROWSER_LAUNCH_FAILED_HINT.length).toBeGreaterThan(BROWSER_LAUNCH_FAILED_NOTICE.length);

    const accountAuth = readFileSync(repoPath("src", "cli", "account-auth.ts"), "utf8");
    expect(accountAuth).toContain("BROWSER_LAUNCH_FAILED_NOTICE");
    expect(accountAuth).not.toContain(BROWSER_LAUNCH_FAILED_NOTICE);
  });
});
