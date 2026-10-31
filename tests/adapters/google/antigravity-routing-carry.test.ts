import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherRoutedModels } from "../../../src/codex/catalog";
import { clearModelCache } from "../../../src/codex/model-cache";
import * as outbound from "../../../src/lib/provider-outbound";
import { credentialGeneration, getAccountCredentialWithStatus } from "../../../src/oauth/store";
import { preferredInitialAccount, routeAntigravityModel, clearGenericFailoverHealth } from "../../../src/oauth/generic-account-failover";
import {
  ANTIGRAVITY_MODEL_DENIAL_TTL_MS, antigravityAccountSupportsModel, antigravityAccountRosterModelIds,
  captureAntigravityModelObservation, clearAntigravityAccountRosters,
  recordAntigravityAccountRoster, recordAntigravityModelDenial,
} from "../../../src/providers/antigravity-account-roster";
import { MODEL_DISCOVERY_MAX_MODELS } from "../../../src/providers/model-discovery";
import { parseAntigravityAvailableModels } from "../../../src/providers/antigravity-models";
import { clearAccountQuotaCache, setCachedProviderAccountQuotaForTests } from "../../../src/providers/quota";
import type { OcxConfig, OcxProviderConfig } from "../../../src/types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";
import { withStubbedProviderFetch } from "../../helpers/catalog-provider-fetch";

const provider = "google-antigravity";
const originalHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;
const homes: string[] = [];
const model = "claude-sonnet-4-6";
const modelRows = (id: string) => [{ id, wireModelId: id }];
const payload = (...ids: string[]) => ({ models: Object.fromEntries(ids.map(id => [id, {}])),
  agentModelSorts: [{ groups: [{ modelIds: ids }] }] });
function setup() {
  const home = mkdtempSync(join(tmpdir(), "ocx-antigravity-carry-"));
  homes.push(home);
  process.env.OPENCODEX_HOME = home;
  const store = { [provider]: { activeAccountId: "a", accounts: ["a", "b", "c"].map(id => ({ id,
    credential: { access: `synthetic-${id}`, refresh: `synthetic-refresh-${id}`, expires: Date.now() + 3600000, projectId: `project-${id}` },
  })) } };
  writeFileSync(join(home, "auth.json"), JSON.stringify(store));
  return { home, store, cfg: withStubbedProviderFetch({ providers: { [provider]: {
    adapter: "google", authMode: "oauth", baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    googleMode: "cloud-code-assist", liveModels: true, models: [], oauthAccountFailover: { enabled: true },
  } } } as unknown as OcxConfig) };
}
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache(); clearAntigravityAccountRosters(); clearGenericFailoverHealth(); clearAccountQuotaCache(provider);
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = originalHome;
  for (const home of homes.splice(0)) removeTreeWithRetry(home);
});

test("refreshing discovery unions usable siblings while retaining each account's own roster", async () => {
  const { cfg, store, home } = setup();
  (store[provider].accounts[2] as unknown as { paused: boolean }).paused = true;
  writeFileSync(join(home, "auth.json"), JSON.stringify(store));
  const sends: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    const auth = new Headers(init?.headers).get("authorization")!;
    sends.push(auth);
    return Response.json(payload(auth.endsWith("-a") ? "model-active" : "model-sibling"));
  }) as typeof fetch;
  const rows = await gatherRoutedModels(cfg);
  expect(rows.filter(row => row.provider === provider).map(row => row.id).sort()).toEqual(["model-active", "model-sibling"]);
  expect(sends).toEqual(["Bearer synthetic-a", "Bearer synthetic-b"]);
  expect(antigravityAccountRosterModelIds(provider, "a")).toEqual(["model-active"]);
  expect(antigravityAccountRosterModelIds(provider, "b")).toEqual(["model-sibling"]);
});

test("a root change during active discovery cannot start sibling probes in the new home", async () => {
  const { cfg } = setup();
  const sends: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    sends.push(new Headers(init?.headers).get("authorization")!);
    if (sends.length === 1) setup();
    return Response.json(payload("model-old-home"));
  }) as typeof fetch;
  const rows = await gatherRoutedModels(cfg);
  expect(sends).toEqual(["Bearer synthetic-a"]);
  expect(rows.some(row => row.id === "model-old-home")).toBe(false);
  expect(antigravityAccountRosterModelIds(provider, "b")).toBeUndefined();
});

