import { afterEach, expect, test } from "bun:test";
import { createServer, request as httpRequest, type Server } from "node:http";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { repoPath } from "../helpers/repo-root";
import { createGateway } from "../../scripts/ocx-recovery-guardian/gateway.cjs";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

async function listen(handler: Parameters<typeof createServer>[0]): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  closers.push(() => new Promise(resolve => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  }));
  return { server, port: (server.address() as { port: number }).port };
}

function call(port: number, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method: options.method ?? "GET", path: options.path ?? "/healthz",
      headers: { host: `127.0.0.1:${port}`, ...(options.headers ?? {}) } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", reject);
    req.end(options.body);
  });
}

async function gateway(primaryPort: number, fallbackPort: number, primaryReady = true, overrides: Record<string, unknown> = {}) {
  const instance = await createGateway({
    port: 0,
    primaryOrigin: `http://127.0.0.1:${primaryPort}`,
    fallbackOrigin: `http://127.0.0.1:${fallbackPort}`,
    models: { "codex-test": "or-test" },
    readFallbackKey: async () => "fallback-secret",
    isPrimaryReady: () => primaryReady,
    isStopped: () => false,
    onPrimaryFailure: () => {},
    log: () => {},
    headerTimeoutMs: 500,
    ...overrides,
  });
  closers.push(instance.close);
  return instance;
}

async function nodeGatewayGetProof() {
  const gatewayPath = JSON.stringify(repoPath("scripts", "ocx-recovery-guardian", "gateway.cjs"));
  const script = `
    const http = require("node:http");
    const { createGateway } = require(${gatewayPath});
    const listen = handler => new Promise((resolve, reject) => {
      const server = http.createServer(handler);
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(server));
    });
    const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
    const get = port => new Promise((resolve, reject) => {
      const request = http.request({ host: "127.0.0.1", port, path: "/v1/models", headers: { host: "127.0.0.1:" + port } }, response => {
        let body = ""; response.setEncoding("utf8"); response.on("data", chunk => body += chunk); response.on("end", () => resolve({ status: response.statusCode, body }));
      });
      request.once("error", reject); request.end();
    });
    (async () => {
      const primary = await listen((_req, res) => res.end("primary-models"));
      const fallback = await listen((_req, res) => res.end("fallback-models"));
      let primaryReady = true;
      const gateway = await createGateway({
        port: 0,
        primaryOrigin: "http://127.0.0.1:" + primary.address().port,
        fallbackOrigin: "http://127.0.0.1:" + fallback.address().port,
        models: {}, readFallbackKey: async () => "fixed-test-key",
        isPrimaryReady: () => primaryReady, isStopped: () => false, onPrimaryFailure: () => {}, log: () => {},
      });
      try {
        const primaryResponse = await get(gateway.port);
        primaryReady = false;
        const fallbackResponse = await get(gateway.port);
        if (primaryResponse.status !== 200 || primaryResponse.body !== "primary-models" || fallbackResponse.status !== 200 || fallbackResponse.body !== "fallback-models") throw new Error("GET route result mismatch");
      } finally { await gateway.close(); await close(primary); await close(fallback); }
    })().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
  `;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("node.exe", ["-e", script], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 10_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(); else reject(new Error(`Node gateway GET proof failed (${code}): ${stderr}`));
    });
  });
}

test("healthy primary receives the supported route", async () => {
  let hits = 0;
  const primary = await listen((req, res) => {
    hits += 1;
    expect(req.url).toBe("/v1/responses");
    expect(req.headers["x-opencodex-api-key"]).toBe("ocx-key");
    expect(req.headers["chatgpt-account-id"]).toBe("account");
    expect(req.headers.session_id).toBe("session");
    expect(req.headers["x-codex-trace"]).toBe("trace");
    expect(req.headers["x-connection-nominated"]).toBeUndefined();
    res.writeHead(200, { authorization: "Bearer upstream", "set-cookie": "secret=value", location: "http://secret@example.test", "x-api-key": "upstream-key" });
    res.end("primary");
  });
  const fallback = await listen((_req, res) => res.end("fallback"));
  const instance = await gateway(primary.port, fallback.port);
  const result = await call(instance.port, { method: "POST", path: "/v1/responses", headers: {
    "x-opencodex-api-key": "ocx-key", "chatgpt-account-id": "account", session_id: "session", "x-codex-trace": "trace",
    connection: "keep-alive, x-connection-nominated", "x-connection-nominated": "must-not-forward",
  }, body: JSON.stringify({ model: "codex-test" }) });
  expect(result.status).toBe(200);
  expect(result.body).toBe("primary");
  expect(hits).toBe(1);
  expect(result.headers.authorization).toBeUndefined();
  expect(result.headers["set-cookie"]).toBeUndefined();
  expect(result.headers.location).toBeUndefined();
  expect(result.headers["x-api-key"]).toBeUndefined();
});

