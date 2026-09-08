import { describe, expect, test } from "bun:test";
import { gracefulStopHost, lastStopRefusalMessage, stopProxyGracefully } from "../../src/lib/process-control";

function okResponse(): Response {
  return new Response(JSON.stringify({ success: true }), { status: 200 });
}

describe("gracefulStopHost", () => {
  test("loopback aliases and wildcard binds answer on IPv4 loopback", () => {
    for (const host of [undefined, "", "  ", "localhost", "LOCALHOST", "127.0.0.1", "0.0.0.0", "::", "[::]"]) {
      expect(gracefulStopHost(host)).toBe("127.0.0.1");
    }
  });

  test("concrete binds are followed (and IPv6 bracketed)", () => {
    expect(gracefulStopHost("::1")).toBe("[::1]");
    expect(gracefulStopHost("[::1]")).toBe("[::1]");
    expect(gracefulStopHost("192.168.1.20")).toBe("192.168.1.20");
    expect(gracefulStopHost("2001:db8::5")).toBe("[2001:db8::5]");
    expect(gracefulStopHost("[2001:db8::5]")).toBe("[2001:db8::5]");
  });
});

describe("stopProxyGracefully", () => {
  test("follows the recorded bind hostname when it names a concrete address", async () => {
    const calls: string[] = [];
    await stopProxyGracefully(9, {
      readRuntime: () => ({ port: 10100, hostname: "::1" }),
      fetchFn: (async (url: string | URL | Request) => {
        calls.push(String(url));
        return okResponse();
      }) as typeof fetch,
      waitExit: () => true,
      env: {},
    });
    expect(calls).toEqual(["http://[::1]:10100/api/stop"]);
  });

  test("POSTs /api/stop on 127.0.0.1 with the runtime port, then waits for exit", async () => {
    const calls: { url: string; method?: string }[] = [];
    const result = await stopProxyGracefully(4242, {
      readRuntime: pid => (pid === 4242 ? { port: 10123 } : null),
      fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method });
        return okResponse();
      }) as typeof fetch,
      waitExit: () => true,
      env: {},
    });

    expect(result).toBe(true);
    expect(calls).toEqual([{ url: "http://127.0.0.1:10123/api/stop", method: "POST" }]);
  });

  test("sends the management token instead of the data token", async () => {
    let headers: Record<string, string> | undefined;
    await stopProxyGracefully(1, {
      readRuntime: () => ({ port: 10100 }),
      fetchFn: (async (_url: string | URL | Request, init?: RequestInit) => {
        headers = init?.headers as Record<string, string>;
        return okResponse();
      }) as typeof fetch,
      waitExit: () => true,
      env: {
        OPENCODEX_API_AUTH_TOKEN: "data-secret",
        OPENCODEX_ADMIN_AUTH_TOKEN: "admin-secret",
      },
    });

    expect(headers?.["x-opencodex-api-key"]).toBe("admin-secret");
  });

  test("returns false when no runtime port is recorded (caller falls back to killProxy)", async () => {
    const result = await stopProxyGracefully(7, {
      readRuntime: () => null,
      fetchFn: (async () => okResponse()) as typeof fetch,
      waitExit: () => true,
    });
    expect(result).toBe(false);
  });

  test("returns false when the API call fails or the process never exits", async () => {
    const rejected = await stopProxyGracefully(7, {
      readRuntime: () => ({ port: 10100 }),
      fetchFn: (async () => {
        throw new Error("connection refused");
      }) as typeof fetch,
      waitExit: () => true,
      env: {},
    });
    expect(rejected).toBe(false);

    const non200 = await stopProxyGracefully(7, {
      readRuntime: () => ({ port: 10100 }),
      fetchFn: (async () => new Response("nope", { status: 401 })) as typeof fetch,
      waitExit: () => true,
      env: {},
    });
    expect(non200).toBe(false);

    const noExit = await stopProxyGracefully(7, {
      readRuntime: () => ({ port: 10100 }),
      fetchFn: (async () => okResponse()) as typeof fetch,
      waitExit: () => false,
      env: {},
    });
    expect(noExit).toBe(false);
  });
});

describe("409 refusal reporting", () => {
  test("a refusal carries the server's own reason, not the ownership guess", async () => {
    // /api/stop answers 409 for more than one reason: a scheduler wrapper under another
    // home, and (since #4023) the proxy being the installed launchd/systemd job itself.
    // stopProxy used to report the first of those unconditionally, sending an operator
    // whose proxy is simply the service to a CODEX_HOME that does not exist.
    const selfUnload = "This proxy is running as the installed service, so stopping the manager"
      + " from inside it would end this process before native Codex is restored."
      + " Run `ocx stop`, which stops the service from outside and completes the restore."
      + " Nothing was changed.";
    const result = await stopProxyGracefully(7, {
      readRuntime: () => ({ port: 10100 }),
      fetchFn: (async () => new Response(
        JSON.stringify({ success: false, code: "self_unload_service", message: selfUnload }),
        { status: 409, headers: { "content-type": "application/json" } },
      )) as typeof fetch,
      waitExit: () => true,
      env: {},
    });
    expect(result).toBe("refused");
    expect(lastStopRefusalMessage()).toBe(selfUnload);
  });

  test("a 409 with no readable body falls back rather than reporting a stale reason", async () => {
    const result = await stopProxyGracefully(7, {
      readRuntime: () => ({ port: 10100 }),
      fetchFn: (async () => new Response("not json", { status: 409 })) as typeof fetch,
      waitExit: () => true,
      env: {},
    });
    expect(result).toBe("refused");
    expect(lastStopRefusalMessage()).toBeNull();
  });
});
