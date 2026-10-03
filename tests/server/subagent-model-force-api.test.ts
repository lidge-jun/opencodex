import { expect, mock, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSubagentModelRoutes } from "../../src/server/management/subagent-model-routes";
import type { ManagementContext } from "../../src/server/management/context";
import { loadConfig, setPersistedConfigMutationBeforeCommitForTests } from "../../src/config";
import type { OcxConfig } from "../../src/types";
import { InitialConfigPublicationError } from "../../src/config/initialize";
import { ConfigWritePublishedError } from "../../src/config/persist-unlocked";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function cfg(): OcxConfig {
  return { port: 10100, providers: {}, defaultProvider: "openai", subagentModels: ["retired/model"],
    claudeCode: { subagentEffort: "high", model: "keep", subagentModelForce: "combo/tev-auto" } };
}
function context(config: OcxConfig, body: unknown): ManagementContext {
  const url = new URL("http://localhost/api/subagent-models");
  return { url, config, version: "test", req: new Request(url, { method: "PUT", body: JSON.stringify(body) }),
    deps: { fetchAllModels: async () => [{ provider: "combo", id: "tev-auto" }], saveConfigPreservingClaudeCode: mock(() => {}) },
    convergeCodexCatalog: mock(async () => ({ status: "committed", changed: true, degraded: false, notices: [] } as const)),
    syncClaudeAgentDefsBestEffort: mock(async () => {}) };
}
const apply = async () => {};

test("force-only set/clear preserves roster and siblings without catalog or agent writes", async () => {
  for (const force of ["combo/tev-auto", null]) {
    const config = cfg(); const ctx = context(config, { force });
    const result = await handleSubagentModelRoutes(ctx, apply);
    expect(result?.status).toBe(200);
    expect(await result!.json()).toMatchObject({ force, applied: ["retired/model"] });
    expect(config.claudeCode).toMatchObject({ model: "keep", subagentEffort: "high" });
    expect(config.claudeCode?.subagentModelForce).toBe(force ?? undefined);
    expect(ctx.convergeCodexCatalog).not.toHaveBeenCalled();
    expect(ctx.syncClaudeAgentDefsBestEffort).not.toHaveBeenCalled();
  }
});

test("roster-only and mixed updates preserve partial-update semantics", async () => {
  const config = cfg();
  expect((await handleSubagentModelRoutes(context(config, { models: [] }), apply))?.status).toBe(200);
  expect(config.claudeCode?.subagentModelForce).toBe("combo/tev-auto");
  expect((await handleSubagentModelRoutes(context(config, { force: null, models: ["retained/model"] }), apply))?.status).toBe(200);
  expect(config.subagentModels).toEqual(["retained/model"]);
  expect(config.claudeCode?.subagentModelForce).toBeUndefined();
});

test("malformed, hidden and retained unavailable targets are rejected without writing", async () => {
  for (const force of [42, "", "bad\nmodel", "retired/model", "combo/tev-auto"]) {
    const config = cfg(); config.disabledModels = ["combo/tev-auto"];
    const ctx = context(config, { force });
    expect((await handleSubagentModelRoutes(ctx, apply))?.status).toBe(400);
    expect(ctx.deps.saveConfigPreservingClaudeCode).not.toHaveBeenCalled();
  }
});

test("persistence failure restores both Claude and roster state", async () => {
  const config = cfg(); const before = structuredClone(config);
  const ctx = context(config, { force: null, models: [] });
  ctx.deps.saveConfigPreservingClaudeCode = () => { throw new Error("fixture save failure"); };
  await expect(handleSubagentModelRoutes(ctx, apply)).rejects.toThrow("fixture save failure");
  expect(config).toEqual(before);
});

test("field-scoped durable force writes preserve concurrent disk edits and clear only the force leaf", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-force-api-"));
  const previous = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  try {
    const path = join(home, "config.json");
    writeFileSync(path, JSON.stringify(cfg()));
    const live = loadConfig();
    const disk = cfg(); disk.claudeCode!.model = "concurrent-model"; disk.claudeCode!.subagentEffort = "max";
    writeFileSync(path, JSON.stringify(disk));
    const ctx = context(live, { force: null }); delete ctx.deps.saveConfigPreservingClaudeCode;
    expect((await handleSubagentModelRoutes(ctx, apply))?.status).toBe(200);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.claudeCode).toMatchObject({ model: "concurrent-model", subagentEffort: "max" });
    expect(saved.claudeCode.subagentModelForce).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
    removeTreeWithRetry(home);
  }
});


async function isolatedForceHome(run: (path: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), "ocx-force-first-run-"));
  const previous = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  try { await run(join(home, "config.json")); }
  finally {
    setPersistedConfigMutationBeforeCommitForTests(null);
    if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
    removeTreeWithRetry(home);
  }
}

for (const force of ["combo/tev-auto", null]) {
  test(`first-run force ${force === null ? "clear" : "set"} initializes absent config without losing live defaults`, () => isolatedForceHome(async path => {
    const live = loadConfig();
    live.claudeCode = { model: "keep-first-run", subagentEffort: "high" };
    const roster = [...(live.subagentModels ?? [])];
    const ctx = context(live, { force }); delete ctx.deps.saveConfigPreservingClaudeCode;
    const response = await handleSubagentModelRoutes(ctx, apply);
    expect(response?.status).toBe(200);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.claudeCode).toMatchObject({ model: "keep-first-run", subagentEffort: "high" });
    expect(saved.claudeCode.subagentModelForce).toBe(force ?? undefined);
    expect(saved.subagentModels ?? []).toEqual(roster);
    expect(ctx.convergeCodexCatalog).not.toHaveBeenCalled();
  }));
}

