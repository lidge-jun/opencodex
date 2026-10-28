import { afterEach, expect, test } from "bun:test";
import { cancelKiroDeviceLogin, kiroDeviceFlowCountForTests, selectKiroDeviceProfile, setKiroDevicePublishForTests, startKiroDeviceLogin, statusKiroDeviceLogin } from "../../../src/oauth/kiro-device-login";
import { listKiroIamProfiles, parseKiroIamOptions } from "../../../src/oauth/kiro-iam-identity-center";
import { getAccountSet } from "../../../src/oauth/store";
import { authorization, kiroDeviceFixture, profileArn, response } from "../../helpers/kiro-device-fixture";
import { STORE_BUDGET_MS } from "../../helpers/test-budget";

let fixture: ReturnType<typeof kiroDeviceFixture> | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
const options = { startUrl: "https://example.awsapps.com/start", region: "eu-west-1" };
const profile = { arn: profileArn, profileName: "Team profile" };
const second = { arn: "arn:aws:codewhisperer:eu-central-1:123456789012:profile/second", profileName: "European profile" };

function transport(email = "first@example.test", profiles = [profile]) {
  fixture = kiroDeviceFixture();
  const calls: { url: string; body: Record<string, unknown>; headers?: Record<string, string> }[] = [];
  fixture.setPost(async (url, body, headers) => {
    calls.push({ url, body, headers });
    if (url.endsWith("/client/register")) return response({ clientId: "id", clientSecret: "private-client-secret" });
    if (url.endsWith("/device_authorization")) return response(authorization);
    if (url.endsWith("/token")) return response({ accessToken: "private-access", refreshToken: `private-refresh-${email}`, expiresIn: 3600 });
    if (headers?.["x-amz-target"]?.endsWith("ListAvailableProfiles")) return response({ profiles: url.includes("us-east-1") ? profiles : [] });
    if (headers?.["x-amz-target"]?.endsWith("GetUsageLimits")) return response({ userInfo: { email, userId: "user-id" } });
    throw new Error("Unexpected upstream request");
  });
  return calls;
}

async function approved() {
  const started = await startKiroDeviceLogin("iam-identity-center", "gui-session", undefined, options);
  fixture!.advance(5_000);
  return { started, status: await statusKiroDeviceLogin(started.flowId, "gui-session") };
}

test("IAM validates portal and region before any network request", async () => {
  expect(parseKiroIamOptions({ ...options, startUrl: options.startUrl+"/#/" })).toEqual(options);
  const authenticatedPortal = new URL(options.startUrl);
  authenticatedPortal.username = "fixture-user";
  for (const input of [undefined, {}, { ...options, region: "us-east-1.evil.test" },
    { ...options, startUrl: "http://example.awsapps.com/start" },
    { ...options, startUrl: "https://example.awsapps.com.evil.test/start" },
    { ...options, startUrl: "https://example.awsapps.com:443/start" },
    { ...options, startUrl: authenticatedPortal.href },
    { ...options, startUrl: options.startUrl+"?next=https://evil.test" },
    { ...options, startUrl: options.startUrl+"\n" }]) {
    expect(parseKiroIamOptions(input)).toBeNull();
    await expect(startKiroDeviceLogin("iam-identity-center", "gui-session", undefined, input)).rejects.toThrow("Invalid Kiro IAM");
  }
});

test("SSO uses the chosen region and portal; user and profile come from this grant", async () => {
  const calls = transport();
  const { started, status } = await approved();
  expect(status?.state).toBe("done");
  expect(calls[0]!.url).toBe("https://oidc.eu-west-1.amazonaws.com/client/register");
  expect(calls[1]!.body.startUrl).toBe(options.startUrl);
  expect(calls[2]!.url).toBe("https://oidc.eu-west-1.amazonaws.com/token");
  const account = getAccountSet("kiro")!.accounts[0]!;
  expect(account.credential.email).toBe("first@example.test");
  expect(account.credential.accountId).toBe(profileArn);
  expect(account.credential.kiro).toMatchObject({ ssoRegion: "eu-west-1", apiRegion: "us-east-1", profileArn, clientSecret: "private-client-secret" });
  expect(account.loginOrigin).toBe("kiro-device");
  const discovery = calls.filter(call => call.headers?.authorization);
  expect(discovery).toHaveLength(3);
  expect(discovery.every(call => call.headers?.authorization === "Bearer private-access")).toBe(true);
  expect(JSON.stringify([started, status])).not.toMatch(/private-access|private-refresh|private-client|userInfo|first@example/);
});

