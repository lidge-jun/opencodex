import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureCatalogAdmissionSnapshot } from "../../src/codex/catalog-admission";
import { loadBundledCodexCatalog, resetCatalogRuntimeStateForTests, syncCatalogModels } from "../../src/codex/catalog";
import { applyNativeAccessPrograms, applyNativeRosterMetadata } from "../../src/codex/catalog/access-programs";
import { buildCodexModelList } from "../../src/server/codex-model-list";
import { CODEX_ACCOUNT_BOUND_CATALOG_KIND } from "../../src/codex/catalog/account-models";
import { CODEX_NATIVE_ALIAS_CATALOG_KIND } from "../../src/codex/catalog/kinds";
import type { RawCatalog, RawEntry } from "../../src/codex/catalog/parsing";
import { commitCodexCatalogCandidate, gatherCodexCatalogCandidate } from "../../src/codex/convergence";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";
import {
  resetCodexModelEntitlementCacheForTests,
  resolveCodexModelEntitlements,
  type CodexModelEntitlementCredentialSnapshot,
} from "../../src/codex/model-entitlements";
import { resetCodexRuntimeResolveCacheForTests } from "../../src/codex/runtime";
import { saveConfig } from "../../src/config";
import { CODEX_FORWARD_BASE_URL } from "../../src/providers/openai-tiers";
import type { OcxConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const MODEL = "gpt-6-astra";
const WRITER_MODEL = "gpt-5.6-sol";
const CLIENT_VERSION = "0.146.0";
setDefaultTimeout(30_000);
const mainCredential: CodexModelEntitlementCredentialSnapshot = {
  accountId: MAIN_CODEX_ACCOUNT_ID, accessToken: "synthetic-main-token",
  chatgptAccountId: "synthetic-main-account", credentialIdentity: "synthetic:main",
};
const poolCredential: CodexModelEntitlementCredentialSnapshot = {
  accountId: "synthetic-pool", accessToken: "synthetic-pool-token",
  chatgptAccountId: "synthetic-pool-account", credentialIdentity: "synthetic:pool",
};

function rosterRow(slug: string, availability_nux?: unknown): Record<string, unknown> {
  return { slug, supported_in_api: true, visibility: "list", availability_nux };
}

async function snapshot(main: unknown[], pool: unknown[] = [], mainFails = false) {
  return resolveCodexModelEntitlements({ codexAccounts: [] }, {
    credentials: [mainCredential, poolCredential], now: 1_000,
    clientVersion: CLIENT_VERSION,
    fetcher: (async (_input, init) => {
      const id = new Headers(init?.headers).get("chatgpt-account-id");
      if (id === mainCredential.chatgptAccountId && mainFails) return new Response(null, { status: 503 });
      return Response.json({ models: id === mainCredential.chatgptAccountId ? main : pool });
    }) as typeof fetch,
  });
}

beforeEach(() => resetCodexModelEntitlementCacheForTests());

test("confirmed main roster projects only its bounded message onto a bare native row", async () => {
  const result = await snapshot([rosterRow(MODEL, { message: `  ${"M".repeat(2_100)}  `, extra: "ignored" })],
    [rosterRow(MODEL, { message: "Pool prompt" })]);
  expect(result.availabilityNuxByAccount?.get(MAIN_CODEX_ACCOUNT_ID)?.get(MODEL))
    .toEqual({ message: "M".repeat(2_000) });
  expect(result.availabilityNuxByAccount?.get("synthetic-pool")?.get(MODEL))
    .toEqual({ message: "Pool prompt" });
  const rows: RawEntry[] = [
    { slug: MODEL, availability_nux: { message: "Old prompt" } },
    { slug: `desktop/${MODEL}`, opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND, availability_nux: { message: "Old prompt" } },
    { slug: `pool/${MODEL}`, opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND, availability_nux: { message: "Old prompt" } },
    { slug: MODEL, owned_by: "combo", availability_nux: { message: "Old prompt" } },
    { slug: MODEL, opencodex_catalog_kind: CODEX_NATIVE_ALIAS_CATALOG_KIND, availability_nux: { message: "Old prompt" } },
  ];
  applyNativeAccessPrograms(rows, result, new Map([["desktop", MAIN_CODEX_ACCOUNT_ID], ["pool", "synthetic-pool"]]));
  expect(rows[0]?.availability_nux).toEqual({ message: "M".repeat(2_000) });
  for (const row of rows.slice(1)) expect(row).not.toHaveProperty("availability_nux");
});

test.each([undefined, null, "bad", [], {}, { message: "  " }, { message: 42 }])(
  "missing or malformed main NUX %p clears a stale bare prompt without changing roster confirmation",
  async value => {
    const result = await snapshot([{
      ...rosterRow(MODEL, value), available_access_programs: { cyber: ["standard"] },
    }]);
    expect(result.confirmedAccountIds.has(MAIN_CODEX_ACCOUNT_ID)).toBe(true);
    expect(result.accessProgramsByAccount?.get(MAIN_CODEX_ACCOUNT_ID)?.get(MODEL))
      .toEqual({ cyber: ["standard"] });
    const row: RawEntry = { slug: MODEL, availability_nux: { message: "Old prompt" } };
    applyNativeAccessPrograms([row], result, new Map());
    expect(row.availability_nux).toBeNull();
  },
);

test("the cap never splits a surrogate pair and lone surrogates are dropped", async () => {
  // 1,999 ASCII units then an emoji: the 2,000-unit cut lands between its two halves.
  const straddling = `${"a".repeat(1_999)}\u{1F600}tail`;
  const cut = await snapshot([rosterRow(MODEL, { message: straddling })]);
  const cutMessage = cut.availabilityNuxByAccount?.get(MAIN_CODEX_ACCOUNT_ID)?.get(MODEL)?.message ?? "";
  expect(cutMessage).toBe("a".repeat(1_999));
  expect(cutMessage.isWellFormed()).toBe(true);
  resetCodexModelEntitlementCacheForTests();
  const lone = await snapshot([rosterRow(MODEL, { message: "Try \uD83D it \u{1F600}" })]);
  const loneMessage = lone.availabilityNuxByAccount?.get(MAIN_CODEX_ACCOUNT_ID)?.get(MODEL)?.message ?? "";
  expect(loneMessage).toBe("Try  it \u{1F600}");
  expect(loneMessage.isWellFormed()).toBe(true);
  expect(JSON.stringify({ message: loneMessage })).not.toMatch(/\\ud[89ab]/i);
});

test("hidden rows and failed or unlisted main rosters cannot retain a prompt", async () => {
  const hidden = await snapshot([{ ...rosterRow(MODEL, { message: "Hidden" }), visibility: "hide" }]);
  expect(hidden.availabilityNuxByAccount?.get(MAIN_CODEX_ACCOUNT_ID)).toBeUndefined();
  const row: RawEntry = { slug: MODEL, availability_nux: { message: "Old prompt" } };
  applyNativeAccessPrograms([row], hidden, new Map());
  expect(row.availability_nux).toBeNull();
  resetCodexModelEntitlementCacheForTests();
  const failed = await snapshot([rosterRow(MODEL, { message: "Never seen" })], [], true);
  expect(failed.confirmedAccountIds.has(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
  expect(failed.availabilityNuxByAccount?.has(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
  row.availability_nux = { message: "Old prompt" };
  applyNativeAccessPrograms([row], failed, new Map());
  expect(row.availability_nux).toBeNull();
  resetCodexModelEntitlementCacheForTests();
  const unlisted = await snapshot([rosterRow("gpt-6-sol")], [rosterRow(MODEL, { message: "Pool only" })]);
  row.availability_nux = { message: "Old prompt" };
  applyNativeAccessPrograms([row], unlisted, new Map());
  expect(row.availability_nux).toBeNull();
});

let home: TempHome | undefined;

test.each([
  ["gpt-5.5", 840_000, 272_000],
  ["gpt-5.5", 200_000, 200_000],
  ["gpt-5.6-sol", 840_000, 840_000],
  ["gpt-6-astra", 840_000, 840_000],
] as const)("roster window for %s respects its opt-in policy with cap %d", async (slug, cap, expected) => {
  const result = await snapshot([{ ...rosterRow(slug), context_window: 272_000, max_context_window: 872_000 }]);
  const row: RawEntry = { slug, context_window: 272_000, auto_compact_token_limit: 244_800 };
  applyNativeRosterMetadata([row], result, new Map(), { cap });
  expect(row.context_window).toBe(expected);
  expect(row.max_context_window).toBe(Math.min(cap, 872_000));
  expect(row.auto_compact_token_limit).toBeLessThanOrEqual(expected);
  if (slug === "gpt-5.5" && cap > 272_000) expect(row.auto_compact_token_limit).toBe(244_800);
});

test.each([
  [undefined, 1_000_000], [950_000, 950_000], [1_100_000, 1_000_000],
] as const)("confirmed default above the shipped opt-in ceiling respects cap %p", async (cap, expected) => {
  const result = await snapshot([{
    ...rosterRow(WRITER_MODEL), context_window: 1_000_000, max_context_window: 1_100_000,
  }]);
  const row: RawEntry = { slug: WRITER_MODEL, context_window: 272_000 };
  applyNativeRosterMetadata([row], result, new Map(), { cap });
  expect(row.context_window).toBe(expected);
  expect(row.max_context_window).toBe(cap ?? 1_100_000);
  expect(row.auto_compact_token_limit).toBe(Math.floor(expected * 0.9));
});

test("exact native capabilities respect configured limits and exclude routed and alias rows", async () => {
  const luna = "gpt-6-luna";
  const daybreak = "gpt-daybreak-blue-latest";
  const result = await snapshot([
    { ...rosterRow(luna, { message: "Local account notice" }), supports_reasoning_effort_updates: true, supports_experimental_context: true },
    { ...rosterRow(daybreak), max_context_window: 872_000 },
  ]);
  const lunaRow: RawEntry = { slug: luna, context_window: 272_000 };
  const blueRow: RawEntry = { slug: daybreak, context_window: 272_000, max_context_window: 922_000 };
  const routed: RawEntry[] = [
    { slug: `other/${luna}` }, { slug: luna, owned_by: "combo" },
    { slug: luna, opencodex_catalog_kind: CODEX_NATIVE_ALIAS_CATALOG_KIND },
  ];
  applyNativeRosterMetadata([lunaRow, blueRow, ...routed], result, new Map(), {
    providerWindow: 900_000, modelWindows: { [daybreak]: 860_000 }, cap: 840_000,
    modelAutoCompactTokenLimits: { [daybreak]: 111_000 },
  });
  expect(lunaRow).toMatchObject({ supports_reasoning_effort_updates: true, supports_experimental_context: true });
  expect(blueRow).toMatchObject({ context_window: 840_000, max_context_window: 840_000, auto_compact_token_limit: 111_000 });
  for (const row of routed) {
    expect(row).not.toHaveProperty("supports_reasoning_effort_updates");
    expect(row).not.toHaveProperty("supports_experimental_context");
  }
  applyNativeRosterMetadata([blueRow], result, new Map(), { providerWindow: 1_000_000 });
  expect(blueRow).toMatchObject({ context_window: 872_000, max_context_window: 872_000 });

  const live = buildCodexModelList({
    config: writerConfig(), nativeSlugs: [luna, daybreak], availableAccountNativeSlugs: [], accountNativeSlugs: [],
    accountNativeSlugsBySelector: new Map(), goOrdered: [], exactComboSlugs: new Set(), accountSelectors: [],
    suppressedBareNativeSlugs: new Set(), disabledModels: new Set(), roster: { snapshot: result, accountTargets: new Map() },
  });
  expect(live.models.find(row => row.slug === luna)).toMatchObject({ supports_reasoning_effort_updates: true, supports_experimental_context: true });
  expect(live.models.find(row => row.slug === daybreak)?.max_context_window).toBe(872_000);
  expect(JSON.stringify(live)).not.toContain("Local account notice");
});
let previousCliPath: string | undefined;
let previousFetch: typeof fetch;
let mainPrompt: unknown;
let poolPrompt: unknown;

function writerConfig(): OcxConfig {
  return {
    port: 10100,
    providers: { openai: { adapter: "openai-responses", baseUrl: CODEX_FORWARD_BASE_URL, authMode: "forward" } },
    defaultProvider: "openai",
    codexAccounts: [{ id: "synthetic-pool", email: "pool@example.test", alias: "Pool", isMain: false }],
    codexAccountNamespaces: { desktop: "@main", team: "synthetic-pool" },
    codexAccountPickerEnabled: true,
    disabledModels: [],
  };
}

function writtenRows(): RawEntry[] {
  return (JSON.parse(readFileSync(join(home!.codexHome, "opencodex-catalog.json"), "utf8")) as RawCatalog).models ?? [];
}

function primeWriter(): void {
  const runtimeScript = home!.path("codex-fixture.js");
  const bundled = JSON.stringify({ models: [{
    slug: "gpt-5.5", display_name: "GPT-5.5", description: "Fixture native",
    priority: 1, visibility: "list", base_instructions: "You are Codex.",
    supported_reasoning_levels: [{ effort: "medium", description: "Medium" }],
    default_reasoning_level: "medium",
  }] });
  writeFileSync(runtimeScript, [
    'if (process.argv.includes("--version")) console.log("codex-cli 0.145.0");',
    `else process.stdout.write(${JSON.stringify(bundled)});`,
  ].join("\n"));
  const runtimeCommand = home!.path(process.platform === "win32" ? "codex-fixture.cmd" : "codex-fixture");
  writeFileSync(runtimeCommand, process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${runtimeScript}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${runtimeScript}" "$@"\n`);
  if (process.platform !== "win32") chmodSync(runtimeCommand, 0o755);
  process.env.CODEX_CLI_PATH = runtimeCommand;
  resetCatalogRuntimeStateForTests();
  resetCodexRuntimeResolveCacheForTests();
  expect(loadBundledCodexCatalog()?.models?.[0]?.slug).toBe("gpt-5.5");
}

async function writeWith(writer: "retained" | "convergence", config: OcxConfig): Promise<RawEntry[]> {
  saveConfig(config);
  if (writer === "retained") await syncCatalogModels(config);
  else {
    const gathered = await gatherCodexCatalogCandidate(captureCatalogAdmissionSnapshot(config));
    expect(gathered.kind).toBe("candidate");
    if (gathered.kind !== "candidate") throw new Error("expected candidate");
    expect((await commitCodexCatalogCandidate(gathered.candidate, 1_000)).kind).toBe("committed");
  }
  return writtenRows();
}

test.each(["retained", "convergence"] as const)("%s projects fresh per-account roster metadata into the on-disk catalog", async writer => {
  let mainCapabilities: Record<string, unknown> = {
    supports_reasoning_effort_updates: true, supports_experimental_context: true,
    context_window: 300_000, max_context_window: 872_000,
  };
  const poolCapabilities = {
    supports_reasoning_effort_updates: false, supports_experimental_context: false,
    context_window: 200_000, max_context_window: 600_000,
  };
  previousCliPath = process.env.CODEX_CLI_PATH;
  previousFetch = globalThis.fetch;
  home = createTempHome("ocx-native-nux-");
  mkdirSync(home.codexHome);
  writeFileSync(join(home.codexHome, "auth.json"), JSON.stringify({
    tokens: { access_token: "synthetic-main-token", account_id: "synthetic-main-account" },
  }));
  saveCodexAccountCredential("synthetic-pool", {
    accessToken: "synthetic-pool-token", refreshToken: "synthetic-pool-refresh",
    expiresAt: Date.now() + 300_000, chatgptAccountId: "synthetic-pool-account",
  });
  globalThis.fetch = (async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    if (url.hostname === "chatgpt.com" && url.pathname.endsWith("/models")) {
      const id = new Headers(init?.headers).get("chatgpt-account-id");
      const isMain = id === "synthetic-main-account";
      return Response.json({ models: [{
        ...rosterRow(WRITER_MODEL, isMain ? mainPrompt : poolPrompt),
        ...(isMain ? mainCapabilities : poolCapabilities),
      }] });
    }
    return previousFetch(input, init);
  }) as typeof fetch;
  try {
    mainPrompt = { message: "Main trial" };
    poolPrompt = { message: "Pool trial" };
    primeWriter();
    writeFileSync(join(home.codexHome, "opencodex-catalog.json"), JSON.stringify({
      models: [{ slug: WRITER_MODEL, display_name: "Sol", visibility: "list", priority: 1,
        supported_reasoning_levels: [{ effort: "medium", description: "Medium" }],
        availability_nux: { message: "Old prompt" } }],
    }));
    const config = writerConfig();
    let rows = await writeWith(writer, config);
    for (const slug of [WRITER_MODEL, `desktop/${WRITER_MODEL}`]) {
      expect(rows.find(row => row.slug === slug)).toMatchObject({ ...mainCapabilities, auto_compact_token_limit: 270_000 });
    }
    expect(rows.find(row => row.slug === `team/${WRITER_MODEL}`))
      .toMatchObject({ ...poolCapabilities, auto_compact_token_limit: 180_000 });
    expect(rows.find(row => row.slug === WRITER_MODEL)?.availability_nux).toEqual({ message: "Main trial" });
    expect(JSON.stringify(rows)).not.toContain("Pool trial");
    for (const slug of [`desktop/${WRITER_MODEL}`, `team/${WRITER_MODEL}`]) {
      expect(rows.find(row => row.slug === slug)).not.toHaveProperty("availability_nux");
    }
    // Compare the persisted window with the final roster projection, not the
    // temporary pinned value used during the observed-state merge.
    for (const slug of [WRITER_MODEL, `desktop/${WRITER_MODEL}`, `team/${WRITER_MODEL}`]) {
      rows.find(row => row.slug === slug)!.auto_compact_token_limit = 100_000;
    }
    writeFileSync(join(home.codexHome, "opencodex-catalog.json"), JSON.stringify({ models: rows }));
    for (let pass = 0; pass < 2; pass++) {
      rows = await writeWith(writer, config);
      for (const slug of [WRITER_MODEL, `desktop/${WRITER_MODEL}`, `team/${WRITER_MODEL}`]) {
        expect(rows.find(row => row.slug === slug)?.auto_compact_token_limit).toBe(100_000);
      }
    }
    // The first duplicate survives publication, whether its budget is lower or
    // higher than the later row. Projection must use that same incoming row.
    for (const [firstBudget, laterBudget] of [[100_000, 150_000], [150_000, 100_000]]) {
      const duplicates = [WRITER_MODEL, `desktop/${WRITER_MODEL}`, `team/${WRITER_MODEL}`].map(slug => {
        const first = rows.find(row => row.slug === slug)!;
        first.auto_compact_token_limit = firstBudget;
        return { ...first, auto_compact_token_limit: laterBudget };
      });
      writeFileSync(join(home.codexHome, "opencodex-catalog.json"), JSON.stringify({ models: [...rows, ...duplicates] }));
      for (let pass = 0; pass < 2; pass++) {
        rows = await writeWith(writer, config);
        for (const duplicate of duplicates) {
          const matching = rows.filter(row => row.slug === duplicate.slug);
          expect(matching).toHaveLength(1);
          expect(matching[0]?.auto_compact_token_limit).toBe(firstBudget);
        }
      }
    }
    mainPrompt = undefined;
    mainCapabilities = { max_context_window: -1, supports_experimental_context: "true" };
    resetCodexModelEntitlementCacheForTests();
    rows = await writeWith(writer, config);
    const fallback = rows.find(row => row.slug === WRITER_MODEL);
    expect(fallback).toMatchObject({ context_window: 272_000, max_context_window: 922_000, auto_compact_token_limit: 244_800 });
    expect(fallback?.supports_experimental_context).not.toBe(true);
    expect(rows.find(row => row.slug === WRITER_MODEL)?.availability_nux).toBeNull();
    for (const slug of [`desktop/${WRITER_MODEL}`, `team/${WRITER_MODEL}`]) {
      expect(rows.find(row => row.slug === slug)).not.toHaveProperty("availability_nux");
    }
    config.combos = { trial: {
      alias: WRITER_MODEL, nativeAlias: true, displayName: "Synthetic alias",
      targets: [{ provider: "openai", model: WRITER_MODEL }],
    } };
    rows = await writeWith(writer, config);
    const alias = rows.find(row => row.slug === WRITER_MODEL);
    expect(alias?.opencodex_catalog_kind).toBe(CODEX_NATIVE_ALIAS_CATALOG_KIND);
    expect(alias).not.toHaveProperty("availability_nux");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousCliPath === undefined) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = previousCliPath;
    resetCodexRuntimeResolveCacheForTests();
    home.remove();
    home = undefined;
  }
});

afterEach(() => resetCodexModelEntitlementCacheForTests());
