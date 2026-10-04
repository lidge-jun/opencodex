import { expect, test, spyOn } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAccessCommand } from "../../src/cli/access";
import { handleOauthAccountRoutes } from "../../src/server/management/oauth-account-routes";
import { saveConfig } from "../../src/config";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import type { OcxConfig } from "../../src/types";
const row = { id: "stable-id", name: "old", createdAt: "2026-01-01T00:00:00.000Z", allowedProviders: ["fixture"], allowedModels: ["fixture/model"] };
async function run(args: string[], deps: RuntimeApiDeps) {
  const logs: string[] = [], errors: string[] = [];
  const out = spyOn(console, "log").mockImplementation(value => { logs.push(String(value)); });
  const err = spyOn(console, "error").mockImplementation(value => { errors.push(String(value)); });
  try { return { code: await handleAccessCommand(["key", "rename", ...args], deps), logs, errors }; }
  finally { out.mockRestore(); err.mockRestore(); }
}
test("rename exact id and name only, projects secret-free receipt", async () => {
  const seen: RequestInit[] = [];
  const result = await run(["OLD", " new ", "--json"], { baseUrl: "http://127.0.0.1:12345", fetchImpl: (async (_url, init) => {
    seen.push(init!);
    return Response.json(seen.length === 1 ? { keys: [row] } : { ...row, name: "new", key: "private-fixture", unknown: "private-fixture" });
  }) as typeof fetch });
  expect(result.code).toBe(0); expect(seen).toHaveLength(2);
  expect(JSON.parse(String(seen[1]!.body))).toEqual({ id: "stable-id", name: "new" });
  expect(seen.map(item => item.redirect)).toEqual(["error", "error"]);
  expect(JSON.parse(result.logs[0]!)).toEqual({ ...row, name: "new" }); expect(result.logs.join("")).not.toContain("private-fixture");
});
for (const rows of [[row, { ...row, id: "STABLE-ID", name: "other" }], [row, { ...row, id: "STABLE-ID", name: "other" }, { ...row, id: "another", name: "stable-id" }], [row, { ...row, id: "other", name: "old" }]]) {
  test("duplicate ids or ambiguous names do not PATCH", async () => {
    let calls = 0;
    const result = await run([rows.length === 3 ? "stable-id" : "old", "new"], { baseUrl: "http://127.0.0.1:12345", fetchImpl: (async () => { calls++; return Response.json({ keys: rows }); }) as typeof fetch });
    expect(result.code).toBe(2); expect(calls).toBe(1); expect(result.logs).toEqual([]);
  });
}
for (const name of ["", " ", "new\n", "new\x7f", "x".repeat(65)]) test("invalid name refused before GET", async () => {
  let calls = 0;
  const result = await run(["old", name], { fetchImpl: (async () => { calls++; throw new Error(); }) as typeof fetch });
  expect(result.code).toBe(2); expect(calls).toBe(0);
});
for (const changed of [{ id: "other" }, { name: "other" }, { allowedModels: [0] }, { createdAt: "0" }]) test("unconfirmed/malformed rename receipt is nonzero", async () => {
  let calls = 0;
  const result = await run(["old", "new", "--json"], { baseUrl: "http://127.0.0.1:12345", fetchImpl: (async () => Response.json(++calls === 1 ? { keys: [row] } : { ...row, name: "new", ...changed })) as typeof fetch });
  expect(result.code).toBe(1); expect(result.logs).toEqual([]);
});
for (const redirectAt of [1, 2]) test(`redirect at request ${redirectAt} never forwards to another endpoint`, async () => {
  let foreign = 0, calls = 0;
  const destination = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { foreign++; return Response.json({}); } });
  const source = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return calls === redirectAt ? Response.redirect(destination.url, 307) : Response.json({ keys: [row] }); } });
  try {
    const result = await run(["old", "new"], { baseUrl: String(source.url).replace(/\/$/, "") });
    expect(result.code).toBe(1); expect(foreign).toBe(0); expect(calls).toBe(redirectAt);
  } finally { await source.stop(true); await destination.stop(true); }
});
test("real management owner persists only name and preserves key/scopes", async () => {
  const prior = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-rename-cli-")); process.env.OPENCODEX_HOME = home;
  const config: OcxConfig = { port: 0, providers: {}, apiKeys: [{ ...row, key: "fixture-secret" }] };
  try {
    saveConfig(config);
    const result = await run(["stable-id", "new", "--json"], { baseUrl: "http://127.0.0.1:12345", fetchImpl: (async (url, init) => {
      const req = new Request(url, init);
      const reply = await handleOauthAccountRoutes({ req, url: new URL(req.url), config, version: "fixture", deps: {},
        convergeCodexCatalog: async () => ({ status: "failed", reason: "disk" }), syncClaudeAgentDefsBestEffort: async () => {} });
      if (!reply) throw new Error("route not handled"); return reply;
    }) as typeof fetch });
    expect(result.code).toBe(0);
    const stored = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(stored.apiKeys[0]).toEqual({ ...row, name: "new", key: "fixture-secret" });
    expect(result.logs.join("")).not.toContain("fixture-secret");
  } finally { if (prior === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = prior; removeTreeWithRetry(home); }
});
