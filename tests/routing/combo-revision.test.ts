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
      let convergences = 0;
      const call = async (method: string, body?: unknown) => {
        const req = new Request("http://localhost/api/combos", { method, headers: { host: "localhost", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return (await handleManagementAPI(req, new URL(req.url), config, { createManagementConvergeCodex: catalogConvergenceFactory(() => { convergences++; }) }))!;
      };
      const draft = ((await (await call("GET")).json()).combos as any[])[0];
      const disk = structuredClone(config);
      if (change === "deleted") delete disk.combos!.c;
      else if (change === "changed") disk.combos!.c!.targets = [{ provider: "fixture", model: "n" }];
      saveConfig(disk);
      const before = readFileSync(getConfigPath(), "utf8");
      const liveBefore = structuredClone(config);
      convergences = 0;
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
      // Adopting a changed or removed combo converges the catalog like a save would.
      expect(convergences).toBe(1);
      // The refused save adopts the stored combo, so the dashboard's refresh sees what blocked it.
      expect({ ...config, combos: undefined }).toEqual({ ...liveBefore, combos: undefined });
      expect(config.combos?.c).toEqual(disk.combos?.c);
      const refreshed = ((await (await call("GET")).json()).combos as any[]).find(combo => combo.id === "c");
      if (change === "deleted") {
        expect(refreshed).toBeUndefined();
        return;
      }
      expect(refreshed.targets.map((target: { model: string }) => target.model)).toEqual(["n"]);
      expect(refreshed.revision).not.toBe(draft.revision);
      const retried = await call("PUT", { id: "c", ifRevision: refreshed.revision, combo: { strategy: "round-robin", targets: [{ provider: "fixture", model: "n" }] } });
      expect(retried.status).toBe(200);
      expect(JSON.parse(readFileSync(getConfigPath(), "utf8")).combos.c.strategy).toBe("round-robin");
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
    const listed = ((await (await call("GET")).json()).combos as any[]).map(combo => combo.id).sort();
    expect(listed).toEqual(["c", "other"]);
  } finally {
    if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("an adopted stored combo does not override a later disk edit on an unrelated save", async () => {
  const home = mkdtempSync(join(tmpdir(), "combo-adopt-baseline-"));
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
    const diskB = structuredClone(config);
    diskB.combos!.c!.targets = [{ provider: "fixture", model: "n" }];
    saveConfig(diskB);
    expect((await call("PUT", { id: "c", ifRevision: draft.revision, combo: { strategy: "failover", targets: [{ provider: "fixture", model: "m" }] } })).status).toBe(409);
    const diskC = JSON.parse(readFileSync(getConfigPath(), "utf8"));
    diskC.combos.c.strategy = "round-robin";
    diskC.combos.c.targets = [{ provider: "fixture", model: "m" }, { provider: "fixture", model: "n" }];
    saveConfig(diskC);
    expect((await call("PUT", { id: "d", combo: { strategy: "failover", targets: [{ provider: "fixture", model: "n" }] } })).status).toBe(200);
    const stored = JSON.parse(readFileSync(getConfigPath(), "utf8")).combos;
    expect(stored.c.strategy).toBe("round-robin");
    expect(stored.c.targets.map((target: { model: string }) => target.model)).toEqual(["m", "n"]);
    expect(Object.keys(stored).sort()).toEqual(["c", "d"]);
  } finally {
    if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a create-only save refuses a combo that exists in the live or stored config", async () => {
  const home = mkdtempSync(join(tmpdir(), "combo-if-absent-"));
  const oldHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  try {
    const config: OcxConfig = { port: 10100, defaultProvider: "fixture", providers: {
      fixture: { adapter: "openai-chat", baseUrl: "https://fixture.example/v1", apiKey: "fixture", models: ["m", "n"], liveModels: false },
    } };
    saveConfig(config);
    armClaudeCodeBaseline(config);
    const call = async (method: string, body?: unknown) => {
      const req = new Request("http://localhost/api/combos", { method, headers: { host: "localhost", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return (await handleManagementAPI(req, new URL(req.url), config, { createManagementConvergeCodex: catalogConvergenceFactory() }))!;
    };
    const m = { strategy: "failover", targets: [{ provider: "fixture", model: "m" }] };
    const n = { strategy: "failover", targets: [{ provider: "fixture", model: "n" }] };
    expect((await call("PUT", { id: "c", ifAbsent: true, combo: m })).status).toBe(200);
    const live = await call("PUT", { id: "c", ifAbsent: true, combo: n });
    expect(live.status).toBe(409);
    expect(await live.json()).toMatchObject({ code: "combo_revision_conflict" });
    expect(JSON.parse(readFileSync(getConfigPath(), "utf8")).combos.c.targets[0].model).toBe("m");
    const disk = JSON.parse(readFileSync(getConfigPath(), "utf8"));
    disk.combos.e = n;
    saveConfig(disk);
    const before = readFileSync(getConfigPath(), "utf8");
    expect((await call("PUT", { id: "e", ifAbsent: true, combo: m })).status).toBe(409);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
    const listed = ((await (await call("GET")).json()).combos as any[]).find(combo => combo.id === "e");
    expect(listed.targets.map((target: { model: string }) => target.model)).toEqual(["n"]);
    expect((await call("PUT", { id: "f", ifAbsent: false, combo: m })).status).toBe(400);
    expect((await call("PUT", { id: "f", renameFrom: "c", ifAbsent: true, combo: m })).status).toBe(400);
  } finally {
    if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a conditional rename onto a live combo is a revision conflict, an unconditional one stays a 400", async () => {
  const config: OcxConfig = { port: 10100, defaultProvider: "fixture", providers: {
    fixture: { adapter: "openai-chat", baseUrl: "https://fixture.example/v1", apiKey: "fixture", models: ["m", "n"], liveModels: false },
  } };
  const call = async (method: string, body?: unknown) => {
    const req = new Request("http://localhost/api/combos", { method, headers: { host: "localhost", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return (await handleManagementAPI(req, new URL(req.url), config, {
      createManagementConvergeCodex: catalogConvergenceFactory(), saveConfigPreservingClaudeCode: () => {},
    }))!;
  };
  const m = { strategy: "failover", targets: [{ provider: "fixture", model: "m" }] };
  expect((await call("PUT", { id: "c", combo: m })).status).toBe(200);
  expect((await call("PUT", { id: "d", combo: m })).status).toBe(200);
  const source = ((await (await call("GET")).json()).combos as any[]).find(combo => combo.id === "c");
  const conditional = await call("PUT", { id: "d", renameFrom: "c", ifRevision: source.revision, combo: m });
  expect(conditional.status).toBe(409);
  expect(await conditional.json()).toMatchObject({ code: "combo_revision_conflict" });
  const unconditional = await call("PUT", { id: "d", renameFrom: "c", combo: m });
  expect(unconditional.status).toBe(400);
  expect(Object.keys(config.combos ?? {}).sort()).toEqual(["c", "d"]);
});

test("adopting a stored combo also adopts the combo whose alias the same disk edit moved", async () => {
  const home = mkdtempSync(join(tmpdir(), "combo-adopt-alias-"));
  const oldHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  try {
    const target = [{ provider: "fixture", model: "m" }];
    const config: OcxConfig = { port: 10100, defaultProvider: "fixture", providers: {
      fixture: { adapter: "openai-chat", baseUrl: "https://fixture.example/v1", apiKey: "fixture", models: ["m", "n"], liveModels: false },
    }, combos: {
      c: { strategy: "failover", alias: "alpha", targets: target },
      d: { strategy: "failover", alias: "beta", targets: target },
      e: { strategy: "failover", alias: "delta", targets: target },
    } };
    saveConfig(config);
    armClaudeCodeBaseline(config);
    const call = async (method: string, body?: unknown) => {
      const req = new Request("http://localhost/api/combos", { method, headers: { host: "localhost", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return (await handleManagementAPI(req, new URL(req.url), config, { createManagementConvergeCodex: catalogConvergenceFactory() }))!;
    };
    const draft = ((await (await call("GET")).json()).combos as any[]).find(combo => combo.id === "c");
    const disk = structuredClone(config);
    disk.combos!.c!.alias = "beta";
    disk.combos!.d!.alias = "gamma";
    disk.combos!.e!.strategy = "round-robin";
    saveConfig(disk);
    const response = await call("PUT", { id: "c", ifRevision: draft.revision, combo: { strategy: "failover", alias: "alpha", targets: target } });
    expect(response.status).toBe(409);
    const listed = (await (await call("GET")).json()).combos as any[];
    const models = Object.fromEntries(listed.map(combo => [combo.id, combo.model]));
    expect(models).toEqual({ c: "beta", d: "gamma", e: "delta" });
    // A row the alias swap did not touch keeps its live value.
    expect(config.combos?.e?.strategy).toBe("failover");
  } finally {
    if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});
