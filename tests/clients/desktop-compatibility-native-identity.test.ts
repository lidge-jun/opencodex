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

for (const pathname of [exchange.pathname, `${exchange.pathname}/stream`]) {
  for (const field of ['account_id', 'user_id', 'plan_type'] as const) {
    test(`explicit foreign ${field} revokes the trial on ${pathname}`, async () => {
      const account = { id: usage.account_id, userId: usage.user_id, plan: 'pro' as const, structure: 'personal' as const };
      const ctl = new UsageRelayController(account, async () => account, async () => account, () => 1000, 600000);
      const route = { ...exchange, pathname };
      const encode = (record: unknown) => JSON.stringify(pathname.endsWith('/stream')
        ? { version: 1, stream_id: 'fixture', sequence: 1, usage: record } : record);
      await ctl.rewriteJson(encode(usage), route);
      expect((await ctl.activate(consent)).accepted).toBe(true);
      const stream = ctl.registerStream(route, async () => {});
      expect(await ctl.rewriteJson(encode(usage), route, stream)).not.toBeNull();
      expect(ctl.snapshot().observation.validatedActiveStreams).toBe(pathname.endsWith('/stream') ? 1 : 0);
      const generation = ctl.snapshot().generation;
      expect(await ctl.rewriteJson(encode({ ...usage, [field]: 'foreign' }), route, stream)).toBeNull();
      expect(ctl.snapshot()).toMatchObject({ mode: 'observe', phase: 'identity-invalidated', outputs: 0 });
      expect(ctl.snapshot().observation.validatedActiveStreams).toBe(0);
      expect(ctl.snapshot().generation).toBeGreaterThan(generation);
      expect((await ctl.activate(consent)).accepted).toBe(false);
      expect(await ctl.rewriteJson(encode(usage), route)).toBeNull();
      expect((await ctl.activate(consent)).accepted).toBe(true);
      expect(await ctl.rewriteJson(encode(usage), route)).not.toBeNull();
      stream?.release();
    });
  }
}

for (const failure of ['mismatch', 'null', 'throw'] as const) {
  test(`fresh activation identity ${failure} revokes existing consent`, async () => {
    const account = { id: usage.account_id, userId: usage.user_id, plan: 'pro' as const, structure: 'personal' as const };
    let fail = false;
    const ctl = new UsageRelayController(account, async () => account, async () => {
      if (!fail) return account;
      if (failure === 'throw') throw new Error('synthetic verification failure');
      return failure === 'null' ? null : { ...account, userId: 'foreign' };
    }, () => 1000, 600000);
    await ctl.rewriteJson(JSON.stringify(usage), exchange);
    expect((await ctl.activate(consent)).accepted).toBe(true);
    fail = true;
    expect(await ctl.activate(consent)).toMatchObject({ accepted: false, reason: 'identity-not-verified', mode: 'observe' });
    fail = false;
    expect((await ctl.activate(consent)).accepted).toBe(false);
    expect(await ctl.rewriteJson(JSON.stringify(usage), exchange)).toBeNull();
    expect((await ctl.activate(consent)).accepted).toBe(true);
  });
}

for (const failure of ['foreign usage', 'failed reauthentication'] as const) {
  test(`${failure} cancels a response waiting for its final context check`, async () => {
    const account = { id: usage.account_id, userId: usage.user_id, plan: 'pro' as const, structure: 'personal' as const };
    let verify = true, waiting = false, entered!: () => void, release!: (valid: boolean) => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const ctl = new UsageRelayController(account, async () => account, async () => verify ? account : null,
      () => 1000, 600000, 180000, () => waiting ? (entered(), new Promise<boolean>(resolve => { release = resolve; })) : true);
    await ctl.rewriteJson(JSON.stringify(usage), exchange); await ctl.activate(consent);
    waiting = true; const pending = ctl.rewriteJson(JSON.stringify(usage), exchange); await started;
    waiting = false;
    try {
      if (failure === 'foreign usage') await ctl.rewriteJson(JSON.stringify({ ...usage, account_id: 'foreign' }), exchange);
      else { verify = false; await ctl.activate(consent); }
    } finally { release(true); }
    expect(await pending).toBeNull();
    expect(ctl.snapshot()).toMatchObject({ mode: 'observe', outputs: 0 });
  });
}

for (const failure of ['mismatch', 'null', 'throw'] as const) {
  test(`stale activation ${failure} cannot cancel a newer trial`, async () => {
    const account = { id: usage.account_id, userId: usage.user_id, plan: 'pro' as const, structure: 'personal' as const };
    let deferred = false, entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ctl = new UsageRelayController(account, async () => account, async () => {
      if (!deferred) return account;
      entered(); await gate;
      if (failure === 'throw') throw new Error('synthetic stale verification failure');
      return failure === 'null' ? null : { ...account, userId: 'foreign' };
    }, () => 1000, 600000);
    await ctl.rewriteJson(JSON.stringify(usage), exchange); await ctl.activate(consent);
    deferred = true; const pending = ctl.activate(consent); await started;
    deferred = false;
    try {
      await ctl.observeOnly();
      await ctl.rewriteJson(JSON.stringify(usage), exchange);
      expect((await ctl.activate(consent)).accepted).toBe(true);
    } finally { release(); }
    const current = ctl.snapshot();
    expect(await pending).toMatchObject({ accepted: false, reason: 'identity-not-verified' });
    expect(ctl.snapshot()).toEqual(current);
    expect(await ctl.rewriteJson(JSON.stringify(usage), exchange)).not.toBeNull();
  });
}
