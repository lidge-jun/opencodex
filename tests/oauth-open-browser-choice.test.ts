import { describe, expect, spyOn, test } from "bun:test";
import { shouldOpenBrowserForLogin } from "../src/oauth/open-browser-choice";
import { handleOauthAccountRoutes } from "../src/server/management/oauth-account-routes";
import type { OcxConfig } from "../src/types";

/**
 * The operator can stop the proxy from opening a browser on its own machine —
 * which is the only way to finish a login in a non-default browser profile, or
 * from a machine that is not the one running the proxy.
 *
 * The load-bearing assertion in this file is the FIRST one: an install that
 * configures nothing must behave exactly as it did before. Everything else is
 * the new capability; that one is the promise not to break anyone.
 */

function config(oauthOpenBrowser?: boolean): OcxConfig {
  return { port: 0, hostname: "127.0.0.1", defaultProvider: "xai", providers: {}, ...(oauthOpenBrowser === undefined ? {} : { oauthOpenBrowser }) } as OcxConfig;
}

describe("shouldOpenBrowserForLogin", () => {
  test("an unconfigured install still opens the browser", () => {
    expect(shouldOpenBrowserForLogin(undefined, config())).toBe(true);
  });

  test("the persisted setting decides when the request says nothing", () => {
    expect(shouldOpenBrowserForLogin(undefined, config(true))).toBe(true);
    expect(shouldOpenBrowserForLogin(undefined, config(false))).toBe(false);
  });

  test("a per-request choice beats the persisted setting, both ways", () => {
    expect(shouldOpenBrowserForLogin(false, config(true))).toBe(false);
    expect(shouldOpenBrowserForLogin(true, config(false))).toBe(true);
  });

  test("a malformed request field is ignored rather than failing the login", () => {
    // This is a display preference. Rejecting the request over it would turn a
    // typo in one client into a login that cannot start at all.
    expect(shouldOpenBrowserForLogin("nope", config())).toBe(true);
    expect(shouldOpenBrowserForLogin(0, config())).toBe(true);
    expect(shouldOpenBrowserForLogin(null, config(false))).toBe(false);
  });
});

async function startLogin(
  body: Record<string, unknown>,
  cfg: OcxConfig,
): Promise<{ opened: string[]; url?: string }> {
  const oauth = await import("../src/oauth");
  const openUrlMod = await import("../src/lib/open-url");
  const opened: string[] = [];
  const startSpy = spyOn(oauth, "startLoginFlow").mockResolvedValue({ url: "https://accounts.x.ai/oauth/authorize?code_challenge=x" });
  const openSpy = spyOn(openUrlMod, "openUrl").mockImplementation((url: string) => { opened.push(url); });
  try {
    const req = new Request("http://127.0.0.1/api/oauth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "xai", ...body }),
    });
    const response = await handleOauthAccountRoutes({
      req,
      url: new URL(req.url),
      config: cfg,
      deps: {},
      convergeCodexCatalog: async () => ({ status: "failed", reason: "disk" }),
      syncClaudeAgentDefsBestEffort: async () => {},
    });
    const json = await response!.json() as { url?: string };
    return { opened, url: json.url };
  } finally {
    startSpy.mockRestore();
    openSpy.mockRestore();
  }
}

describe("POST /api/oauth/login honors the choice", () => {
  test("opens by default, and the URL is returned either way", async () => {
    const { opened, url } = await startLogin({}, config());
    expect(opened).toEqual(["https://accounts.x.ai/oauth/authorize?code_challenge=x"]);
    expect(url).toBe("https://accounts.x.ai/oauth/authorize?code_challenge=x");
  });

  test("declining spawns nothing but still hands back the link to copy", async () => {
    const { opened, url } = await startLogin({ openBrowser: false }, config());
    expect(opened).toEqual([]);
    // Declining must never mean losing the way in.
    expect(url).toBe("https://accounts.x.ai/oauth/authorize?code_challenge=x");
  });

  test("the persisted setting applies with no request field", async () => {
    const { opened } = await startLogin({}, config(false));
    expect(opened).toEqual([]);
  });

  test("a request opt-in overrides a persisted opt-out", async () => {
    const { opened } = await startLogin({ openBrowser: true }, config(false));
    expect(opened).toEqual(["https://accounts.x.ai/oauth/authorize?code_challenge=x"]);
  });
});

describe("the rollback path keeps the setting honest", () => {
  test("a failed save restores the previous value instead of leaving it half-applied", async () => {
    const { handleManagementAPI } = await import("../src/server/management-api");
    const cfg = { port: 10100, defaultProvider: "openai", providers: {} } as OcxConfig;
    const req = new Request("http://127.0.0.1:10100/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", host: "127.0.0.1:10100" },
      body: JSON.stringify({ oauthOpenBrowser: false }),
    });
    // The live config object is shared by reference with the request handlers, so a
    // write that fails to reach disk must not leave the process disagreeing with the file.
    await handleManagementAPI(req, new URL(req.url), cfg, {
      saveConfigPreservingClaudeCode: () => { throw new Error("disk full"); },
    }).catch(() => {});
    expect(Object.hasOwn(cfg, "oauthOpenBrowser")).toBe(false);
  });
});
