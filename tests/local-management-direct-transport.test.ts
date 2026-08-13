import { describe, expect, test } from "bun:test";
import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { createConnection, createServer as createTcpServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { directLocalHttpFetch } from "../src/server/direct-local-http";

const PID = 4242;
const SECRET = "A".repeat(43);

async function listen(server: Server, hostname = "127.0.0.1"): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, hostname, () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("test server did not bind TCP"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

describe("local management direct transport", () => {
  test("sends a bodyless POST directly with explicit zero content length", async () => {
    let observed: { method: string; contentLength: string | null; body: string } | null = null;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        observed = {
          method: request.method,
          contentLength: request.headers.get("content-length"),
          body: await request.text(),
        };
        return Response.json({ ok: true });
      },
    });
    try {
      const response = await directLocalHttpFetch(`http://127.0.0.1:${server.port}/api/providers/reload`, {
        method: "POST",
      });
      expect(response.status).toBe(200);
      expect(observed).toEqual({ method: "POST", contentLength: "0", body: "" });
    } finally {
      await server.stop(true);
    }
  });
  test("preserves an AbortError for an already-cancelled request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(directLocalHttpFetch("http://127.0.0.1:9/healthz", {
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
  });

  test("passes localhost unchanged to the direct connector", async () => {
    const server = createTcpServer(socket => {
      socket.once("data", () => {
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
      });
    });
    let port = 0;
    try {
      port = await listen(server, "127.0.0.1");
      let connectedHostname: string | undefined;
      const response = await directLocalHttpFetch(`http://localhost:${port}/healthz`, {
        signal: AbortSignal.timeout(500),
      }, {
        connect(hostname, selectedPort) {
          connectedHostname = hostname;
          return createConnection({ host: "127.0.0.1", port: selectedPort });
        },
      });
      expect(connectedHostname).toBe("localhost");
      expect(await response.text()).toBe("ok");
    } finally {
      if (port !== 0) await close(server);
    }
  });

  test("preserves localhost DNS resolution for an IPv6 listener when available", async () => {
    const addresses = await lookup("localhost", { all: true });
    if (!addresses.some(address => address.family === 6)) return;
    const server = createTcpServer(socket => {
      socket.once("data", () => {
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
      });
    });
    let port = 0;
    try {
      try {
        port = await listen(server, "::1");
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT") return;
        throw error;
      }
      const response = await directLocalHttpFetch(`http://localhost:${port}/healthz`, {
        signal: AbortSignal.timeout(500),
      });
      expect(await response.text()).toBe("ok");
    } finally {
      if (port !== 0) await close(server);
    }
  });

  test("preserves AbortError after a socket connects but never replies", async () => {
    let accept!: () => void;
    const accepted = new Promise<void>(resolve => { accept = resolve; });
    const sockets = new Set<Socket>();
    const server = createTcpServer(socket => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      accept();
    });
    const controller = new AbortController();
    let port = 0;
    try {
      port = await listen(server);
      const pending = directLocalHttpFetch(`http://127.0.0.1:${port}/healthz`, {
        signal: controller.signal,
      }, { timeoutMs: 1_000 });
      await Promise.race([
        accepted,
        pending.then(
          () => { throw new Error("direct request completed before the server accepted it"); },
          error => { throw error; },
        ),
      ]);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      for (const socket of sockets) socket.destroy();
      if (port !== 0) await close(server);
    }
  });

  test("times out an accepted silent socket without an AbortSignal", async () => {
    let accept!: () => void;
    const accepted = new Promise<void>(resolve => { accept = resolve; });
    const sockets = new Set<Socket>();
    const server = createTcpServer(socket => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      accept();
    });
    let port = 0;
    try {
      port = await listen(server);
      const pending = directLocalHttpFetch(`http://127.0.0.1:${port}/healthz`, {}, { timeoutMs: 250 });
      await Promise.race([
        accepted,
        pending.then(
          () => { throw new Error("direct request completed before the server accepted it"); },
          error => { throw error; },
        ),
      ]);
      await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      for (const socket of sockets) socket.destroy();
      if (port !== 0) await close(server);
    }
  });

  test.each([
    ["content-length", (body: string) => `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`],
    ["chunked", (body: string) => `Transfer-Encoding: chunked\r\n\r\n${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n0\r\n\r\n`],
  ])("finishes a %s response without waiting for a keep-alive socket to close", async (_name, frame) => {
    const sockets = new Set<Socket>();
    const body = JSON.stringify({ ok: true });
    const server = createTcpServer(socket => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.once("data", () => {
        socket.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: keep-alive\r\n${frame(body)}`);
      });
    });
    let port = 0;
    try {
      port = await listen(server);
      const response = await directLocalHttpFetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(500),
      });
      expect(await response.json()).toEqual({ ok: true });
    } finally {
      for (const socket of sockets) socket.destroy();
      if (port !== 0) await close(server);
    }
  });

  test.each([
    ["invalid status", "NOT-HTTP\r\nContent-Length: 0\r\n\r\n"],
    ["invalid header", "HTTP/1.1 200 OK\r\nBroken-Header\r\n\r\n"],
    ["invalid content length", "HTTP/1.1 200 OK\r\nContent-Length: nope\r\n\r\n"],
    ["oversized content length", `HTTP/1.1 200 OK\r\nContent-Length: ${8 * 1024 * 1024 + 1}\r\n\r\n`],
    ["truncated body", "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nab"],
    ["invalid chunk size", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n"],
    ["invalid chunk terminator", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\naXX"],
    ["invalid chunk trailer", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nbad\r\n\r\n"],
    ["content-length trailing bytes", "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nokextra"],
    ["bodyless status with a body", "HTTP/1.1 204 No Content\r\n\r\nunexpected"],
  ])("rejects a malformed response with %s", async (_name, frame) => {
    const sockets = new Set<Socket>();
    const server = createTcpServer(socket => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.once("data", () => socket.end(frame));
    });
    let port = 0;
    try {
      port = await listen(server);
      await expect(directLocalHttpFetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(500),
      })).rejects.toThrow(/direct local HTTP response/);
    } finally {
      for (const socket of sockets) socket.destroy();
      if (port !== 0) await close(server);
    }
  });

  test("bypasses configured environment proxies for liveness, readiness, and capability reads", async () => {
    const targetPaths: string[] = [];
    const targetCapabilities: string[] = [];
    const proxyPaths: string[] = [];
    const proxyCapabilities: string[] = [];
    let targetPort = 0;

    const reply = (
      rawPath: string,
      write: (status: number, body: unknown) => void,
    ) => {
      const pathname = new URL(rawPath, "http://127.0.0.1").pathname;
      if (pathname === "/healthz") {
        write(200, { service: "opencodex", status: "ok", version: "test", uptime: 1, pid: PID, port: targetPort });
        return;
      }
      if (pathname === "/readyz") {
        write(200, { service: "opencodex", status: "ready", version: "test", uptime: 1, pid: PID, port: targetPort });
        return;
      }
      if (pathname === "/api/system/memory") {
        write(200, { pid: PID });
        return;
      }
      write(404, { error: "not found" });
    };

    const target = createServer((request, response) => {
      const rawPath = request.url ?? "/";
      const pathname = new URL(rawPath, "http://127.0.0.1").pathname;
      targetPaths.push(pathname);
      if (pathname === "/__proxy-control") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ via: "target" }));
        return;
      }
      const capability = request.headers["x-opencodex-local-capability"];
      if (typeof capability === "string") targetCapabilities.push(capability);
      reply(rawPath, (status, body) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      });
    });
    const proxy = createServer((request, response) => {
      const rawPath = request.url ?? "/";
      proxyPaths.push(rawPath);
      const capability = request.headers["x-opencodex-local-capability"];
      if (typeof capability === "string") proxyCapabilities.push(capability);
      const pathname = new URL(rawPath, "http://127.0.0.1").pathname;
      if (pathname === "/__proxy-control") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ via: "proxy" }));
        return;
      }
      // Return valid-looking data so the assertion detects routing, not parsing.
      reply(rawPath, (status, body) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      });
    });

    let proxyPort = 0;
    try {
      targetPort = await listen(target);
      proxyPort = await listen(proxy);

      const proxyLivenessUrl = pathToFileURL(join(import.meta.dir, "..", "src", "server", "proxy-liveness.ts")).href;
      const localClientUrl = pathToFileURL(join(import.meta.dir, "..", "src", "server", "local-management-read-client.ts")).href;
      const capabilityUrl = pathToFileURL(join(import.meta.dir, "..", "src", "lib", "local-management-capability.ts")).href;
      const childSource = `
        const liveness = await import(${JSON.stringify(proxyLivenessUrl)});
        const client = await import(${JSON.stringify(localClientUrl)});
        const capability = await import(${JSON.stringify(capabilityUrl)});
        const port = ${targetPort};
        const pid = ${PID};
        const control = await fetch(\`http://127.0.0.1:\${port}/__proxy-control\`).then(response => response.json());
        const identity = await liveness.proxyIdentityAt(port, { hostname: "127.0.0.1", expectedPid: pid });
        const readiness = await liveness.probeReadiness(port, { hostname: "127.0.0.1", expectedPid: pid });
        const read = await client.fetchBoundLocalManagementRead(
          { hostname: "127.0.0.1", port, pid, source: "runtime" },
          capability.LOCAL_MANAGEMENT_READ_PATHS.systemMemory,
          {
            readRuntime: () => ({ pid, port, hostname: "127.0.0.1", attestationSecret: ${JSON.stringify(SECRET)} }),
            createNonce: () => "B".repeat(43),
            timeoutMs: 2_000,
          },
        );
        const memory = read.kind === "response" ? await read.response.json() : null;
        const result = { control, identity, readiness, readKind: read.kind, memory };
        console.log(JSON.stringify(result));
        if (control?.via !== "proxy" || identity?.pid !== pid || readiness?.ready !== true || read.kind !== "response" || memory?.pid !== pid) {
          process.exitCode = 2;
        }
      `;

      const childEnv = { ...process.env } as Record<string, string>;
      for (const key of ["NO_PROXY", "no_proxy"]) delete childEnv[key];
      const proxyUrl = `http://127.0.0.1:${proxyPort}`;
      for (const key of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) {
        childEnv[key] = proxyUrl;
      }

      const child = Bun.spawn([process.execPath, "--eval", childSource], {
        cwd: join(import.meta.dir, ".."),
        env: childEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      let childTimedOut = false;
      const childWatchdog = setTimeout(() => {
        childTimedOut = true;
        child.kill();
      }, 3_000);
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]).finally(() => clearTimeout(childWatchdog));
      if (childTimedOut) throw new Error("direct-transport child timed out");
      if (exitCode !== 0) {
        throw new Error(`direct-transport child failed (${exitCode}): ${stderr.trim()}\n${stdout.trim()}`);
      }

      const line = stdout.trim().split(/\r?\n/).at(-1);
      expect(line ? JSON.parse(line) : null).toEqual({
        control: { via: "proxy" },
        identity: { pid: PID },
        readiness: { ready: true, status: "ready", pid: PID, port: targetPort },
        readKind: "response",
        memory: { pid: PID },
      });
      expect(proxyPaths).toHaveLength(1);
      expect(proxyPaths[0]).toEndWith("/__proxy-control");
      expect(proxyCapabilities).toEqual([]);
      expect(targetPaths).toEqual(["/healthz", "/readyz", "/api/system/memory"]);
      expect(targetCapabilities).toHaveLength(1);
      expect(targetCapabilities[0]).toHaveLength(43);
    } finally {
      if (proxyPort !== 0) await close(proxy);
      if (targetPort !== 0) await close(target);
    }
  });
});
