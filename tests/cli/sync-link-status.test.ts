import { expect, test } from "bun:test";
import { readHomeLinkStatus } from "../../src/cli/sync-link-status";

const never = () => new Promise<never>(() => {});
test.each(["discovery", "headers", "body"] as const)("bounds stalled %s by the same deadline", async stage => {
  const start = Date.now();
  await expect(readHomeLinkStatus(40, {
    headers: () => new Headers(),
    baseUrl: stage === "discovery" ? never : async () => "http://localhost",
    fetchImpl: stage === "headers" ? never : async () => ({ ok: true, status: 200, text: never }) as Response,
  })).rejects.toMatchObject({ reason: "home-link-status-timeout" });
  expect(Date.now() - start).toBeLessThan(500);
});
test("classifies absent runtime, unauthorized and invalid bodies", async () => {
  await expect(readHomeLinkStatus(100, { baseUrl: async () => null })).rejects.toMatchObject({ reason: "home-runtime-not-running" });
  for (const status of [401, 403]) {
    await expect(readHomeLinkStatus(100, { headers: () => new Headers(), baseUrl: async () => "http://localhost", fetchImpl: async () => new Response("", { status }) })).rejects.toMatchObject({ reason: "home-link-status-unauthorized" });
  }
  await expect(readHomeLinkStatus(100, { headers: () => new Headers(), baseUrl: async () => "http://localhost", fetchImpl: async () => new Response("{}") })).rejects.toMatchObject({ reason: "home-link-status-invalid" });
});
test("accepts the validated wire status", async () => {
  const dto = { role: "home", listener: { state: "listening", port: 27000 }, child: null, links: [] };
  const result = await readHomeLinkStatus(100, { headers: () => new Headers(), baseUrl: async () => "http://localhost", fetchImpl: async () => Response.json(dto) });
  expect(result).toEqual(dto);
});
