import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearProviderQuotaCache, fetchProviderQuotaReports } from "../../src/providers/quota";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
let opencodexHome: string;

function deepSeekConfig(): OcxConfig {
  return {
    defaultProvider: "deepseek",
    providers: {
      deepseek: {
        adapter: "openai-chat",
        authMode: "key",
        baseUrl: "https://api.deepseek.com",
        apiKey: "deepseek-secret",
      },
    },
  } as OcxConfig;
}

/** Answer the DeepSeek balance probe with exactly these `balance_infos` rows. */
async function balanceLabels(rows: unknown[]): Promise<string[]> {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    is_available: true,
    balance_infos: rows,
  }), { status: 200 })) as typeof fetch;

  const result = await fetchProviderQuotaReports(deepSeekConfig(), true);

  expect(result.reports).toHaveLength(1);
  expect(result.reports[0]?.source).toBe("deepseek:balance");
  return (result.reports[0]?.quota.customWindows ?? []).map(window => window.label);
}

async function balanceLabel(rows: unknown[]): Promise<string | undefined> {
  return (await balanceLabels(rows))[0];
}

beforeEach(() => {
  opencodexHome = mkdtempSync(join(tmpdir(), "ocx-deepseek-quota-"));
  process.env.OPENCODEX_HOME = opencodexHome;
  clearProviderQuotaCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearProviderQuotaCache();
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  removeTreeWithRetry(opencodexHome);
});

describe("DeepSeek quota balance currency", () => {
  test("a CNY-only row renders the yuan sign", async () => {
    expect(await balanceLabel([{ currency: "CNY", total_balance: "76.88" }]))
      .toBe("API balance (¥76.88)");
  });

  test("a CNY row with a granted balance renders both amounts in yuan", async () => {
    expect(await balanceLabel([{ currency: "CNY", total_balance: "76.88", granted_balance: "12.5" }]))
      .toBe("API balance (¥76.88 total, ¥12.50 granted)");
  });

  test("a USD row keeps the dollar sign", async () => {
    expect(await balanceLabel([{ currency: "USD", total_balance: "6" }]))
      .toBe("API balance ($6.00)");
  });

  test("any other currency prefixes the upper-cased code", async () => {
    expect(await balanceLabel([{ currency: "eur", total_balance: "5" }]))
      .toBe("API balance (EUR 5.00)");
  });

  test("a row without a currency keeps the legacy dollar sign", async () => {
    expect(await balanceLabel([{ total_balance: "5" }]))
      .toBe("API balance ($5.00)");
  });

  test("a zero USD wallet does not shadow a non-zero CNY wallet", async () => {
    expect(await balanceLabels([
      { currency: "USD", total_balance: "0.00", granted_balance: "0.00", topped_up_balance: "0.00" },
      { currency: "CNY", total_balance: "6.06", granted_balance: "0.00", topped_up_balance: "6.06" },
    ])).toEqual(["API balance (¥6.06)"]);
  });

  test("a zero CNY wallet is omitted when USD has a positive balance", async () => {
    expect(await balanceLabels([
      { currency: "CNY", total_balance: "0.00" },
      { currency: "USD", total_balance: "7" },
    ])).toEqual(["API balance ($7.00)"]);
  });

  test("both positive wallets are shown with USD ordered before CNY", async () => {
    expect(await balanceLabels([
      { currency: "CNY", total_balance: "10" },
      { currency: "USD", total_balance: "7" },
    ])).toEqual(["API balance ($7.00)", "API balance (¥10.00)"]);
  });

  test("both positive wallets preserve per-currency granted amounts", async () => {
    expect(await balanceLabels([
      { currency: "CNY", total_balance: "10", granted_balance: "4" },
      { currency: "USD", total_balance: "7", granted_balance: "2" },
    ])).toEqual([
      "API balance ($7.00 total, $2.00 granted)",
      "API balance (¥10.00 total, ¥4.00 granted)",
    ]);
  });

  test("all-zero wallets fall back to a single top-priority row (USD over CNY)", async () => {
    expect(await balanceLabels([
      { currency: "CNY", total_balance: "0.00" },
      { currency: "USD", total_balance: "0.00" },
    ])).toEqual(["API balance ($0.00)"]);
  });

  test("malformed or negative earlier rows do not mask a valid wallet", async () => {
    expect(await balanceLabels([
      { currency: "USD", total_balance: "not-a-number" },
      { currency: "CNY", total_balance: "6.06" },
    ])).toEqual(["API balance (¥6.06)"]);

    expect(await balanceLabels([
      { currency: "USD", total_balance: "-1" },
      { currency: "CNY", total_balance: "6.06" },
    ])).toEqual(["API balance (¥6.06)"]);
  });

  test("duplicate currency rows keep the first valid row per currency", async () => {
    expect(await balanceLabels([
      { currency: "CNY", total_balance: "6.06" },
      { currency: "CNY", total_balance: "9.99" },
    ])).toEqual(["API balance (¥6.06)"]);
  });
});
