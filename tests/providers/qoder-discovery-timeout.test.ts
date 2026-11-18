import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearQoderDiscoveryFlightsForTests, discoverQoderModels, fetchQoderModels, qoderDiscoveryFlightCountForTests, QODER_DISCOVERY_REUSE_MS,
  QODER_INTERACTIVE_DEADLINE_MS, QODER_MODEL_DISCOVERY_TIMEOUT_MS, setFetchQoderModelsForTests, type QoderModelsResult,
} from "../../src/adapters/qoder/live-models";
import { clearQoderBinaryCache, QODER_GLOBAL_PROFILE } from "../../src/adapters/qoder/profiles";
import { collectDefaultModelExposure } from "../../src/cli/doctor";
import { fetchProviderModels } from "../../src/codex/catalog/provider-fetch";
import { clearGatherRoutedModelsInflight, gatherRoutedModels } from "../../src/codex/catalog/routed-gather";
import { clearModelCache, getProviderDiscoveryStatus, providerCacheGenerations } from "../../src/codex/model-cache";
import { probeQoderProvider } from "../../src/server/management/qoder-provider-probe";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// #8115: qoder --list-models took 14.5 s on a working install, past the former 8 s bound.
const NAME = "qoder-slow";
const provider = { adapter: "qoder", baseUrl: "https://qoder.com", apiKey: "pat", authMode: "key", liveModels: true, models: ["Static-Model"] } as OcxProviderConfig;
const roster = { stdout: "MODEL\nQwen3.8-Max\n", stderr: "" };

beforeEach(() => { clearQoderBinaryCache(); clearQoderDiscoveryFlightsForTests(); });
afterEach(() => {
  clearQoderBinaryCache();
  clearQoderDiscoveryFlightsForTests();
  setFetchQoderModelsForTests(null);
  clearModelCache(NAME);
  providerCacheGenerations.delete(NAME);
});

/** A CLI stand-in that answers only when released, counting its runs. */
function gatedCli(results: QoderModelsResult[] = [{ ok: true, models: ["Account-Model"] }]) {
  let calls = 0;
  const releases: (() => void)[] = [];
  setFetchQoderModelsForTests(async () => {
    const result = results[Math.min(calls, results.length - 1)]!;
    calls += 1;
    await new Promise<void>(resolve => releases.push(resolve));
    return result;
  });
  return {
    calls: () => calls,
    release: async () => { while (releases.length === 0) await Bun.sleep(1); releases.shift()!(); await Bun.sleep(5); },
  };
}

