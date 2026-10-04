import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { handleModels, type ModelsCommandDeps } from "../../src/cli/models";
import type { CodexSyncResult } from "../../src/codex/sync";
import type { LiveProxy } from "../../src/server/proxy-liveness";
import { createTempHome, type TempHome } from "../helpers/temp-home";

let home: TempHome, output: ReturnType<typeof spyOn>, errors: ReturnType<typeof spyOn>;
let priorExit: typeof process.exitCode;
beforeEach(() => {
  home = createTempHome("ocx-model-local-result-");
  priorExit = process.exitCode; process.exitCode = 0;
  writeFileSync(home.path("config.json"), JSON.stringify({ port: 19223, defaultProvider: "fixture",
    providers: { fixture: { adapter: "openai-chat", baseUrl: "https://fixture.example.test/v1", authMode: "local" } } }));
  output = spyOn(console, "log").mockImplementation(() => {});
  errors = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { output.mockRestore(); errors.mockRestore(); process.exitCode = priorExit ?? 0; home.remove(); });
const text = () => output.mock.calls.flat().join("\n");
const config = () => JSON.parse(readFileSync(home.path("config.json"), "utf8"));
const stopped: ModelsCommandDeps = { findLiveProxy: async () => null };
function result(status: CodexSyncResult["status"], ok: boolean, exists = true, refreshOutcome?: "committed" | "refused"): CodexSyncResult {
  return { status, ok, catalogExists: exists, catalogWritten: false, cacheSynced: false,
    added: 0, catalogPath: null, message: "fixture-private-warning", refreshOutcome };
}

describe("local custom model JSON and opportunistic synchronization", () => {
  test("a stopped proxy keeps local add/remove successful and pending", async () => {
    await handleModels(["add", "fixture", "raw/model", "--reasoning-efforts", "", "--json"], stopped);
    expect(process.exitCode ?? 0).toBe(0);
    const added = JSON.parse(text());
    expect(added).toMatchObject({ action: "added", needsSync: true, sync: { status: "not-attempted", ok: false } });
    expect(added.model.reasoningEfforts).toEqual([]);
    expect(config().customModels[0].id).toBe(added.model.id);
    output.mockClear();
    await handleModels(["remove", added.model.id, "--yes", "--json"], stopped);
    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(text())).toMatchObject({ action: "removed", needsSync: true, model: { id: added.model.id } });
    expect(config().customModels ?? []).toEqual([]);
  });
  test.each([
    { backend: result("applied", true), code: 0, needsSync: false },
    { backend: result("applied", true, false), code: 1, needsSync: true },
    { backend: result("applied", true, true, "refused"), code: 1, needsSync: true },
    { backend: result("catalog-only", true), code: 0, needsSync: true },
    { backend: result("skipped", true, false), code: 0, needsSync: true },
    { backend: result("refused", false, false), code: 1, needsSync: true },
  ])("attempted sync uses safe config/catalog evidence", async ({ backend, code, needsSync }) => {
    let calls = 0;
    await handleModels(["add", "fixture", "new-model", "--json"], {
      findLiveProxy: async () => ({ port: 19223 } as LiveProxy),
      syncModels: async (port, saved, log) => {
        calls++; expect(port).toBe(19223); expect(log).toBeNull();
        expect(saved?.customModels?.[0].modelId).toBe("new-model"); return backend;
      },
    });
    expect(calls).toBe(1);
    expect(process.exitCode ?? 0).toBe(code);
    expect(JSON.parse(text()).needsSync).toBe(needsSync);
    expect(text()).not.toContain("fixture-private");
    expect(errors.mock.calls).toEqual([]);
  });
  test("throwing sync preserves the saved entry and no exception detail", async () => {
    await handleModels(["add", "fixture", "new-model", "--json"], {
      findLiveProxy: async () => ({ port: 19223 } as LiveProxy),
      syncModels: async () => { throw new Error("fixture-private-warning"); },
    });
    expect(process.exitCode).toBe(1);
    expect(config().customModels).toHaveLength(1);
    expect(JSON.parse(text()).sync).toEqual({ status: "failed", ok: false });
    expect(text()).not.toContain("fixture-private");
  });
  test("JSON removal refuses without --yes and cannot enter a prompt", async () => {
    const before = readFileSync(home.path("config.json"), "utf8");
    await handleModels(["remove", "fixture-id", "--json"], stopped);
    expect(process.exitCode).toBe(2); expect(text()).toBe("");
    expect(readFileSync(home.path("config.json"), "utf8")).toBe(before);
  });
  test("invalid live selection cannot fall through to a local writer", async () => {
    const before = readFileSync(home.path("config.json"), "utf8");
    for (const args of [["add", "fixture", "m", "--live", "--live"], ["list", "--live"], ["add", "fixture", "m", "--live=yes"]]) {
      await handleModels(args, stopped); expect(process.exitCode).toBe(2);
      expect(readFileSync(home.path("config.json"), "utf8")).toBe(before);
    }
  });
});
