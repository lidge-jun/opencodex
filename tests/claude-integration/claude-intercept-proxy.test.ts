import { afterAll, expect, test } from "bun:test";
import { connect, createServer, type Socket } from "node:net";
import { CLAUDE_INTERCEPT_HOSTS, isLoopbackTarget, parseConnectRequestLine, startConnectProxy, type ConnectProxyHandle } from "../../src/claude/intercept/connect-proxy";
import { startClaudeInterceptListener, rewriteInterceptedRequest } from "../../src/claude/intercept/listener";
import { createLocalInterceptCa, issueLocalInterceptLeaf } from "../../src/claude/intercept/local-ca";

/**
 * End-to-end shape of the intercept pair: a client that only knows `HTTPS_PROXY` and trusts the
 * local CA reaches the router's Messages handler for `api.anthropic.com`, while every other
 * CONNECT target is relayed blind. No real network: the "upstream" for blind tunnels is a local
 * echo socket and the relay target for non-Messages paths is a local Bun server.
 */

const cleanups: Array<() => Promise<void> | void> = [];
const AUTH_TOKEN = "test-proxy-token";
const AUTH_HEADER = `Proxy-Authorization: Basic ${Buffer.from(`opencodex:${AUTH_TOKEN}`).toString("base64")}\r\n`;
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

test("parseConnectRequestLine accepts host:port and bracketed IPv6, rejects the rest", () => {
  expect(parseConnectRequestLine("CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: x")).toEqual({ host: "api.anthropic.com", port: 443 });
  expect(parseConnectRequestLine("CONNECT API.Anthropic.COM.:443 HTTP/1.0")).toEqual({ host: "api.anthropic.com", port: 443 });
  expect(parseConnectRequestLine("CONNECT [::1]:8443 HTTP/1.1")).toEqual({ host: "::1", port: 8443 });
  expect(parseConnectRequestLine("GET http://example.com/ HTTP/1.1")).toBeNull();
  expect(parseConnectRequestLine("CONNECT example.com HTTP/1.1")).toBeNull();
  expect(parseConnectRequestLine("CONNECT example.com:99999 HTTP/1.1")).toBeNull();
});

function rawRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => socket.write(payload));
    let out = "";
    socket.on("data", chunk => { out += chunk.toString("latin1"); });
    socket.on("end", () => resolve(out));
    socket.on("close", () => resolve(out));
    socket.on("error", reject);
  });
}

async function startEchoUpstream(): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer(socket => socket.on("data", chunk => socket.write(`echo:${chunk.toString()}`)));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  return { port, close: () => new Promise(resolve => server.close(() => resolve())) };
}

async function startPair(): Promise<{ proxy: ConnectProxyHandle; ca: ReturnType<typeof createLocalInterceptCa>; seen: Request[]; relayHits: string[] }> {
  const ca = createLocalInterceptCa();
  const leaf = issueLocalInterceptLeaf(ca, CLAUDE_INTERCEPT_HOSTS);
  const seen: Request[] = [];
  const relayHits: string[] = [];
  const fakeUpstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      relayHits.push(`${req.method} ${new URL(req.url).pathname} host=${req.headers.get("host")}`);
      return new Response(JSON.stringify({ relayed: true }), { headers: { "content-type": "application/json", "x-upstream": "fake" } });
    },
  });
  cleanups.push(() => fakeUpstream.stop(true));
  const listener = startClaudeInterceptListener({
    leaf,
    upstreamBase: `http://127.0.0.1:${fakeUpstream.port}`,
    dispatch: async req => {
      seen.push(req);
      const body = await req.text();
      return Response.json({ dispatched: true, url: req.url, host: req.headers.get("host"), body });
    },
  });
  cleanups.push(() => listener.stop(true));
  const echo = await startEchoUpstream();
  cleanups.push(echo.close);
  const proxy = await startConnectProxy(0, {
    interceptPort: listener.port!,
    authToken: AUTH_TOKEN,
    dialUpstream: (host, port) => {
      expect(host).toBe("telemetry.example");
      expect(port).toBe(443);
      return connect({ host: "127.0.0.1", port: echo.port });
    },
  });
  cleanups.push(proxy.close);
  return { proxy, ca, seen, relayHits };
}

/** Speak HTTPS to `api.anthropic.com` through the CONNECT proxy, trusting only the local CA. */
async function viaProxy(proxyPort: number, caPem: string, method: string, path: string, body?: string): Promise<{ status: number; headers: Headers; body: string }> {
  const res = await fetch(`https://api.anthropic.com${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": "sk-ant-test" },
    body,
    proxy: `http://opencodex:${AUTH_TOKEN}@127.0.0.1:${proxyPort}`,
    tls: { ca: caPem },
  });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

