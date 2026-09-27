import { afterEach, describe, expect, test } from "bun:test";
import { createCertificateAuthority } from "../../src/claude/intercept/local-ca";
import { X509Certificate } from "node:crypto";
import { createDesktopCompatibilityRuntime } from "../../src/codex/desktop-compatibility/runtime";
import { UsageRelayController, type UsageIdentity } from "../../src/codex/desktop-compatibility/usage-controller";
import { desktopCompatibilityRuntimeActive } from "../../src/codex/desktop-compatibility/runtime-ownership";
import { createDesktopCertificateService } from "../../src/codex/desktop-compatibility/certificate-service";
import { resetOptionalShutdownHooksForTests, runOptionalShutdownHooks } from "../../src/lib/optional-shutdown-hooks";
import type { DesktopConnectionIdentity, DesktopConnectionStore } from "../../src/codex/desktop-compatibility/connection-store";
import { createServer as createTcpServer } from "node:net";

const account: UsageIdentity = { id: "fixture-account", userId: "fixture-user", plan: "pro", structure: "personal" };
const usage = { account_id: account.id, user_id: account.userId, plan_type: "pro", rate_limit: { allowed: false, limit_reached: true,
  primary_window: { used_percent: 100, reset_at: 123456 } }, spend_control: { reached: false }, credits: { has_credits: false, unlimited: false } };
const exchange = { method: "GET", pathname: "/backend-api/wham/usage/stream", status: 200 };
const frame = (data = usage, sequence = 7) => JSON.stringify({ version: 1, stream_id: "fixture", sequence, usage: data });
const consent = { scope: "account-ui-compatibility" as const, accountWideConsent: true };
const stopped: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const stop of stopped.splice(0)) await stop(); resetOptionalShutdownHooksForTests(); });

