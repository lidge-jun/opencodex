/**
 * The test process may not reach real hosts (#8848). A full suite once sent fixture credentials to
 * nine provider hosts through paths that slipped past mocks: native WebSocket, node:https behind
 * pinned-http, and module-level fetch calls. tests/preload.ts installs the guard; these cases prove
 * each entry point refuses a public host locally and still lets loopback fixtures through.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import { isTestEgressAllowed, REFUSED_WEBSOCKET_URL } from "../helpers/network-egress-guard";
import { fetchCodexUsage } from "../../src/codex/quota-query-backoff";
import { pinnedHttpGet } from "../../src/lib/pinned-http";

let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req, { data: undefined })) return undefined;
      return new Response("local");
    },
    websocket: { open(ws) { ws.close(1000, "done"); }, message() {} },
  });
});
afterAll(() => server.stop(true));

function errorOf(emitter: { once(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown }): Promise<NodeJS.ErrnoException> {
  return new Promise(resolve => { emitter.once("error", resolve); });
}

describe("the test network guard (#8848)", () => {
  test("names: loopback, wildcard and reserved names pass; public hosts do not", () => {
    for (const host of ["127.0.0.1", "127.8.9.10", "::1", "[::1]", "::ffff:127.0.0.1", "::ffff:7f00:1", "0:0:0:0:0:ffff:127.0.0.1", "0.0.0.0", "::", "localhost", "LOCALHOST.", "api.localhost", "fixture.test", "upstream.example", "nothing.invalid", undefined, ""]) {
      expect({ host, allowed: isTestEgressAllowed(host) }).toEqual({ host, allowed: true });
    }
    for (const host of ["chatgpt.com", "auth.openai.com", "api.githubcopilot.com", "example.com", "8.8.8.8", "2606:4700::1111", "localhost.evil.com", "10.0.0.1", "::ffff:10.0.0.1", "127.0.0.1.nip.io"]) {
      expect({ host, allowed: isTestEgressAllowed(host) }).toEqual({ host, allowed: false });
    }
  });

  test("fetch to a public host is refused locally, with or without a Request object", async () => {
    await expect(fetch("https://chatgpt.com/backend-api/wham/usage")).rejects.toMatchObject({ code: "ECONNREFUSED" });
    await expect(fetch(new Request("https://auth.openai.com/oauth/token", { method: "POST", body: "x" }))).rejects.toMatchObject({ code: "ECONNREFUSED" });
    await expect(fetch(new URL("https://api.anthropic.com/api/oauth/profile"))).rejects.toThrow("test network guard refused https://api.anthropic.com");
    expect(await (await fetch(`http://127.0.0.1:${server.port}/`)).text()).toBe("local");
  });

  test("the quota probe and pinned-http (node:https) paths are refused", async () => {
    await expect(fetchCodexUsage("guard-probe", {}, undefined, { unpaced: true })).rejects.toMatchObject({ code: "ECONNREFUSED" });
    await expect(pinnedHttpGet("https://api.githubcopilot.com/models", { address: "140.82.112.21", family: 4 })).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  test("node:https, node:http, http2, net and tls to a public host fail as connection errors", async () => {
    const httpsReq = https.request("https://api.githubcopilot.com/models");
    const httpsError = errorOf(httpsReq);
    httpsReq.end();
    expect((await httpsError).code).toBe("ECONNREFUSED");
    const httpReq = http.request("http://example.com/");
    const httpError = errorOf(httpReq);
    httpReq.end();
    expect((await httpError).code).toBe("ECONNREFUSED");
    expect((await errorOf(http2.connect("https://chatgpt.com"))).code).toBe("ECONNREFUSED");
    expect((await errorOf(net.connect(443, "chatgpt.com"))).code).toBe("ECONNREFUSED");
    expect((await errorOf(tls.connect({ host: "chatgpt.com", port: 443, servername: "chatgpt.com" }))).code).toBe("ECONNREFUSED");
  });

  test("node:http and net to a loopback fixture still connect", async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      http.get(`http://127.0.0.1:${server.port}/`, res => { res.resume(); resolve(res.statusCode); }).on("error", reject);
    });
    expect(status).toBe(200);
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(server.port!, "127.0.0.1", () => { socket.destroy(); resolve(); });
      socket.on("error", reject);
    });
  });

  test("a WebSocket to a public host closes without connecting; loopback still opens", async () => {
    const refused = new WebSocket("wss://chatgpt.com/backend-api/codex/responses");
    const events: string[] = [];
    refused.addEventListener("error", () => events.push("error"));
    const closed = await new Promise<number>(resolve => refused.addEventListener("close", event => resolve(event.code)));
    // Only the guard reroutes it: the socket never dialed the public host.
    expect(refused.url).toBe(REFUSED_WEBSOCKET_URL);
    expect(events).toEqual(["error"]);
    expect(closed).toBe(1006);
    expect(WebSocket.OPEN).toBe(1);
    const local = new WebSocket(`ws://127.0.0.1:${server.port}/`);
    const opened = await new Promise<string>(resolve => {
      local.addEventListener("open", () => resolve("open"));
      local.addEventListener("error", () => resolve("error"));
    });
    expect(opened).toBe("open");
  });

  test("a reserved .invalid name keeps its DNS failure", async () => {
    await expect(fetch("http://nothing.invalid/")).rejects.not.toThrow("test network guard");
  });
});

