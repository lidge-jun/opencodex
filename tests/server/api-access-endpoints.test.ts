import { describe, expect, test } from "bun:test";
import {
  buildApiAccessEndpoints,
  formatAuthorityHost,
  resolveApiAccessBaseUrl,
} from "../../src/server/management/api-access";

describe("buildApiAccessEndpoints", () => {
  test("builds the external gateway URLs from hostname and port", () => {
    expect(buildApiAccessEndpoints({ hostname: "127.0.0.1", port: 10100 })).toEqual({
      baseUrl: "http://127.0.0.1:10100/v1",
      endpoint: "http://127.0.0.1:10100/v1/responses",
      responsesEndpoint: "http://127.0.0.1:10100/v1/responses",
      chatCompletionsEndpoint: "http://127.0.0.1:10100/v1/chat/completions",
      messagesEndpoint: "http://127.0.0.1:10100/v1/messages",
      modelsEndpoint: "http://127.0.0.1:10100/v1/models",
      claudeCodeEnabled: true,
    });
  });

  test("falls back to the default bind when config fields are missing", () => {
    expect(buildApiAccessEndpoints({})).toEqual({
      baseUrl: "http://127.0.0.1:10100/v1",
      endpoint: "http://127.0.0.1:10100/v1/responses",
      responsesEndpoint: "http://127.0.0.1:10100/v1/responses",
      chatCompletionsEndpoint: "http://127.0.0.1:10100/v1/chat/completions",
      messagesEndpoint: "http://127.0.0.1:10100/v1/messages",
      modelsEndpoint: "http://127.0.0.1:10100/v1/models",
      claudeCodeEnabled: true,
    });
  });

  test("brackets IPv6 hostnames for URL display", () => {
    expect(buildApiAccessEndpoints({ hostname: "::1", port: 10100 })).toEqual({
      baseUrl: "http://[::1]:10100/v1",
      endpoint: "http://[::1]:10100/v1/responses",
      responsesEndpoint: "http://[::1]:10100/v1/responses",
      chatCompletionsEndpoint: "http://[::1]:10100/v1/chat/completions",
      messagesEndpoint: "http://[::1]:10100/v1/messages",
      modelsEndpoint: "http://[::1]:10100/v1/models",
      claudeCodeEnabled: true,
    });
  });

  test("wildcard binds fall back to loopback only without request context", () => {
    // Every all-zero spelling, not the three this file used to know: `0.0.0.0.`, `::0` and `*`
    // are wildcard binds the server treats as such, and describing them as literal hostnames
    // published `http://0.0.0.0.:10100` — a URL that resolves to nothing — to the GUI.
    for (const hostname of ["0.0.0.0", "0.0.0.0.", "00.0.0.000", "::", "[::]", "::0", "0::", "*", "0", ""]) {
      expect({ hostname, baseUrl: buildApiAccessEndpoints({ hostname, port: 10100 }).baseUrl })
        .toEqual({ hostname, baseUrl: "http://127.0.0.1:10100/v1" });
    }
  });

  test("wildcard binds publish the request host instead of 127.0.0.1", () => {
    expect(resolveApiAccessBaseUrl(
      { hostname: "0.0.0.0", port: 10100 },
      { requestUrl: "http://192.168.1.50:10100/api/keys" },
    )).toBe("http://192.168.1.50:10100/v1");

    expect(buildApiAccessEndpoints(
      { hostname: "0.0.0.0", port: 10100 },
      { requestHost: "gateway.example:10100" },
    ).baseUrl).toBe("http://gateway.example:10100/v1");

    expect(buildApiAccessEndpoints(
      { hostname: "::", port: 10100 },
      { requestOrigin: "http://[2001:db8::1]:10100" },
    ).baseUrl).toBe("http://[2001:db8::1]:10100/v1");

    expect(buildApiAccessEndpoints(
      { hostname: "::", port: 10100 },
      { requestHost: "[2001:db8::1]:9999" },
    ).baseUrl).toBe("http://[2001:db8::1]:9999/v1");
  });

  /**
   * Only the LAST-RESORT loopback fallback honors the unauthenticated loopback listener
   * (#4236). Everything above it describes the address the CLIENT reached, so a remote caller
   * is never handed a port that only exists on the hub's own 127.0.0.1.
   */
  test("the loopback fallback honors the loopback listener; request-derived hosts do not", () => {
    const wildcard = { hostname: "0.0.0.0", port: 10100 } as const;
    expect(resolveApiAccessBaseUrl({ ...wildcard, unauthenticatedLoopbackListener: { enabled: true, port: 10104 } }))
      .toBe("http://127.0.0.1:10104/v1");
    // Companion form: same port as the public listener, so the string does not move.
    expect(resolveApiAccessBaseUrl({ ...wildcard, unauthenticatedLoopbackListener: { enabled: true } }))
      .toBe("http://127.0.0.1:10100/v1");
    expect(resolveApiAccessBaseUrl({ ...wildcard, unauthenticatedLoopbackListener: { enabled: false } }))
      .toBe("http://127.0.0.1:10100/v1");

    // A real request context still wins, on the port the caller actually used.
    expect(resolveApiAccessBaseUrl(
      { ...wildcard, unauthenticatedLoopbackListener: { enabled: true, port: 10104 } },
      { requestUrl: "http://192.168.1.50:10100/api/keys" },
    )).toBe("http://192.168.1.50:10100/v1");

    // And a specific bind is described as itself: a remote client cannot dial 10104 here.
    expect(resolveApiAccessBaseUrl({
      hostname: "100.76.170.81",
      port: 10100,
      unauthenticatedLoopbackListener: { enabled: true, port: 10104 },
    })).toBe("http://100.76.170.81:10100/v1");
  });

  test("reflects disabled Claude inbound in API access metadata", () => {
    expect(buildApiAccessEndpoints({ claudeCode: { enabled: false } }).claudeCodeEnabled).toBe(false);
  });
});

describe("formatAuthorityHost", () => {
  test("brackets bare IPv6 and leaves IPv4/DNS untouched", () => {
    expect(formatAuthorityHost("::1")).toBe("[::1]");
    expect(formatAuthorityHost("[::1]")).toBe("[::1]");
    expect(formatAuthorityHost("127.0.0.1")).toBe("127.0.0.1");
    expect(formatAuthorityHost("gateway.local")).toBe("gateway.local");
  });
});
