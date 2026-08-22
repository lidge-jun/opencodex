import { describe, expect, test } from "bun:test";
import { requestCodexRestart } from "../src/codex-restart";
import type { CodexRestartResponse } from "../src/codex-restart";

const STOPPED: CodexRestartResponse = {
  success: true,
  stateBefore: "stale",
  synced: true,
  requested: [4242],
  stopped: [4242],
  surviving: [],
  failed: [],
  code: "stopped",
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const formatters = {
  formatFailure: (status: number) => `http ${status}`,
  formatUnreachable: () => "unreachable",
  formatMalformed: () => "malformed",
  formatTimeout: () => "timeout",
};

describe("requestCodexRestart", () => {
  test("returns the parsed contract body on success", async () => {
    const outcome = await requestCodexRestart("", {
      fetchFn: (async () => response(STOPPED)) as typeof fetch,
      ...formatters,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.result).toEqual(STOPPED);
  });

  test("surfaces a non-2xx status through formatFailure", async () => {
    const outcome = await requestCodexRestart("", {
      fetchFn: (async () => response({ error: "nope" }, 500)) as typeof fetch,
      ...formatters,
    });

    expect(outcome).toEqual({ ok: false, message: "http 500" });
  });

  test("a network failure is reported as unreachable", async () => {
    // requestProxyStop reads a dropped socket as "the stop started". This route
    // does not kill the process serving it, so silence means something broke.
    const outcome = await requestCodexRestart("", {
      fetchFn: (async () => {
        throw new TypeError("Failed to fetch");
      }) as typeof fetch,
      ...formatters,
    });

    expect(outcome).toEqual({ ok: false, message: "unreachable" });
  });

  test("a timeout is reported separately, because the work may still be running", async () => {
    // The proxy never sees the client abort: a long catalog sync can still stop
    // app-servers afterwards. Saying "could not reach the proxy" would be a lie
    // the user acts on.
    const outcome = await requestCodexRestart("", {
      fetchFn: (async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }) as typeof fetch,
      ...formatters,
    });

    expect(outcome).toEqual({ ok: false, message: "timeout" });
  });

  test("rejects an unparseable 2xx body", async () => {
    const outcome = await requestCodexRestart("", {
      fetchFn: (async () => new Response("not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
      ...formatters,
    });

    expect(outcome).toEqual({ ok: false, message: "malformed" });
  });

  test("rejects a parseable 2xx body of the wrong shape", async () => {
    // The handler reads .stopped.length; a bare { success: true } would throw
    // inside an event handler, where it surfaces as a dead button.
    const outcome = await requestCodexRestart("", {
      fetchFn: (async () => response({ success: true })) as typeof fetch,
      ...formatters,
    });

    expect(outcome).toEqual({ ok: false, message: "malformed" });
  });

  test("rejects a body whose pid arrays are not pids", async () => {
    const outcome = await requestCodexRestart("", {
      fetchFn: (async () => response({ ...STOPPED, stopped: ["4242"] })) as typeof fetch,
      ...formatters,
    });

    expect(outcome).toEqual({ ok: false, message: "malformed" });
  });

  test("rejects a negative or fractional pid", async () => {
    const negative = await requestCodexRestart("", {
      fetchFn: (async () => response({ ...STOPPED, stopped: [-1] })) as typeof fetch,
      ...formatters,
    });
    const fractional = await requestCodexRestart("", {
      fetchFn: (async () => response({ ...STOPPED, surviving: [1.5] })) as typeof fetch,
      ...formatters,
    });

    expect(negative.ok).toBe(false);
    expect(fractional.ok).toBe(false);
  });

  test("rejects an unknown response code", async () => {
    const outcome = await requestCodexRestart("", {
      fetchFn: (async () => response({ ...STOPPED, code: "exploded" })) as typeof fetch,
      ...formatters,
    });

    expect(outcome).toEqual({ ok: false, message: "malformed" });
  });

  test("posts to the codex-restart path", async () => {
    let seen = "";
    let method = "";
    await requestCodexRestart("http://127.0.0.1:10100", {
      fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
        seen = String(input);
        method = String(init?.method);
        return response(STOPPED);
      }) as unknown as typeof fetch,
      ...formatters,
    });

    expect(seen).toBe("http://127.0.0.1:10100/api/system/codex-restart");
    expect(method).toBe("POST");
  });

  test("passes each response code through with a self-consistent body", async () => {
    const cases = [
      { code: "stopped", success: true, stopped: [4242], surviving: [], failed: [] },
      { code: "nothing_running", success: true, stopped: [], surviving: [], failed: [] },
      { code: "enumeration_unavailable", success: true, stopped: [], surviving: [], failed: [] },
      { code: "partially_stopped", success: false, stopped: [], surviving: [4242], failed: [] },
    ] as const;
    for (const patch of cases) {
      const outcome = await requestCodexRestart("", {
        fetchFn: (async () => response({ ...STOPPED, ...patch })) as typeof fetch,
        ...formatters,
      });
      expect(outcome.ok).toBe(true);
      expect(outcome.result?.code).toBe(patch.code);
    }
  });

  test("rejects a body whose code contradicts its success flag", async () => {
    // A version-skewed or regressed proxy is how this arrives; trusting it would
    // report a success that never happened.
    const successWithFailureCode = await requestCodexRestart("", {
      fetchFn: (async () => response({ ...STOPPED, code: "partially_stopped" })) as typeof fetch,
      ...formatters,
    });
    const cleanCodeWithSurvivors = await requestCodexRestart("", {
      fetchFn: (async () => response({ ...STOPPED, surviving: [99] })) as typeof fetch,
      ...formatters,
    });
    const nothingRunningButStopped = await requestCodexRestart("", {
      fetchFn: (async () => response({
        ...STOPPED,
        code: "nothing_running",
        stopped: [4242],
      })) as typeof fetch,
      ...formatters,
    });

    expect(successWithFailureCode).toEqual({ ok: false, message: "malformed" });
    expect(cleanCodeWithSurvivors).toEqual({ ok: false, message: "malformed" });
    expect(nothingRunningButStopped).toEqual({ ok: false, message: "malformed" });
  });

  test("a body that never finishes arriving is a timeout, not a malformed body", async () => {
    // The response headers arrived, so this is not "unreachable"; the body then
    // timed out, so it is not the payload's fault either. Blaming the payload
    // would send the user looking for a proxy bug that is not there.
    const stalled = {
      ok: true,
      status: 200,
      json: async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    } as unknown as Response;

    const outcome = await requestCodexRestart("", {
      fetchFn: (async () => stalled) as typeof fetch,
      ...formatters,
    });

    expect(outcome).toEqual({ ok: false, message: "timeout" });
  });

  test("a genuinely unparseable body is still reported as malformed", async () => {
    const outcome = await requestCodexRestart("", {
      fetchFn: (async () => new Response("not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
      ...formatters,
    });

    expect(outcome).toEqual({ ok: false, message: "malformed" });
  });
});