test("active discovery held by a sibling cannot erase a newer inference denial", async () => {
  const { cfg } = setup();
  let releaseSibling!: () => void;
  let siblingSent!: () => void;
  const atSibling = new Promise<void>(resolve => { siblingSent = resolve; });
  const held = new Promise<void>(resolve => { releaseSibling = resolve; });
  globalThis.fetch = (async (_input, init) => {
    if (new Headers(init?.headers).get("authorization")!.endsWith("-b")) {
      siblingSent(); await held;
    }
    return Response.json(payload(model));
  }) as typeof fetch;
  const pending = gatherRoutedModels(cfg);
  await atSibling;
  try {
    const sent = { ...captureAntigravityModelObservation(),
      generation: credentialGeneration(getAccountCredentialWithStatus(provider, "a")!.credential) };
    expect(recordAntigravityModelDenial(provider, "a", model, sent)).toBe(true);
  } finally { releaseSibling(); }
  await pending;
  expect(antigravityAccountRosterModelIds(provider, "a")).toEqual([model]);
  expect(antigravityAccountSupportsModel(provider, "a", model)).toBe(false);
  expect(routeAntigravityModel(cfg, provider, "a", model)).toEqual({ kind: "reroute", accountId: "b" });
  expect(preferredInitialAccount(cfg, provider, Date.now(), model)).toBe("b");
});

test("active discovery held by a sibling cannot publish into replacement credentials", async () => {
  const { cfg, store, home } = setup();
  globalThis.fetch = (async (_input, init) => {
    const active = new Headers(init?.headers).get("authorization")!.endsWith("-a");
    if (!active) {
      store[provider].accounts[0]!.credential.access = "synthetic-replacement";
      writeFileSync(join(home, "auth.json"), JSON.stringify(store));
    }
    return Response.json(payload(active ? "model-active" : "model-sibling"));
  }) as typeof fetch;
  const rows = await gatherRoutedModels(cfg);
  expect(rows.some(row => row.id === "model-active")).toBe(false);
  expect(antigravityAccountRosterModelIds(provider, "a")).toBeUndefined();
});

test("late D1 publication cannot roll back D2 before a delayed inference denial", async () => {
  const { cfg } = setup();
  let releaseSibling!: () => void;
  let siblingSent!: () => void;
  const atSibling = new Promise<void>(resolve => { siblingSent = resolve; });
  const held = new Promise<void>(resolve => { releaseSibling = resolve; });
  globalThis.fetch = (async (_input, init) => {
    if (new Headers(init?.headers).get("authorization")!.endsWith("-b")) {
      siblingSent(); await held;
    }
    return Response.json(payload(model));
  }) as typeof fetch;
  const d1 = gatherRoutedModels(cfg);
  await atSibling;
  const sent = { ...captureAntigravityModelObservation(),
    generation: credentialGeneration(getAccountCredentialWithStatus(provider, "a")!.credential) };
  try {
    recordAntigravityAccountRoster(provider, "a", modelRows(model)); // D2 completes first.
  } finally { releaseSibling(); }
  await d1;
  expect(recordAntigravityModelDenial(provider, "a", model, sent)).toBe(false);
  expect(antigravityAccountRosterModelIds(provider, "a")).toEqual([model]);
  expect(antigravityAccountSupportsModel(provider, "a", model)).toBe(true);
  expect(routeAntigravityModel(cfg, provider, "a", model)).toEqual({ kind: "keep" });
  expect(preferredInitialAccount(cfg, provider, Date.now(), model)).toBeNull(); // No switch from the eligible active account.
});

for (const timing of ["before-send", "before-publication"] as const) {
  for (const mutation of ["paused", "removed", "reauth", "replaced", "root"] as const) {
    test(`sibling ${mutation} ${timing} contributes no stale discovery`, async () => {
      const { cfg, store, home } = setup();
      store[provider].accounts.splice(2);
      writeFileSync(join(home, "auth.json"), JSON.stringify(store));
      const mutate = () => {
        const b = store[provider].accounts[1]!;
        if (mutation === "removed") store[provider].accounts.splice(1);
        if (mutation === "paused") Object.assign(b, { paused: true });
        if (mutation === "reauth") Object.assign(b, { needsReauth: true });
        if (mutation === "replaced") b.credential.access = "synthetic-replacement";
        if (mutation === "root") { setup(); return; }
        writeFileSync(join(home, "auth.json"), JSON.stringify(store));
      };
      const sends: string[] = [];
      globalThis.fetch = (async (_input, init) => {
        const auth = new Headers(init?.headers).get("authorization")!;
        sends.push(auth);
        if (auth.endsWith("-b") && timing === "before-publication") mutate();
        return Response.json(payload(auth.endsWith("-a") ? "model-active" : "model-sibling"));
      }) as typeof fetch;
      const realPost = outbound.providerOutboundPost;
      const hook = spyOn(outbound, "providerOutboundPost").mockImplementation(async (...args) => {
        if (new Headers(args[3].headers).get("authorization")?.endsWith("-b") && timing === "before-send") {
          await Promise.resolve(); mutate();
        }
        return realPost(...args);
      });
      try {
        const rows = await gatherRoutedModels(cfg);
        expect(rows.some(row => row.id === "model-sibling")).toBe(false);
        expect(antigravityAccountRosterModelIds(provider, "b")).toBeUndefined();
        if (timing === "before-send") expect(sends).toEqual(["Bearer synthetic-a"]);
      } finally { hook.mockRestore(); }
    });
  }
}

