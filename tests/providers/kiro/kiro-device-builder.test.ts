import { afterEach, describe, expect, test } from "bun:test";
import { startKiroDeviceLogin, statusKiroDeviceLogin } from "../../../src/oauth/kiro-device-login";
import { getAccountSet, isStorableKiroClientPart } from "../../../src/oauth/store";
import { authorization, kiroDeviceFixture, response } from "../../helpers/kiro-device-fixture";

let fixture: ReturnType<typeof kiroDeviceFixture> | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

describe("Kiro Builder ID device grant", () => {
  test("register, authorize, pending, slow_down and approve without persisting a service profile", async () => {
    fixture = kiroDeviceFixture();
    const paths: string[] = [];
    let polls = 0;
    fixture.setPost(async (url, body) => {
      paths.push(new URL(url).pathname);
      if (url.endsWith("/client/register")) return response({ clientId: "client-id", clientSecret: "client-secret" });
      if (url.endsWith("/device_authorization")) {
        expect(body.clientId).toBe("client-id");
        return response(authorization);
      }
      polls++;
      if (polls === 1) return response({ error: "authorization_pending" }, 400);
      if (polls === 2) return response({ error: "slow_down" }, 400);
      return response({ accessToken: "private-access", refreshToken: "private-refresh", expiresIn: 3600 });
    });
    const start = await startKiroDeviceLogin("builder-id", "admin-token");
    expect(JSON.stringify(start)).not.toMatch(/private-device|client-secret/);
    expect(start.userCode).toBe("ABCD-1234");
    expect((await statusKiroDeviceLogin(start.flowId, "admin-token"))?.state).toBe("pending");
    expect(polls).toBe(0);
    fixture.advance(5_000);
    expect((await statusKiroDeviceLogin(start.flowId, "admin-token"))?.state).toBe("pending");
    expect(polls).toBe(1);
    fixture.advance(5_000);
    expect((await statusKiroDeviceLogin(start.flowId, "admin-token"))?.state).toBe("pending");
    fixture.advance(10_000);
    const done = await statusKiroDeviceLogin(start.flowId, "admin-token");
    expect(done?.state).toBe("done");
    expect(JSON.stringify(done)).not.toMatch(/private-access|private-refresh|client-secret|private-device/);
    expect(paths).toEqual(["/client/register", "/device_authorization", "/token", "/token", "/token"]);
    const account = getAccountSet("kiro")!.accounts[0]!;
    expect(account.loginOrigin).toBe("kiro-device");
    expect(account.credential.kiro?.profileArn).toBeUndefined();
    expect(account.credential.kiro?.clientSecret).toBe("client-secret");
  });

  test("a 200 reply with an unknown status persists nothing", async () => {
    fixture = kiroDeviceFixture();
    fixture.setPost(async url => url.endsWith("/client/register")
      ? response({ clientId: "id", clientSecret: "secret" })
      : url.endsWith("/device_authorization") ? response(authorization)
      : response({ status: "mystery", accessToken: "token", refreshToken: "refresh", expiresIn: 3600 }));
    const start = await startKiroDeviceLogin("builder-id", "admin-token");
    fixture.advance(5_000);
    expect((await statusKiroDeviceLogin(start.flowId, "admin-token"))?.state).toBe("failed");
    expect(getAccountSet("kiro")).toBeNull();
  });

  test("an expired token error from the AWS header ends the flow", async () => {
    fixture = kiroDeviceFixture();
    fixture.setPost(async url => url.endsWith("/client/register")
      ? response({ clientId: "id", clientSecret: "secret" })
      : url.endsWith("/device_authorization") ? response(authorization)
      : response({}, 400, { "x-amzn-errortype": "ExpiredTokenException:upstream" }));
    const start = await startKiroDeviceLogin("builder-id", "admin-token");
    fixture.advance(5_000);
    expect((await statusKiroDeviceLogin(start.flowId, "admin-token"))?.state).toBe("expired");
    expect(getAccountSet("kiro")).toBeNull();
  });

  test("registration whitespace or controls are rejected before authorization", async () => {
    for (const clientId of [" id", "id\n", "\u0001id"]) {
      fixture = kiroDeviceFixture();
      let calls = 0;
      fixture.setPost(async () => { calls++; return response({ clientId, clientSecret: "secret" }); });
      await expect(startKiroDeviceLogin("builder-id", "admin-token")).rejects.toThrow("could not start");
      expect(calls).toBe(1);
      await fixture.close(); fixture = undefined;
    }
    expect(isStorableKiroClientPart(" valid ")).toBe(false);
  });

  test("hostile verification fields fail before reaching a public view", async () => {
    for (const override of [
      { verificationUri: "https://example.test/verify\u001b]8;;https://evil.test\u0007" },
      { verificationUriComplete: "https://example.test/verify\u009b31m" },
      { verificationUri: "https://user:pass@example.test/verify" },
      { verificationUri: "http://example.test/verify" },
      { verificationUri: `https://example.test/${"a".repeat(2048)}` },
      { userCode: "ABCD\u001b[31m" },
      { verificationUri: "https://example.test/\u202egnp.exe" },
      { verificationUriComplete: "https://example.test/\u200bverify" },
    ]) {
      fixture = kiroDeviceFixture();
      fixture.setPost(async url => url.endsWith("/client/register")
        ? response({ clientId: "id", clientSecret: "secret" }) : response({ ...authorization, ...override }));
      await expect(startKiroDeviceLogin("builder-id", "admin-token")).rejects.toThrow("could not start");
      expect(getAccountSet("kiro")).toBeNull();
      await fixture.close(); fixture = undefined;
    }
  });

  test("a 200 approval with a non-string error persists nothing", async () => {
    fixture = kiroDeviceFixture();
    fixture.setPost(async url => url.endsWith("/client/register")
      ? response({ clientId: "id", clientSecret: "secret" })
      : url.endsWith("/device_authorization") ? response(authorization)
      : response({ accessToken: "token", refreshToken: "refresh", expiresIn: 3600, error: { message: "denied" } }));
    const start = await startKiroDeviceLogin("builder-id", "admin-token");
    fixture.advance(5_000);
    expect((await statusKiroDeviceLogin(start.flowId, "admin-token"))?.state).toBe("failed");
    expect(getAccountSet("kiro")).toBeNull();
  });
});