test("unready primary sends an exact mapped model to fallback with stripped credentials", async () => {
  const primary = await listen((_req, res) => res.end("unexpected"));
  let seen = "";
  let authorization = "";
  const fallback = await listen((req, res) => {
    authorization = String(req.headers.authorization);
    expect(req.headers.cookie).toBeUndefined();
    expect(req.headers["x-api-key"]).toBeUndefined();
    req.on("data", chunk => { seen += chunk; });
    req.on("end", () => res.end("fallback"));
  });
  const instance = await gateway(primary.port, fallback.port, false);
  const result = await call(instance.port, { method: "POST", path: "/v1/responses", headers: { authorization: "Bearer primary", "x-api-key": "primary-key", "openai-project": "primary-project" }, body: JSON.stringify({ model: "codex-test" }) });
  expect(result.body).toBe("fallback");
  expect(authorization).toBe("Bearer fallback-secret");
  expect(JSON.parse(seen)).toMatchObject({ model: "or-test" });
});

test("incompatible fallback models and previous-response continuations do not go outbound", async () => {
  const primary = await listen((_req, res) => res.end("unexpected"));
  let fallbackHits = 0;
  const fallback = await listen((_req, res) => { fallbackHits += 1; res.end("unexpected"); });
  const instance = await gateway(primary.port, fallback.port, false);
  const incompatible = await call(instance.port, { method: "POST", path: "/v1/responses", body: JSON.stringify({ model: "other" }) });
  expect(incompatible.status).toBe(503);
  expect(incompatible.body).toContain("fallback_model_unavailable");
  const continuation = await call(instance.port, { method: "POST", path: "/v1/responses", body: JSON.stringify({ model: "codex-test", previous_response_id: "resp_1" }) });
  expect(continuation.status).toBe(503);
  expect(continuation.body).toContain("fallback_requires_fresh_full_context");
  expect(fallbackHits).toBe(0);
});

test("a post-dispatch primary failure is never replayed to fallback", async () => {
  let primaryFailures = 0;
  const primary = await listen((_req, res) => { primaryFailures += 1; res.writeHead(503); res.end("down"); });
  let fallbackHits = 0;
  const fallback = await listen((_req, res) => { fallbackHits += 1; res.end("fallback"); });
  let charged = 0;
  const instance = await gateway(primary.port, fallback.port, true, { onPrimaryFailure: () => { charged += 1; } });
  const result = await call(instance.port, { method: "POST", path: "/v1/responses", body: JSON.stringify({ model: "codex-test" }) });
  expect(result.status).toBe(503);
  expect(primaryFailures).toBe(1);
  expect(fallbackHits).toBe(0);
  expect(charged).toBe(1);
});

test("primary 4xx is relayed without declaring the primary globally failed", async () => {
  const primary = await listen((_req, res) => { res.writeHead(400); res.end("client error"); });
  const fallback = await listen((_req, res) => res.end("fallback"));
  let failures = 0;
  const instance = await gateway(primary.port, fallback.port, true, { onPrimaryFailure: () => { failures += 1; } });
  const result = await call(instance.port, { method: "POST", path: "/v1/responses", body: JSON.stringify({ model: "codex-test" }) });
  expect(result.status).toBe(400);
  expect(failures).toBe(0);
});

test("handler exceptions become a sterile 502 instead of an unhandled rejection", async () => {
  const primary = await listen((_req, res) => res.end("unexpected"));
  const fallback = await listen((_req, res) => res.end("unexpected"));
  let failures = 0;
  const instance = await gateway(primary.port, fallback.port, true, {
    isPrimaryReady: () => { throw new Error("fixture"); },
    onPrimaryFailure: () => { failures += 1; },
  });
  const result = await call(instance.port, { path: "/v1/models" });
  expect(result.status).toBe(502);
  expect(result.body).toContain("gateway_unavailable");
  expect(result.body).not.toContain("fixture");
  expect(failures).toBe(1);
});

