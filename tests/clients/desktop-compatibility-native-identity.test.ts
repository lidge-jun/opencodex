import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmdirSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeIdentityReader } from "../../src/codex/desktop-compatibility/native-identity";
import { UsageRelayController } from "../../src/codex/desktop-compatibility/usage-controller";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { unlinkSync(join(root, "auth.json")); rmdirSync(root); } });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "desktop-identity-")); roots.push(root);
  const path = join(root, "auth.json"); let revision = 0;
  const write = (id = "fixture-A", access = "synthetic-access-A") => {
    const claims = { "https://api.openai.com/auth": { chatgpt_account_id: id, chatgpt_user_id: "fixture-user", chatgpt_plan_type: "pro" } };
    writeFileSync(path, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: id, access_token: access,
      id_token: `fixture.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture` } }));
    const timestamp = new Date(Date.now() + ++revision * 2000); utimesSync(path, timestamp, timestamp);
  };
  write(); return { path, write };
}
const usage = { account_id: "fixture-A", user_id: "fixture-user", plan_type: "pro",
  rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100 } },
  spend_control: { reached: false }, credits: { has_credits: false, unlimited: false } };
function upstreamFixture(beforeResponse?: () => Promise<void>) {
  const requests: Request[] = [];
  return {
    fetch: (async (input, init) => {
      requests.push(new Request(input, init)); await beforeResponse?.(); return Response.json(usage);
    }) as typeof fetch,
    verify(tokens: string[]) {
      // Assert outside the production reader's catch: a bad request must not look
      // like the expected null result of a negative identity test.
      expect(requests).toHaveLength(tokens.length);
      requests.forEach((request, index) => {
        expect(request.url).toBe("https://chatgpt.com/backend-api/wham/usage");
        expect(request.method).toBe("GET"); expect(request.redirect).toBe("manual");
        expect(request.headers.get("authorization")).toBe(`Bearer ${tokens[index]}`);
        expect(request.headers.get("ChatGPT-Account-ID")).toBe("fixture-A");
      });
    },
  };
}
const exchange = { method: "GET", pathname: "/backend-api/wham/usage", status: 200 };
const consent = { scope: "account-ui-compatibility" as const, accountWideConsent: true };

test("unchanged native credentials keep one opaque generation and verify without exposing tokens", async () => {
  const io = fixture(), upstream = upstreamFixture(), reader = createNativeIdentityReader(io.path, upstream.fetch);
  const first = await reader.readCurrentIdentity();
  expect(first?.credentialGeneration).toBeDefined();
  expect(await reader.readCurrentIdentity()).toEqual(first);
  expect(await reader.verifyFreshIdentity()).toEqual(first);
  expect(JSON.stringify(first)).not.toContain("synthetic-access");
  expect(JSON.stringify(first)).not.toContain("id_token");
  upstream.verify(["synthetic-access-A"]);
});

for (const change of ["token rotation", "A to B to A"] as const) test(`a delayed identity response cannot cross ${change}`, async () => {
  const io = fixture(); let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const upstream = upstreamFixture(async () => { entered(); await pending; });
  const reader = createNativeIdentityReader(io.path, upstream.fetch);
  const before = await reader.readCurrentIdentity(), verifying = reader.verifyFreshIdentity(); await started;
  if (change === "token rotation") io.write("fixture-A", "synthetic-access-new");
  else { io.write("fixture-B", "synthetic-access-B"); io.write(); }
  release(); expect(await verifying).toBeNull();
  expect((await reader.readCurrentIdentity())?.credentialGeneration).not.toBe(before?.credentialGeneration);
  upstream.verify(["synthetic-access-A"]);
});

test("an unreadable intermediate login cannot recover an old credential generation", async () => {
  const io = fixture(), upstream = upstreamFixture(), reader = createNativeIdentityReader(io.path, upstream.fetch), before = await reader.readCurrentIdentity();
  writeFileSync(io.path, "{}"); expect(await reader.readCurrentIdentity()).toBeNull(); io.write();
  expect((await reader.readCurrentIdentity())?.credentialGeneration).not.toBe(before?.credentialGeneration);
  upstream.verify([]);
});

test("a trial disarms on native credential replacement and a fresh runtime can bind the replacement", async () => {
  const io = fixture(), upstream = upstreamFixture(), reader = createNativeIdentityReader(io.path, upstream.fetch), account = (await reader.verifyFreshIdentity())!;
  const controller = new UsageRelayController(account, reader.readCurrentIdentity, reader.verifyFreshIdentity, Date.now, Date.now() + 600000);
  await controller.rewriteJson(JSON.stringify(usage), exchange); expect((await controller.activate(consent)).accepted).toBe(true);
  io.write("fixture-A", "synthetic-access-new");
  expect(await controller.rewriteJson(JSON.stringify(usage), exchange)).toBeNull();
  expect(controller.snapshot().mode).toBe("observe"); expect(controller.snapshot().outputs).toBe(0);
  const replacement = new UsageRelayController((await reader.verifyFreshIdentity())!, reader.readCurrentIdentity, reader.verifyFreshIdentity, Date.now, Date.now() + 600000);
  await replacement.rewriteJson(JSON.stringify(usage), exchange); expect((await replacement.activate(consent)).accepted).toBe(true);
  upstream.verify(["synthetic-access-A", "synthetic-access-A", "synthetic-access-new", "synthetic-access-new"]);
});

test("A to B to A during the async build check cannot publish a corrected old response", async () => {
  const io = fixture(), upstream = upstreamFixture(), reader = createNativeIdentityReader(io.path, upstream.fetch); let waiting = false, entered!: () => void, release!: (value: boolean) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const controller = new UsageRelayController((await reader.verifyFreshIdentity())!, reader.readCurrentIdentity, reader.verifyFreshIdentity, Date.now, Date.now() + 600000, 180000,
    () => waiting ? (entered(), new Promise<boolean>(resolve => { release = resolve; })) : true);
  await controller.rewriteJson(JSON.stringify(usage), exchange); await controller.activate(consent);
  waiting = true; const correcting = controller.rewriteJson(JSON.stringify(usage), exchange); await started;
  io.write("fixture-B", "synthetic-access-B"); io.write(); release(true);
  expect(await correcting).toBeNull(); expect(controller.snapshot().mode).toBe("observe"); expect(controller.snapshot().outputs).toBe(0);
  upstream.verify(["synthetic-access-A", "synthetic-access-A"]);
});
