import { describe, expect, mock, spyOn, test } from "bun:test";
import type { OcxConfig } from "../src/types";
import { scheduleCatalogPrewarm } from "../src/cli/catalog-prewarm";

const root = new URL("../", import.meta.url);

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

describe("catalog prewarm on handleStart bind", () => {
  test("scheduleCatalogPrewarm calls gatherRoutedModels(loadConfig()) once", async () => {
    const config = { port: 9_001, providers: {}, defaultProvider: "fixture" } as OcxConfig;
    const gatherRoutedModels = mock(async (_config: OcxConfig) => []);
    const load = mock(() => config);
    const importCatalog = mock(async () => ({ gatherRoutedModels }));

    scheduleCatalogPrewarm({ loadConfig: load, importCatalog });

    await Bun.sleep(0);
    expect(importCatalog).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(gatherRoutedModels).toHaveBeenCalledTimes(1);
    expect(gatherRoutedModels.mock.calls[0]?.[0]).toBe(config);
  });

  test("scheduleCatalogPrewarm swallows gather failures", async () => {
    const gatherRoutedModels = mock(async () => {
      throw new Error("discovery failed");
    });
    scheduleCatalogPrewarm({
      loadConfig: () => ({ port: 9_002, providers: {}, defaultProvider: "fixture" }) as OcxConfig,
      importCatalog: async () => ({ gatherRoutedModels }),
    });
    await Bun.sleep(0);
    expect(gatherRoutedModels).toHaveBeenCalledTimes(1);
  });

  test("catalog busy maps startup prewarm to warn-skip", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      scheduleCatalogPrewarm({
        loadConfig: () => ({ port: 9_003, providers: {}, defaultProvider: "fixture" }) as OcxConfig,
        importCatalog: async () => ({ gatherRoutedModels: async () => { throw Object.assign(new Error("busy"), { code: "catalog_busy" }); } }),
      });
      await Bun.sleep(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("skipped");
    } finally {
      warn.mockRestore();
    }
  });

  test("handleStart schedules catalog prewarm immediately after a successful bind", async () => {
    const cli = (await readText("src/cli/index.ts")).replace(/\r\n/g, "\n");
    const bindIdx = cli.indexOf("server = startServer(port");
    const prewarmIdx = cli.indexOf("scheduleCatalogPrewarm()");
    const breakIdx = cli.indexOf("\n      break;", bindIdx);

    expect(cli).toContain('from "./catalog-prewarm"');
    expect(bindIdx).toBeGreaterThan(-1);
    expect(prewarmIdx).toBeGreaterThan(bindIdx);
    expect(breakIdx).toBeGreaterThan(prewarmIdx);
    // Must stay inside the successful-bind try path, not only on a later sync.
    expect(cli.slice(bindIdx, breakIdx)).toContain("scheduleCatalogPrewarm()");
    expect(cli).not.toContain('void import("../codex/catalog").then(({ gatherRoutedModels })');
  });
});
