import { describe, expect, test } from "bun:test";
import { linkRouteAllowed as clientRouteAllowed } from "../../src/link/routes";
import { linkRouteAllowed as serverRouteAllowed } from "../../src/server/index/link-listener";
import { machineRouteAllowed } from "../../src/client/machine-listener";

function request(path: string, method = "GET", headers?: HeadersInit): Request {
  return new Request(`http://127.0.0.1${path}`, { method, headers });
}

describe("shared link route table", () => {
  test("the server entry point re-exports the client shared predicate", () => {
    expect(serverRouteAllowed).toBe(clientRouteAllowed);
  });

  test.each([
    { path: "/readyz", method: "GET", expected: true },
    { path: "/readyz", method: "HEAD", expected: false },
    { path: "/v1/catalog", method: "GET", expected: true },
    { path: "/v1/catalog", method: "HEAD", expected: true },
    { path: "/v1/responses", method: "POST", expected: true },
    { path: "/v1/responses", method: "GET", expected: false },
    { path: "/v1/opencodex/artifacts/a", method: "GET", expected: true },
    { path: "/v1/unknown", method: "GET", expected: false },
    { path: "/api/config", method: "GET", expected: false },
    { path: "/v1/responses", method: "POST", expected: false, headers: { upgrade: "websocket" } },
  ])("admits the same route in server and client listener", ({ path, method, expected, headers }) => {
    const req = request(path, method, headers);
    const url = new URL(req.url);
    expect(serverRouteAllowed(url, req)).toBe(expected);
    expect(clientRouteAllowed(url, req)).toBe(expected);
    expect(machineRouteAllowed(url, req, false, true)).toBe(expected);
  });
});