test("multiple profiles wait for an owner-scoped selection and reject arbitrary ARNs", async () => {
  const calls = transport("second@example.test", [profile, second]);
  const { started, status } = await approved();
  expect(status?.state).toBe("select-profile");
  expect(status?.profiles).toHaveLength(2);
  expect(getAccountSet("kiro")).toBeNull();
  expect(await selectKiroDeviceProfile(started.flowId, "admin-token", second.arn)).toBeNull();
  expect(await selectKiroDeviceProfile(started.flowId, "gui-session", profileArn+"-forged")).toBeNull();
  expect((await statusKiroDeviceLogin(started.flowId, "gui-session"))?.state).toBe("select-profile");
  expect((await selectKiroDeviceProfile(started.flowId, "gui-session", second.arn))?.state).toBe("done");
  expect(getAccountSet("kiro")!.accounts[0]!.credential.kiro?.apiRegion).toBe("eu-central-1");
  const identity = calls.find(call => call.headers?.["x-amz-target"]?.endsWith("GetUsageLimits"));
  expect(identity?.url).toStartWith("https://q.eu-central-1.amazonaws.com/");
  expect(identity?.body.profileArn).toBe(second.arn);
});

test("two users of one organization profile remain separate without a duplicate warning", async () => {
  transport();
  await approved();
  const initial = getAccountSet("kiro")!;
  const first = structuredClone(initial.accounts[0]!);
  fixture!.setPost(async (url, body, headers) => {
    if (url.endsWith("/client/register")) return response({ clientId: "second-id", clientSecret: "second-secret" });
    if (url.endsWith("/device_authorization")) return response(authorization);
    if (url.endsWith("/token")) return response({ accessToken: "second-access", refreshToken: "second-refresh", expiresIn: 3600 });
    if (headers?.["x-amz-target"]?.endsWith("ListAvailableProfiles")) return response({ profiles: url.includes("us-east-1") ? [profile] : [] });
    return response({ userInfo: { email: "second@example.test" } });
  });
  const { status } = await approved();
  expect(status?.state).toBe("done");
  expect(status?.warning).toBeUndefined();
  const result = getAccountSet("kiro")!;
  expect(result.accounts).toHaveLength(2);
  expect(result.accounts[0]).toEqual(first);
  expect(result.activeAccountId).toBe(initial.activeAccountId);
  expect(result.accounts[1]!.credential.email).toBe("second@example.test");
});

test("flow-table pressure preserves live IAM profile selection and the active-flow cap", async () => {
  transport("first@example.test", [profile, second]);
  const choosing = await approved();
  fixture!.setPost(async (url, _body, headers) => {
    if (url.endsWith("/client/register")) return response({ clientId: "id", clientSecret: "private-client-secret" });
    if (url.endsWith("/device_authorization")) return response({ ...authorization, interval: 1 });
    if (url.endsWith("/token")) return response({ accessToken: "private-access", refreshToken: "private-refresh", expiresIn: 3600 });
    if (headers?.["x-amz-target"]?.endsWith("ListAvailableProfiles")) return response({ profiles: url.includes("us-east-1") ? [profile, second] : [] });
    if (headers?.["x-amz-target"]?.endsWith("GetUsageLimits")) return response({ userInfo: { email: "first@example.test" } });
    throw new Error("Unexpected upstream request");
  });
  for (let i = 0; i < 14; i++) {
    const finished = await startKiroDeviceLogin("iam-identity-center", "gui-session", undefined, options);
    fixture!.advance(1_000);
    expect((await statusKiroDeviceLogin(finished.flowId, "gui-session"))?.state).toBe("select-profile");
    expect((await selectKiroDeviceProfile(finished.flowId, "gui-session", profileArn))?.state).toBe("done");
  }
  const pending = [];
  for (let i = 0; i < 3; i++) pending.push(await startKiroDeviceLogin("builder-id", "gui-session"));
  expect(kiroDeviceFlowCountForTests()).toBeLessThanOrEqual(16);
  expect((await statusKiroDeviceLogin(choosing.started.flowId, "gui-session"))?.state).toBe("select-profile");
  await expect(startKiroDeviceLogin("builder-id", "gui-session")).rejects.toThrow("Too many Kiro device logins");
  for (const flow of pending) expect((await statusKiroDeviceLogin(flow.flowId, "gui-session"))?.state).toBe("pending");
  expect((await selectKiroDeviceProfile(choosing.started.flowId, "gui-session", second.arn))?.state).toBe("done");
}, STORE_BUDGET_MS);

