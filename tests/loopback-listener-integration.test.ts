/**
 * Integration coverage for the unauthenticated loopback listener (#1102).
 *
 * The companion unit file exercises the admission and CORS helpers in isolation. That is not
 * enough for a surface that admits without a credential: helper-level tests stay green if the
 * second listener never opens, binds the wrong address, is not distinguished from the public
 * one, or serves routes outside its allowlist. These tests start real servers and speak HTTP
 * to them, so those regressions have somewhere to fail.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { runListenerShutdown } from "../src/server/lifecycle";
import {
  findAvailablePort,
  PortUnavailableError,
  setEphemeralPortAllocatorForTests,
} from "../src/server/ports";
import type { OcxConfig } from "../src/types";
import { SERVER_BUDGET_MS } from "./helpers/test-budget";

const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousHome = process.env.OPENCODEX_HOME;
let testDir = "";

function baseConfig(loopbackPort: number | null): OcxConfig {
  return {
    port: 0,
    hostname: "0.0.0.0",
    defaultProvider: "chatgpt",
    providers: {
      chatgpt: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
    },
    ...(loopbackPort === null
      ? {}
      : { unauthenticatedLoopbackListener: { enabled: true, port: loopbackPort } }),
  } as unknown as OcxConfig;
}

/** A free port to hand the loopback listener, chosen the same way production would not reuse. */
async function freePort(): Promise<number> {
  return await findAvailablePort(0, "127.0.0.1");
}

function firstNonLoopbackIPv4(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}

/** One-shot settle with a cleared timer, so a late timeout cannot fire into the next test. */
function handshake(url: string): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const ws = new WebSocket(url);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { ws.close(); } catch { /* already closing */ }
      resolve(value);
    };
    ws.addEventListener("open", () => settle(true));
    ws.addEventListener("error", () => settle(false));
    timer = setTimeout(() => settle(false), 3_000);
  });
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-loopback-listener-"));
  process.env.OPENCODEX_HOME = testDir;
  process.env.OPENCODEX_API_AUTH_TOKEN = "public-secret";
});

