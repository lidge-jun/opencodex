import { afterEach, describe, expect, test } from "bun:test";
import { clearCachedProviderQuotas, setCachedProviderQuotaForTests } from "../../src/providers/quota-routing-cache";
import { quotaInactiveReason } from "../../src/combos/resolve";
import { buildCatalogEntries, CATALOG_INACTIVE_REASON_FIELD, deriveEntry } from "../../src/codex/catalog/sync";
import type { RawEntry } from "../../src/codex/catalog/parsing";
import type { OcxConfig } from "../../src/types";
import type { ProviderQuota } from "../../src/providers/quota";

/**
 * Regression coverage for #1711 — zero-credit models and combos were still offered as ordinary
 * selectable catalog entries, with nothing to say a request would fail.
 *
 * The quota was already known: `ProviderQuota.creditsUsd.remaining` is written on probe and read
 * back within 30 minutes, and the combo loop already refuses exhausted targets at request time.
 * It simply never reached the catalog, whose only "inactive" mechanisms REMOVE the row — the live
 * visibility filter, the disabled-routed-key merge drop, and native `visibility: "hide"`. Hiding
 * is what the issue explicitly rejects, so this adds a field that means "listed but not
 * currently serviceable" and leaves visibility alone.
 *
 * The predicate deliberately follows the RUNTIME rules, not the Dashboard's harsher
 * `quotaStateFromReport`, which treats `remaining <= 0` as exhausted without requiring
 * `percent >= 100` and ignores an elapsed `resetAt`. Marking a row inactive on the harsher rule
 * would contradict the router, which would still send the request.
 */
const NOW = Date.now();

function exhausted(updatedAt = NOW): ProviderQuota {
  return { updatedAt, creditsUsd: { remaining: 0, percent: 100, unlimited: false } } as ProviderQuota;
}

function funded(updatedAt = NOW): ProviderQuota {
  return { updatedAt, creditsUsd: { remaining: 12.5, percent: 40, unlimited: false } } as ProviderQuota;
}

function config(extra: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    providers: {
      alpha: { adapter: "openai-chat", baseUrl: "https://alpha.example.test/v1", apiKey: "sk-a" },
      beta: { adapter: "openai-chat", baseUrl: "https://beta.example.test/v1", apiKey: "sk-b" },
    },
    ...extra,
  } as OcxConfig;
}

afterEach(() => { clearCachedProviderQuotas(); });

