import { afterEach, describe, expect, test } from "bun:test";
import { createCertificateAuthority } from "../../src/claude/intercept/local-ca";
import { X509Certificate } from "node:crypto";
import { createDesktopCompatibilityRuntime } from "../../src/codex/desktop-compatibility/runtime";
import { UsageRelayController, type UsageIdentity } from "../../src/codex/desktop-compatibility/usage-controller";
import { desktopCompatibilityRuntimeActive } from "../../src/codex/desktop-compatibility/runtime-ownership";
import { createDesktopCertificateService } from "../../src/codex/desktop-compatibility/certificate-service";
import { resetOptionalShutdownHooksForTests, runOptionalShutdownHooks } from "../../src/lib/optional-shutdown-hooks";

const account: UsageIdentity = { id: "fixture-account", userId: "fixture-user", plan: "pro", structure: "personal" };
const usage = { account_id: account.id, user_id: account.userId, plan_type: "pro", rate_limit: { allowed: false, limit_reached: true,
  primary_window: { used_percent: 100, reset_at: 123456 } }, spend_control: { reached: false }, credits: { has_credits: false, unlimited: false } };
const exchange = { method: "GET", pathname: "/backend-api/wham/usage/stream", status: 200 };
const frame = (data = usage, sequence = 7) => JSON.stringify({ version: 1, stream_id: "fixture", sequence, usage: data });
const consent = { scope: "account-ui-compatibility" as const, accountWideConsent: true };
const stopped: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const stop of stopped.splice(0)) await stop(); resetOptionalShutdownHooksForTests(); });

describe("bounded compatibility usage controller", () => {
  test("observes first, refreshes only bound streams and preserves actual quota values", async () => {
    let closed = 0;
    const ctl = new UsageRelayController(account, async () => account, async () => account, Date.now, Date.now() + 600000);
    const stream = ctl.registerStream(exchange, async () => { closed++; });
    expect((await ctl.activate(consent)).accepted).toBe(false);
    expect(await ctl.rewriteJson(frame(), exchange, stream)).toBeNull();
    expect((await ctl.activate({ ...consent, accountWideConsent: false })).accepted).toBe(false);
    expect((await ctl.activate(consent)).accepted).toBe(true); expect(closed).toBe(1);
    const result = JSON.parse((await ctl.rewriteJson(frame(), exchange))!);
    expect(result).toEqual({ version: 1, stream_id: "fixture", sequence: 7, usage: { ...usage, rate_limit: { ...usage.rate_limit, allowed: true, limit_reached: false } } });
    expect(ctl.snapshot().appCacheConfirmed).toBe(false);
    await ctl.observeOnly(); expect(await ctl.rewriteJson(frame(), exchange)).toBeNull();
  });
  test("identity, spending restrictions, app responses and unknown stream schemas stay protected", async () => {
    let identity: UsageIdentity | null = account;
    const ctl = new UsageRelayController(account, async () => identity, async () => identity, Date.now, Date.now() + 600000);
    await ctl.rewriteJson(frame(), exchange); await ctl.activate(consent);
    for (const context of [{ ...exchange, method: "POST" }, { ...exchange, status: 401 }, { ...exchange, pathname: "/backend-api/conversation" }]) {
      expect(await ctl.rewriteJson(frame(), context)).toBeNull();
    }
    expect(await ctl.rewriteJson(frame({ ...usage, spend_control: { reached: true } }), exchange)).toBeNull();
    expect(await ctl.rewriteJson(frame(usage, 0), exchange)).toBeNull();
    identity = { ...account, id: "changed" };
    expect(await ctl.rewriteJson(frame(), exchange)).toBeNull(); expect(ctl.snapshot().mode).toBe("observe");
  });
  test("an async identity check cannot carry correction across the safety deadline", async () => {
    let now = 1000, advance = false;
    const ctl = new UsageRelayController(account, async () => { if (advance) now = 2000; return account; }, async () => account, () => now, 2000);
    await ctl.rewriteJson(frame(), exchange); await ctl.activate(consent); advance = true;
    expect(await ctl.rewriteJson(frame(), exchange)).toBeNull(); expect(ctl.snapshot().mode).toBe("observe");
  });
});

function fixture(trusted = true) {
  const authority = createCertificateAuthority({ commonName: "runtime-fixture", validityDays: 1 });
  const cert = new X509Certificate(authority.certPem);
  const identity = { readCurrentIdentity: async () => account, verifyFreshIdentity: async () => account };
  const calls: { path: string; method: string; bytes: number; cookie: string | null }[] = [];
  let streamSequence = 0, cancelledStreams = 0, buildSupported = true;
  const runtime = createDesktopCompatibilityRuntime({ platform: "win32", testOnly: true, identity, buildSupported: () => buildSupported,
    loadAuthority: async () => ({ authority, commonName: "runtime-fixture", fingerprint: cert.fingerprint256.replaceAll(":", ""),
      expiresAt: Date.parse(cert.validTo), renewalDue: false, reused: true }), trust: async () => trusted ? "trusted" : "not-trusted",
    upstreamFetch: (async (input, init) => {
      const request = new Request(input, init);
      const data = new Uint8Array(await request.arrayBuffer());
      const path = new URL(request.url).pathname;
      calls.push({ path, method: request.method, bytes: data.length, cookie: request.headers.get("cookie") });
      if (path === "/backend-api/wham/usage") return Response.json(usage, { headers: { etag: '"original-fixture"' } });
      if (path === "/backend-api/wham/usage/stream") return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("event: usage.snapshot\ndata: " + frame(usage, ++streamSequence) + "\n\n")); },
        cancel() { cancelledStreams++; },
      }), { headers: { "content-type": "text/event-stream" } });
      return new Response(data, { headers: { "content-type": "application/octet-stream", "set-cookie": "fixture=kept; Secure" } });
    }) as typeof fetch,
  });
  stopped.push(() => runtime.stop());
  return { runtime, authority, calls, cancelledStreams: () => cancelledStreams, setBuildSupported: (value: boolean) => { buildSupported = value; } };
}

