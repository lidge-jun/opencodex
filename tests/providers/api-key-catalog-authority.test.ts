import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { saveConfig } from "../../src/config";
import { clearModelCache, captureModelCacheGeneration, getStaleCached, setCached } from "../../src/codex/model-cache";
import { commitProviderApiKeySelection } from "../../src/providers/api-key-selection";
import { knownModelIdsForProvider, routeModel } from "../../src/router";
import { saveCredential, getAuthStorePath } from "../../src/oauth/store";
import { setProviderKeychainEntryFactoryForTests } from "../../src/providers/key-store";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";

let home: TempHome;
beforeEach(() => { home = createTempHome("ocx-catalog-authority-"); clearModelCache(); });
afterEach(() => { clearModelCache(); setProviderKeychainEntryFactoryForTests(null); home.remove(); });
const identity = (token: string) => createHash("sha256").update(token).digest("hex");
function cache(provider: string, key: string, model = "claude-opus-5-private") {
  setCached(provider, [{ provider, id: model }], Date.now(), captureModelCacheGeneration(provider), identity(key));
}
function config(): OcxConfig {
  return { port: 0, defaultProvider: "work-cursor", defaultModelAliases: true, providers: {
    "work-cursor": { adapter: "cursor", baseUrl: "https://api2.cursor.sh", authMode: "key", apiKey: "key-a", models: [] },
  } } as unknown as OcxConfig;
}

test("committed automatic key selection retires aliases and in-flight catalog authority", () => {
  const current = config(); saveConfig(current);
  cache("work-cursor", "key-a");
  expect(routeModel(current, "work-cursor/opus").modelId).toBe("claude-opus-5-private");
  const flight = captureModelCacheGeneration("work-cursor");
  const result = commitProviderApiKeySelection(current, "work-cursor", provider => {
    provider.apiKey = "key-b"; return { changed: true, value: "rotated" };
  });
  expect(result.status).toBe("committed");
  expect(getStaleCached("work-cursor")).toBeNull();
  expect(setCached("work-cursor", [{ provider: "work-cursor", id: "late-a" }], Date.now(), flight, identity("key-a"))).toBe(false);
  expect(routeModel(current, "work-cursor/opus").modelId).not.toBe("claude-opus-5-private");
});

test("a changed or missing key cannot decode the previous credential's roster", () => {
  const provider = config().providers["work-cursor"]!;
  cache("work-cursor", "key-a");
  expect(knownModelIdsForProvider("work-cursor", provider)).toContain("claude-opus-5-private");
  expect(knownModelIdsForProvider("work-cursor", { ...provider, apiKey: "key-b" })).not.toContain("claude-opus-5-private");
  expect(knownModelIdsForProvider("work-cursor", { ...provider, apiKey: undefined })).not.toContain("claude-opus-5-private");
});

test("unscoped rows do not consult a keychain reference", () => {
  let reads = 0;
  setProviderKeychainEntryFactoryForTests(() => { reads += 1; throw new Error("unexpected keychain read"); });
  setCached("custom", [{ provider: "custom", id: "unscoped" }]);
  expect(knownModelIdsForProvider("custom", {
    adapter: "openai-chat", baseUrl: "https://example.invalid/v1", apiKey: "keychain:custom",
  })).toContain("unscoped");
  expect(reads).toBe(0);
});

test("OAuth scoped rows follow the passive active credential and never repair malformed storage", async () => {
  const provider: OcxProviderConfig = { adapter: "cursor", baseUrl: "https://api2.cursor.sh", authMode: "oauth" };
  await saveCredential("cursor", { access: "oauth-a", refresh: "refresh-a", expires: Date.now() + 3_600_000 });
  cache("cursor", "oauth-a", "private-oauth-model");
  const path = getAuthStorePath();
  const bytes = readFileSync(path, "utf8");
  expect(knownModelIdsForProvider("cursor", provider)).toContain("private-oauth-model");
  expect(readFileSync(path, "utf8")).toBe(bytes);
  writeFileSync(path, bytes.replaceAll("oauth-a", "oauth-b"));
  expect(knownModelIdsForProvider("cursor", provider)).not.toContain("private-oauth-model");
  writeFileSync(path, "{malformed");
  expect(knownModelIdsForProvider("cursor", provider)).not.toContain("private-oauth-model");
  expect(readFileSync(path, "utf8")).toBe("{malformed");
});

test("a usable key override takes precedence over the stored OAuth credential", async () => {
  const provider: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "key", apiKey: "key-override" };
  await saveCredential("xai", { access: "oauth-a", refresh: "refresh-a", expires: Date.now() + 3_600_000 });
  cache("xai", "oauth-a", "oauth-only-model");
  expect(knownModelIdsForProvider("xai", provider)).not.toContain("oauth-only-model");
  cache("xai", "key-override", "key-only-model");
  expect(knownModelIdsForProvider("xai", provider)).toContain("key-only-model");
});
