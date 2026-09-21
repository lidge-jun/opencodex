import { describe, expect, test } from "bun:test";
import { requestProxyStop } from "../src/stop-proxy";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("App proxy stop", () => {
  test("routes standalone stop and connected disconnect to different machine mutations", async () => {
    const seen: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), method: String(init?.method), body: init?.body });
      return response({ success: true }, init?.body ? 202 : 200);
    }) as typeof fetch;
    expect((await requestProxyStop("http://machine", { fetchFn })).status).toBe("accepted");
    expect((await requestProxyStop("http://machine", { fetchFn, mode: "client" })).status).toBe("accepted");
    expect(seen).toEqual([
      { url: "http://machine/api/stop", method: "POST", body: undefined },
      { url: "http://machine/api/machine/disconnect", method: "POST", body: "{}" },
    ]);
  });

  test("releases the pending UI and exposes a non-2xx server message", async () => {
    const outcome = await requestProxyStop("", {
      fetchFn: (async () => response({
        success: false,
        message: "native Codex restore failed",
      }, 500)) as typeof fetch,
      formatFailure: status => `Failed to stop proxy (HTTP ${status}).`,
    });

    expect(outcome).toEqual({ status: "rejected", message: "native Codex restore failed" });
  });

  test("rejects an HTTP 200 cleanup failure and exposes its server message", async () => {
    const outcome = await requestProxyStop("", {
      fetchFn: (async () => response({
        success: false,
        message: "native Codex cleanup failed",
      })) as typeof fetch,
      formatFailure: status => `Failed to stop proxy (HTTP ${status}).`,
    });

    expect(outcome).toEqual({ status: "rejected", message: "native Codex cleanup failed" });
  });

  /*
   * A lost connection is not an answer. It used to be reported as acceptance, which turned
   * "the user pressed the button" into "the server acted": a stop that never arrived read
   * exactly like one that succeeded. The fate of the request is settled by READING the
   * instance again, never by sending the mutation a second time.
   */
  test("a dropped stop is accepted only once the proxy has actually gone", async () => {
    const seen: string[] = [];
    const outcome = await requestProxyStop("http://machine", {
      fetchFn: (async (input: RequestInfo | URL) => {
        const url = String(input);
        seen.push(url);
        // The proxy dies mid-response, then nothing answers the follow-up read.
        throw new TypeError("network error");
      }) as typeof fetch,
    });

    expect(outcome).toEqual({ status: "accepted" });
    expect(seen).toEqual(["http://machine/api/stop", "http://machine/healthz"]);
  });

  test("a proxy that still answers after a dropped stop is unknown, not accepted", async () => {
    const outcome = await requestProxyStop("http://machine", {
      fetchFn: (async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/healthz")) return response({ status: "ok" });
        throw new DOMException("The operation timed out.", "TimeoutError");
      }) as typeof fetch,
      formatStillRunning: () => "still answering",
    });

    expect(outcome).toEqual({ status: "unknown", message: "still answering" });
  });

  test("an unsettled follow-up read stays unknown", async () => {
    const outcome = await requestProxyStop("http://machine", {
      fetchFn: (async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/healthz")) return response({}, 503);
        throw new DOMException("aborted", "AbortError");
      }) as typeof fetch,
      formatUnknown: () => "not confirmed",
    });

    expect(outcome).toEqual({ status: "unknown", message: "not confirmed" });
  });

  test("a dropped disconnect is unknown, because disconnecting ends no process", async () => {
    const seen: string[] = [];
    const outcome = await requestProxyStop("http://machine", {
      fetchFn: (async (input: RequestInfo | URL) => {
        seen.push(String(input));
        throw new TypeError("network error");
      }) as typeof fetch,
      mode: "client",
      formatUnknown: () => "not confirmed",
    });

    // No liveness read: the proxy answering proves nothing about a client disconnect.
    expect(outcome).toEqual({ status: "unknown", message: "not confirmed" });
    expect(seen).toEqual(["http://machine/api/machine/disconnect"]);
  });

  test("a 2xx whose body cannot be read is unknown, because success: false rides in it", async () => {
    const outcome = await requestProxyStop("", {
      fetchFn: (async () => new Response("not json", { status: 200 })) as typeof fetch,
      formatUnknown: () => "not confirmed",
    });

    expect(outcome).toEqual({ status: "unknown", message: "not confirmed" });
  });

  test("uses the localized fallback when the server omits a message", async () => {
    const outcome = await requestProxyStop("", {
      fetchFn: (async () => response({}, 503)) as typeof fetch,
      formatFailure: status => `HTTP ${status} stop failed`,
    });

    expect(outcome).toEqual({ status: "rejected", message: "HTTP 503 stop failed" });
  });

  test("App gates the stop on an in-page dialog and reports every rejected outcome", async () => {
    const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
    const handleStopIdx = app.indexOf("const handleStop");
    const brandIdx = app.indexOf("const brand");
    expect(handleStopIdx).toBeGreaterThanOrEqual(0);
    expect(brandIdx).toBeGreaterThan(handleStopIdx);
    const handler = app.slice(handleStopIdx, brandIdx);

    // The consent gate is awaited, and a refusal returns before the request. It used to
    // be `confirm()`, which the app's webview answers false without drawing, so this
    // control did nothing there at all.
    expect(handler).toContain("await confirmAction(");
    expect(handler).toContain("if (!consented) return;");
    expect(handler).toContain("await requestProxyStop(machineBase");
    expect(handler).toContain('mode: targets.connected ? "client" : "standalone"');
    expect(handler).toContain('if (outcome.status !== "accepted")');
    expect(handler).toContain("setStopping(false)");
    // Reported in the page, not through a platform dialog that draws nothing — and a
    // refusal and an unknown are not reported in the same tone.
    expect(handler).toContain('outcome.status === "rejected" ? "err" : "warn"');
    expect(handler).not.toContain("alert(");
  });
});
