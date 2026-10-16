import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { connect as connectTls } from "node:tls";
import { createLocalInterceptCa, issueLocalInterceptLeaf } from "../../src/claude/intercept/local-ca";
import { startChatgptUnblockListener } from "../../src/chatgpt/desktop-unblock/listener";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeChatgptUnblockListener } from "../../src/chatgpt/desktop-unblock/launch-watcher";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { spawnTestChild } from "../helpers/spawn-test-child";

// Isolate module mocks and the macOS gate from other test files. Runtime startup is
// deferred explicitly; handles own real loopback sockets, without a CA or app launch.
async function runLifecycle(body: string): Promise<void> {
  const result = await spawnTestChild([process.execPath, "-e", `
    import { strict as assert } from "node:assert";
    import { mock } from "bun:test";
    Object.defineProperty(process, "platform", { value: "darwin" });
    const starts = [], warnings = [], logs = [], sockets = [];
    const started = Promise.withResolvers();
    let stopCalls = 0, stopGate, app = "ChatGPT", matchesPac = false, matchesRule = false;
    const rulePorts = [];
    console.warn = text => warnings.push(text);
    console.log = text => logs.push(text);
    const tick = () => new Promise(resolve => setImmediate(resolve));
    const options = (desktop = {}, role) => ({
      config: { chatgptDesktop: { unblockSend: true, ...desktop }, runtimeRole: role },
      publicPort: 10100,
    });
    function bind(port = 0) {
      const socket = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
      sockets.push(socket);
      return socket;
    }
    function fulfillStart(index = 0, extra = {}) {
      const listener = bind();
      const handle = {
        port: listener.port, caCertPath: "/test-config/ca.pem", listener,
        async stop() { stopCalls++; await stopGate?.promise; listener.stop(true); },
        ...extra,
      };
      starts[index].resolve(handle);
      return handle;
    }
    function assertPortReleased(port) { bind(port).stop(true); }
    mock.module(${JSON.stringify(repoPath("src/config/paths.ts"))}, () => ({ getConfigDir: () => "/test-config" }));
    mock.module(${JSON.stringify(repoPath("src/chatgpt/desktop-unblock/runtime.ts"))}, () => ({
      startChatgptUnblock(options) {
        const deferred = Promise.withResolvers();
        starts.push({ options, ...deferred });
        started.resolve();
        return deferred.promise;
      },
    }));
    mock.module(${JSON.stringify(repoPath("src/chatgpt/desktop-unblock/launch-watcher.ts"))}, () => ({
      chatgptAppCommandLine: () => app,
      chatgptCommandLineHasPac: () => matchesPac,
      chatgptCommandLineHasRule: (_app, port) => { rulePorts.push(port); return matchesRule; },
    }));
    const { createChatgptUnblockLifecycle } = await import(${JSON.stringify(repoPath("src/server/index/chatgpt-unblock-lifecycle.ts"))});
    const lifecycle = createChatgptUnblockLifecycle();
    try { ${body} } finally { for (const socket of sockets) socket.stop(true); }
  `], { cwd: repoRoot(), env: { ...process.env }, deadlineMs: 10_000 });
  expect(result.timedOut, result.stderr).toBe(false);
  expect(result.exitCode, result.stderr).toBe(0);
}

