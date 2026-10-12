import { afterEach, describe, expect, test } from "bun:test";
import { kiroDeviceConfigBaseline, kiroDeviceFlowCountForTests, startKiroDeviceLogin, statusKiroDeviceLogin } from "../../../src/oauth/kiro-device-login";
import { getAccountSet } from "../../../src/oauth/store";
import { kiroDeviceFixture, profileArn, response, socialAuthorization } from "../../helpers/kiro-device-fixture";
import type { OcxConfig } from "../../../src/types";

let fixture: ReturnType<typeof kiroDeviceFixture> | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

describe("Kiro social device grant", () => {
  test("uses millisecond authorization timings and appends duplicate profile ARN with warning", async () => {
    fixture = kiroDeviceFixture();
    const bodies: Record<string, unknown>[] = [];
    fixture.setPost(async (url, body) => {
      bodies.push(body);
      return url.endsWith("/authorization") ? response(socialAuthorization)
        : response({ status: "approved", accessToken: "private-access", refreshToken: "private-refresh", profileArn });
    });
    const first = await startKiroDeviceLogin("google", "admin-token");
    expect(first.expiresAt).toBe(1_300_000);
    fixture.advance(5_000);
    expect((await statusKiroDeviceLogin(first.flowId, "admin-token"))?.state).toBe("done");
    const selected = getAccountSet("kiro")!.activeAccountId;
    const second = await startKiroDeviceLogin("github", "admin-token");
    fixture.advance(5_000);
    const done = await statusKiroDeviceLogin(second.flowId, "admin-token");
    expect(done?.warning).toBe("duplicate_profile_arn");
    expect(getAccountSet("kiro")?.accounts).toHaveLength(2);
    expect(getAccountSet("kiro")?.activeAccountId).toBe(selected);
    expect(bodies[0]?.loginProvider).toBe("Google");
    expect(bodies[2]?.loginProvider).toBe("Github");
    expect(JSON.stringify(done)).not.toMatch(/private-access|private-refresh|private-device/);
  });

  test("unknown approval status or malformed profile persists nothing", async () => {
    for (const approval of [
      { status: "strange", accessToken: "a", refreshToken: "r", profileArn },
      { status: "approved", accessToken: "a", refreshToken: "r", profileArn: "bad" },
      { status: "approved", accessToken: "a", refreshToken: "r", profileArn, error: { message: "denied" } },
    ]) {
      fixture = kiroDeviceFixture();
      fixture.setPost(async url => url.endsWith("/authorization") ? response(socialAuthorization) : response(approval));
      const start = await startKiroDeviceLogin("google", "admin-token");
      fixture.advance(5_000);
      expect((await statusKiroDeviceLogin(start.flowId, "admin-token"))?.state).toBe("failed");
      expect(getAccountSet("kiro")).toBeNull();
      await fixture.close(); fixture = undefined;
    }
  });

  test("many completed flows release their entries and config snapshots", async () => {
    fixture = kiroDeviceFixture();
    fixture.setPost(async url => url.endsWith("/authorization") ? response(socialAuthorization)
      : response({ status: "approved", accessToken: "private-access", refreshToken: "private-refresh", profileArn }));
    for (let i = 0; i < 40; i++) {
      const started = await startKiroDeviceLogin("google", "admin-token", { port: 10100, providers: {} } as OcxConfig);
      fixture.advance(5_000);
      expect((await statusKiroDeviceLogin(started.flowId, "admin-token"))?.state).toBe("done");
      expect(kiroDeviceConfigBaseline(started.flowId, "admin-token")).toBeUndefined();
      expect(await statusKiroDeviceLogin(started.flowId, "admin-token")).toBeNull();
      expect(kiroDeviceFlowCountForTests()).toBeLessThanOrEqual(16);
    }
  });
});
