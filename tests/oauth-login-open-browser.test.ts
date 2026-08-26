import { describe, expect, spyOn, test } from "bun:test";
import { handleOauthAccountRoutes } from "../src/server/management/oauth-account-routes";
import type { OcxConfig } from "../src/types";

/**
 * The login route decides whether to spawn a browser on the machine running the
 * proxy, and it decides it from one field: a flow that reports a `deviceCode`
 * is a device flow and is never auto-opened.
 *
 * That coupling is invisible from either side. A provider author setting
 * `deviceCode` for a GUI widget is also, silently, turning off a process spawn;
 * a reader of the route sees a field whose producer is three files away. These
 * assertions pin both directions so neither can drift without a red test.
 */

function loginRequest(provider: string): Request {
  return new Request("http://127.0.0.1/api/oauth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider }),
  });
}

function baseConfig(): OcxConfig {
  return { port: 0, hostname: "127.0.0.1", defaultProvider: "kimi", providers: {} } as OcxConfig;
}

async function startLogin(flow: { url: string; instructions?: string; deviceCode?: string }): Promise<{
  opened: string[];
  body: { url?: string; deviceCode?: string; instructions?: string };
}> {
  const oauth = await import("../src/oauth");
  const openUrlMod = await import("../src/lib/open-url");
  const opened: string[] = [];
  const startSpy = spyOn(oauth, "startLoginFlow").mockResolvedValue(flow);
  const openSpy = spyOn(openUrlMod, "openUrl").mockImplementation((url: string) => { opened.push(url); });
  try {
    const req = loginRequest("kimi");
    const response = await handleOauthAccountRoutes({
      req,
      url: new URL(req.url),
      config: baseConfig(),
      deps: {},
      convergeCodexCatalog: async () => ({ status: "failed", reason: "disk" }),
      syncClaudeAgentDefsBestEffort: async () => {},
    });
    return { opened, body: await response!.json() as { url?: string; deviceCode?: string; instructions?: string } };
  } finally {
    startSpy.mockRestore();
    openSpy.mockRestore();
  }
}

describe("POST /api/oauth/login browser opening", () => {
  test("a device flow is not opened server-side, and still returns its URL and code", async () => {
    const { opened, body } = await startLogin({
      url: "https://auth.kimi.com/device?user_code=WDJB-MJHT",
      instructions: "Enter code: WDJB-MJHT",
      deviceCode: "WDJB-MJHT",
    });

    // No provider-supplied verification URI reaches a local process spawn.
    expect(opened).toEqual([]);
    // The user keeps every way to finish the login by hand.
    expect(body.url).toBe("https://auth.kimi.com/device?user_code=WDJB-MJHT");
    expect(body.deviceCode).toBe("WDJB-MJHT");
  });

  test("a browser redirect flow is still opened, exactly as before", async () => {
    const { opened, body } = await startLogin({ url: "https://accounts.example.test/authorize?code=1" });

    expect(opened).toEqual(["https://accounts.example.test/authorize?code=1"]);
    expect(body.deviceCode).toBeUndefined();
  });
});
