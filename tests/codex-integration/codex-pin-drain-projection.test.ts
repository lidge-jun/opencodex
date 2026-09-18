import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  clearAccountNeedsReauth,
  clearAccountQuota,
  handleCodexAuthAPI,
  markAccountNeedsReauth,
  updateAccountQuota,
} from "../../src/codex/auth-api";
import { pinnedCodexAccountId } from "../../src/codex/account-priority";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/account-id";
import {
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  codexAccountPinDrainReason,
} from "../../src/codex/routing";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";

/**
 * #4521: "Use this account next" was accepted with a bare 200 for an account the very next
 * resolve would unpin. The route checks existence, pause and pending validation; the release
 * checks quota headroom. Nothing carried the second answer back to the operator, so the
 * setting looked ignored one request later.
 *
 * These pin the reporting contract and the one ordering the extraction of
 * {@link codexAccountPinDrainReason} out of the release could have silently lost.
 */
const TEST_DIR = join(import.meta.dir, ".tmp-codex-pin-drain-projection-test");
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    providers: {},
    codexAccounts: [],
    activeCodexAccountId: undefined,
    ...overrides,
  } as OcxConfig;
}

function seedAccount(config: OcxConfig, id: string): void {
  config.codexAccounts = [
    ...(config.codexAccounts ?? []),
    { id, email: `${id}@example.test`, isMain: false },
  ];
  saveCodexAccountCredential(id, {
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    expiresAt: Date.now() + 5 * 60_000,
    chatgptAccountId: `acct-${id}`,
  });
}

async function selectAccount(config: OcxConfig, accountId: string): Promise<Record<string, unknown>> {
  const req = new Request("http://localhost/api/codex-auth/active", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId }),
  });
  const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
  expect(resp!.status).toBe(200);
  return await resp!.json() as Record<string, unknown>;
}

describe("manual pin drain projection", () => {
  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    previousCodexHome = process.env.CODEX_HOME;
    if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    process.env.CODEX_HOME = TEST_DIR;
    clearThreadAccountMap();
    clearCodexUpstreamHealth();
    clearAccountQuota();
  });

  afterEach(() => {
    clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
    clearAccountQuota();
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
  });

  test("an over-threshold selection is accepted and reported as a pin the threshold will release", async () => {
    const config = makeConfig();
    seedAccount(config, "pool-pin-hot");
    updateAccountQuota("pool-pin-hot", 90);

    expect(await selectAccount(config, "pool-pin-hot")).toMatchObject({
      ok: true,
      activeCodexAccountId: "pool-pin-hot",
      appliesImmediately: true,
      pinDrained: true,
      pinDrainReason: "quota_threshold",
    });
    // Reporting the outcome is not refusing the operator: a usage score is a preference and
    // the reading can be stale, so the pin is still recorded.
    expect(pinnedCodexAccountId(config)).toBe("pool-pin-hot");
  });

  test("a selection with headroom omits both fields rather than reporting false", async () => {
    const config = makeConfig();
    seedAccount(config, "pool-pin-cool");
    updateAccountQuota("pool-pin-cool", 10);

    const body = await selectAccount(config, "pool-pin-cool");
    expect(body).toMatchObject({
      ok: true,
      activeCodexAccountId: "pool-pin-cool",
      appliesImmediately: true,
    });
    // Absent, so a client that does not know the fields reads no drain.
    expect(body).not.toHaveProperty("pinDrained");
    expect(body).not.toHaveProperty("pinDrainReason");
  });

  test("clearing the selection reports nothing, because it releases the pin instead of making one", async () => {
    const config = makeConfig();
    seedAccount(config, "pool-pin-cool");
    updateAccountQuota("pool-pin-cool", 10);
    await selectAccount(config, "pool-pin-cool");

    const req = new Request("http://localhost/api/codex-auth/active", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: null }),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    expect(resp!.status).toBe(200);
    const body = await resp!.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty("pinDrained");
    expect(pinnedCodexAccountId(config)).toBeUndefined();
  });

  test("a cached reauth is classified before the native-main fence", () => {
    const config = makeConfig();
    // A selection-only caller owns the native-main drain fence, and past it every later
    // classification answers "no drain". Reading reauth after it would make a pin on a
    // signed-out main read as durable, which is the ordering the extraction preserves.
    markAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
    expect(codexAccountPinDrainReason(config, MAIN_CODEX_ACCOUNT_ID, { nativeMainSelectionOnly: true }))
      .toBe("needs_reauth");

    clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
    expect(codexAccountPinDrainReason(config, MAIN_CODEX_ACCOUNT_ID, { nativeMainSelectionOnly: true }))
      .toBeUndefined();
  });
});
