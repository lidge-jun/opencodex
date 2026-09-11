import { describe, expect, test } from "bun:test";
import { gatedNativeReauthSuppressionReason } from "../../src/codex/catalog/sync";
import type { CodexModelEntitlementSnapshot } from "../../src/codex/model-entitlements";

/**
 * #4212: when the accounts backing an account-gated native model stop being usable, the model is
 * omitted from the catalog. An omission has no row, so nothing downstream could later explain the
 * disappearance — the model was simply gone, and the reporter concluded the proxy had broken.
 *
 * Two properties have to hold together, and they pull against each other. The explanation has to
 * appear for the operator whose credential is the cause, and it has to stay silent for everyone
 * else, because being unentitled to a gated model is the normal state of most installations and
 * a line printed on every sync would bury the one that matters.
 */

const SLUG = "gpt-daybreak-blue-latest";

interface AccountFixture {
  id: string;
  /** Observed roster for this account. Defaults to one that includes the gated model. */
  models?: string[];
  /** False leaves the roster unconfirmed, which is what a stuck credential looks like. */
  confirmed?: boolean;
}

function snapshot(accounts: AccountFixture[]): CodexModelEntitlementSnapshot {
  return {
    modelsByAccount: new Map(accounts.map(account => [account.id, new Set(account.models ?? [SLUG])])),
    clientVersionByAccount: new Map(),
    confirmedAccountIds: new Set(
      accounts.filter(account => account.confirmed !== false).map(account => account.id),
    ),
    credentialIdentities: new Map(),
  };
}

const label = (accountId: string): string => `label-${accountId}`;
const nobodyNeedsReauth = (): boolean => false;
const everybodyNeedsReauth = (): boolean => true;

describe("gated native suppression reason", () => {
  test("stays silent when every account is healthy", () => {
    expect(gatedNativeReauthSuppressionReason({
      snapshot: snapshot([{ id: "pool-a" }, { id: "pool-b" }]),
      slug: SLUG,
      needsReauth: nobodyNeedsReauth,
      label,
    })).toBeUndefined();
  });

  test("stays silent when no account was observed at all", () => {
    expect(gatedNativeReauthSuppressionReason({
      snapshot: snapshot([]),
      slug: SLUG,
      needsReauth: everybodyNeedsReauth,
      label,
    })).toBeUndefined();
  });

  test("stays silent when the stuck account was never entitled to this model", () => {
    // The ordinary install: a confirmed roster that simply does not list the gated model is a
    // denial, so this account is not why the model is missing. Naming it would send the operator
    // to repair a credential that was never going to produce the model.
    expect(gatedNativeReauthSuppressionReason({
      snapshot: snapshot([{ id: "pool-a", models: [] }]),
      slug: SLUG,
      needsReauth: everybodyNeedsReauth,
      label,
    })).toBeUndefined();
  });

  test("names an entitled account that is stuck", () => {
    const reason = gatedNativeReauthSuppressionReason({
      snapshot: snapshot([{ id: "pool-a" }, { id: "pool-b" }]),
      slug: SLUG,
      needsReauth: everybodyNeedsReauth,
      label,
    });
    expect(reason).toContain("every Codex account that could serve it needs reauthentication");
    expect(reason).toContain("label-pool-a");
    expect(reason).toContain("label-pool-b");
  });

  test("names an account whose roster could not be confirmed", () => {
    // This is the reported shape. A credential stuck on a failed refresh cannot confirm its
    // roster, so entitlement reads `unknown` rather than `granted` — the model disappears
    // precisely because the evidence went missing, and that account must stay a candidate.
    const reason = gatedNativeReauthSuppressionReason({
      snapshot: snapshot([{ id: "pool-a", models: [], confirmed: false }]),
      slug: SLUG,
      needsReauth: everybodyNeedsReauth,
      label,
    });
    expect(reason).toContain("every Codex account that could serve it needs reauthentication");
    expect(reason).toContain("label-pool-a");
  });

  test("reports how many accounts are stuck when only some are", () => {
    const reason = gatedNativeReauthSuppressionReason({
      snapshot: snapshot([{ id: "pool-a" }, { id: "pool-b" }]),
      slug: SLUG,
      needsReauth: accountId => accountId === "pool-a",
      label,
    });
    expect(reason).toContain("1 of 2 Codex accounts that could serve it need reauthentication");
    expect(reason).toContain("label-pool-a");
    expect(reason).not.toContain("label-pool-b");
  });

  test("counts only accounts the caller considers eligible", () => {
    // Direct mode narrows the eligible set to main. A broken pool account outside that set did
    // not cause this omission.
    expect(gatedNativeReauthSuppressionReason({
      snapshot: snapshot([{ id: "pool-a" }, { id: "main" }]),
      slug: SLUG,
      eligibleAccountIds: new Set(["main"]),
      needsReauth: accountId => accountId === "pool-a",
      label,
    })).toBeUndefined();

    const reason = gatedNativeReauthSuppressionReason({
      snapshot: snapshot([{ id: "pool-a" }, { id: "main" }]),
      slug: SLUG,
      eligibleAccountIds: new Set(["main"]),
      needsReauth: accountId => accountId === "main",
      label,
    });
    expect(reason).toContain("every Codex account that could serve it needs reauthentication");
    expect(reason).toContain("label-main");
  });

  test("orders names so the same failure produces the same sentence", () => {
    // The warning is emitted once per distinct sentence, so an unstable order would re-warn
    // about a situation that had not changed.
    const forwards = gatedNativeReauthSuppressionReason({
      snapshot: snapshot([{ id: "pool-b" }, { id: "pool-a" }]),
      slug: SLUG,
      needsReauth: everybodyNeedsReauth,
      label,
    });
    const backwards = gatedNativeReauthSuppressionReason({
      snapshot: snapshot([{ id: "pool-a" }, { id: "pool-b" }]),
      slug: SLUG,
      needsReauth: everybodyNeedsReauth,
      label,
    });
    expect(forwards).toBe(backwards!);
  });
});
