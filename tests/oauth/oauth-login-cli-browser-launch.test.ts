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
  test("an instruction-only Keychain hint never launches an empty browser URL", async () => {
    let launches = 0;
    const lines: string[] = [];
    const capture = spyOn(console, "log").mockImplementation(line => { lines.push(String(line)); });
    try {
      await handleOAuthLogin(anyOAuthProvider(), {
        runLogin: async (_provider, ctrl) => {
          ctrl.onAuth?.({ url: "", instructions: "Approve the Muse Code Keychain prompt." });
          return {} as OAuthCredentials;
        },
        openUrl: async () => { launches++; return { status: "started" }; },
      });
      expect(launches).toBe(0);
      expect(lines.join(" ")).toContain("Approve the Muse Code Keychain prompt.");
      expect(lines.join(" ")).not.toContain("Opening browser");
    } finally { capture.mockRestore(); }
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

  test("provider-supplied URL and instructions reach the terminal escaped, and the launcher raw", async () => {
    // The device flow hands the CLI a provider-supplied verification URL and an instruction line
    // quoting the provider's user code. Both land in a tty, so a control sequence in either would
    // rewrite the operator's screen. The launcher still needs the real URL, and a normal URL and
    // code must print unchanged — escaping is not a rewrite of the value itself.
    const lines: string[] = [];
    const launched: string[] = [];
    const capture = spyOn(console, "log").mockImplementation(line => { lines.push(String(line)); });
    const hostileUrl = "https://accounts.x.ai/oauth2/device\u001b[31m?user_code=AB";
    const hostileInstructions = "Confirm the code\u001b]0;pwnd\u0007AB";
    try {
      await handleOAuthLogin(anyOAuthProvider(), {
        runLogin: async (_provider, ctrl) => {
          ctrl.onAuth?.({ url: hostileUrl, instructions: hostileInstructions, deviceCode: "AB" });
          return {} as OAuthCredentials;
        },
        openUrl: async (url: string) => { launched.push(url); return { status: "started" }; },
      });
    } finally { capture.mockRestore(); }

    const printed = lines.join("\n");
    expect(printed).not.toContain("\u001b");
    expect(printed).not.toContain("\u0007");
    expect(printed).toContain("\\x1b[31m");
    expect(printed).toContain("\\x07");
    // The value is only escaped where a human reads it.
    expect(launched).toEqual([hostileUrl]);
  });

  test("an ordinary URL, code and instruction print unchanged", async () => {
    const lines: string[] = [];
    const capture = spyOn(console, "log").mockImplementation(line => { lines.push(String(line)); });
    try {
      await handleOAuthLogin(anyOAuthProvider(), {
        runLogin: async (_provider, ctrl) => {
          ctrl.onAuth?.({
            url: "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH",
            instructions: "Open this URL in any browser and confirm the code ABCD-EFGH.",
            deviceCode: "ABCD-EFGH",
          });
          return {} as OAuthCredentials;
        },
        openUrl: async () => ({ status: "started" }),
      });
    } finally { capture.mockRestore(); }

    const printed = lines.join("\n");
    expect(printed).toContain("https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH");
    expect(printed).toContain("confirm the code ABCD-EFGH.");
    expect(printed).not.toContain("\\x");
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

describe("provider-supplied progress text reaches the terminal escaped (#8436)", () => {
  /**
   * The Meta Muse device login ends by printing an action URL it took from the provider payload
   * (`src/oauth/meta-muse-device.ts`), so `onProgress` carries provider-derived text — not the
   * fixed sentences most flows send. It used to be interpolated straight into `console.log`, which
   * left a bidi override or a line separator free to rewrite the operator's screen.
   */
  const HOSTILE_PROGRESS =
    "Meta reports this account needs a subscription or payment method: "
    + "https://pay.example.test/\u202echeckout\u061c?step=1\u2028&next=\u206a\u206f\u{e0041}";
  const UNSAFE_CODES = [0x202e, 0x061c, 0x2028, 0x206a, 0x206f, 0xe0041] as const;

  test("the browser flow escapes progress text and keeps the URL it was given intact", async () => {
    const lines: string[] = [];
    const seen: string[] = [];
    const capture = spyOn(console, "log").mockImplementation(line => { lines.push(String(line)); });
    try {
      await handleOAuthLogin(anyOAuthProvider(), {
        runLogin: async (_provider, ctrl) => {
          ctrl.onAuth?.({ url: "https://accounts.example.test/authorize?state=progress" });
          ctrl.onProgress?.(HOSTILE_PROGRESS);
          seen.push(HOSTILE_PROGRESS);
          return {} as OAuthCredentials;
        },
        openUrl: async () => ({ status: "started" }),
        ask: async () => "",
      });
    } finally { capture.mockRestore(); }

    const printed = lines.join("\n");
    for (const code of UNSAFE_CODES) expect(printed).not.toContain(String.fromCodePoint(code));
    // Escaped, not dropped: the value survives in a readable form so a pasted report reproduces it.
    expect(printed).toContain("https://pay.example.test/\\u202echeckout\\u061c?step=1\\u2028&next=\\u206a\\u206f\\u{e0041}");
    // The callback's own argument is data, not a rendering surface: nothing here rewrites it.
    expect(seen).toEqual([HOSTILE_PROGRESS]);
  });

  test("ordinary progress text still prints as one prefixed line", async () => {
    const lines: string[] = [];
    const capture = spyOn(console, "log").mockImplementation(line => { lines.push(String(line)); });
    try {
      await handleOAuthLogin(anyOAuthProvider(), {
        runLogin: async (_provider, ctrl) => {
          ctrl.onAuth?.({ url: "https://accounts.example.test/authorize?state=plain" });
          ctrl.onProgress?.("Waiting for approval…");
          return {} as OAuthCredentials;
        },
        openUrl: async () => ({ status: "started" }),
        ask: async () => "",
      });
    } finally { capture.mockRestore(); }

    expect(lines).toContain("   Waiting for approval…");
    expect(lines.join("\n")).not.toContain("\\u");
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
