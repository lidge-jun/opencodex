import { expect, test } from "bun:test";
import { machineHealthPath, readManagementHealth } from "../src/lib/proxy-health";

const respond = (status: number, body: unknown = {}) => (async () => Response.json(body, { status })) as unknown as typeof fetch;

test("a connected Child keeps probing its machine listener's unauthenticated /healthz", () => {
  // The machine listener admits /healthz and refuses every /api/* route but /api/machine/*.
  expect(machineHealthPath(true)).toBe("/healthz");
});

test("every other dashboard probes the authenticated management health route", () => {
  // A hub's management ingress answers /healthz with 404 (#8506).
  expect(machineHealthPath(false)).toBe("/api/system/health");
});

test("a 2xx health body yields its version and uptime", async () => {
  const health = await readManagementHealth("http://hub", "/api/system/health", new AbortController().signal,
    respond(200, { status: "ok", version: "2.100.2", uptime: 42, pid: 7 }));
  expect(health).toEqual({ version: "2.100.2", uptime: 42 });
});

test("a refused session still proves the process answered", async () => {
  for (const status of [401, 403]) {
    const health = await readManagementHealth("http://hub", "/api/system/health", new AbortController().signal, respond(status));
    expect(health).toEqual({ version: null, uptime: null });
  }
});

test("a missing route or a server error is not an answer", async () => {
  for (const status of [404, 500, 503]) {
    expect(await readManagementHealth("http://hub", "/api/system/health", new AbortController().signal, respond(status))).toBeNull();
  }
});

test("the probe asks the requested base and path", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => { seen.push(String(input)); return Response.json({ version: "1", uptime: 1 }); }) as unknown as typeof fetch;
  await readManagementHealth("http://machine", "/healthz", new AbortController().signal, fetchImpl);
  expect(seen).toEqual(["http://machine/healthz"]);
});
