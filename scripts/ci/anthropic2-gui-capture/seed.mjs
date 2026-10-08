// Synthetic OpenCodex state for the anthropic / anthropic2 dashboard captures.
//
// Every value is fake: tokens are fixed "synthetic-*" strings, emails use the reserved
// .test TLD (allowed by scripts/privacy-scan.ts), and the account UUIDs are the constants
// tests/helpers/anthropic-instance-fixture.ts already uses. Nothing here can authenticate
// anywhere, and the workflow additionally sinkholes the Anthropic hosts.
import { createHash } from "node:crypto";

const YEAR_MS = 365 * 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;

/** Same UUIDs as tests/helpers/anthropic-instance-fixture.ts (instanceFixtureUuid). */
const UUIDS = {
  anthropic: ["11111111-1111-4111-8111-111111111111", "33333333-3333-4333-8333-333333333333"],
  anthropic2: ["22222222-2222-4222-8222-222222222222", "44444444-4444-4444-8444-444444444444"],
};

/** Store-owned opaque account ids; normalizeAccount only requires a non-empty string. */
export const ACCOUNT_IDS = {
  anthropic: ["main-work", "main-personal"],
  anthropic2: ["pool2-work", "pool2-personal"],
};

export const ALIASES = {
  anthropic: ["Main · Work", "Main · Personal"],
  anthropic2: ["Pool 2 · Work", "Pool 2 · Personal"],
};

const EMAILS = {
  anthropic: ["main-work@claude-pool.test", "main-personal@claude-pool.test"],
  anthropic2: ["pool2-work@claude-pool.test", "pool2-personal@claude-pool.test"],
};

/** Static model list so the Models page never depends on live discovery (liveModels: false). */
export const MODELS = ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"];
const DEFAULT_MODEL = "claude-sonnet-4-6";

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * One ProviderAccount (src/oauth/types.ts). anthropicIdentity must hash the exact access
 * bearer, or normalizeAnthropicIdentity (src/oauth/anthropic-identity.ts:20) drops it.
 */
function account(instance, slot, now) {
  const access = `synthetic-${instance}-${slot + 1}-access`;
  const accountUuid = UUIDS[instance][slot];
  return {
    id: ACCOUNT_IDS[instance][slot],
    alias: ALIASES[instance][slot],
    addedAt: now - (slot + 1) * 24 * HOUR_MS,
    credential: {
      access,
      refresh: `synthetic-${instance}-${slot + 1}-refresh`,
      // Far future: the token guardian skips credentials outside its horizon (src/oauth/token-guardian.ts:152).
      expires: now + YEAR_MS,
      email: EMAILS[instance][slot],
      accountId: accountUuid,
      // anthropic2 refuses "local-cli" credentials (src/oauth/store-anthropic-instance.ts:63).
      source: "oauth",
      anthropicIdentity: { v: 1, accountUuid, bearerSha256: sha256Hex(access) },
    },
  };
}

function accountSet(instance, now) {
  const accounts = [account(instance, 0, now), account(instance, 1, now)];
  return { activeAccountId: accounts[0].id, accounts };
}

/** auth.json: { [provider]: ProviderAccountSet }. The empty scenario omits anthropic2 entirely. */
export function authStore(scenario, now = Date.now()) {
  const store = { anthropic: accountSet("anthropic", now) };
  if (scenario === "populated") store.anthropic2 = accountSet("anthropic2", now);
  return store;
}

function anthropicRow(extra = {}) {
  return {
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com",
    authMode: "oauth",
    defaultModel: DEFAULT_MODEL,
    models: MODELS,
    liveModels: false,
    ...extra,
  };
}

/**
 * config.json. Provider shape mirrors anthropicInstanceConfig() in
 * tests/helpers/anthropic-instance-fixture.ts; the isolation keys come from
 * tests/gui/gui-pair-http.test.ts (codexAutoStart, clientIntegrations, claudeCode).
 */
export function configFor(scenario, port) {
  const config = {
    port,
    hostname: "127.0.0.1",
    runtimeRole: "standalone",
    defaultProvider: "anthropic",
    providers: {
      anthropic: anthropicRow(),
      // Only this exact shape is the builtin Pool 2 (src/providers/anthropic-instance-id.ts:39).
      anthropic2: anthropicRow({
        anthropicOAuthInstance: "anthropic2",
        anthropicAccountPool: { enabled: true, strategy: "round-robin", autoSwitchThreshold: 70, quotaWindow: "five-hour" },
      }),
    },
    anthropicAccountPool: { enabled: true, strategy: "quota", autoSwitchThreshold: 80, quotaWindow: "five-hour" },
    codexAutoStart: false,
    syncResumeHistory: false,
    clientIntegrations: { codex: false, grok: false, "claude-desktop": false },
    claudeCode: { enabled: false, systemEnv: false },
  };
  if (scenario === "populated") {
    // An explicit "anthropic" backend is what renders the Pool select
    // (gui/src/pages/dashboard-overview-sections.tsx:601 and :672).
    config.webSearchSidecar = { backend: "anthropic", anthropicInstance: "anthropic2", model: DEFAULT_MODEL };
    config.visionSidecar = { backend: "anthropic", anthropicInstance: "anthropic2", model: DEFAULT_MODEL };
  }
  return config;
}

/**
 * provider-account-quota-cache.json (src/providers/account-quota-disk.ts:20). Cosmetic only:
 * Anthropic rows hydrate with ts 0 (src/providers/quota/account-cache.ts:144), so a live probe
 * follows at once and fails against the sinkhole. Whether the bars survive that is unproven.
 */
export function quotaCache(scenario, now = Date.now()) {
  const rows = {};
  const add = (instance, slot, five, weekly) => {
    rows[`${instance}\u0000${ACCOUNT_IDS[instance][slot]}`] = {
      fiveHourPercent: five, fiveHourResetAt: now + 2 * HOUR_MS,
      weeklyPercent: weekly, weeklyResetAt: now + 4 * 24 * HOUR_MS,
      updatedAt: now,
    };
  };
  add("anthropic", 0, 64, 31);
  add("anthropic", 1, 12, 8);
  if (scenario === "populated") {
    add("anthropic2", 0, 37, 22);
    add("anthropic2", 1, 5, 3);
  }
  return { version: 1, rows };
}

/** Visible strings asserted on; sources: gui/src/i18n/{en,ko}.ts and gui/src/provider-icons.ts. */
export const TEXT = {
  en: {
    a: "Anthropic Claude",
    b: "Anthropic · Pool 2",
    accountsTab: "Accounts",
    poolToggle: "Claude account pool (experimental)",
    pool: "Pool",
  },
  ko: {
    a: "Anthropic Claude",
    b: "Anthropic · 풀 2",
    accountsTab: "계정",
    poolToggle: "Claude 계정 풀(실험적)",
    pool: "계정 풀",
  },
};
