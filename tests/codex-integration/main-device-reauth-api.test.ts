import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleMainDeviceReauthAPI } from "../../src/codex/main-device-reauth-api";
import { resetMainDeviceReauthForTests } from "../../src/codex/main-device-reauth";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * #3898 route contract: /api/codex-auth/main/reauth-device is the only
 * device-reauth surface for the native main slot. Safe 400/404/405/409/503
 * shapes, strict request keys, and no token material in any payload.
 */

const ROUTE = "http://localhost/api/codex-auth/main/reauth-device";
const USERCODE = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN = "https://auth.openai.com/api/accounts/deviceauth/token";

const realFetch = globalThis.fetch;
let home: string;
let previousCodexHome: string | undefined;

const config = { port: 0 } as OcxConfig;

function call(method: string, query = "", body?: string): Promise<Response | null> {
  const url = new URL(ROUTE + query);
  const req = body === undefined
    ? new Request(url, { method })
    : new Request(url, { method, body, headers: { "content-type": "application/json" } });
  return handleMainDeviceReauthAPI(req, url, config);
}

/** Device endpoints that stay pending forever, so the flow never leaves pending. */
function stubPendingDevice(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === USERCODE) {
      return new Response(JSON.stringify({
        device_auth_id: "auth-id-opaque",
        user_code: "ABCD-1234",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === DEVICE_TOKEN) {
      return new Response("{}", { status: 403, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

beforeEach(() => {
  resetMainDeviceReauthForTests();
  home = mkdtempSync(join(tmpdir(), "ocx-main-reauth-api-"));
  previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetMainDeviceReauthForTests();
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(home);
});

function writeMainCredential(): void {
  writeFileSync(join(home, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: "old-access",
      refresh_token: "old-refresh",
      account_id: "acct-main-1",
    },
  }));
}

describe("native main device reauth route (#3898)", () => {
  test("other paths fall through", async () => {
    const url = new URL("http://localhost/api/codex-auth/login");
    const handled = await handleMainDeviceReauthAPI(new Request(url, { method: "POST" }), url, config);
    expect(handled).toBeNull();
  });

  test("start without a native credential answers 503 native_main_unavailable", async () => {
    const response = await call("POST");
    expect(response?.status).toBe(503);
    const body = await response!.json() as { code: string };
    expect(body.code).toBe("native_main_unavailable");
  });

  test("start rejects an unexpected body", async () => {
    writeMainCredential();
    const response = await call("POST", "", JSON.stringify({ id: "__main__" }));
    expect(response?.status).toBe(400);
  });

  test("status requires an exact flowId query", async () => {
    expect((await call("GET"))?.status).toBe(400);
    expect((await call("GET", "?flowId="))?.status).toBe(400);
    expect((await call("GET", "?flowId=x&extra=1"))?.status).toBe(400);
  });

  test("unknown flows answer 404 for status and cancel", async () => {
    expect((await call("GET", "?flowId=nope"))?.status).toBe(404);
    expect((await call("DELETE", "?flowId=nope"))?.status).toBe(404);
  });

  test("unsupported methods answer 405", async () => {
    expect((await call("PUT"))?.status).toBe(405);
  });

  test("start, poll and cancel round trip with a pending device grant", async () => {
    writeMainCredential();
    stubPendingDevice();
    const started = await call("POST");
    expect(started?.status).toBe(200);
    const pending = await started!.json() as { flowId: string; status: string };
    expect(pending.status).toBe("pending");
    // The URL/code arrive with the usercode response; give the microtask a turn.
    await Bun.sleep(20);
    const polled = await call("GET", `?flowId=${pending.flowId}`);
    const polledBody = await polled!.json() as Record<string, unknown>;
    expect(polledBody.status).toBe("pending");
    expect(polledBody.deviceCode).toBe("ABCD-1234");
    expect(String(polledBody.verificationUrl)).toContain("codex/device");
    const cancelled = await call("DELETE", `?flowId=${pending.flowId}`);
    expect(cancelled?.status).toBe(200);
    expect(await cancelled!.json() as Record<string, unknown>).toMatchObject({ status: "cancelled" });
    for (const payload of [pending, polledBody, await (await call("GET", `?flowId=${pending.flowId}`))!.json()]) {
      const json = JSON.stringify(payload);
      expect(json).not.toContain("old-access");
      expect(json).not.toContain("old-refresh");
      expect(json).not.toContain("acct-main-1");
    }
  });

  test("a second start while active answers 409 flow_in_progress", async () => {
    writeMainCredential();
    stubPendingDevice();
    const first = await call("POST");
    expect(first?.status).toBe(200);
    const second = await call("POST");
    expect(second?.status).toBe(409);
    expect((await second!.json() as { code: string }).code).toBe("flow_in_progress");
  });
});