describe("ChatGPT unblock single-shot listener ownership", () => {
  test("concurrent enabled starts retain one listener and the first options", async () => {
    await runLifecycle(`
      const first = options({ port: 10300 });
      lifecycle.start(first);
      lifecycle.start(options({ port: 10400 }));
      await started.promise;
      await tick();
      assert.equal(starts.length, 1);
      assert.equal(starts[0].options, first);
      const handle = fulfillStart();
      await lifecycle.stop();
      assert.equal(stopCalls, 1);
      assertPortReleased(handle.port);
    `);
  }, 20_000);

  test("a disabled second start cannot discard an in-flight listener", async () => {
    await runLifecycle(`
      lifecycle.start(options());
      await started.promise;
      lifecycle.start(options({ unblockSend: false }));
      const handle = fulfillStart();
      await lifecycle.stop();
      assert.equal(starts.length, 1);
      assert.equal(stopCalls, 1);
      assertPortReleased(handle.port);
    `);
  }, 20_000);

  test("later enabled and disabled starts leave an already-active listener owned", async () => {
    await runLifecycle(`
      lifecycle.start(options());
      await started.promise;
      const handle = fulfillStart();
      await tick();
      assert.ok(logs.some(message => message.includes("send-unblock active")));
      lifecycle.start(options({ port: 10400 }));
      lifecycle.start(options({ unblockSend: false }));
      await lifecycle.stop();
      assert.equal(starts.length, 1);
      assert.equal(stopCalls, 1);
      assertPortReleased(handle.port);
    `);
  }, 20_000);

  test("stop while startup is pending waits for and closes the eventual listener", async () => {
    await runLifecycle(`
      lifecycle.start(options());
      let stopped = false;
      const stopping = lifecycle.stop().then(() => { stopped = true; });
      await started.promise;
      await tick();
      assert.equal(stopped, false);
      assert.equal(stopCalls, 0);
      const handle = fulfillStart();
      await stopping;
      assert.equal(stopped, true);
      assert.equal(stopCalls, 1);
      assertPortReleased(handle.port);
    `);
  }, 20_000);

  test("repeated stops join the same shutdown and report the route warning once", async () => {
    await runLifecycle(`
      lifecycle.start(options());
      await started.promise;
      const handle = fulfillStart();
      matchesRule = true;
      stopGate = Promise.withResolvers();
      const first = lifecycle.stop(), second = lifecycle.stop();
      assert.equal(first, second);
      let stopped = false;
      void second.then(() => { stopped = true; });
      await tick();
      assert.equal(stopCalls, 1);
      assert.equal(stopped, false);
      stopGate.resolve();
      await Promise.all([first, second]);
      assert.equal(lifecycle.stop(), first);
      await lifecycle.stop();
      assert.equal(stopCalls, 1);
      assert.equal(warnings.length, 2);
      assert.ok(warnings[0].includes("still routed to port " + handle.port));
      assert.ok(warnings[1].includes("ocx chatgpt restore"));
      assert.deepEqual(rulePorts, [handle.port]);
      assertPortReleased(handle.port);
    `);
  }, 20_000);

  test("starts during shutdown and after stop cannot create another listener", async () => {
    await runLifecycle(`
      lifecycle.start(options());
      await started.promise;
      const stopping = lifecycle.stop();
      lifecycle.start(options({ port: 10400 }));
      const handle = fulfillStart();
      await stopping;
      lifecycle.start(options({ port: 10500 }));
      await tick();
      assert.equal(starts.length, 1);
      assert.equal(stopCalls, 1);
      assertPortReleased(handle.port);
    `);
  }, 20_000);

  test("stop before start permanently closes an unused lifecycle", async () => {
    await runLifecycle(`
      const stopping = lifecycle.stop();
      lifecycle.start(options());
      await stopping;
      lifecycle.start(options());
      await tick();
      assert.equal(starts.length, 0);
      assert.equal(stopCalls, 0);
    `);
  }, 20_000);

  test.each(["disabled", "client", "platform"])("a %s initial start stays inactive", async gate => {
    await runLifecycle(`
      ${gate === "platform" ? 'Object.defineProperty(process, "platform", { value: "linux" });' : ""}
      lifecycle.start(options(${gate === "disabled" ? "{ unblockSend: false }" : "{}"}, ${gate === "client" ? '"client"' : "undefined"}));
      Object.defineProperty(process, "platform", { value: "darwin" });
      lifecycle.start(options());
      await tick();
      assert.equal(starts.length, 0);
      await lifecycle.stop();
      assert.deepEqual(warnings, []);
      assert.deepEqual(logs, []);
    `);
  }, 20_000);

  test.each([false, true])("ignored starts preserve the original PAC mode (%s)", async pacMode => {
    await runLifecycle(`
      lifecycle.start(options({ pacFallback: ${pacMode} }));
      await started.promise;
      lifecycle.start(options({ pacFallback: ${!pacMode} }));
      await tick();
      assert.equal(starts.length, 1);
      const handle = fulfillStart();
      matchesPac = matchesRule = true;
      await lifecycle.stop();
      assert.equal(warnings.length, 2);
      assert.ok(warnings[0].includes(${JSON.stringify(pacMode ? "still launched with opencodex's PAC" : "still routed to port ")}));
      assert.deepEqual(rulePorts, ${pacMode ? "[]" : "[handle.port]"});
      assert.equal(starts.length, 1);
    `);
  }, 20_000);

  test("startup rejection stays a single warning and shutdown still completes", async () => {
    await runLifecycle(`
      lifecycle.start(options());
      await started.promise;
      starts[0].reject(new Error("test bind failure"));
      await lifecycle.stop();
      await lifecycle.stop();
      assert.equal(stopCalls, 0);
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].includes("could not start: test bind failure"));
    `);
  }, 20_000);

  test("a null runtime result needs no shutdown and does not allow another start", async () => {
    await runLifecycle(`
      lifecycle.start(options());
      await started.promise;
      starts[0].resolve(null);
      await tick();
      lifecycle.start(options());
      await lifecycle.stop();
      assert.equal(starts.length, 1);
      assert.equal(stopCalls, 0);
      assert.deepEqual(warnings, []);
      assert.deepEqual(logs, []);
    `);
  }, 20_000);

  test("shutdown failures propagate to every caller without stopping twice", async () => {
    await runLifecycle(`
      lifecycle.start(options());
      await started.promise;
      const failure = new Error("test stop failure");
      fulfillStart(0, { async stop() { stopCalls++; throw failure; } });
      const first = lifecycle.stop(), second = lifecycle.stop();
      assert.equal(first, second);
      await assert.rejects(first, error => error === failure);
      await assert.rejects(second, error => error === failure);
      await assert.rejects(lifecycle.stop(), error => error === failure);
      lifecycle.start(options());
      await tick();
      assert.equal(starts.length, 1);
      assert.equal(stopCalls, 1);
    `);
  }, 20_000);
});