for (const kind of ["corrupt", "directory", "dangling-link", "appeared", "deleted", "mutation-race"] as const) {
  test(`force persistence refuses ${kind} config without overwriting or recreating it`, () => isolatedForceHome(async path => {
    if (kind === "corrupt") writeFileSync(path, "{broken");
    if (kind === "directory") mkdirSync(path);
    if (kind === "dangling-link") symlinkSync(join(path, "..", "missing-target"), path);
    if (kind === "deleted" || kind === "mutation-race") writeFileSync(path, JSON.stringify(cfg()));
    const live = cfg(); const before = structuredClone(live);
    const ctx = context(live, { force: "combo/tev-auto" }); delete ctx.deps.saveConfigPreservingClaudeCode;
    ctx.deps.fetchAllModels = async () => {
      if (kind === "appeared") writeFileSync(path, JSON.stringify({ ...cfg(), port: 17777 }));
      if (kind === "deleted") unlinkSync(path);
      return [{ provider: "combo", id: "tev-auto" }];
    };
    if (kind === "mutation-race") setPersistedConfigMutationBeforeCommitForTests(() => writeFileSync(path, "{raced"));
    expect((await handleSubagentModelRoutes(ctx, apply))?.status).toBe(409);
    expect(live).toEqual(before);
    if (kind === "corrupt") expect(readFileSync(path, "utf8")).toBe("{broken");
    if (kind === "mutation-race") expect(readFileSync(path, "utf8")).toBe("{raced");
    if (kind === "appeared") expect(JSON.parse(readFileSync(path, "utf8")).port).toBe(17777);
    if (kind === "deleted") expect(existsSync(path)).toBe(false);
  }));
}

test("force API rejects an unadvertised million-context suffix", async () => {
  const config = cfg();
  const ctx = context(config, { force: "combo/tev-auto[1m]" });
  expect((await handleSubagentModelRoutes(ctx, apply))?.status).toBe(400);
  expect(ctx.deps.saveConfigPreservingClaudeCode).not.toHaveBeenCalled();
});


test.skipIf(process.platform === "win32")("unreadable config is preserved and force mutation fails closed", () => isolatedForceHome(async path => {
  const original = JSON.stringify(cfg()); writeFileSync(path, original); chmodSync(path, 0);
  try {
    const live = cfg(); const before = structuredClone(live);
    const ctx = context(live, { force: null }); delete ctx.deps.saveConfigPreservingClaudeCode;
    expect((await handleSubagentModelRoutes(ctx, apply))?.status).toBe(409);
    expect(live).toEqual(before);
  } finally { chmodSync(path, 0o600); }
  expect(readFileSync(path, "utf8")).toBe(original);
}));

test("first-run mixed force and roster writes persist together", () => isolatedForceHome(async path => {
  const live = loadConfig();
  const ctx = context(live, { force: "combo/tev-auto", models: ["retained/model"], pickerOrder: null });
  delete ctx.deps.saveConfigPreservingClaudeCode;
  expect((await handleSubagentModelRoutes(ctx, apply))?.status).toBe(200);
  const saved = JSON.parse(readFileSync(path, "utf8"));
  expect(saved.claudeCode.subagentModelForce).toBe("combo/tev-auto");
  expect(saved.subagentModels).toEqual(["retained/model"]);
  expect(saved.modelPickerOrder).toBeUndefined();
  expect(ctx.convergeCodexCatalog).toHaveBeenCalledTimes(1);
}));

for (const publication of ["not-published", "published", "uncertain"] as const) {
  test(`initial publication ${publication} error honors the durable rollback boundary`, async () => {
    const live = cfg(); const before = structuredClone(live);
    const ctx = context(live, { force: null });
    ctx.deps.saveConfigPreservingClaudeCode = () => { throw new InitialConfigPublicationError(publication, false, false); };
    await expect(handleSubagentModelRoutes(ctx, apply)).rejects.toBeInstanceOf(InitialConfigPublicationError);
    if (publication === "not-published") expect(live).toEqual(before);
    else expect(live.claudeCode?.subagentModelForce).toBeUndefined();
  });
}

test("existing-file published write error does not restore only live force state", async () => {
  const live = cfg(); const ctx = context(live, { force: null });
  ctx.deps.saveConfigPreservingClaudeCode = () => { throw new ConfigWritePublishedError(new Error("fixture post-publication")); };
  await expect(handleSubagentModelRoutes(ctx, apply)).rejects.toBeInstanceOf(ConfigWritePublishedError);
  expect(live.claudeCode?.subagentModelForce).toBeUndefined();
});


test("force API keeps genuine marked catalog entries and ordinary unmarked writes", async () => {
  for (const force of ["combo/tev-auto", "kimi/k3[1m]"]) {
    const live = cfg(); const ctx = context(live, { force });
    ctx.deps.fetchAllModels = async () => [{ provider: "combo", id: "tev-auto" }, { provider: "kimi", id: "k3[1m]", contextWindow: 262144 }];
    expect((await handleSubagentModelRoutes(ctx, apply))?.status).toBe(200);
    expect(live.claudeCode?.subagentModelForce).toBe(force);
  }
});
