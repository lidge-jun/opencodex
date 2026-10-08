import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { setActiveAccount } from "../../src/oauth/store";
import { observedModelsAuthResolver, fetchProviderModels } from "../../src/codex/catalog/provider-models";
import { captureModelCacheGeneration, clearModelCache, getFreshCached, setCached } from "../../src/codex/model-cache";
import type { CatalogGatherProviderAuthOutcome } from "../../src/codex/catalog/gather-capture";
import type { OcxProviderConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";
let home: TempHome;
beforeEach(() => { home = createTempHome("ocx-anthropic2-catalog-"); clearModelCache(); });
afterEach(() => { clearModelCache(); home.remove(); });
const b: OcxProviderConfig = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth", anthropicOAuthInstance: "anthropic2", models: ["claude-opus-5"], liveModels: false };
test("observed discovery resolves equal account IDs from the exact provider namespace", () => {
  const set = (access: string) => ({ activeAccountId: "same", accounts: [{ id: "same", credential: { access, refresh: "fixture-refresh", expires: 9999999999999 } }] });
  const outcomes: CatalogGatherProviderAuthOutcome[] = [];
  const resolver = observedModelsAuthResolver(Buffer.from(JSON.stringify({ anthropic: set("fixture-a"), anthropic2: set("fixture-b") })), outcomes);
  if (resolver.kind !== "observed") throw new Error("Expected observed resolver");
  expect(resolver.resolve("anthropic", { ...b, anthropicOAuthInstance: undefined }).apiKey).toBe("fixture-a");
  expect(resolver.resolve("anthropic2", b).apiKey).toBe("fixture-b");
  expect(outcomes).toEqual([{ provider: "anthropic", state: "available" }, { provider: "anthropic2", state: "available" }]);
});
test("unmarked and disabled B never borrow A's discovery bearer", () => {
  const bytes = Buffer.from(JSON.stringify({ anthropic: { activeAccountId: "same", accounts: [{ id: "same", credential: { access: "fixture-a", refresh: "fixture-r", expires: 9999999999999 } }] } }));
  const resolver = observedModelsAuthResolver(bytes, []);
  if (resolver.kind !== "observed") throw new Error("Expected observed resolver");
  for (const row of [b, { ...b, disabled: true }, { ...b, anthropicOAuthInstance: undefined }]) expect(resolver.resolve("anthropic2", row).apiKey).toBeUndefined();
});
test("static catalog keeps B provider identity and needs no credential resolution", async () => {
  const rows = await fetchProviderModels("anthropic2", b, 60_000);
  expect(rows.map(row => [row.provider, row.id])).toEqual([["anthropic2", "claude-opus-5"]]);
});
test("B invalidation rejects its stale publication without revoking A", () => {
  const aGeneration = captureModelCacheGeneration("anthropic");
  const bGeneration = captureModelCacheGeneration("anthropic2");
  const aRows = [{ provider: "anthropic", id: "a-only" }];
  expect(setCached("anthropic", aRows, Date.now(), aGeneration)).toBe(true);
  expect(setCached("anthropic2", [{ provider: "anthropic2", id: "b-only" }], Date.now(), bGeneration)).toBe(true);
  clearModelCache("anthropic2");
  expect(setCached("anthropic2", [{ provider: "anthropic2", id: "late-b" }], Date.now(), bGeneration)).toBe(false);
  expect(getFreshCached("anthropic", 60_000)).toEqual(aRows);
  expect(getFreshCached("anthropic2", 60_000)).toBeNull();
});

test("an account switch while discovery is pending cannot publish the old B roster", async () => {
  const account = (id: string) => ({ id, credential: { access: "fixture-" + id, refresh: "fixture-refresh-" + id, expires: 9999999999999 } });
  writeFileSync(home.path("auth.json"), JSON.stringify({ anthropic2: { activeAccountId: "old", accounts: [account("old"), account("new")] } }), { mode: 0o600 });
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const sent = new Promise<void>(resolve => { started = resolve; });
  const provider: OcxProviderConfig = { ...b, liveModels: true, models: [], fetch: (async () => { started(); await pending; return Response.json({ data: [{ id: "old-account-only" }] }); }) as typeof fetch };
  const flight = fetchProviderModels("anthropic2", provider, 60_000);
  try {
    await Promise.race([sent, flight.then(() => { throw new Error("Discovery returned before the fixture send"); })]);
    expect(await setActiveAccount("anthropic2", "new")).toBe(true);
  } finally { release(); }
  const rows = await flight;
  expect(rows.some(row => row.id === "old-account-only")).toBe(false);
  expect(getFreshCached("anthropic2", 60_000)?.some(row => row.id === "old-account-only") ?? false).toBe(false);
});
