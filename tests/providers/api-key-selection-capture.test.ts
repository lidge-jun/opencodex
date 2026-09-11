import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { captureProviderApiKeySelection } from "../../src/providers/api-key-selection-capture";
import { captureProviderApiKeySelection as legacyCapture } from "../../src/providers/api-key-selection";
import type { OcxProviderConfig } from "../../src/types";
import { repoPath } from "../helpers/repo-root";

describe("API-key selection snapshot", () => {
  const base: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://example.test/v1" };

  test("captures the selected entry and revision without resolving its reference", () => {
    const provider: OcxProviderConfig = {
      ...base,
      apiKey: "${OCX_CAPTURE_FIXTURE}",
      apiKeySelectionRevision: "revision-before",
      apiKeyPool: [
        { id: "other", key: "keychain:other" },
        { id: "selected", key: "${OCX_CAPTURE_FIXTURE}" },
      ],
    };
    const before = structuredClone(provider);
    const snapshot = captureProviderApiKeySelection(provider);
    expect(snapshot).toEqual({ entryId: "selected", reference: "${OCX_CAPTURE_FIXTURE}", revision: "revision-before" });
    expect(provider).toEqual(before);
    provider.apiKey = "keychain:other";
    provider.apiKeySelectionRevision = "revision-after";
    provider.apiKeyPool![1]!.id = "changed";
    expect(snapshot).toEqual({ entryId: "selected", reference: "${OCX_CAPTURE_FIXTURE}", revision: "revision-before" });
  });

  test("retains an unmatched reference and absent optional fields", () => {
    expect(captureProviderApiKeySelection(base)).toEqual({ entryId: undefined, reference: undefined, revision: undefined });
    expect(captureProviderApiKeySelection({ ...base, apiKey: "keychain:unpooled", apiKeyPool: [] })).toEqual({
      entryId: undefined, reference: "keychain:unpooled", revision: undefined,
    });
  });

  test("preserves first-match semantics when a pool repeats the same reference", () => {
    expect(captureProviderApiKeySelection({
      ...base,
      apiKey: "keychain:shared",
      apiKeyPool: [{ id: "first", key: "keychain:shared" }, { id: "second", key: "keychain:shared" }],
    })).toEqual({ entryId: "first", reference: "keychain:shared", revision: undefined });
  });

  test("preserves the existing export", () => {
    expect(legacyCapture).toBe(captureProviderApiKeySelection);
  });
});

describe("selection capture dependency boundary", () => {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const runtimeImports = (source: string) => transpiler.scanImports(transpiler.transformSync(source)).map(entry => entry.path);

  test("the leaf has no runtime imports", () => {
    expect(runtimeImports(readFileSync(repoPath("src/providers/api-key-selection-capture.ts"), "utf8"))).toEqual([]);
  });

  test("the router consumes capture without a direct import of the stateful selection module", () => {
    const imports = runtimeImports(readFileSync(repoPath("src/router.ts"), "utf8"));
    expect(imports).toContain("./providers/api-key-selection-capture");
    expect(imports).not.toContain("./providers/api-key-selection");
  });

  test("the boundary scanner distinguishes erased types from a runtime dependency", () => {
    expect(runtimeImports('import type { T } from "../router"; export const value = 1;')).toEqual([]);
    expect(runtimeImports('import "../router"; export const value = 1;')).toEqual(["../router"]);
  });
});