test("CONNECT api.anthropic.com terminates TLS locally and dispatches Messages to the router", async () => {
  const { proxy, ca, seen } = await startPair();
  const res = await viaProxy(proxy.port, ca.certPem, "POST", "/v1/messages?beta=true", JSON.stringify({ model: "claude-x" }));
  expect(res.status).toBe(200);
  const json = JSON.parse(res.body) as { dispatched: boolean; url: string; host: string; body: string };
  expect(json.dispatched).toBe(true);
  expect(json.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/messages\?beta=true$/);
  expect(json.host).toMatch(/^127\.0\.0\.1:\d+$/);
  expect(json.body).toBe(JSON.stringify({ model: "claude-x" }));
  expect(seen).toHaveLength(1);
  expect(seen[0]!.headers.get("x-api-key")).toBe("sk-ant-test");
});

test("non-Messages paths on the intercepted host are relayed to upstream, not dispatched", async () => {
  const { proxy, ca, seen, relayHits } = await startPair();
  const res = await viaProxy(proxy.port, ca.certPem, "GET", "/v1/models?limit=1");
  expect(res.status).toBe(200);
  expect(JSON.parse(res.body)).toEqual({ relayed: true });
  expect(res.headers.get("x-upstream")).toBe("fake");
  expect(relayHits).toEqual(["GET /v1/models host=127.0.0.1:" + relayHits[0]!.split(":").pop()]);
  expect(seen).toHaveLength(0);
});

test("GET on /v1/messages is relayed rather than dispatched", async () => {
  const { proxy, ca, seen, relayHits } = await startPair();
  await viaProxy(proxy.port, ca.certPem, "GET", "/v1/messages");
  expect(seen).toHaveLength(0);
  expect(relayHits[0]).toStartWith("GET /v1/messages ");
});

test("other CONNECT targets are relayed blind, including pipelined bytes after the head", async () => {
  const { proxy } = await startPair();
  const out = await new Promise<string>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: proxy.port }, () => {
      socket.write(`CONNECT telemetry.example:443 HTTP/1.1\r\nHost: telemetry.example:443\r\n${AUTH_HEADER}\r\nhello`);
    });
    let buf = "";
    socket.on("data", chunk => {
      buf += chunk.toString("latin1");
      if (buf.includes("echo:hello")) { socket.end(); resolve(buf); }
    });
    socket.on("error", reject);
  });
  expect(out.startsWith("HTTP/1.1 200 Connection Established\r\n\r\n")).toBe(true);
  expect(out).toContain("echo:hello");
});