describe("qoder discovery bound (#8115)", () => {
  test("background discovery passes the 30 s bound to the CLI", async () => {
    expect(QODER_MODEL_DISCOVERY_TIMEOUT_MS).toBe(30_000);
    expect(QODER_INTERACTIVE_DEADLINE_MS).toBe(8_000);
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

describe("shared qoder discovery flight (#8115)", () => {
  test("concurrent callers for one PAT share one CLI run; another PAT gets its own", async () => {
    const cli = gatedCli();
    const a = discoverQoderModels(QODER_GLOBAL_PROFILE, "pat", "scope");
    const b = discoverQoderModels(QODER_GLOBAL_PROFILE, "pat", "scope");
    const other = discoverQoderModels(QODER_GLOBAL_PROFILE, "other-pat", "scope");
    await cli.release(); await cli.release();
    expect(await a).toEqual({ ok: true, models: ["Account-Model"] });
    expect(await b).toBe(await a);
    await other;
    expect(cli.calls()).toBe(2);
  });

  test("a success is reused only within the reuse window, and a failure is not reused", async () => {
    const cli = gatedCli([{ ok: false, error: "timeout" }, { ok: true, models: ["Account-Model"] }]);
    const failed = discoverQoderModels(QODER_GLOBAL_PROFILE, "pat", "scope");
    await cli.release();
    expect((await failed).ok).toBe(false);
    const ok = discoverQoderModels(QODER_GLOBAL_PROFILE, "pat", "scope");
    await cli.release();
    expect((await ok).ok).toBe(true);
    expect(cli.calls()).toBe(2);
    expect(await discoverQoderModels(QODER_GLOBAL_PROFILE, "pat", "scope")).toBe(await ok);
    expect(cli.calls()).toBe(2);
    const later = discoverQoderModels(QODER_GLOBAL_PROFILE, "pat", "scope", Date.now() + QODER_DISCOVERY_REUSE_MS + 1);
    await cli.release();
    await later;
    expect(cli.calls()).toBe(3);
  });

  test("the catalog gather waits for a slow run instead of degrading", async () => {
    const cli = gatedCli();
    const gathered = fetchProviderModels(NAME, provider, 60_000);
    await Bun.sleep(30);
    await cli.release();
    expect((await gathered).map(model => model.id)).toEqual(["Account-Model"]);
    expect(getProviderDiscoveryStatus(NAME)).toEqual({ status: "ok" });
  });
});

describe("qoder connection test (#8115)", () => {
  const read = async (response: Response) => await response.json() as Record<string, unknown>;

  test("past its deadline the test reports still discovering, and a late success re-syncs the catalog without a second run", async () => {
    // Earlier state: a success, then a failed refresh, so the gather is inside its failure cooldown.
    setFetchQoderModelsForTests(async () => ({ ok: true, models: ["Old-Model"] }));
    expect((await fetchProviderModels(NAME, provider, 0)).map(model => model.id)).toEqual(["Old-Model"]);
    clearQoderDiscoveryFlightsForTests();
    setFetchQoderModelsForTests(async () => ({ ok: false, error: "timeout" }));
    await fetchProviderModels(NAME, provider, 0);
    expect(getProviderDiscoveryStatus(NAME)).toMatchObject({ status: "failed" });

    const cli = gatedCli();
    let resyncs = 0;
    let resynced: Promise<string[]> | undefined;
    const response = await probeQoderProvider(NAME, provider, "pat", async () => {
      resyncs += 1;
      resynced = fetchProviderModels(NAME, provider, 0).then(models => models.map(model => model.id));
      await resynced;
      return { status: "committed" };
    }, { deadlineMs: 20 });
    expect(await read(response)).toMatchObject({ ok: true, discovering: true });
    expect(resyncs).toBe(0);
    await cli.release();
    expect(resyncs).toBe(1);
    expect(await resynced).toEqual(["Account-Model"]);
    expect(cli.calls()).toBe(1);
    expect(getProviderDiscoveryStatus(NAME)).toEqual({ status: "ok" });
  });

  test("a late success replaces a roster that is still fresh in the cache", async () => {
    setFetchQoderModelsForTests(async () => ({ ok: true, models: ["Old-Model"] }));
    expect((await fetchProviderModels(NAME, provider, 60_000)).map(model => model.id)).toEqual(["Old-Model"]);
    clearQoderDiscoveryFlightsForTests();
    const cli = gatedCli();
    let resynced: Promise<string[]> | undefined;
    const response = await probeQoderProvider(NAME, provider, "pat", async () => {
      resynced = fetchProviderModels(NAME, provider, 60_000).then(models => models.map(model => model.id));
      await resynced;
      return { status: "committed" };
    }, { deadlineMs: 20 });
    expect(await read(response)).toMatchObject({ ok: true, discovering: true });
    await cli.release();
    expect(await resynced).toEqual(["Account-Model"]);
    expect(cli.calls()).toBe(1);
  });

  test("a cache invalidation revokes a run in flight: no join, no late re-sync", async () => {
    const cli = gatedCli([{ ok: true, models: ["Previous-Account"] }, { ok: true, models: ["Current-Account"] }]);
    let resyncs = 0;
    const response = await probeQoderProvider(NAME, provider, "pat", async () => { resyncs += 1; return { status: "committed" }; }, { deadlineMs: 20 });
    expect(await read(response)).toMatchObject({ ok: true, discovering: true });
    clearModelCache(NAME);
    const gathered = fetchProviderModels(NAME, provider, 60_000);
    await cli.release();
    await cli.release();
    expect((await gathered).map(model => model.id)).toEqual(["Current-Account"]);
    expect(cli.calls()).toBe(2);
    expect(resyncs).toBe(0);
  });

  test("a cache invalidation after a success stops its reuse", async () => {
    const cli = gatedCli([{ ok: true, models: ["Before"] }, { ok: true, models: ["After"] }]);
    const first = fetchProviderModels(NAME, provider, 60_000);
    await cli.release();
    expect((await first).map(model => model.id)).toEqual(["Before"]);
    clearModelCache(NAME);
    const second = fetchProviderModels(NAME, provider, 60_000);
    await cli.release();
    expect((await second).map(model => model.id)).toEqual(["After"]);
    expect(cli.calls()).toBe(2);
  });

  test("a run that fails after the deadline does not re-sync", async () => {
    const cli = gatedCli([{ ok: false, error: "auth" }]);
    let resyncs = 0;
    const response = await probeQoderProvider(NAME, provider, "pat", async () => { resyncs += 1; return { status: "committed" }; }, { deadlineMs: 20 });
    expect(await read(response)).toMatchObject({ ok: true, discovering: true });
    await cli.release();
    expect(resyncs).toBe(0);
  });

  test("a run inside the deadline reports its result as before", async () => {
    setFetchQoderModelsForTests(async () => ({ ok: true, models: ["A", "B"] }));
    expect(await read(await probeQoderProvider(NAME, provider, "pat", async () => ({ status: "committed" }), { deadlineMs: 1_000 })))
      .toMatchObject({ ok: true, models: 2, message: "Connected. 2 models." });
    clearQoderDiscoveryFlightsForTests();
    setFetchQoderModelsForTests(async () => ({ ok: false, error: "cli_not_found", detail: "install it" }));
    expect(await read(await probeQoderProvider(NAME, provider, "pat", async () => ({ status: "committed" }), { deadlineMs: 1_000 })))
      .toMatchObject({ ok: false, error: "qoder discovery cli_not_found: install it" });
  });
});

describe("doctor exposure read past its deadline (#8115)", () => {
  test("says the proxy was still gathering instead of implying a failed check", async () => {
    const result = await collectDefaultModelExposure({
      readConfiguredModelFn: () => "gpt-5.6-sol",
      live: { pid: 4321, port: 10100, source: "config" } as never,
      fetchFn: (async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); }) as unknown as typeof fetch,
      readCatalogModelsFn: () => [{ slug: "gpt-5.6-sol", visibility: "list" }],
    });
    expect(result.status).toBe("exposed");
    expect(result.source).toBe("catalog");
    expect(result.detail).toContain("still gathering its model list after 8 s");
  });
});

describe("shared flight retention (#8115)", () => {
  test("successes under revoked generations or other PATs do not accumulate", async () => {
    setFetchQoderModelsForTests(async () => ({ ok: true, models: ["M"] }));
    for (let generation = 0; generation < 5; generation += 1) {
      await discoverQoderModels(QODER_GLOBAL_PROFILE, "pat-" + generation, "scope\0" + generation);
    }
    expect(qoderDiscoveryFlightCountForTests()).toBe(5);
    // Any later call past the reuse window sweeps every expired success, not only its own key.
    await discoverQoderModels(QODER_GLOBAL_PROFILE, "fresh", "scope\0new", Date.now() + QODER_DISCOVERY_REUSE_MS + 1);
    expect(qoderDiscoveryFlightCountForTests()).toBe(1);
  });
});

describe("late re-sync publication (#8115)", () => {
  const SECOND = "qoder-second";
  const config = {
    port: 10100,
    defaultProvider: NAME,
    providers: { [NAME]: provider, [SECOND]: { ...provider, apiKey: "pat-second" } },
  } as unknown as OcxConfig;
  afterEach(() => { clearModelCache(SECOND); providerCacheGenerations.delete(SECOND); clearGatherRoutedModelsInflight(); });

  test("a gather another provider holds open since before the eviction is not reused", async () => {
    const gates = new Map<string, () => void>();
    const roster: Record<string, string[]> = { pat: ["Old-Model"], "pat-second": ["Second-Model"] };
    let gated = false;
    setFetchQoderModelsForTests(async (_profile, apiKey) => {
      if (gated) await new Promise<void>(resolve => gates.set(apiKey, resolve));
      return { ok: true, models: roster[apiKey]! };
    });
    expect((await fetchProviderModels(NAME, provider, 60_000)).map(model => model.id)).toEqual(["Old-Model"]);
    clearQoderDiscoveryFlightsForTests();
    gated = true;
    roster.pat = ["Account-Model"];
    // The aggregate gather reads the fresh cached roster for NAME and waits on the second provider.
    const held = gatherRoutedModels(config);
    while (!gates.has("pat-second")) await Bun.sleep(1);
    const published: string[][] = [];
    const response = await probeQoderProvider(NAME, provider, "pat", async () => {
      const rows = await gatherRoutedModels(config);
      published.push(rows.filter(row => row.provider === NAME).map(row => row.id));
      return { status: "committed" };
    }, { deadlineMs: 20 });
    expect((await response.json() as { discovering?: boolean }).discovering).toBe(true);
    while (!gates.has("pat")) await Bun.sleep(1);
    gates.get("pat")!();
    await Bun.sleep(20);
    gates.get("pat-second")!();
    await held;
    const until = Date.now() + 5_000;
    while (published.length === 0 && Date.now() < until) await Bun.sleep(5);
    expect(published).toEqual([["Account-Model"]]);
  });

  test("a busy convergence is retried while the generation is current", async () => {
    setFetchQoderModelsForTests(async () => { await Bun.sleep(40); return { ok: true, models: ["Account-Model"] }; });
    const outcomes = [{ status: "skipped", reason: "busy", retryable: true }, { status: "committed" }];
    let attempts = 0;
    let clears = 0;
    const sleeps: number[] = [];
    await probeQoderProvider(NAME, provider, "pat", async () => outcomes[attempts++], {
      deadlineMs: 5, sleep: async ms => { sleeps.push(ms); }, clearGatherInflight: () => { clears += 1; },
    });
    const until = Date.now() + 5_000;
    while (attempts < 2 && Date.now() < until) await Bun.sleep(5);
    await Bun.sleep(20);
    expect(attempts).toBe(2);
    expect(clears).toBe(2);
    expect(sleeps).toEqual([2_000]);
  });

  test("no re-sync runs once the cache generation was invalidated", async () => {
    setFetchQoderModelsForTests(async () => { await Bun.sleep(40); return { ok: true, models: ["Account-Model"] }; });
    let attempts = 0;
    await probeQoderProvider(NAME, provider, "pat", async () => { attempts += 1; return { status: "committed" }; }, { deadlineMs: 5 });
    clearModelCache(NAME);
    await Bun.sleep(80);
    expect(attempts).toBe(0);
  });
});

describe("late result publication keeps the retained roster (#8115)", () => {
  test("a re-sync that never publishes leaves the previous roster as the fallback", async () => {
    setFetchQoderModelsForTests(async () => ({ ok: true, models: ["Old-Model"] }));
    expect((await fetchProviderModels(NAME, provider, 60_000)).map(model => model.id)).toEqual(["Old-Model"]);
    clearQoderDiscoveryFlightsForTests();
    setFetchQoderModelsForTests(async () => { await Bun.sleep(40); return { ok: true, models: ["Account-Model"] }; });
    let attempts = 0;
    await probeQoderProvider(NAME, provider, "pat", async () => { attempts += 1; return { status: "failed", retryable: false }; }, { deadlineMs: 5 });
    const until = Date.now() + 5_000;
    while (attempts === 0 && Date.now() < until) await Bun.sleep(5);
    expect(attempts).toBe(1);
    // The unpublished run expires; a later discovery fails and degrades to the retained roster.
    clearQoderDiscoveryFlightsForTests();
    setFetchQoderModelsForTests(async () => ({ ok: false, error: "timeout" }));
    expect((await fetchProviderModels(NAME, provider, 0)).map(model => model.id)).toEqual(["Old-Model"]);
  });

  test("once a gather stores the run, later gathers use the cache again", async () => {
    let runs = 0;
    setFetchQoderModelsForTests(async () => { runs += 1; return { ok: true, models: ["Account-Model"] }; });
    await fetchProviderModels(NAME, provider, 60_000);
    const revision = (await import("../../src/codex/model-cache")).observeModelCacheRevision(NAME);
    await fetchProviderModels(NAME, provider, 60_000);
    expect((await import("../../src/codex/model-cache")).observeModelCacheRevision(NAME)).toBe(revision);
    expect(runs).toBe(1);
  });
});