test("disabled ids do not consume the enabled limit, including tier and image indexes", () => {
  const body = payload("flagged", "legacy-disabled", "enabled");
  body.models.flagged = { disabled: true };
  expect(parseAntigravityAvailableModels(body, 1)?.map(row => row.id)).toEqual(["enabled"]);
  expect(parseAntigravityAvailableModels(payload("enabled", "other"), 1)).toBeNull();
  expect(parseAntigravityAvailableModels({ ...payload("legacy-disabled"),
    models: { "legacy-disabled": {}, "gemini-3.1-flash-image": {}, "future-tiered": { disabled: true } },
    imageGenerationModelIds: ["gemini-3.1-flash-image"], tieredModelIds: { flash: ["future-tiered"] },
  }, 1)?.map(row => row.id)).toEqual(["gemini-3.1-flash-image"]);
});

test("raw disabled responses remain independently bounded", () => {
  const body = payload("legacy-disabled");
  body.agentModelSorts[0]!.groups[0]!.modelIds = Array(MODEL_DISCOVERY_MAX_MODELS * 4 + 1).fill("legacy-disabled");
  expect(parseAntigravityAvailableModels(body, 1)).toBeNull();
});

test("denials last 24h independently of roster TTL and a newer positive observation wins", () => {
  setup();
  expect(ANTIGRAVITY_MODEL_DENIAL_TTL_MS).toBe(24 * 60 * 60 * 1000);
  const generation = credentialGeneration(getAccountCredentialWithStatus(provider, "a")!.credential);
  const sent = { ...captureAntigravityModelObservation(), generation };
  expect(recordAntigravityModelDenial(provider, "a", model, sent, 1000)).toBe(true);
  expect(antigravityAccountSupportsModel(provider, "a", model, 1000 + ANTIGRAVITY_MODEL_DENIAL_TTL_MS)).toBe(false);
  expect(antigravityAccountSupportsModel(provider, "a", model, 1001 + ANTIGRAVITY_MODEL_DENIAL_TTL_MS)).toBeUndefined();
  recordAntigravityAccountRoster(provider, "a", modelRows(model));
  expect(recordAntigravityModelDenial(provider, "a", model, sent)).toBe(false);
  expect(antigravityAccountSupportsModel(provider, "a", model)).toBe(true);
});

test("a delayed denial cannot enter a replacement credential or a different config home", () => {
  const { home } = setup();
  const sent = { ...captureAntigravityModelObservation(), generation: credentialGeneration(getAccountCredentialWithStatus(provider, "a")!.credential) };
  const store = JSON.parse(readFileSync(join(home, "auth.json"), "utf8"));
  store[provider].accounts[0].credential.access = "synthetic-replaced";
  writeFileSync(join(home, "auth.json"), JSON.stringify(store));
  expect(recordAntigravityModelDenial(provider, "a", model, sent)).toBe(false);
  recordAntigravityAccountRoster(provider, "a", modelRows(model));
  expect(recordAntigravityModelDenial(provider, "a", model, sent)).toBe(false);
  expect(antigravityAccountSupportsModel(provider, "a", model)).toBe(true);
  setup();
  expect(recordAntigravityModelDenial(provider, "a", model, sent)).toBe(false);
});

test("a newer roster omitting the requested model does not suppress valid model-denial recovery", () => {
  setup();
  const sent = { ...captureAntigravityModelObservation(), generation: credentialGeneration(getAccountCredentialWithStatus(provider, "a")!.credential) };
  recordAntigravityAccountRoster(provider, "a", modelRows("other-model"));
  expect(recordAntigravityModelDenial(provider, "a", model, sent)).toBe(true);
  expect(antigravityAccountSupportsModel(provider, "a", model)).toBe(false);
});

test("model routing and proactive preference rank by headroom within support/readiness tiers", () => {
  const { cfg } = setup();
  recordAntigravityAccountRoster(provider, "a", modelRows("other"));
  for (const id of ["b", "c"]) recordAntigravityAccountRoster(provider, id, modelRows(model));
  for (const [id, percent] of [["b", 90], ["c", 10]] as const)
    setCachedProviderAccountQuotaForTests(provider, id, { customWindows: [{ label: "Cla", percent }], fetchedAt: Date.now() });
  expect(routeAntigravityModel(cfg, provider, "a", model)).toEqual({ kind: "reroute", accountId: "c" });
  expect(preferredInitialAccount(cfg, provider, Date.now(), model)).toBe("c");
  clearAntigravityAccountRosters(provider, "c");
  expect(routeAntigravityModel(cfg, provider, "a", model)).toEqual({ kind: "reroute", accountId: "b" });
  const fill = cfg.providers[provider] as OcxProviderConfig;
  cfg.pool = { kernel: true } as never;
  fill.oauthAccountFailover = { enabled: true, strategy: "fill-first" };
  recordAntigravityAccountRoster(provider, "c", modelRows(model));
  expect(routeAntigravityModel(cfg, provider, "a", model)).toEqual({ kind: "reroute", accountId: "b" });
});