function tunnelPayload(port: number, host: string, payload = "hello"): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () =>
      socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n${AUTH_HEADER}\r\n${payload}`));
    let out = "";
    socket.on("data", chunk => {
      out += chunk.toString("latin1");
      if (out.includes(`echo:${payload}`)) { socket.end(); resolve(out); }
    });
    socket.on("error", reject);
  });
}

test("per-connection override chooses its own listener or blind tunnel", async () => {
  const echo = await startEchoUpstream();
  cleanups.push(echo.close);
  const selected: string[] = [];
  const proxy = await startConnectProxy(0, {
    interceptPort: 1,
    authToken: AUTH_TOKEN,
    selectTunnel: (host, port) => {
      selected.push(`${host}:${port}`);
      return host === "claude.ai" ? { kind: "intercept", port: echo.port } : { kind: "blind" };
    },
    dialUpstream: () => connect({ host: "127.0.0.1", port: echo.port }),
  });
  cleanups.push(proxy.close);
  expect(await tunnelPayload(proxy.port, "claude.ai")).toContain("echo:hello");
  expect(await tunnelPayload(proxy.port, "other.example")).toContain("echo:hello");
  expect(selected).toEqual(["claude.ai:443", "other.example:443"]);
});

test("pending async choice holds pipelined bytes, then connects; rejection falls back blind", async () => {
  const echo = await startEchoUpstream();
  cleanups.push(echo.close);
  let settle!: (choice: { kind: "intercept"; port: number }) => void;
  let dialCount = 0;
  const proxy = await startConnectProxy(0, {
    interceptPort: 1,
    authToken: AUTH_TOKEN,
    selectTunnel: host => host === "claude.ai"
      ? new Promise(resolve => { settle = resolve; })
      : Promise.reject(new Error("decision failed")),
    dialUpstream: () => { dialCount += 1; return connect({ host: "127.0.0.1", port: echo.port }); },
  });
  cleanups.push(proxy.close);
  const delayed = tunnelPayload(proxy.port, "claude.ai", "pending");
  await Bun.sleep(20);
  expect(dialCount).toBe(0);
  settle({ kind: "intercept", port: echo.port });
  expect(await delayed).toContain("echo:pending");
  expect(dialCount).toBe(0);
  expect(await tunnelPayload(proxy.port, "failed.example", "blind")).toContain("echo:blind");
  expect(dialCount).toBe(1);
});

test("a closed client during an async decision causes no upstream dial", async () => {
  let settle!: (choice: { kind: "blind" }) => void;
  let dialCount = 0;
  const proxy = await startConnectProxy(0, {
    interceptPort: 1,
    authToken: AUTH_TOKEN,
    selectTunnel: () => new Promise(resolve => { settle = resolve; }),
    dialUpstream: () => { dialCount += 1; return connect({ host: "127.0.0.1", port: 1 }); },
  });
  cleanups.push(proxy.close);
  const client: Socket = connect({ host: "127.0.0.1", port: proxy.port }, () =>
    client.write(`CONNECT claude.ai:443 HTTP/1.1\r\n${AUTH_HEADER}\r\n`));
  await new Promise<void>(resolve => {
    const check = setInterval(() => {
      if (!settle) return;
      clearInterval(check);
      client.destroy();
      client.once("close", resolve);
    }, 1);
  });
  await Bun.sleep(20);
  settle({ kind: "blind" });
  await Bun.sleep(0);
  expect(dialCount).toBe(0);
});

test("invalid request and loopback are refused before consulting tunnel choice", async () => {
  let consulted = 0;
  const proxy = await startConnectProxy(0, {
    interceptPort: 1,
    authToken: AUTH_TOKEN,
    selectTunnel: () => { consulted += 1; return { kind: "blind" }; },
  });
  cleanups.push(proxy.close);
  expect(await rawRequest(proxy.port, "GET http://example.com/ HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 405");
  expect(await rawRequest(proxy.port, `CONNECT localhost:443 HTTP/1.1\r\n${AUTH_HEADER}\r\n`)).toStartWith("HTTP/1.1 403");
  expect(consulted).toBe(0);
});

test("restricted CONNECT admits only exact normalized authorities before tunnel selection", async () => {
  const echo = await startEchoUpstream();
  cleanups.push(echo.close);
  const selected: string[] = [];
  let blindDials = 0;
  const allowedTargets = ["CHATGPT.COM.:443"];
  const proxy = await startConnectProxy(0, {
    interceptPort: echo.port,
    interceptHosts: ["chatgpt.com"],
    allowedTargets,
    selectTunnel: (host, port) => { selected.push(`${host}:${port}`); return null; },
    dialUpstream: () => { blindDials++; return connect({ host: "127.0.0.1", port: echo.port }); },
  });
  cleanups.push(proxy.close);
  // A caller mutating its original array cannot broaden a running listener.
  allowedTargets.push("other.example:443");
  expect(await tunnelPayload(proxy.port, "ChatGPT.Com.")).toContain("echo:hello");
  for (const authority of ["other.example:443", "chatgpt.com:8443", "child.chatgpt.com:443", "chatgpt.com.evil.example:443"]) {
    expect(await rawRequest(proxy.port, `CONNECT ${authority} HTTP/1.1\r\nUser-Agent: Mozilla/test\r\n\r\npipelined`)).toStartWith("HTTP/1.1 403");
  }
  expect(selected).toEqual(["chatgpt.com:443"]);
  expect(blindDials).toBe(0);
});

test("empty CONNECT allowlist denies all and cannot enter a failing selector", async () => {
  let called = false;
  const proxy = await startConnectProxy(0, {
    interceptPort: 1,
    allowedTargets: [],
    selectTunnel: () => { called = true; throw new Error("must not run"); },
  });
  cleanups.push(proxy.close);
  expect(await rawRequest(proxy.port, "CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 403");
  expect(called).toBe(false);
});

test("destination restriction does not replace authentication or loopback refusal", async () => {
  const proxy = await startConnectProxy(0, {
    interceptPort: 1, authToken: AUTH_TOKEN, allowedTargets: ["chatgpt.com:443", "127.0.0.1:443"],
  });
  cleanups.push(proxy.close);
  expect(await rawRequest(proxy.port, "CONNECT chatgpt.com:443 HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 407");
  expect(await rawRequest(proxy.port, `CONNECT 127.0.0.1:443 HTTP/1.1\r\n${AUTH_HEADER}\r\n`)).toStartWith("HTTP/1.1 403");
});

test("malformed destination restrictions fail before a listener starts", () => {
  for (const authority of ["", "*.example.com:443", "example.com", "example.com:0", "example.com:65536", "example.com:443\r\nX: value", "https://example.com:443"]) {
    expect(() => startConnectProxy(0, { interceptPort: 1, allowedTargets: [authority] })).toThrow("Invalid CONNECT allowed target");
  }
});

test("plain proxied HTTP, loopback targets and oversized heads are refused", async () => {
  const { proxy } = await startPair();
  expect(await rawRequest(proxy.port, "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n")).toStartWith("HTTP/1.1 405");
  expect(await rawRequest(proxy.port, `CONNECT 127.0.0.1:22 HTTP/1.1\r\n${AUTH_HEADER}\r\n`)).toStartWith("HTTP/1.1 403");
  expect(await rawRequest(proxy.port, `CONNECT localhost:443 HTTP/1.1\r\n${AUTH_HEADER}\r\n`)).toStartWith("HTTP/1.1 403");
  expect(await rawRequest(proxy.port, `CONNECT [::ffff:127.0.0.1]:22 HTTP/1.1\r\n${AUTH_HEADER}\r\n`)).toStartWith("HTTP/1.1 403");
  expect(await rawRequest(proxy.port, `CONNECT a:443 HTTP/1.1\r\nX: ${"y".repeat(9000)}`)).toStartWith("HTTP/1.1 431");
  // One read that carries a complete but oversized head is refused the same way.
  expect(await rawRequest(proxy.port, `CONNECT a:443 HTTP/1.1\r\nX: ${"y".repeat(9000)}\r\n\r\n`)).toStartWith("HTTP/1.1 431");
});

test("CONNECT requires the per-install proxy credential", async () => {
  const { proxy } = await startPair();
  expect(await rawRequest(proxy.port, "CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 407");
  expect(await rawRequest(proxy.port, "CONNECT api.anthropic.com:443 HTTP/1.1\r\nProxy-Authorization: Basic bad\r\n\r\n")).toStartWith("HTTP/1.1 407");
});

test("isLoopbackTarget covers mapped, unspecified and shorthand loopback literals", () => {
  for (const host of ["localhost", "foo.localhost", "127.0.0.1", "127.255.0.9", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "0.0.0.0", "::", "127.1", "0x7f000001", "2130706433"]) {
    expect(isLoopbackTarget(host)).toBe(true);
  }
  for (const host of ["api.anthropic.com", "10.0.0.1", "::ffff:10.0.0.1", "2606:4700::1", "1.example"]) {
    expect(isLoopbackTarget(host)).toBe(false);
  }
});

test("a dead upstream yields 502 instead of a hung tunnel", async () => {
  const dead = await startEchoUpstream();
  await dead.close();
  const proxy = await startConnectProxy(0, {
    interceptPort: 1,
    authToken: AUTH_TOKEN,
    dialUpstream: () => connect({ host: "127.0.0.1", port: dead.port }),
  });
  cleanups.push(proxy.close);
  expect(await rawRequest(proxy.port, `CONNECT gone.example:443 HTTP/1.1\r\n${AUTH_HEADER}\r\n`)).toStartWith("HTTP/1.1 502");
});

test("rewriteInterceptedRequest moves the request onto the loopback origin and keeps path, query and headers", () => {
  const original = new Request("https://api.anthropic.com/v1/messages?x=1", {
    method: "POST",
    headers: { "anthropic-version": "2023-06-01", host: "api.anthropic.com" },
    body: "{}",
  });
  const rewritten = rewriteInterceptedRequest(original, "http://127.0.0.1:4567");
  expect(rewritten.url).toBe("http://127.0.0.1:4567/v1/messages?x=1");
  expect(rewritten.headers.get("host")).toBe("127.0.0.1:4567");
  expect(rewritten.headers.get("anthropic-version")).toBe("2023-06-01");
  expect(rewritten.method).toBe("POST");
});

test("every authentication rejection includes a Basic proxy challenge before any dial", async () => {
  for (const authToken of [AUTH_TOKEN, () => null, () => { throw new Error("unavailable"); }]) {
    let dials = 0;
    const proxy = await startConnectProxy(0, {
      interceptPort: 1, authToken,
      dialUpstream: () => { dials += 1; throw new Error("unexpected dial"); },
    });
    try {
      for (const header of ["", "Proxy-Authorization: Basic invalid\r\n"]) {
        const response = await rawRequest(proxy.port,
          `CONNECT telemetry.example:443 HTTP/1.1\r\nHost: telemetry.example:443\r\n${header}\r\n`);
        expect(response).toMatch(/^HTTP\/1\.1 407 /);
        expect(response).toContain('\r\nProxy-Authenticate: Basic realm="OpenCodex"\r\n');
        expect(dials).toBe(0);
      }
    } finally { await proxy.close(); }
  }
});