test("streaming primary output is passed through once and client close does not retry", async () => {
  let primaryHits = 0;
  const primary = await listen((_req, res) => {
    primaryHits += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first\n\n");
    setTimeout(() => res.end("data: [DONE]\n\n"), 25);
  });
  let fallbackHits = 0;
  const fallback = await listen((_req, res) => { fallbackHits += 1; res.end("fallback"); });
  const instance = await gateway(primary.port, fallback.port);
  const result = await call(instance.port, { method: "POST", path: "/v1/responses", body: JSON.stringify({ model: "codex-test" }) });
  expect(result.body).toContain("data: first");
  expect(primaryHits).toBe(1);
  expect(fallbackHits).toBe(0);
});

test("request ceiling and browser or Host requests are denied locally", async () => {
  const primary = await listen((_req, res) => res.end("unexpected"));
  const fallback = await listen((_req, res) => res.end("unexpected"));
  const instance = await gateway(primary.port, fallback.port);
  const origin = await call(instance.port, { headers: { origin: "https://example.test" } });
  expect(origin.status).toBe(403);
  const badHost = await new Promise<{ status: number }>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: instance.port, path: "/healthz", headers: { host: "example.test" } }, res => resolve({ status: res.statusCode ?? 0 }));
    req.once("error", reject); req.end();
  });
  expect(badHost.status).toBe(421);
  const query = await call(instance.port, { path: "/healthz?x=1" });
  expect(query.status).toBe(404);
  const healthPost = await call(instance.port, { method: "POST", path: "/healthz", body: "{}" });
  expect(healthPost.status).toBe(405);
  const large = await call(instance.port, { method: "POST", path: "/v1/responses", body: "x".repeat(8 * 1024 * 1024 + 1) });
  expect(large.status).toBe(413);
});

test("stopped gateway remains identifiable at healthz but rejects ready and data routes", async () => {
  const primary = await listen((_req, res) => res.end("unexpected"));
  const fallback = await listen((_req, res) => res.end("unexpected"));
  const instance = await gateway(primary.port, fallback.port, true, {
    isStopped: () => true,
    isPrimaryReady: () => { throw new Error("stopped probe must not call readiness"); },
  });
  const health = await call(instance.port, { path: "/healthz" });
  expect(health.status).toBe(200);
  expect(JSON.parse(health.body)).toMatchObject({ service: "ocx-recovery-gateway" });
  expect((await call(instance.port, { path: "/readyz" })).status).toBe(503);
  expect((await call(instance.port, { method: "POST", path: "/v1/responses", body: JSON.stringify({ model: "codex-test" }) })).status).toBe(503);
});

test("concurrent requests are capped before another 8 MiB body can be admitted", async () => {
  let primaryHits = 0;
  const held: import("node:http").ServerResponse[] = [];
  const primary = await listen((_req, response) => { primaryHits += 1; held.push(response); });
  const fallback = await listen((_req, res) => res.end("unexpected"));
  const instance = await gateway(primary.port, fallback.port, true, { maxConcurrentRequests: 64, headerTimeoutMs: 120_000 });
  for (let index = 0; index < 64; index += 1) {
    const req = httpRequest({ host: "127.0.0.1", port: instance.port, method: "POST", path: "/v1/responses",
      headers: { host: `127.0.0.1:${instance.port}`, "content-type": "application/json" } });
    req.on("error", () => {});
    req.end(JSON.stringify({ model: "codex-test", index }));
  }
  for (let attempt = 0; attempt < 100 && primaryHits < 64; attempt += 1) await Bun.sleep(10);
  expect(primaryHits).toBe(64);
  const rejected = await call(instance.port, { method: "POST", path: "/v1/responses", body: JSON.stringify({ model: "codex-test" }) });
  expect(rejected.status).toBe(503);
  expect(rejected.body).toContain("gateway_busy");
  for (const response of held) response.end();
  await Bun.sleep(20);
});

test("self-proxy origins and upgrades fail closed", async () => {
  const upstream = await listen((_req, res) => res.end("upstream"));
  await expect(createGateway({
    port: upstream.port, primaryOrigin: `http://127.0.0.1:${upstream.port}`, fallbackOrigin: "http://127.0.0.1:9",
    models: {}, readFallbackKey: async () => "x", isPrimaryReady: () => true, isStopped: () => false, onPrimaryFailure: () => {}, log: () => {},
  })).rejects.toThrow();
});