// Real listeners and fixture-only macOS dispatch: this checks process/socket recovery,
// not Chromium's cached PAC fallback or the user's installed application.
describe.skipIf(process.platform === "win32")("ChatGPT unblock process crash recovery", () => {
  test("SIGKILL releases both ports and restart replaces stale PAC and readiness files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-unblock-crash-"));
    let safeToRemove = true;
    const scutil = (proxyPort: number) => writeFileSync(join(dir, "scutil"),
      `#!/bin/sh\nprintf '%s\\n' '<dictionary> {' 'HTTPSEnable : 1' 'HTTPSProxy : 127.0.0.1' 'HTTPSPort : ${proxyPort}' '}'\n`, { mode: 0o755 });
    const source = `
      import { strict as assert } from "node:assert";
      import { freeLoopbackPortPair as freePair } from ${JSON.stringify(repoPath("tests/helpers/free-loopback-port-pair.ts"))};
      import { readFileSync, writeFileSync } from "node:fs";
      import { startChatgptUnblock, chatgptUnblockPacPath, chatgptUnblockReadyPath } from ${JSON.stringify(repoPath("src/chatgpt/desktop-unblock/runtime.ts"))};
      import { probeChatgptUnblockListener } from ${JSON.stringify(repoPath("src/chatgpt/desktop-unblock/launch-watcher.ts"))};
      Object.defineProperty(process, "platform", { value: "darwin" });
      const dir = ${JSON.stringify(dir)};
      async function start(port) {
        const handle = await startChatgptUnblock({ config: { chatgptDesktop: { unblockSend: true, pacFallback: true, port } }, publicPort: 0, configDir: dir });
        assert.ok(handle);
        assert.equal((await probeChatgptUnblockListener(port, undefined, undefined, dir)).state, "ours");
        return handle;
      }
    `;
    const env = { ...process.env, PATH: dir, OPENCODEX_HOME: dir };
    try {
      scutil(7892);
      safeToRemove = false;
      const crashed = await spawnTestChild([process.execPath, "-e", source + `
        const handle = await start(freePair());
        const established = Promise.withResolvers();
        const client = await Bun.connect({ hostname: "127.0.0.1", port: handle.entryProxy.port,
          socket: { data(_socket, data) { if (Buffer.from(data).toString().startsWith("HTTP/1.1 200")) established.resolve(); }, error() {} } });
        client.write("CONNECT chatgpt.com:443 HTTP/1.1\\r\\n\\r\\n");
        await established.promise;
        writeFileSync(dir + "/crash-state.json", JSON.stringify({
          port: handle.port, entryPort: handle.entryProxy.port,
          pac: readFileSync(chatgptUnblockPacPath(dir), "utf8"),
          ready: readFileSync(chatgptUnblockReadyPath(dir), "utf8"),
        }));
        process.kill(process.pid, "SIGKILL");
      `], { cwd: repoRoot(), env, deadlineMs: 8_000 });
      safeToRemove = crashed.reaped;
      expect(crashed.timedOut, crashed.stderr).toBe(false);
      expect(crashed.reaped, crashed.stderr).toBe(true);
      expect(crashed.signal, crashed.stderr).toBe("SIGKILL");
      const state = JSON.parse(readFileSync(join(dir, "crash-state.json"), "utf8")) as { port: number; entryPort: number; pac: string; ready: string };
      expect(readFileSync(join(dir, "chatgpt-unblock.pac"), "utf8")).toBe(state.pac);
      expect(readFileSync(join(dir, "chatgpt-unblock.ready"), "utf8")).toBe(state.ready);
      expect(state.pac).toContain("PROXY 127.0.0.1:7892");
      expect(state.pac).not.toContain("DIRECT");
      expect(await probeChatgptUnblockListener(state.port, undefined, undefined, dir)).toEqual({ state: "down" });
      for (const port of [state.port, state.entryPort]) {
        Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true);
      }
      scutil(7893);
      safeToRemove = false;
      const restarted = await spawnTestChild([process.execPath, "-e", source + `
        const before = JSON.parse(readFileSync(dir + "/crash-state.json", "utf8"));
        const handle = await start(before.port);
        try {
          assert.equal(handle.entryProxy.port, before.entryPort);
          const pac = readFileSync(chatgptUnblockPacPath(dir), "utf8");
          assert.ok(pac.includes("PROXY 127.0.0.1:7893"));
          assert.ok(!pac.includes("PROXY 127.0.0.1:7892"));
          assert.ok(!pac.includes("DIRECT"));
          assert.notEqual(readFileSync(chatgptUnblockReadyPath(dir), "utf8"), before.ready);
        } finally { await handle.stop(); }
        for (const port of [before.port, before.entryPort]) {
          Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true);
        }
      `], { cwd: repoRoot(), env, deadlineMs: 8_000 });
      safeToRemove = restarted.reaped;
      expect(restarted.timedOut, restarted.stderr).toBe(false);
      expect(restarted.reaped, restarted.stderr).toBe(true);
      expect(restarted.exitCode, restarted.stderr).toBe(0);
      expect(existsSync(join(dir, "chatgpt-unblock.ready"))).toBe(true);
      expect(await probeChatgptUnblockListener(state.port, undefined, undefined, dir)).toEqual({ state: "down" });
    } finally {
      if (safeToRemove) rmSync(dir, { recursive: true, force: true });
    }
  }, 25_000);
});