describe("bounded compatibility usage controller", () => {
  test("returning to observation supersedes activation during its asynchronous context check", async () => {
    let release!: (value: boolean) => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const ctl = new UsageRelayController(account, async () => account, async () => account, Date.now, Date.now() + 600000, 180000,
      () => { entered(); return new Promise(resolve => { release = resolve; }); });
    await ctl.rewriteJson(frame(), exchange);
    const activation = ctl.activate(consent); await waiting; await ctl.observeOnly(); release(true);
    expect((await activation).accepted).toBe(false); expect(ctl.snapshot().mode).toBe("observe");
  });
  test("observation avoids build probes and pending async checks cannot cross a trial or account change", async () => {
    for (const change of ["observe", "account", "expiry"] as const) {
      let now = 1000, current: UsageIdentity | null = account, checks = 0, waiting = false;
      let entered!: () => void, release!: (value: boolean) => void;
      const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
      const ctl = new UsageRelayController(account, async () => current, async () => current, () => now, 100000, 180000, () => {
        checks++; if (!waiting) return true;
        entered(); return new Promise(resolve => { release = resolve; });
      });
      expect(await ctl.rewriteJson(frame(), exchange)).toBeNull(); expect(checks).toBe(0);
      expect((await ctl.activate(consent)).accepted).toBe(true); expect(checks).toBe(1);
      waiting = true; const response = ctl.rewriteJson(frame(), exchange);
      await enteredPromise;
      // The event loop remains usable while a package query is pending.
      let ticked = false; await new Promise<void>(resolve => setTimeout(() => { ticked = true; resolve(); }, 0)); expect(ticked).toBe(true);
      if (change === "observe") await ctl.observeOnly();
      if (change === "account") current = null;
      if (change === "expiry") now = 100001;
      release(true); expect(await response).toBeNull(); expect(ctl.snapshot().outputs).toBe(0);
    }
  });
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

function fixture(trusted = true, connectionStore?: DesktopConnectionStore, buildProbe?: () => boolean | Promise<boolean>) {
  const authority = createCertificateAuthority({ commonName: "runtime-fixture", validityDays: 1 });
  const cert = new X509Certificate(authority.certPem);
  const identity = { readCurrentIdentity: async () => account, verifyFreshIdentity: async () => account };
  const calls: { path: string; method: string; bytes: number; cookie: string | null }[] = [];
  let streamSequence = 0, cancelledStreams = 0, buildSupported = true, routingSupported = true;
  let connection: DesktopConnectionIdentity | null = null;
  const runtime = createDesktopCompatibilityRuntime({ platform: "win32", testOnly: true, identity, buildSupported: () => buildProbe ? buildProbe() : buildSupported,
    routingSupported: () => routingSupported,
    connectionStore: connectionStore ?? { read: () => connection, publish: async value => (connection ??= value) },
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
  return { runtime, authority, calls, cancelledStreams: () => cancelledStreams, setBuildSupported: (value: boolean) => { buildSupported = value; }, setRoutingSupported: (value: boolean) => { routingSupported = value; } };
}

describe("optional native compatibility runtime", () => {
  test("observation cancels a pending apply request before its build preflight can finish", async () => {
    let pending = false, entered!: () => void, release!: (value: boolean) => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const io = fixture(true, undefined, () => pending ? (entered(), new Promise(resolve => { release = resolve; })) : true);
    await io.runtime.start();
    const pac = await fetch(io.runtime.getPacUrl()!).then(res => res.text()), port = /PROXY 127\.0\.0\.1:(\d+)/.exec(pac)![1];
    await fetch("https://chatgpt.com/backend-api/wham/usage", { proxy: `http://127.0.0.1:${port}`, tls: { ca: io.authority.certPem } }).then(res => res.json());
    pending = true; const applying = io.runtime.apply(true); await waiting; await io.runtime.observe(); release(true);
    expect((await applying).accepted).toBe(false); expect(io.runtime.status().usage?.mode).toBe("observe");
  });
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
  test("an active trial disarms on an app update or routing change before returning the next usage response", async () => {
    for (const failure of ["build", "routing"] as const) {
      const io = fixture(); await io.runtime.start();
      const pac = await fetch(io.runtime.getPacUrl()!).then(res => res.text()), port = /PROXY 127\.0\.0\.1:(\d+)/.exec(pac)![1];
      const read = () => fetch("https://chatgpt.com/backend-api/wham/usage", { proxy: `http://127.0.0.1:${port}`, tls: { ca: io.authority.certPem } }).then(res => res.json());
      await read(); expect((await io.runtime.apply(true)).accepted).toBe(true); expect((await read()).rate_limit.allowed).toBe(true);
      if (failure === "build") io.setBuildSupported(false); else io.setRoutingSupported(false);
      expect(await read()).toEqual(usage); expect(io.runtime.status().usage?.mode).toBe("observe");
      expect(io.runtime.status().contextFailure).toBe(failure === "build" ? "build_unverified" : "native_routing_unverified");
      await io.runtime.stop();
    }
  });
  test("routing preflight refuses a start before opening listeners", async () => {
    const io = fixture(); io.setRoutingSupported(false);
    await expect(io.runtime.start()).rejects.toThrow("native_routing_unverified");
    expect(io.runtime.status().running).toBe(false); expect(io.runtime.getPacUrl()).toBeNull(); expect(desktopCompatibilityRuntimeActive()).toBe(false);
  });
  test("a cached PAC reconnects to the same ports after restart and Apply is never resumed", async () => {
    const io = fixture(); await io.runtime.start();
    const originalUrl = io.runtime.getPacUrl()!, pac = await fetch(originalUrl).then(res => res.text());
    const port = Number(/PROXY 127\.0\.0\.1:(\d+)/.exec(pac)![1]);
    const request = () => fetch("https://chatgpt.com/backend-api/wham/usage", { proxy: `http://127.0.0.1:${port}`, tls: { ca: io.authority.certPem } }).then(res => res.json());
    expect((await request()).rate_limit.allowed).toBe(false); await io.runtime.apply(true);
    expect((await request()).rate_limit.allowed).toBe(true);
    await io.runtime.stop(); await io.runtime.start();
    expect(io.runtime.getPacUrl()).toBe(originalUrl); expect(await fetch(originalUrl).then(res => res.text())).toBe(pac);
    expect((await request()).rate_limit.allowed).toBe(false); expect(io.runtime.status().usage?.mode).toBe("observe");
  });
  test("a reused port conflict refuses startup and never replaces the cached connection identity", async () => {
    let stored: DesktopConnectionIdentity | null = null;
    const io = fixture(true, { read: () => stored, publish: async value => (stored ??= value) });
    await io.runtime.start(); const originalUrl = io.runtime.getPacUrl(); await io.runtime.stop();
    const original = { ...stored! };
    for (const occupied of ["connectPort", "pacPort"] as const) {
      const blocker = createTcpServer();
      await new Promise<void>(resolve => blocker.listen(original[occupied], "127.0.0.1", resolve));
      try {
        await expect(io.runtime.start()).rejects.toThrow("connection_unavailable");
        expect(stored).toEqual(original); expect(io.runtime.status().phase).toBe("off"); expect(desktopCompatibilityRuntimeActive()).toBe(false);
        // The other port must be bindable even when startup had already opened it.
        const probe = createTcpServer();
        try { await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(original[occupied === "connectPort" ? "pacPort" : "connectPort"], "127.0.0.1", resolve); }); }
        finally { await new Promise<void>(resolve => probe.close(() => resolve())); }
      } finally { await new Promise<void>(resolve => blocker.close(() => resolve())); }
      await io.runtime.start(); expect(io.runtime.getPacUrl()).toBe(originalUrl); await io.runtime.stop();
    }
  });
});
