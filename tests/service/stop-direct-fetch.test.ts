import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { stopProxyGracefully } from "../../src/lib/process-control";
import { repoPath } from "../helpers/repo-root";

/** Argument text of each `await <call>(...)`, balanced so nested calls stay separate. */
function callArguments(body: string, call: string): string[] {
  const marker = `await ${call}(`;
  const found: string[] = [];
  let from = 0;
  for (;;) {
    const at = body.indexOf(marker, from);
    if (at < 0) return found;
    let depth = 0;
    let index = at + marker.length - 1;
    for (; index < body.length; index += 1) {
      if (body[index] === "(") depth += 1;
      else if (body[index] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    found.push(body.slice(at + marker.length, index));
    from = index;
  }
}

const stopRunner = `
  const { stopProxyGracefully } = await import("./src/lib/process-control.ts");
  const port = Number(process.env.OCX_TEST_STOP_PORT);
  const origin = "http://127.0.0.1:" + port;
  const control = await fetch(origin + "/__proxy-control", {
    signal: AbortSignal.timeout(2000),
  }).then(response => response.json());
  const result = await stopProxyGracefully(process.pid, {
    runtimeEndpoint: { hostname: "127.0.0.1", port },
    waitExit: () => true,
    exitTimeoutMs: 2000,
    deferSharedTeardownNonce: process.env.OCX_TEST_STOP_NONCE || undefined,
    env: { OPENCODEX_ADMIN_AUTH_TOKEN: "ocx-test-direct-stop-token" },
  });
  console.log(JSON.stringify({ control: control.via, result }));
`;

describe("local stop transport", () => {
  for (const [status, stalled] of [[409, false], [409, true], [401, false]] as const) {
    test(`${status} with a ${stalled ? "stalled" : "truncated"} body retains stop semantics`, async () => {
      const sockets = new Set<Socket>();
      const server = createServer(socket => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.once("data", () => {
          socket.write(`HTTP/1.1 ${status} Response\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{`);
          if (!stalled) socket.end();
        });
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      let waits = 0;
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("missing TCP listener");
        const result = await stopProxyGracefully(4242, {
          runtimeEndpoint: { hostname: "127.0.0.1", port: address.port },
          waitExit: () => { waits++; return true; }, env: {}, exitTimeoutMs: 100,
        });
        expect(result).toBe(status === 409 ? "refused" : false);
        expect(waits).toBe(0);
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    });
  }

  for (const deferred of [false, true]) {
    test(`default ${deferred ? "deferred" : "plain"} stop bypasses proxy environment`, async () => {
      const targetRequests: { method: string; path: string; token: string | null }[] = [];
      const proxyRequests: typeof targetRequests = [];
      let controls = 0;
      const reply = () => Response.json({ success: true, sharedTeardown: deferred ? "deferred" : "performed" });
      const record = (request: Request) => ({ method: request.method,
        path: new URL(request.url).pathname + new URL(request.url).search,
        token: request.headers.get("x-opencodex-api-key") });
      const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
        targetRequests.push(record(request));
        return reply();
      } });
      const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
        if (new URL(request.url).pathname === "/__proxy-control") {
          controls++;
          return Response.json({ via: "proxy" });
        }
        proxyRequests.push(record(request));
        return reply();
      } });
      let child: ReturnType<typeof Bun.spawn> | undefined;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        // Child-only environment: Bun reads proxy settings at startup.
        const env = { ...process.env, OCX_TEST_STOP_PORT: String(target.port),
          OCX_TEST_STOP_NONCE: deferred ? "dummy-receipt" : "",
          NO_PROXY: "example.invalid", no_proxy: "example.invalid" };
        for (const key of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) {
          env[key] = `http://127.0.0.1:${proxy.port}`;
        }
        child = Bun.spawn([process.execPath, "--eval", stopRunner], {
          cwd: repoPath(), env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
        });
        watchdog = setTimeout(() => child?.kill(), 8000);
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        expect(exitCode, stderr).toBe(0);
        expect(JSON.parse(stdout)).toEqual({ control: "proxy", result: true });
        expect(controls).toBe(1);
        expect({ targetRequests, proxyRequests }).toEqual({
          targetRequests: [{ method: "POST", path: "/api/stop" + (deferred
            ? "?deferSharedTeardown=1&teardownNonce=dummy-receipt" : ""), token: "ocx-test-direct-stop-token" }],
          proxyRequests: [],
        });
      } finally {
        if (watchdog) clearTimeout(watchdog);
        if (child && child.exitCode === null) { child.kill(); await child.exited; }
        await target.stop(true);
        await proxy.stop(true);
      }
    });
  }

  // These paths mutate service/process state; exercise their shared real transport above
  // and verify each caller delegates without overriding it with the global fetch.
  // `handleUninstall` delegates its two stops to `stopUninstallProxy` (#7771), which owns
  // the receipt and the no-forced-fallback rule; the transport default is still not overridden.
  for (const [file, functionName, count, call] of [
    ["src/cli/index.ts", "handleStopUnlocked", 1, "stopProxy"],
    ["src/service/orchestration.ts", "stopTrackedProxyIfRunning", 3, "stopProxy"],
    // One site: the target is resolved before the receipt, so both the tracked and the
    // discovered path reach the stop through the same call (#7771 round 8).
    ["src/cli/uninstall-stop.ts", "stopUninstallProxy", 1, "io.stop"],
  ] as const) {
    test(`${functionName} retains the direct stop default`, () => {
      const source = readFileSync(repoPath(file), "utf8");
      const start = source.indexOf(`async function ${functionName}(`);
      expect(start).toBeGreaterThanOrEqual(0);
      const end = source.indexOf("\n}", start);
      expect(end).toBeGreaterThan(start);
      const calls = callArguments(source.slice(start, end), call);
      expect(calls).toHaveLength(count);
      for (const args of calls) {
        // Connected stops also retain the shared default's refusal-status handling.
        expect(args).not.toMatch(/\bfetchFn\s*:/);
        expect(args.replace(/as typeof fetch\b/g, "")).not.toMatch(/\bfetch\b/);
      }
    });
  }
});
