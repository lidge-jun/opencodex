import { describe, expect, test } from "bun:test";
import { gracefulStopHost, lastStopRefusalCode, lastStopRefusalMessage, ProxyOwnershipRefusedError, refusalNextStep, stopProxy, stopProxyGracefully } from "../../src/lib/process-control";

function okResponse(): Response {
  return new Response(JSON.stringify({ success: true, sharedTeardown: "performed" }), { status: 200 });
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
  for (const [name, body] of [
    ["reported restore failure", JSON.stringify({ success: false, sharedTeardown: "performed" })],
    ["missing teardown result", JSON.stringify({ success: true })],
    ["unexpected deferral", JSON.stringify({ success: true, sharedTeardown: "deferred" })],
    ["nonboolean success", JSON.stringify({ success: "true", sharedTeardown: "performed" })],
    ["empty body", ""],
    ["invalid JSON", "{broken"],
    ["null body", "null"],
    ["array body", "[]"],
  ]) {
    test(`process exit does not confirm shared teardown: ${name}`, async () => {
      const waits: number[] = [];
      const result = await stopProxyGracefully(4242, {
        readRuntime: () => ({ port: 10100 }),
        fetchFn: (async () => new Response(body, { status: 200 })) as typeof fetch,
        waitExit: pid => { waits.push(pid); return true; },
        exitTimeoutMs: 1,
        env: {},
      });
      expect(result).toBe("teardown-unconfirmed");
      expect(waits).toEqual([4242]);
    });
  }

  test("requires the assigned deferred response when a receipt nonce was sent", async () => {
    for (const sharedTeardown of ["deferred", "performed"]) {
      const result = await stopProxyGracefully(4242, {
        readRuntime: () => ({ port: 10100 }),
        fetchFn: (async () => new Response(JSON.stringify({ success: true, sharedTeardown }))) as typeof fetch,
        waitExit: () => true,
        deferSharedTeardownNonce: "receipt-nonce",
        exitTimeoutMs: 1,
        env: {},
      });
      expect(result).toBe(sharedTeardown === "deferred" ? true : "teardown-unconfirmed");
    }
  });

  test("an unconfirmed response still requires process exit", async () => {
    expect(await stopProxyGracefully(4242, {
      readRuntime: () => ({ port: 10100 }),
      fetchFn: (async () => new Response(JSON.stringify({ success: false, sharedTeardown: "performed" }))) as typeof fetch,
      waitExit: () => false,
      exitTimeoutMs: 1,
      env: {},
    })).toBe(false);
  });

  test("ownership refusal never waits for exit or becomes a teardown retry", async () => {
    expect(await stopProxyGracefully(4242, {
      readRuntime: () => ({ port: 10100 }),
      fetchFn: (async () => new Response("refused", { status: 409 })) as typeof fetch,
      waitExit: () => { throw new Error("must not wait for a refused stop"); },
      env: {},
    })).toBe("refused");
  });

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

  test("the refusal code is captured alongside the message", async () => {
    // The message alone cannot drive the fallback: a refusal that arrives with an empty or
    // unparseable body still has to name a cause, and #4169 showed what happens when the
    // fallback guesses one — the operator re-checks CODEX_HOME for a refusal the scheduler
    // wrapper issued.
    await stopProxyGracefully(7, {
      readRuntime: () => ({ port: 10100 }),
      fetchFn: (async () => new Response(
        JSON.stringify({ success: false, code: "respawnable_service", message: "wrapper owns it" }),
        { status: 409, headers: { "content-type": "application/json" } },
      )) as typeof fetch,
      waitExit: () => true,
      env: {},
    });
    expect(lastStopRefusalCode()).toBe("respawnable_service");

    await stopProxyGracefully(7, {
      readRuntime: () => ({ port: 10100 }),
      fetchFn: (async () => new Response("not json", { status: 409 })) as typeof fetch,
      waitExit: () => true,
      env: {},
    });
    expect(lastStopRefusalCode()).toBeNull();
  });

  test("a refusal without a message falls back by code, never to an ownership claim", async () => {
    const refusalFor = async (code: string | null): Promise<string> => {
      const body = code === null ? "not json" : JSON.stringify({ success: false, code });
      try {
        await stopProxy(process.pid, {
          readRuntime: () => ({ port: 10100 }),
          fetchFn: (async () => new Response(body, {
            status: 409,
            headers: { "content-type": "application/json" },
          })) as typeof fetch,
          waitExit: () => { throw new Error("must not wait for a refused stop"); },
          env: {},
        });
      } catch (err) {
        if (err instanceof ProxyOwnershipRefusedError) return err.message;
        throw err;
      }
      throw new Error("stopProxy must throw on a refusal");
    };

    const respawnable = await refusalFor("respawnable_service");
    expect(respawnable).toContain("respawn");
    // Not `ocx stop`: the only callers of stopProxy are `ocx stop` and the service
    // manager's own cleanup, so recommending it here is the #4169 loop. The fallback names
    // the cause and refusalNextStep names the command.
    expect(respawnable).not.toContain("ocx stop");

    const selfUnload = await refusalFor("self_unload_service");
    expect(selfUnload).toContain("installed service itself");
    expect(selfUnload).not.toContain("ocx stop");

    const unknownState = await refusalFor("service_state_unknown");
    expect(unknownState).toContain("could not be read");
    expect(unknownState).not.toContain("ocx stop");

    const noBody = await refusalFor(null);
    expect(noBody).toContain("sent no reason");
    expect(noBody).not.toContain("ocx stop");

    // None of them may assert the cause that #4169 was filed for.
    for (const message of [respawnable, selfUnload, unknownState, noBody]) {
      expect(message).not.toContain("CODEX_HOME");
      expect(message).not.toContain("OPENCODEX_HOME");
    }
  });

  test("the refusal carries its code to the caller that has to report it", async () => {
    // The reporting caller acts on the cause. Re-parsing the prose is not an option: the
    // message is the server's, and the server's message is exactly what recommends the
    // command that already failed.
    let thrown: unknown;
    try {
      await stopProxy(process.pid, {
        readRuntime: () => ({ port: 10100 }),
        fetchFn: (async () => new Response(
          JSON.stringify({ success: false, code: "respawnable_service", message: "wrapper owns it" }),
          { status: 409, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
        waitExit: () => { throw new Error("must not wait for a refused stop"); },
        env: {},
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProxyOwnershipRefusedError);
    expect((thrown as ProxyOwnershipRefusedError).code).toBe("respawnable_service");
    // The server's own message still wins, unchanged.
    expect((thrown as ProxyOwnershipRefusedError).message).toBe("wrapper owns it");
  });

  test("no next step sends the operator back to the command that just refused", () => {
    // #4169's loop: POST /api/stop answers "the stop must be run by `ocx stop`", and
    // `ocx stop` reprints it. Whatever the cause, the next step has to be something else,
    // because the service manager was already asked to stop before this point.
    for (const code of ["respawnable_service", "self_unload_service", "service_state_unknown", null]) {
      const step = refusalNextStep(code);
      // Naming `ocx stop` in order to rule it out is the point; recommending it is the loop.
      expect(step).not.toMatch(/Run `ocx stop`/);
      expect(step).toContain("ocx service status");
    }
    // The two service causes say why repeating the stop is not the missing step, since the
    // server's message printed just above them recommends exactly that.
    expect(refusalNextStep("respawnable_service")).toContain("already asked the service manager");
    expect(refusalNextStep("self_unload_service")).toContain("already asked the service manager");
  });

  test("concurrent refusals each keep their own cause", async () => {
    // Reading the reason from module state lets one stop publish its refusal and a second
    // overwrite it before the first continuation consumes it. Starting both together is
    // what actually reproduces that: verified against the pre-fix global handoff, where
    // this schedule fails with the first call throwing the second's cause
    // ("...it is the installed service itself..." for the respawnable_service stop).
    // A schedule that lets one call finish entirely before resuming the other does NOT
    // discriminate — the parked call republishes its own globals last and passes either way.
    const refusalOf = (code: string) => async (): Promise<string> => {
      try {
        await stopProxy(process.pid, {
          readRuntime: () => ({ port: 10100 }),
          fetchFn: (async () => new Response(JSON.stringify({ success: false, code }), {
            status: 409,
            headers: { "content-type": "application/json" },
          })) as typeof fetch,
          waitExit: () => { throw new Error("must not wait for a refused stop"); },
          env: {},
        });
      } catch (err) {
        if (err instanceof ProxyOwnershipRefusedError) return err.message;
        throw err;
      }
      throw new Error("stopProxy must throw on a refusal");
    };

    // Repeated because the interleaving is scheduler-dependent; the pre-fix code fails on
    // the first iteration, but a single run would be a weak guard against reintroduction.
    for (let i = 0; i < 20; i++) {
      const [respawnable, selfUnload] = await Promise.all([
        refusalOf("respawnable_service")(),
        refusalOf("self_unload_service")(),
      ]);
      expect(respawnable).toContain("respawn");
      expect(selfUnload).toContain("installed service itself");
    }
  });
});
