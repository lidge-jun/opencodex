import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchQoderModels, QODER_MODEL_DISCOVERY_TIMEOUT_MS, setFetchQoderModelsForTests, setQoderDiscoveryRequestBudgetForTests,
} from "../../src/adapters/qoder/live-models";
import { clearQoderBinaryCache, QODER_GLOBAL_PROFILE } from "../../src/adapters/qoder/profiles";
import { fetchProviderModels } from "../../src/codex/catalog/provider-fetch";
import { clearModelCache, providerCacheGenerations } from "../../src/codex/model-cache";
import type { OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// #8115: `qoder --list-models` took 14.5 s on a working install, past the former 8 s bound.
beforeEach(() => clearQoderBinaryCache());
afterEach(() => {
  clearQoderBinaryCache();
  setFetchQoderModelsForTests(null);
  setQoderDiscoveryRequestBudgetForTests(null);
  clearModelCache("qoder-slow");
  providerCacheGenerations.delete("qoder-slow");
});

const roster = { stdout: "MODEL\nQwen3.8-Max\n", stderr: "" };

describe("qoder discovery timeout (#8115)", () => {
  test("the default bound admits a listing slower than the former 8 s limit", async () => {
    expect(QODER_MODEL_DISCOVERY_TIMEOUT_MS).toBe(30_000);
    let timeout: number | undefined;
    const result = await fetchQoderModels(QODER_GLOBAL_PROFILE, "pat", {
      which: () => "/bin/qoder",
      exec: async (_command, _args, options) => { timeout = (options as { timeout?: number }).timeout; return roster; },
    });
    expect(result).toEqual({ ok: true, models: ["Qwen3.8-Max"] });
    expect(timeout).toBe(30_000);
  });

  test("an explicit timeout is passed through unchanged", async () => {
    let timeout: number | undefined;
    await fetchQoderModels(QODER_GLOBAL_PROFILE, "pat", {
      which: () => "/bin/qoder", timeoutMs: 1_234,
      exec: async (_command, _args, options) => { timeout = (options as { timeout?: number }).timeout; return roster; },
    });
    expect(timeout).toBe(1_234);
  });

  test.each([
    ["killed", Object.assign(new Error("terminated"), { killed: true })],
    ["ETIMEDOUT", Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })],
  ])("a %s child still reports a timeout", async (_label, failure) => {
    const result = await fetchQoderModels(QODER_GLOBAL_PROFILE, "pat", {
      which: () => "/bin/qoder", exec: async () => { throw failure; },
    });
    expect(result).toEqual({ ok: false, error: "timeout", detail: "Qoder model discovery timed out" });
  });

  test.skipIf(process.platform === "win32")("a real child that outlives its bound is killed and reported as a timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-qoder-timeout-"));
    try {
      const binary = join(dir, "qoder");
      writeFileSync(binary, "#!/bin/sh\nsleep 30\necho MODEL\n");
      chmodSync(binary, 0o755);
      const result = await fetchQoderModels(QODER_GLOBAL_PROFILE, "pat", { which: () => binary, timeoutMs: 200 });
      expect(result).toMatchObject({ ok: false, error: "timeout" });
    } finally { removeTreeWithRetry(dir); }
  }, 20_000);
});

describe("qoder catalog requests do not wait for a slow CLI (#8115)", () => {
  const provider = { adapter: "qoder", baseUrl: "https://qoder.com", apiKey: "pat", authMode: "key", liveModels: true, models: ["Static-Model"] } as OcxProviderConfig;
  const slowRoster = () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    setFetchQoderModelsForTests(async () => { calls += 1; await gate; return { ok: true, models: ["Account-Model"] }; });
    return { calls: () => calls, release };
  };

  test("a request past its budget answers from the static catalog and the run still fills the cache", async () => {
    setQoderDiscoveryRequestBudgetForTests(20);
    const cli = slowRoster();
    const first = await fetchProviderModels("qoder-slow", provider, 60_000);
    expect(first.map(model => model.id)).toEqual(["Static-Model"]);
    cli.release();
    await Bun.sleep(20);
    const second = await fetchProviderModels("qoder-slow", provider, 60_000);
    expect(second.map(model => model.id)).toEqual(["Account-Model"]);
    expect(cli.calls()).toBe(1);
  });

  test("concurrent requests share one CLI run", async () => {
    setQoderDiscoveryRequestBudgetForTests(5_000);
    const cli = slowRoster();
    const both = Promise.all([fetchProviderModels("qoder-slow", provider, 60_000), fetchProviderModels("qoder-slow", provider, 60_000)]);
    await Bun.sleep(20);
    cli.release();
    const [a, b] = await both;
    expect(a.map(model => model.id)).toEqual(["Account-Model"]);
    expect(b.map(model => model.id)).toEqual(["Account-Model"]);
    expect(cli.calls()).toBe(1);
  });
});

