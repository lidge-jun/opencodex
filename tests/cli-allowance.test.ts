import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { handleAllowanceCommand } from "../src/cli/allowance";

type Recorded = { path: string; method: string; body: unknown };
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  process.exitCode = 0;
});

function fakeRuntime(responder?: (req: Request, body: unknown) => unknown) {
  const requests: Recorded[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" || req.method === "DELETE" ? null : await req.json().catch(() => null);
      requests.push({ path: `${url.pathname}${url.search}`, method: req.method, body });
      const custom = responder?.(req, body);
      if (custom !== undefined) return Response.json(custom);
      return Response.json({ ok: true, allowances: [{ id: "promo", state: "unknown", activeReservations: 0 }] });
    },
  });
  servers.push(server);
  return { requests, deps: { baseUrl: `http://127.0.0.1:${server.port}` } };
}

describe("ocx allowance", () => {
  test("list hits GET /api/economic-allowances", async () => {
    const runtime = fakeRuntime(() => ({ allowances: [{ id: "promo", state: "present", activeReservations: 1 }] }));
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(String(args[0])); });
    try {
      expect(await handleAllowanceCommand(["list"], runtime.deps)).toBe(0);
      expect(runtime.requests[0]).toEqual({ path: "/api/economic-allowances", method: "GET", body: null });
      expect(logs.join("\n")).toContain("promo");
    } finally {
      spy.mockRestore();
    }
  });

  test("snapshot get encodes id", async () => {
    const runtime = fakeRuntime(() => ({ allowanceId: "a/b", state: "unknown", snapshot: null }));
    expect(await handleAllowanceCommand(["snapshot", "get", "a/b", "--json"], runtime.deps)).toBe(0);
    expect(runtime.requests[0]?.path).toBe("/api/economic-allowances/a%2Fb/snapshot");
    expect(runtime.requests[0]?.method).toBe("GET");
  });

  test("snapshot set requires --snapshot-json", async () => {
    const runtime = fakeRuntime();
    expect(await handleAllowanceCommand(["snapshot", "set", "promo"], runtime.deps)).toBe(2);
    expect(runtime.requests).toEqual([]);
  });

  test("snapshot set posts body and clearReservations flag", async () => {
    const runtime = fakeRuntime(() => ({ ok: true }));
    const code = await handleAllowanceCommand([
      "snapshot", "set", "promo",
      "--snapshot-json", JSON.stringify({ remaining: 3, updatedAt: 1, source: "manual", confidence: "authoritative" }),
      "--clear-reservations",
      "--json",
    ], runtime.deps);
    expect(code).toBe(0);
    expect(runtime.requests[0]?.method).toBe("PUT");
    expect(runtime.requests[0]?.path).toBe("/api/economic-allowances/promo/snapshot");
    expect(runtime.requests[0]?.body).toMatchObject({ remaining: 3, clearReservations: true });
  });

  test("snapshot clear without flag omits query", async () => {
    const runtime = fakeRuntime(() => ({ cleared: true }));
    expect(await handleAllowanceCommand(["snapshot", "clear", "promo"], runtime.deps)).toBe(0);
    expect(runtime.requests[0]).toEqual({
      path: "/api/economic-allowances/promo/snapshot",
      method: "DELETE",
      body: null,
    });
  });

  test("snapshot clear with --clear-reservations sets query", async () => {
    const runtime = fakeRuntime(() => ({ cleared: true }));
    expect(await handleAllowanceCommand(["snapshot", "clear", "promo", "--clear-reservations"], runtime.deps)).toBe(0);
    expect(runtime.requests[0]?.path).toBe("/api/economic-allowances/promo/snapshot?clearReservations=true");
    expect(runtime.requests[0]?.method).toBe("DELETE");
  });

  test("malformed snapshot json exits 2", async () => {
    const runtime = fakeRuntime();
    expect(await handleAllowanceCommand(["snapshot", "set", "promo", "--snapshot-json", "{"], runtime.deps)).toBe(2);
    expect(runtime.requests).toEqual([]);
  });
});