test("stopping the TLS listener closes an established WebSocket and its upstream", async () => {
  const ca = createLocalInterceptCa(), leaf = issueLocalInterceptLeaf(ca, ["chatgpt.com"]);
  const upstreamClosed = Promise.withResolvers<boolean>();
  let upstreamSocket: { terminate(): void } | undefined;
  const upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0, tls: { cert: leaf.certPem, key: leaf.keyPem },
    fetch(request, server) { if (!server.upgrade(request)) return new Response("upgrade required", { status: 400 }); },
    websocket: { open(socket) { upstreamSocket = socket; }, message() {}, close() { upstreamClosed.resolve(true); } },
  });
  const listener = startChatgptUnblockListener({
    leaf, wsUpstream: { proxy: null, target: { host: "127.0.0.1", port: upstream.port! }, ca: ca.certPem },
  });
  const client = connectTls({ host: "127.0.0.1", port: listener.port!, servername: "chatgpt.com", ca: ca.certPem });
  client.on("error", () => {});
  const clientClosed = new Promise<boolean>(resolve => client.once("close", () => resolve(true)));
  const withinDeadline = async (promise: Promise<boolean>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1_000); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    await once(client, "secureConnect");
    const head = new Promise<string>(resolve => {
      let buffer = "";
      client.on("data", chunk => { buffer += chunk.toString(); if (buffer.includes("\r\n\r\n")) resolve(buffer); });
    });
    client.write("GET /dictation/stream HTTP/1.1\r\nHost: chatgpt.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
    expect(await head).toStartWith("HTTP/1.1 101");
    expect(await withinDeadline(Promise.resolve(listener.stop(true)).then(() => true))).toBe(true);
    expect(await withinDeadline(clientClosed)).toBe(true);
    expect(await withinDeadline(upstreamClosed.promise)).toBe(true);
  } finally {
    client.destroy();
    upstreamSocket?.terminate();
    await listener.stop(true);
    await upstream.stop(true);
  }
});
