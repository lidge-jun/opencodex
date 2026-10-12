import { afterEach, describe, expect, test } from "bun:test";
import { saveConfig } from "../../src/config";
import { clearLoginState, OAUTH_PROVIDERS } from "../../src/oauth";
import { cancelKiroDeviceLogin, setKiroDevicePublishForTests, startKiroDeviceLogin, statusKiroDeviceLogin } from "../../src/oauth/kiro-device-login";
import { getAccountSet, mutateStore, oauthMutationTailSnapshot } from "../../src/oauth/store";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import { kiroDeviceFixture, profileArn, response, socialAuthorization } from "../helpers/kiro-device-fixture";

let fixture: ReturnType<typeof kiroDeviceFixture> | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

function config(): OcxConfig {
  return { port: 10100, defaultProvider: "openai", providers: {} } as OcxConfig;
}
async function api(config: OcxConfig, path: string, body?: Record<string, unknown>, principal: "gui-session" | "admin-token" = "admin-token") {
  const req = new Request(`http://127.0.0.1:10100${path}`, body ? {
    method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1:10100" }, body: JSON.stringify(body),
  } : { headers: { host: "127.0.0.1:10100" } });
  const result = await handleManagementAPI(req, new URL(req.url), config, {}, principal);
  return { status: result?.status, data: await result?.json() as Record<string, unknown> };
}