test("only canonical numeric IPv4 loopback origins are accepted", async () => {
  const invalidOrigins = [
    "http://localhost:1234",
    "http://127.000.000.001:1234",
    "http://2130706433:1234",
    "http://[::1]:1234",
    "http://127.0.0.1:01234",
  ];
  for (const primaryOrigin of invalidOrigins) {
    await expect(createGateway({
      port: 0, primaryOrigin, fallbackOrigin: "http://127.0.0.1:1235",
      models: {}, readFallbackKey: async () => "x", isPrimaryReady: () => true, isStopped: () => false, onPrimaryFailure: () => {}, log: () => {},
    })).rejects.toThrow("canonical numeric loopback");
  }
});

test("a real Node child relays GET models through both primary and fallback", async () => {
  await nodeGatewayGetProof();
});

// The guardian runs under Node, where a torn-down upstream surfaces as an aborted
// or reset response. Bun does not emit those events, so only a child process can
// tell a client hang-up apart from a primary that actually failed.
async function nodeGatewayCancelProof() {
  const gatewayPath = JSON.stringify(repoPath("scripts", "ocx-recovery-guardian", "gateway.cjs"));
  const script = `
    const http = require("node:http");
    const { createGateway } = require(${gatewayPath});
    const listen = handler => new Promise(resolve => {
      const server = http.createServer(handler);
      server.listen(0, "127.0.0.1", () => resolve(server));
    });
    const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
    (async () => {
      let charged = 0;
      let mode = "hold";
      let primary = null;
      let gateway = null;
      try {
        primary = await listen((_req, res) => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write("data: first\\n\\n");
          if (mode === "abort") res.socket.destroy();
        });
        gateway = await createGateway({
          port: 0,
          primaryOrigin: "http://127.0.0.1:" + primary.address().port,
          fallbackOrigin: "http://127.0.0.1:9",
          models: {}, readFallbackKey: async () => "fixed-test-key", isPrimaryReady: () => true,
          isStopped: () => false, onPrimaryFailure: () => { charged += 1; }, log: () => {},
        });
        await new Promise((resolve, reject) => {
          const request = http.request({ host: "127.0.0.1", port: gateway.port, method: "POST", path: "/v1/responses",
            headers: { host: "127.0.0.1:" + gateway.port, "content-type": "application/json" } }, response => {
            response.once("data", () => { response.destroy(); resolve(); });
          });
          request.on("error", reject);
          request.end(JSON.stringify({ model: "codex-test", stream: true }));
        });
        await new Promise(resolve => setTimeout(resolve, 400));
        if (charged !== 0) throw new Error("a client cancel charged " + charged + " primary failure(s)");
        // Positive control: the same counter must dare to move, or the line above
        // only proves that nothing ever charges it.
        mode = "abort";
        await new Promise(resolve => {
          const again = http.request({ host: "127.0.0.1", port: gateway.port, method: "POST", path: "/v1/responses",
            headers: { host: "127.0.0.1:" + gateway.port, "content-type": "application/json" } }, response => {
            response.resume();
            response.once("end", resolve);
          });
          again.on("error", resolve);
          again.end(JSON.stringify({ model: "codex-test", stream: true }));
        });
        await new Promise(resolve => setTimeout(resolve, 400));
        if (charged === 0) throw new Error("an upstream abort charged nothing, so the cancel assertion above is vacuous");
      } finally {
        // Always release the sockets: a child that hangs on a leaked stream would
        // report this check as a timeout instead of as the failure it is.
        if (gateway) await gateway.close();
        if (primary) await close(primary);
      }
    })().catch(error => { console.error(error && error.message || error); process.exitCode = 1; });
  `;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("node.exe", ["-e", script], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 20_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(); else reject(new Error(`Node gateway cancel proof failed (${code}): ${stderr}`));
    });
  });
}

test("a real Node child keeps the primary ready across a client cancel", async () => {
  await nodeGatewayCancelProof();
});

test("WebSocket upgrades receive 426 rather than a proxied connection", async () => {
  const primary = await listen((_req, res) => res.end("primary"));
  const fallback = await listen((_req, res) => res.end("fallback"));
  const instance = await gateway(primary.port, fallback.port);
  const response = await new Promise<string>((resolve, reject) => {
    const socket = connect(instance.port, "127.0.0.1");
    let received = "";
    socket.on("connect", () => socket.write(`GET /v1/realtime HTTP/1.1\r\nHost: 127.0.0.1:${instance.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`));
    socket.on("data", chunk => { received += chunk; });
    socket.on("end", () => resolve(received));
    socket.on("error", reject);
  });
  expect(response).toContain("426 Upgrade Required");
});