describe("optional native compatibility runtime", () => {
  test("construction/status are inert and untrusted certificates cannot start listeners", async () => {
    let effects = 0;
    const dormant = createDesktopCompatibilityRuntime({ loadAuthority: async () => { effects++; throw new Error(); } });
    expect(dormant.status().running).toBe(false); expect(dormant.getPacUrl()).toBeNull(); expect(effects).toBe(0);
    const io = fixture(false); await expect(io.runtime.start()).rejects.toThrow("trust_required");
    expect(io.runtime.status().phase).toBe("off"); expect(desktopCompatibilityRuntimeActive()).toBe(false);
  });
  test("real loopback CONNECT/TLS preserves requests and restricts correction to an explicit trial", async () => {
    const io = fixture();
    await io.runtime.start(); expect(io.runtime.status().phase).toBe("running"); expect(io.runtime.status().usage?.mode).toBe("observe");
    const pac = await fetch(io.runtime.getPacUrl()!).then(res => res.text());
    expect(pac).toContain("; DIRECT"); expect(pac).toContain('host.toLowerCase() === "chatgpt.com"');
    const port = /PROXY 127\.0\.0\.1:(\d+)/.exec(pac)![1];
    const send = (path: string, init: RequestInit = {}) => fetch("https://chatgpt.com" + path, {
      ...init, proxy: `http://127.0.0.1:${port}`, tls: { ca: io.authority.certPem },
    });
    expect(await send("/backend-api/wham/usage").then(res => res.json())).toEqual(usage);
    const initial = await send("/backend-api/wham/usage/stream"), originalStream = initial.body!.getReader();
    expect(new TextDecoder().decode((await originalStream.read()).value)).toContain('"allowed":false');
    expect((await io.runtime.apply(true)).accepted).toBe(true);
    expect((await originalStream.read()).done).toBe(true); originalStream.releaseLock(); expect(io.cancelledStreams()).toBe(1);
    const next = await send("/backend-api/wham/usage/stream"), correctedStream = next.body!.getReader();
    const event = new TextDecoder().decode((await correctedStream.read()).value);
    expect(event).toContain('"sequence":2'); expect(event).toContain('"allowed":true');
    await correctedStream.cancel(); correctedStream.releaseLock();
    const changedResponse = await send("/backend-api/wham/usage");
    expect(changedResponse.headers.get("etag")).toBeNull(); expect(changedResponse.headers.get("cache-control")).toBe("no-store");
    const adjusted = await changedResponse.json();
    expect(adjusted.rate_limit.allowed).toBe(true); expect(adjusted.rate_limit.primary_window.used_percent).toBe(100); expect(adjusted.credits.has_credits).toBe(false);
    const bytes = new Uint8Array([0, 255, 1, 128, 42]);
    const uploaded = await send("/backend-api/files", { method: "POST", body: bytes, headers: { cookie: "fixture=session" } });
    expect(new Uint8Array(await uploaded.arrayBuffer())).toEqual(bytes); expect(uploaded.headers.get("set-cookie")).toContain("fixture=kept");
    expect(io.calls.at(-1)).toEqual({ path: "/backend-api/files", method: "POST", bytes: 5, cookie: "fixture=session" });
    await io.runtime.observe(); expect(await send("/backend-api/wham/usage").then(res => res.json())).toEqual(usage);
    const cert = createDesktopCertificateService("unused", { platform: "win32" });
    await expect(cert.renew("A".repeat(64))).rejects.toMatchObject({ code: "runtime_running" });
    await io.runtime.stop(); expect(io.runtime.status().phase).toBe("off"); expect(desktopCompatibilityRuntimeActive()).toBe(false);
    expect(await io.runtime.stop()).toMatchObject({ phase: "off" });
    await expect(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  }, 15000);
  test("core shutdown owns teardown and prevents reactivation in a draining process", async () => {
    const io = fixture(); await io.runtime.start();
    runOptionalShutdownHooks(); await io.runtime.stop();
    expect(io.runtime.status().running).toBe(false);
    await expect(io.runtime.start()).rejects.toThrow("stopping");
  });
  test("an unassessed app update cannot start or rearm the response correction", async () => {
    const io = fixture(); io.setBuildSupported(false);
    await expect(io.runtime.start()).rejects.toThrow("build_unverified"); expect(desktopCompatibilityRuntimeActive()).toBe(false);
    io.setBuildSupported(true); await io.runtime.start(); io.setBuildSupported(false);
    await expect(io.runtime.apply(true)).rejects.toThrow("build_unverified"); expect(io.runtime.status().usage?.mode).toBe("observe");
  });
});