test("cancel and expiry while choosing a profile retain no credential", async () => {
  transport("first@example.test", [profile, second]);
  const first = await approved();
  expect(cancelKiroDeviceLogin(first.started.flowId, "gui-session")?.state).toBe("cancelled");
  expect(await selectKiroDeviceProfile(first.started.flowId, "gui-session", profileArn)).toBeNull();
  const another = await approved();
  fixture!.advance(600_000);
  expect(await selectKiroDeviceProfile(another.started.flowId, "gui-session", profileArn)).toBeNull();
  expect(getAccountSet("kiro")).toBeNull();
});

test.each(["status", "cancel"])("accepted IAM commits survive expiry during concurrent %s", async operation => {
  transport("first@example.test", [profile, second]);
  const { started } = await approved();
  let release!: () => void;
  let entered!: () => void;
  const publishing = new Promise<void>(resolve => { release = resolve; });
  const called = new Promise<void>(resolve => { entered = resolve; });
  setKiroDevicePublishForTests(async () => { entered(); await publishing; });
  const selecting = selectKiroDeviceProfile(started.flowId, "gui-session", second.arn);
  await called;
  fixture!.advance(600_000);
  let concurrent;
  try {
    concurrent = operation === "status"
      ? await statusKiroDeviceLogin(started.flowId, "gui-session")
      : cancelKiroDeviceLogin(started.flowId, "gui-session");
  } finally { release(); }
  expect((await selecting)?.state).toBe("done");
  expect(concurrent?.state).toBe(operation === "status" ? "select-profile" : "done");
  expect((await statusKiroDeviceLogin(started.flowId, "gui-session"))?.state).toBe("done");
  expect(getAccountSet("kiro")?.accounts).toHaveLength(1);
});

test("missing user identity and failed discovery never save an ambiguous organization account", async () => {
  transport("");
  expect((await approved()).status?.state).toBe("failed");
  expect(getAccountSet("kiro")).toBeNull();
});

test("profile pagination rejects cycles instead of presenting a partial list", async () => {
  let calls = 0;
  await expect(listKiroIamProfiles(async () => {
    calls++; return { status: 200, errorType: "", data: { profiles: [profile], nextToken: "repeated" } };
  }, "private-access")).rejects.toThrow("Incomplete");
  expect(calls).toBeLessThanOrEqual(4);
});

test("a region without permission is skipped, but transient discovery failure is not hidden", async () => {
  const discovered = await listKiroIamProfiles(async url => ({
    status: url.includes("eu-central-1") ? 403 : 200, errorType: "",
    data: { profiles: [profile] },
  }), "private-access");
  expect(discovered.map(profile => profile.arn)).toEqual([profileArn]);
  await expect(listKiroIamProfiles(async url => ({
    status: url.includes("eu-central-1") ? 503 : 200, errorType: "", data: { profiles: [profile] },
  }), "private-access")).rejects.toThrow("discovery failed");
});

test("cancelling during the selected profile's identity lookup cannot commit its grant", async () => {
  transport("first@example.test", [profile, second]);
  const { started } = await approved();
  let release!: (response: Response) => void;
  let entered!: () => void;
  const pending = new Promise<Response>(resolve => { release = resolve; });
  const called = new Promise<void>(resolve => { entered = resolve; });
  fixture!.setPost(async () => { entered(); return pending; });
  const selecting = selectKiroDeviceProfile(started.flowId, "gui-session", second.arn);
  await called;
  expect(cancelKiroDeviceLogin(started.flowId, "gui-session")?.state).toBe("cancelled");
  release(response({ userInfo: { email: "first@example.test" } }));
  expect((await selecting)?.state).toBe("cancelled");
  expect(getAccountSet("kiro")).toBeNull();
});