afterEach(() => {
  if (previousApiToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousApiToken;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

describe("unauthenticated loopback listener", () => {
  test("is absent unless configured, and the public listener still demands a key", async () => {
    saveConfig(baseConfig(null));
    const server = startServer(0);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/models`);
      expect(res.status).toBe(401);
    } finally {
      await server.stop(true);
    }
  });

  test("admits without a credential while the public listener does not", async () => {
    const loopbackPort = await freePort();
    saveConfig(baseConfig(loopbackPort));
    const server = startServer(0);
    try {
      // Same request, two sockets, two answers. This is the whole feature.
      const viaPublic = await fetch(`http://127.0.0.1:${server.port}/v1/models`);
      expect(viaPublic.status).toBe(401);

      const viaLoopback = await fetch(`http://127.0.0.1:${loopbackPort}/v1/models`);
      expect(viaLoopback.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("refuses connections on a non-loopback interface", async () => {
    const address = firstNonLoopbackIPv4();
    if (!address) {
      // A host with no external IPv4 cannot prove this. Say so rather than pass silently:
      // a quiet skip here would let the bind address regress unnoticed on that machine.
      console.warn("[loopback-listener] no non-loopback IPv4 interface; bind-scope check not run");
      return;
    }
    const loopbackPort = await freePort();
    saveConfig(baseConfig(loopbackPort));
    const server = startServer(0);
    try {
      const refused = await new Promise<boolean>(resolve => {
        const socket = connect({ host: address, port: loopbackPort });
        const settle = (value: boolean) => {
          socket.destroy();
          resolve(value);
        };
        socket.setTimeout(2_000);
        socket.once("connect", () => settle(false));
        socket.once("error", () => settle(true));
        socket.once("timeout", () => settle(true));
      });
      expect(refused).toBe(true);
    } finally {
      await server.stop(true);
    }
    // A real proxy plus a real listener, and the refusal is only proven by letting the
    // connection attempt reach its own 2s socket timeout. Together those exceed Bun's
    // 5s default on a loaded Windows box, where the test measured 5.04s.
  }, SERVER_BUDGET_MS);

  test("serves only the four allowlisted routes, using each route's real method", async () => {
    const loopbackPort = await freePort();
    saveConfig(baseConfig(loopbackPort));
    const server = startServer(0);
    const base = `http://127.0.0.1:${loopbackPort}`;
    try {
      // Each entry uses the METHOD its handler actually accepts. Probing a POST route with GET
      // would 404 on method mismatch inside the handler, so the assertion would hold even if
      // the allowlist were widened to admit that route — the test would be watching nothing.
      const denied: Array<{ method: string; path: string; body?: string }> = [
        { method: "GET", path: "/api/config" },
        { method: "GET", path: "/" },
        { method: "GET", path: "/healthz" },
        { method: "GET", path: "/readyz" },
        { method: "POST", path: "/v1/chat/completions", body: '{"model":"x","messages":[]}' },
        { method: "POST", path: "/v1/messages", body: '{"model":"x","messages":[]}' },
        { method: "POST", path: "/v1/images/generations", body: '{"prompt":"x"}' },
        { method: "POST", path: "/v1/alpha/search", body: '{"query":"x"}' },
        { method: "GET", path: "/v1/opencodex/artifacts/x" },
        { method: "POST", path: "/v1/live", body: "{}" },
        { method: "POST", path: "/v1/realtime/calls", body: "{}" },
        // Allowlisted paths still reject the methods they do not serve.
        { method: "DELETE", path: "/v1/responses" },
        { method: "POST", path: "/v1/models" },
      ];
      for (const { method, path, body } of denied) {
        const res = await fetch(`${base}${path}`, {
          method,
          ...(body ? { body, headers: { "content-type": "application/json" } } : {}),
        });
        expect({ method, path, status: res.status }).toEqual({ method, path, status: 404 });
      }

      // And an allowlisted route is genuinely reachable, so the rejections above are not
      // passing merely because nothing works on this listener.
      expect((await fetch(`${base}/v1/models`)).status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("admits standalone realtime voice WebSocket upgrades, HTTP stays rejected", async () => {
    const loopbackPort = await freePort();
    saveConfig(baseConfig(loopbackPort));
    const server = startServer(0);
    const base = `http://127.0.0.1:${loopbackPort}`;
    const upgradeHeaders = {
      connection: "upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": Buffer.from("0123456789abcdef").toString("base64"),
    };
    try {
      // A directly-spawned `codex app-server` drives desktop voice through the injected
      // listener (codex-rs thread/realtime/start, standalone WebSocket transport). The
      // allowlist must not 404 these upgrades; what comes back instead is the relay's own
      // auth answer (no upstream credential is configured here), which still proves the
      // request got past the allowlist.
      for (const path of ["/v1/realtime?model=m", "/v1/live?model=m"]) {
        const res = await fetch(`${base}${path}`, { headers: upgradeHeaders });
        expect({ path, status: res.status }).not.toEqual({ path, status: 404 });
      }
      // Plain HTTP on the same paths remains outside the allowlist.
      expect((await fetch(`${base}/v1/realtime?model=m`)).status).toBe(404);
      expect((await fetch(`${base}/v1/live?model=m`)).status).toBe(404);
    } finally {
      await server.stop(true);
    }
  });

  test("admits POST /v1/responses and its compact sibling without a credential", async () => {
    const loopbackPort = await freePort();
    saveConfig(baseConfig(loopbackPort));
    const server = startServer(0);
    const base = `http://127.0.0.1:${loopbackPort}`;
    const publicBase = `http://127.0.0.1:${server.port}`;
    try {
      // These are the routes the reported defect actually fails on. `/v1/models` passing does
      // not prove they admit: they use a different resolver.
      //
      // The request is deliberately malformed, so it fails INSIDE the handler rather than at
      // admission. Any status other than 401 proves admission let it through, which is the
      // only thing under test here — no upstream is involved.
      for (const path of ["/v1/responses", "/v1/responses/compact"]) {
        const viaPublic = await fetch(`${publicBase}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        expect({ path, status: viaPublic.status }).toEqual({ path, status: 401 });

        const viaLoopback = await fetch(`${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        // Not `not.toBe(401)`: a 404 would satisfy that too, so removing the route from the
        // allowlist would keep the assertion green. The route must be admitted AND reachable,
        // which means neither 401 nor 404.
        expect({ path, status: viaLoopback.status }).not.toEqual({ path, status: 401 });
        expect({ path, status: viaLoopback.status }).not.toEqual({ path, status: 404 });
      }
    } finally {
      await server.stop(true);
    }
  });

  test("upgrades a Responses WebSocket on the listener that received it", async () => {
    const loopbackPort = await freePort();
    saveConfig({ ...baseConfig(loopbackPort), websockets: true } as unknown as OcxConfig);
    const server = startServer(0);
    try {
      // What this proves: the loopback listener completes a Responses WebSocket handshake
      // without a credential, and the public one does not.
      //
      // What it does NOT prove: that the upgrade goes through `requestServer` rather than the
      // captured `server`. That ablation was run and stayed green — this Bun version accepts
      // an upgrade issued from a sibling Bun.serve in the same process. `requestServer` is
      // still correct (it is the server that received the request, and nothing documents the
      // cross-listener behaviour as supported), but the assertion below cannot defend it.
      // Saying so beats implying coverage that does not exist.
      expect(await handshake(`ws://127.0.0.1:${loopbackPort}/v1/responses`)).toBe(true);
      expect(await handshake(`ws://127.0.0.1:${server.port}/v1/responses`)).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  test("applies the loopback Host and Origin gate, not the public same-origin rule", async () => {
    const loopbackPort = await freePort();
    saveConfig(baseConfig(loopbackPort));
    const server = startServer(0);
    const url = `http://127.0.0.1:${loopbackPort}/v1/models`;
    try {
      // The kernel refuses remote TCP, but a victim's browser connects locally on an
      // attacker's behalf. Under the PUBLIC policy this same-origin shape is allowed; under
      // the loopback policy it must not be.
      const rebinding = await fetch(url, { headers: { Host: "attacker.example" } });
      expect(rebinding.status).toBe(403);

      const hostileOrigin = await fetch(url, { headers: { Origin: "http://attacker.example" } });
      expect(hostileOrigin.status).toBe(403);
      expect(hostileOrigin.headers.get("access-control-allow-origin")).not.toBe("http://attacker.example");

      const ok = await fetch(url);
      expect(ok.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("stopping the server closes both listeners", async () => {
    const loopbackPort = await freePort();
    saveConfig(baseConfig(loopbackPort));
    const server = startServer(0);
    const publicPort = server.port;
    await server.stop(true);

    // Both ports must be rebindable. A surviving loopback listener would keep serving
    // unauthenticated traffic after shutdown reported success.
    for (const port of [publicPort, loopbackPort]) {
      const probe = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("ok") });
      await probe.stop(true);
    }
  });

  test("stopping the server clears the background intervals it started", async () => {
    saveConfig(baseConfig(null));
    const nativeSetInterval = globalThis.setInterval;
    const nativeClearInterval = globalThis.clearInterval;
    const started = new Set<ReturnType<typeof setInterval>>();
    const cleared = new Set<ReturnType<typeof setInterval>>();

    Object.defineProperty(globalThis, "setInterval", {
      configurable: true,
      value: ((...args: Parameters<typeof setInterval>) => {
        const timer = nativeSetInterval(...args);
        started.add(timer);
        return timer;
      }) as typeof setInterval,
      writable: true,
    });
    Object.defineProperty(globalThis, "clearInterval", {
      configurable: true,
      value: ((timer: ReturnType<typeof setInterval>) => {
        cleared.add(timer);
        nativeClearInterval(timer);
      }) as typeof clearInterval,
      writable: true,
    });

    let allCleared = false;
    try {
      const server = startServer(0);
      // Memory watchdog and state-store sweeper always replace their singleton;
      // the storage scheduler may already be the leaked instance from a prior test.
      expect(started.size).toBeGreaterThanOrEqual(2);
      await server.stop(true);
      allCleared = [...started].every(timer => cleared.has(timer));
    } finally {
      for (const timer of started) nativeClearInterval(timer);
      Object.defineProperty(globalThis, "setInterval", {
        configurable: true,
        value: nativeSetInterval,
        writable: true,
      });
      Object.defineProperty(globalThis, "clearInterval", {
        configurable: true,
        value: nativeClearInterval,
        writable: true,
      });
    }
    expect(allCleared).toBe(true);
  });

  test("stopping an older server does not clear a newer server's background intervals", async () => {
    saveConfig(baseConfig(null));
    const nativeSetInterval = globalThis.setInterval;
    const nativeClearInterval = globalThis.clearInterval;
    const started: Array<ReturnType<typeof setInterval>> = [];
    const cleared = new Set<ReturnType<typeof setInterval>>();

    Object.defineProperty(globalThis, "setInterval", {
      configurable: true,
      value: ((...args: Parameters<typeof setInterval>) => {
        const timer = nativeSetInterval(...args);
        started.push(timer);
        return timer;
      }) as typeof setInterval,
      writable: true,
    });
    Object.defineProperty(globalThis, "clearInterval", {
      configurable: true,
      value: ((timer: ReturnType<typeof setInterval>) => {
        cleared.add(timer);
        nativeClearInterval(timer);
      }) as typeof clearInterval,
      writable: true,
    });

    let newerTimersSurvivedOlderStop = false;
    let newerTimersClearedOnOwnStop = false;
    try {
      const older = startServer(0);
      const sharedTimers = [...started];
      expect(sharedTimers.length).toBeGreaterThanOrEqual(3);
      const newer = startServer(0);
      // Singleton loops are process-scoped: the second live server acquires the
      // same lease instead of replacing the watchdog and sweeper intervals.
      expect(started).toEqual(sharedTimers);

      await older.stop(true);
      newerTimersSurvivedOlderStop = sharedTimers.every(timer => !cleared.has(timer));
      await newer.stop(true);
      newerTimersClearedOnOwnStop = sharedTimers.every(timer => cleared.has(timer));
    } finally {
      for (const timer of started) nativeClearInterval(timer);
      Object.defineProperty(globalThis, "setInterval", {
        configurable: true,
        value: nativeSetInterval,
        writable: true,
      });
      Object.defineProperty(globalThis, "clearInterval", {
        configurable: true,
        value: nativeClearInterval,
        writable: true,
      });
    }
    expect(newerTimersSurvivedOlderStop).toBe(true);
    expect(newerTimersClearedOnOwnStop).toBe(true);
  });

  test("a loopback bind failure rolls back the public listener rather than stranding it", async () => {
    const loopbackPort = await freePort();
    // A FIXED public port, not 0. Throwing is not the property under test — a startup that
    // throws while leaving the public listener bound is exactly the failure the rollback
    // exists to prevent, and only a rebind attempt can tell the two apart.
    // Reserve the loopback port during this draw: two back-to-back freePort() calls can hand
    // back the same port, which would make the test squat its own public port.
    const publicPort = await findAvailablePort(0, "127.0.0.1", { reservedPort: loopbackPort });
    const squatter = Bun.serve({
      port: loopbackPort,
      hostname: "127.0.0.1",
      fetch: () => new Response("occupied"),
    });
    saveConfig(baseConfig(loopbackPort));
    try {
      expect(() => startServer(publicPort)).toThrow();

      const rebound = Bun.serve({
        port: publicPort,
        hostname: "127.0.0.1",
        fetch: () => new Response("ok"),
      });
      expect(rebound.port).toBe(publicPort);
      await rebound.stop(true);
    } finally {
      await squatter.stop(true);
    }
  });

  // Not covered here: composite stop's failure PROPAGATION when one listener's stop rejects.
  // The composite captures the underlying stop at construction, so a test cannot inject a
  // rejection from outside without a seam that does not exist yet. Its sibling property —
  // cleanup completing across both listeners — is covered by the test above. Writing a case
  // that asserts something weaker and calls it propagation coverage would be worse than the
  // gap, because the next reader would believe the branch was defended.
});

describe("composite listener shutdown", () => {
  // Both listeners share one `stop`, and the two properties it must hold pull against each
  // other: keep cleaning up after a failure, yet still report that failure. A test against a
  // live server cannot inject the rejection, so the orchestration was extracted.
  test("a failing step does not stop the others, and still reaches the caller", async () => {
    const ran: string[] = [];
    const failure = new Error("primary stop failed");
    await expect(runListenerShutdown(
      [
        async () => { ran.push("primary"); throw failure; },
        async () => { ran.push("loopback"); },
      ],
      async () => { ran.push("lifecycle"); },
    )).rejects.toBe(failure);
    // The whole point: a rejected primary stop must not strand the loopback socket or skip
    // the native lifecycle release.
    expect(ran).toEqual(["primary", "loopback", "lifecycle"]);
  });

  test("two failures are reported together rather than one hiding the other", async () => {
    const ran: string[] = [];
    let caught: unknown;
    try {
      await runListenerShutdown(
        [
          async () => { ran.push("primary"); throw new Error("a"); },
          async () => { ran.push("loopback"); throw new Error("b"); },
        ],
        async () => { ran.push("lifecycle"); },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toHaveLength(2);
    expect(ran).toEqual(["primary", "loopback", "lifecycle"]);
  });

  test("a failing lifecycle release is reported too", async () => {
    const failure = new Error("release failed");
    await expect(runListenerShutdown(
      [async () => {}],
      async () => { throw failure; },
    )).rejects.toBe(failure);
  });

  test("an all-clear shutdown resolves", async () => {
    await expect(runListenerShutdown([async () => {}, async () => {}], async () => {}))
      .resolves.toBeUndefined();
  });
});

describe("seams the runtime cannot defend", () => {
  // Two properties have no runtime oracle on this Bun version, and both would regress
  // silently. A source assertion is a weak instrument, but a weak instrument aimed at a known
  // blind spot beats none — the alternative is a comment nobody runs.
  const serverSource = readFileSync(join(process.cwd(), "src", "server", "index.ts"), "utf-8");

  test("the WebSocket upgrade uses the receiving server, never the captured binding", () => {
    // Swapping in `server.upgrade` stays green at runtime here: this Bun accepts an upgrade
    // issued from a sibling Bun.serve in the same process. Another version or platform is not
    // promised to, and the loopback listener would then fail to upgrade at all.
    expect(serverSource).not.toMatch(/\bif \(server\.upgrade\(req,/);
    expect(serverSource.match(/requestServer\.upgrade\(req,/g)?.length).toBe(2);
  });

  test("the loopback listener binds 127.0.0.1 explicitly", () => {
    // The connection-refused test above is the real oracle, but it degrades to a warning on a
    // host with no external IPv4 — and on that host the 0.0.0.0 ablation would pass. This
    // holds everywhere.
    expect(serverSource).toMatch(/port: loopbackListenerPort,\s*\n\s*hostname: "127\.0\.0\.1",/);
  });
});

describe("public port selection avoids the loopback port", () => {
  afterEach(() => setEphemeralPortAllocatorForTests(null));

  test("an explicit preference for the reserved port is refused rather than taken", async () => {
    const reserved = await freePort();
    // Free, yet must not be selected: taking it would bind the public listener onto the
    // address the loopback listener is configured for, and the loopback bind would then fail.
    await expect(findAvailablePort(reserved, "127.0.0.1", { reservedPort: reserved }))
      .rejects.toBeInstanceOf(PortUnavailableError);
  });

  test("ephemeral selection redraws when the OS hands back the reserved port", async () => {
    // Without a seam this branch is unreachable: the OS practically never returns the one
    // reserved port, so a loop over real draws would pass with the redraw code deleted.
    const reserved = 45_001;
    const draws = [reserved, reserved, 45_002];
    let index = 0;
    setEphemeralPortAllocatorForTests(async () => draws[index++] ?? 45_003);
    expect(await findAvailablePort(0, "127.0.0.1", { reservedPort: reserved })).toBe(45_002);
    expect(index).toBe(3);
  });

  test("redrawing is bounded rather than recursing forever", async () => {
    const reserved = 45_001;
    let draws = 0;
    setEphemeralPortAllocatorForTests(async () => {
      draws += 1;
      return reserved;
    });
    await expect(findAvailablePort(0, "127.0.0.1", { reservedPort: reserved })).rejects.toThrow();
    expect(draws).toBe(8);
  });

  test("an unreserved preference is still honored", async () => {
    const reserved = await freePort();
    const wanted = await freePort();
    if (wanted === reserved) return;
    expect(await findAvailablePort(wanted, "127.0.0.1", { reservedPort: reserved })).toBe(wanted);
  });
});

describe("Codex injection targets the loopback listener", () => {
  test("the written config points at the loopback port with no auth header", () => {
    // A subprocess, because CODEX_CONFIG_PATH is resolved at module load: setting CODEX_HOME
    // in-process would write to whatever path this test file already imported.
    //
    // The child passes the PUBLIC port to injectCodexConfig, which is what every real caller
    // does. The loopback substitution happens inside the injector, so handing the loopback
    // port straight to the block builder would keep passing with that wiring deleted.
    const root = mkdtempSync(join(tmpdir(), "ocx-loopback-inject-"));
    const codexHome = join(root, ".codex");
    const ocxHome = join(root, ".opencodex");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(ocxHome, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5"\n', "utf-8");
    const config = baseConfig(10_200) as Record<string, unknown>;
    config.port = 10_100;
    writeFileSync(join(ocxHome, "config.json"), JSON.stringify(config), "utf-8");
    try {
      const child = spawnSync(process.execPath, [
        join(process.cwd(), "tests", "helpers", "codex-inject-race-child.ts"),
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
          OPENCODEX_HOME: ocxHome,
          OCX_INJECT_RACE_PAYLOAD: JSON.stringify({ port: 10_100 }),
        },
      });
      const line = (child.stdout ?? "").trim().split("\n").filter(Boolean).pop() ?? "{}";
      expect(JSON.parse(line)).toMatchObject({ success: true });

      const written = readFileSync(join(codexHome, "config.toml"), "utf-8");
      expect(written).toContain("http://127.0.0.1:10200/v1");
      expect(written).not.toContain("http://127.0.0.1:10100/v1");
      expect(written).not.toContain("env_http_headers");
      expect(written).not.toContain("env_key");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