describe("quota-inactive catalog rows (#1711)", () => {
  test("a single provider out of credit marks the row no_credit", () => {
    setCachedProviderQuotaForTests("alpha", exhausted());
    expect(quotaInactiveReason(config(), [{ provider: "alpha" }], NOW)).toBe("no_credit");
  });

  test("a refill clears the field", () => {
    setCachedProviderQuotaForTests("alpha", funded());
    expect(quotaInactiveReason(config(), [{ provider: "alpha" }], NOW)).toBeUndefined();
  });

  test("a combo needs EVERY usable target exhausted", () => {
    const targets = [{ provider: "alpha" }, { provider: "beta" }];
    setCachedProviderQuotaForTests("alpha", exhausted());
    setCachedProviderQuotaForTests("beta", funded());
    // One target can still serve, so the combo is serviceable — the same conclusion the request
    // path reaches when it hops past the exhausted target.
    expect(quotaInactiveReason(config(), targets, NOW)).toBeUndefined();
    setCachedProviderQuotaForTests("beta", exhausted());
    expect(quotaInactiveReason(config(), targets, NOW)).toBe("no_credit");
  });

  test("a stale cache entry is not exhaustion evidence", () => {
    // getCachedProviderQuota returns null past 30 minutes. An unprobed provider must never be
    // advertised as out of credit on a reading nobody refreshed.
    setCachedProviderQuotaForTests("alpha", exhausted(NOW - 31 * 60_000));
    expect(quotaInactiveReason(config(), [{ provider: "alpha" }], NOW)).toBeUndefined();
  });

  test("percent below 100 is not exhaustion, even at zero remaining", () => {
    // This is exactly where the Dashboard predicate disagrees with the router. The catalog
    // follows the router.
    setCachedProviderQuotaForTests("alpha", {
      updatedAt: NOW,
      creditsUsd: { remaining: 0, percent: 40, unlimited: false },
    } as ProviderQuota);
    expect(quotaInactiveReason(config(), [{ provider: "alpha" }], NOW)).toBeUndefined();
  });

  test("an unlimited plan is never out of credit", () => {
    setCachedProviderQuotaForTests("alpha", {
      updatedAt: NOW,
      creditsUsd: { remaining: 0, percent: 100, unlimited: true },
    } as ProviderQuota);
    expect(quotaInactiveReason(config(), [{ provider: "alpha" }], NOW)).toBeUndefined();
  });

  test("the canonical ChatGPT forward provider is exempt", () => {
    // Native account selection owns model-scoped quota; a provider-level summary cannot veto it.
    const forward = config({
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
      },
    } as Partial<OcxConfig>);
    setCachedProviderQuotaForTests("openai", exhausted());
    expect(quotaInactiveReason(forward, [{ provider: "openai" }], NOW)).toBeUndefined();
  });

  test("an operator-disabled or unknown target is not evidence, and never the sole reason", () => {
    const withDisabled = config({
      providers: {
        alpha: { adapter: "openai-chat", baseUrl: "https://alpha.example.test/v1", apiKey: "sk-a", disabled: true },
        beta: { adapter: "openai-chat", baseUrl: "https://beta.example.test/v1", apiKey: "sk-b" },
      },
    } as Partial<OcxConfig>);
    // The disabled target drops out of the vote; the one usable target decides.
    setCachedProviderQuotaForTests("beta", funded());
    expect(quotaInactiveReason(withDisabled, [{ provider: "alpha" }, { provider: "beta" }], NOW)).toBeUndefined();
    setCachedProviderQuotaForTests("beta", exhausted());
    expect(quotaInactiveReason(withDisabled, [{ provider: "alpha" }, { provider: "beta" }], NOW)).toBe("no_credit");
    // Nothing usable at all is an operator outcome, not a quota one.
    expect(quotaInactiveReason(withDisabled, [{ provider: "alpha" }], NOW)).toBeUndefined();
    expect(quotaInactiveReason(config(), [{ provider: "absent" }], NOW)).toBeUndefined();
    expect(quotaInactiveReason(config(), [], NOW)).toBeUndefined();
  });

  test("the served entry stays visibility list and carries the reason as an extension field", () => {
    // Both derivation paths, because deriveEntry builds the entry twice over: once by cloning a
    // cached template and once from scratch when none is available. Covering only one of them is
    // what let the fallback ship unstamped, so the field would have appeared or vanished
    // depending on whether a template happened to be cached.
    for (const template of [null, { slug: "gpt-5.6-sol", visibility: "list" } as RawEntry]) {
      const entry = deriveEntry(template, "alpha/model-x", "desc", 5, {
        id: "model-x",
        provider: "alpha",
        quotaInactiveReason: "no_credit",
      });
      // The whole point of the issue: still offered, just marked.
      expect(entry.visibility).toBe("list");
      expect(entry[CATALOG_INACTIVE_REASON_FIELD]).toBe("no_credit");
    }
  });

  test("a serviceable row carries no field at all", () => {
    for (const template of [null, { slug: "gpt-5.6-sol", visibility: "list" } as RawEntry]) {
      const entry = deriveEntry(template, "alpha/model-y", "desc", 5, { id: "model-y", provider: "alpha" });
      expect(entry.visibility).toBe("list");
      expect(Object.hasOwn(entry, CATALOG_INACTIVE_REASON_FIELD)).toBe(false);
    }
  });

  test("a seeded quota reaches the built catalog entry, still listed", () => {
    // The whole path in one case: seed the routing cache, let the predicate read it, carry the
    // result on the CatalogModel, and build the served entries. The unit cases above would all
    // stay green if a refactor moved the stamp out of the entry builder, and this one would not.
    setCachedProviderQuotaForTests("alpha", exhausted());
    setCachedProviderQuotaForTests("beta", funded());
    const models = [
      { id: "model-x", provider: "alpha" },
      { id: "model-y", provider: "beta" },
    ].map(model => {
      const reason = quotaInactiveReason(config(), [{ provider: model.provider }], NOW);
      return reason ? { ...model, quotaInactiveReason: reason } : model;
    });

    const entries = buildCatalogEntries(null, [], models);
    const bySlug = new Map(entries.map(entry => [entry.slug as string, entry]));
    const exhaustedRow = bySlug.get("alpha/model-x")!;
    const fundedRow = bySlug.get("beta/model-y")!;

    // Present, listed, and marked — the row is still offered, which is the issue's requirement.
    expect(exhaustedRow).toBeDefined();
    expect(exhaustedRow.visibility).toBe("list");
    expect(exhaustedRow[CATALOG_INACTIVE_REASON_FIELD]).toBe("no_credit");
    // The funded provider's row is untouched, so the marker is per-row rather than catalog-wide.
    expect(fundedRow.visibility).toBe("list");
    expect(Object.hasOwn(fundedRow, CATALOG_INACTIVE_REASON_FIELD)).toBe(false);
  });
});