describe("native Kiro management login", () => {
  test("native only with a valid method; reauth and invalid methods are rejected", async () => {
    fixture = kiroDeviceFixture();
    const cfg = config(); saveConfig(cfg);
    let calls = 0;
    fixture.setPost(async url => { calls++; return response(socialAuthorization); });
    expect((await api(cfg, "/api/oauth/login", { provider: "kiro", method: "other" })).status).toBe(400);
    expect((await api(cfg, "/api/oauth/login", { provider: "kiro", reauth: true })).status).toBe(400);
    const addOnly = await api(cfg, "/api/oauth/login", { provider: "kiro", method: "google", reauth: true, accountId: "a" });
    expect(addOnly.status).toBe(400);
    expect(addOnly.data.error).toBe("native_login_is_add_only");
    const started = await api(cfg, "/api/oauth/login", { provider: "kiro", method: "google" });
    expect(started.status).toBe(200);
    expect(started.data.method).toBe("google");
    expect(calls).toBe(1);
  });

  test("a method-less start stays on the kiro-cli login flow", async () => {
    fixture = kiroDeviceFixture();
    const cfg = config(); saveConfig(cfg);
    fixture.setPost(async () => { throw new Error("native transport must not run"); });
    const original = OAUTH_PROVIDERS.kiro.login;
    let invoked = false;
    OAUTH_PROVIDERS.kiro.login = async ctrl => {
      invoked = true;
      ctrl.onAuth?.({ url: "https://example.test/kiro-cli" });
      throw new Error("synthetic CLI stop");
    };
    try {
      const started = await api(cfg, "/api/oauth/login", { provider: "kiro", openBrowser: false });
      expect(started.status).toBe(200);
      expect(started.data.url).toBe("https://example.test/kiro-cli");
      expect(started.data.flowId).toBeUndefined();
      expect(invoked).toBe(true);
    } finally {
      OAUTH_PROVIDERS.kiro.login = original;
      clearLoginState("kiro");
    }
  });

  test("different principal cannot poll or cancel; responses contain no upstream secrets", async () => {
    fixture = kiroDeviceFixture();
    const cfg = config(); saveConfig(cfg);
    fixture.setPost(async url => url.endsWith("/authorization") ? response(socialAuthorization)
      : response({ status: "approved", accessToken: "private-access", refreshToken: "private-refresh", profileArn }));
    const start = await api(cfg, "/api/oauth/login", { provider: "kiro", method: "google" }, "gui-session");
    const id = String(start.data.flowId);
    expect((await api(cfg, `/api/oauth/status?provider=kiro&flowId=${id}`, undefined, "admin-token")).status).toBe(404);
    expect((await api(cfg, "/api/oauth/login/cancel", { provider: "kiro", flowId: id }, "admin-token")).status).toBe(404);
    fixture.advance(5_000);
    const done = await api(cfg, `/api/oauth/status?provider=kiro&flowId=${id}`, undefined, "gui-session");
    expect(done.data.state).toBe("done");
    expect(JSON.stringify(start.data) + JSON.stringify(done.data)).not.toMatch(/private-device|private-access|private-refresh/);
    expect(cfg.providers.kiro).toBeDefined();
    const accounts = await api(cfg, "/api/oauth/accounts?provider=kiro", undefined, "gui-session");
    expect(JSON.stringify(accounts.data)).not.toMatch(/loginOrigin|private-access|private-refresh|private-device/);
  });

  test("concurrent starts beyond the cap are refused without upstream calls", async () => {
    fixture = kiroDeviceFixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    fixture.setPost(async () => { calls++; await gate; return response(socialAuthorization); });
    const pending = Array.from({ length: 4 }, () => startKiroDeviceLogin("google", "admin-token"));
    await expect(startKiroDeviceLogin("google", "admin-token")).rejects.toThrow("Too many");
    expect(calls).toBe(4);
    release();
    await Promise.all(pending);
  });

  test("status is server paced and a cancel during an approving poll persists nothing", async () => {
    fixture = kiroDeviceFixture();
    let polls = 0;
    let release!: (value: Response) => void;
    const gate = new Promise<Response>(resolve => { release = resolve; });
    fixture.setPost(async url => {
      if (url.endsWith("/authorization")) return response(socialAuthorization);
      polls++;
      return gate;
    });
    const started = await startKiroDeviceLogin("google", "admin-token");
    expect((await statusKiroDeviceLogin(started.flowId, "admin-token"))?.state).toBe("pending");
    expect(polls).toBe(0);
    fixture.advance(5_000);
    const pending = statusKiroDeviceLogin(started.flowId, "admin-token");
    expect(polls).toBe(1);
    expect(cancelKiroDeviceLogin(started.flowId, "admin-token")?.state).toBe("cancelled");
    release(response({ status: "approved", accessToken: "private-access", refreshToken: "private-refresh", profileArn }));
    expect((await pending)?.state).toBe("cancelled");
    expect(getAccountSet("kiro")).toBeNull();
  });

  test("first-account config-save failure rolls back the native slot", async () => {
    fixture = kiroDeviceFixture();
    fixture.setPost(async url => url.endsWith("/authorization") ? response(socialAuthorization)
      : response({ status: "approved", accessToken: "private-access", refreshToken: "private-refresh", profileArn }));
    setKiroDevicePublishForTests(() => { throw new Error("private config detail"); });
    const started = await startKiroDeviceLogin("google", "admin-token");
    fixture.advance(5_000);
    const status = await statusKiroDeviceLogin(started.flowId, "admin-token");
    expect(status?.state).toBe("failed");
    expect(JSON.stringify(status)).not.toContain("private config detail");
    expect(getAccountSet("kiro")).toBeNull();
  });

  test("a cancel that lands during an approving poll persists nothing", async () => {
    fixture = kiroDeviceFixture();
    fixture.setPost(async url => url.endsWith("/authorization") ? response(socialAuthorization)
      : response({ status: "approved", accessToken: "private-access", refreshToken: "private-refresh", profileArn }));
    const started = await startKiroDeviceLogin("google", "admin-token");
    fixture.advance(5_000);
    let entered!: () => void;
    const occupied = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const hold = mutateStore(async () => { entered(); await gate; });
    await occupied;
    const approving = statusKiroDeviceLogin(started.flowId, "admin-token");
    for (let i = 0; i < 100 && oauthMutationTailSnapshot().active < 2; i++) await Promise.resolve();
    expect(oauthMutationTailSnapshot().active).toBe(2);
    expect(cancelKiroDeviceLogin(started.flowId, "admin-token")?.state).toBe("cancelled");
    release();
    await hold;
    expect((await approving)?.state).toBe("cancelled");
    expect(getAccountSet("kiro")).toBeNull();
  });
});
