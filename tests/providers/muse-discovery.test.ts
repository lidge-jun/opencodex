import { describe, expect, test } from "bun:test";
import { parseMuseCatalog } from "../../src/adapters/muse-msp/discovery";
import { applyCatalogModelMetadata } from "../../src/codex/catalog/effort";
import { getProviderRegistryEntry } from "../../src/providers/registry";

describe("Muse dynamic catalog", () => {
  test("projects each actual model and its own context to Codex", () => {
    const rows = parseMuseCatalog({models:[
      {modelId:"model-a", displayLabel:"model-a", contextLimit:100000, outputLimit:8000},
      {modelId:"model-b", contextLimit:250000, outputLimit:16000},
    ]});
    const entries = rows.map(row => {
      const entry: Record<string, unknown> = {display_name:`muse-code/${row.id}`};
      applyCatalogModelMetadata(entry, {...row, provider:"muse-code"});
      return entry;
    });
    expect(entries.map(entry=>entry.context_window)).toEqual([100000,250000]);
    expect(entries.map(entry=>entry.display_name)).toEqual(["muse-code/model-a","muse-code/model-b"]);
    expect(rows.map(row=>row.maxOutputTokens)).toEqual([8000,16000]);
  });
  test("rejects invalid catalogs and never seeds a fixed model", () => {
    expect(() => parseMuseCatalog({models:[{modelId:"a",contextLimit:10,outputLimit:20}]})).toThrow();
    expect(() => parseMuseCatalog({models:[{modelId:"../unsafe",contextLimit:10,outputLimit:5}]})).toThrow();
    expect(parseMuseCatalog({models:[]})).toEqual([]);
    const preset = getProviderRegistryEntry("muse-code")!;
    expect(preset.models ?? []).toEqual([]);
    expect(preset.defaultModel).toBeUndefined();
  });
  test("derives contributor choices from the discovered Spark roster", () => {
    const rows=parseMuseCatalog({models:[{modelId:"muse-spark-9.8",contextLimit:10000,outputLimit:1000},
      {modelId:"other-model",contextLimit:20000,outputLimit:2000}]});
    expect(rows.map(row=>row.id)).toEqual(["muse-spark-9.8","other-model","muse-spark-9.8-contributor"]);
    expect(rows[2]).toMatchObject({ contextWindow: rows[0]!.contextWindow, maxOutputTokens: rows[0]!.maxOutputTokens });
  });
  test("preserves explicit Contributor metadata if a future CLI reports it", () => {
    const rows = parseMuseCatalog({ models: [
      { modelId: "muse-spark-9.8", contextLimit: 10000, outputLimit: 1000 },
      { modelId: "muse-spark-9.8-contributor", contextLimit: 20000, outputLimit: 2000 },
    ] });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ id: "muse-spark-9.8-contributor", contextWindow: 20000, maxOutputTokens: 2000 });
  });
});
