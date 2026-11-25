import { expect, test } from "bun:test";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armClaudeCodeBaseline, getConfigPath, saveConfig } from "../../src/config";

test("combo revisions reject stale saves and allow matching and unconditional saves", async () => {
  const config: OcxConfig = { port: 10100, defaultProvider: "fixture", providers: {
    fixture: { adapter: "openai-chat", baseUrl: "https://fixture.example/v1", apiKey: "fixture", models: ["m", "n"], liveModels: false },
  } };
  const call = async (method: string, body?: unknown) => {
    const req = new Request("http://localhost/api/combos", { method, headers: { host: "localhost", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return (await handleManagementAPI(req, new URL(req.url), config, {
      createManagementConvergeCodex: catalogConvergenceFactory(), saveConfigPreservingClaudeCode: () => {},
    }))!;
  };
  const m = { provider: "fixture", model: "m", metered: true };
  const n = { provider: "fixture", model: "n" };
  expect((await call("PUT", { id: "c", combo: { strategy: "failover", targets: [m, n] } })).status).toBe(200);
  const draft = ((await (await call("GET")).json()).combos as any[])[0];
  expect((await call("PUT", { id: "c", combo: { strategy: "failover", targets: [n] } })).status).toBe(200);
  const before = structuredClone(config.combos);
  const stale = await call("PUT", { id: "c", ifRevision: draft.revision ?? "missing-revision", combo: { strategy: "failover", targets: [{ provider: "fixture", model: "m" }, n] } });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ code: "combo_revision_conflict" });
  expect(config.combos).toEqual(before);
  expect(typeof draft.revision).toBe("string");
  const current = ((await (await call("GET")).json()).combos as any[])[0];
  const matching = await call("PUT", { id: "c", ifRevision: current.revision, combo: { strategy: "failover", targets: [n, m] } });
  expect(matching.status).toBe(200);
  const result = await matching.json();
  expect(result.combo.revision).toBeString();
  expect(result.combo.revision).not.toBe(current.revision);
  expect((await call("PUT", { id: "c", combo: { strategy: "failover", targets: [n] } })).status).toBe(200);
  const latest = ((await (await call("GET")).json()).combos as any[])[0];
  const renamed = await call("PUT", { id: "renamed", renameFrom: "c", ifRevision: latest.revision, combo: { strategy: "failover", targets: [n] } });
  expect(renamed.status).toBe(200);
  expect((await call("PUT", { id: "another", renameFrom: "c", ifRevision: latest.revision, combo: { strategy: "failover", targets: [n] } })).status).toBe(409);
  expect((await call("PUT", { id: "c", ifRevision: latest.revision, combo: { strategy: "failover", targets: [n] } })).status).toBe(409);
});

for (const change of ["changed", "deleted", "unchanged"] as const) {
  test(`conditional save checks a combo ${change} on disk`, async () => {
    const home = mkdtempSync(join(tmpdir(), "combo-revision-"));
    const oldHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    try {
      const config: OcxConfig = { port: 10100, defaultProvider: "fixture", providers: {
        fixture: { adapter: "openai-chat", baseUrl: "https://fixture.example/v1", apiKey: "fixture", models: ["m", "n"], liveModels: false },
      }, combos: { c: { strategy: "failover", targets: [{ provider: "fixture", model: "m" }] } } };
      saveConfig(config);
      armClaudeCodeBaseline(config);
      const call = async (method: string, body?: unknown) => {
        const req = new Request("http://localhost/api/combos", { method, headers: { host: "localhost", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return (await handleManagementAPI(req, new URL(req.url), config, { createManagementConvergeCodex: catalogConvergenceFactory() }))!;
      };
      const draft = ((await (await call("GET")).json()).combos as any[])[0];
      const disk = structuredClone(config);
      if (change === "deleted") delete disk.combos!.c;
      else if (change === "changed") disk.combos!.c!.targets = [{ provider: "fixture", model: "n" }];
      saveConfig(disk);
      const before = readFileSync(getConfigPath(), "utf8");
      const liveBefore = structuredClone(config);
      const response = await call("PUT", { id: "c", ifRevision: draft.revision, combo: { strategy: "failover", targets: [{ provider: "fixture", model: "n" }] } });
      if (change === "unchanged") {
        expect(response.status).toBe(200);
        expect((await response.json()).combo.revision).not.toBe(draft.revision);
        expect(readFileSync(getConfigPath(), "utf8")).not.toBe(before);
        return;
      }
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "combo_revision_conflict" });
      expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
      expect(config).toEqual(liveBefore);
    } finally {
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test("a PUT returns its own committed combo when another PUT finishes during convergence", async () => {
  const config: OcxConfig = { port: 10100, defaultProvider: "fixture", providers: {
    fixture: { adapter: "openai-chat", baseUrl: "https://fixture.example/v1", apiKey: "fixture", models: ["m", "n"], liveModels: false },
  } };
  let interleave: (() => Promise<void>) | undefined;
  const call = async (body: unknown) => {
    const req = new Request("http://localhost/api/combos", { method: "PUT", headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await handleManagementAPI(req, new URL(req.url), config, {
      createManagementConvergeCodex: catalogConvergenceFactory(async () => { const run = interleave; interleave = undefined; await run?.(); }),
      saveConfigPreservingClaudeCode: () => {},
    }))!;
  };
  let second: any;
  interleave = async () => { second = await (await call({ id: "c", combo: { strategy: "failover", targets: [{ provider: "fixture", model: "n" }] } })).json(); };
  const first = await (await call({ id: "c", combo: { strategy: "failover", targets: [{ provider: "fixture", model: "m" }] } })).json();
  expect(first.combo.targets[0].model).toBe("m");
  expect(second.combo.targets[0].model).toBe("n");
  expect(first.combo.revision).not.toBe(second.combo.revision);
});
test("a conditional rename refuses a destination that exists only in the stored config", async () => {
  const home = mkdtempSync(join(tmpdir(), "combo-destination-"));
  const oldHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  try {
    const config: OcxConfig = { port: 10100, defaultProvider: "fixture", providers: {
      fixture: { adapter: "openai-chat", baseUrl: "https://fixture.example/v1", apiKey: "fixture", models: ["m", "n"], liveModels: false },
    }, combos: { c: { strategy: "failover", targets: [{ provider: "fixture", model: "m" }] } } };
    saveConfig(config);
    armClaudeCodeBaseline(config);
    const call = async (method: string, body?: unknown) => {
      const req = new Request("http://localhost/api/combos", { method, headers: { host: "localhost", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return (await handleManagementAPI(req, new URL(req.url), config, { createManagementConvergeCodex: catalogConvergenceFactory() }))!;
    };
    const draft = ((await (await call("GET")).json()).combos as any[])[0];
    const disk = structuredClone(config);
    disk.combos!.other = { strategy: "failover", targets: [{ provider: "fixture", model: "n" }] };
    saveConfig(disk);
    const before = readFileSync(getConfigPath(), "utf8");
    const response = await call("PUT", { id: "other", renameFrom: "c", ifRevision: draft.revision, combo: { strategy: "failover", targets: [{ provider: "fixture", model: "m" }] } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "combo_revision_conflict" });
    expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
  } finally {
    if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});
