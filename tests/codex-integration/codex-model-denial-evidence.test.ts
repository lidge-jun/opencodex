import { beforeEach, describe, expect, test } from "bun:test";
import {
  cachedDeniedCodexAccountIdsForModel,
  clearCodexModelDenialEvidence,
  recordCodexModelDenialEvidence,
  resetCodexModelEntitlementCacheForTests,
  seedCodexModelEntitlementsForTests,
} from "../../src/codex/model-entitlements";
import { setObservedDenialGenerationCheck } from "../../src/codex/observed-model-denials";
import {
  codexUnsupportedModelFromDetail,
  isAllowListedCodexAccountModel400,
  shouldRetryCodexPoolAccountModel400,
} from "../../src/server/responses/core-codex-account";
import { markResponseNonReplayable } from "../../src/lib/upstream-retry";

/** Credential generation these fixtures record under (#4952). */
const GEN = 1;

const TEST_CLIENT_VERSION = "0.146.0";
const DAYBREAK = "gpt-daybreak-blue-latest";
const SOL = "gpt-5.6-sol";
const ASTRA = "gpt-6-astra";

/** The exact refusal body the ChatGPT Codex backend returns for an unentitled model. */
function refusalBody(modelId: string): string {
  return JSON.stringify({
    detail: `The '${modelId}' model is not supported when using Codex with a ChatGPT account.`,
  });
}

function refusalResponse(modelId: string): Response {
  return new Response(refusalBody(modelId), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => resetCodexModelEntitlementCacheForTests());

/**
 * #4906. `#4797` taught selection to order by roster denial, and the reporter still lands on a
 * Free account for Sol and Astra after a refresh and a catalog sync.
 *
 * The reason is that the roster is the only evidence the reader had, and a roster entry lives
 * five minutes (`MODEL_ROSTER_TTL_MS`). Nothing on the flagship request path refetches it --
 * `resolveCodexModelEntitlements` is awaited only for `ACCOUNT_GATED_NATIVE_OPENAI_MODELS`,
 * which holds Daybreak alone since the 2026-09-04 owner decision. So for most requests the
 * denial set is absent, both ordering rules are the identity function, and the pool chooses on
 * quota alone.
 *
 * These tests pin the second source of evidence: the upstream refusal itself. It is
 * account-specific, model-specific, authenticated, and it does not expire on the roster's
 * schedule.
 */
describe("upstream refusal as per-account model denial evidence", () => {
  test("a recorded refusal denies the account with no roster cached at all", () => {
    const now = 1_800_000_000_000;
    // Precondition, and the whole of #4906: with no roster evidence the reader is silent, so
    // selection sees nothing and picks the Free account on quota.
    expect(cachedDeniedCodexAccountIdsForModel(SOL, now)).toBeUndefined();

    recordCodexModelDenialEvidence("free", SOL, GEN, now);

    expect([...(cachedDeniedCodexAccountIdsForModel(SOL, now) ?? [])]).toEqual(["free"]);
    // Model-scoped: refusing Sol says nothing about Astra on the same account.
    expect(cachedDeniedCodexAccountIdsForModel(ASTRA, now)).toBeUndefined();
  });

  test("a confirmed roster grant outranks an earlier refusal", () => {
    const now = 1_800_000_000_000;
    recordCodexModelDenialEvidence("plus", ASTRA, GEN, now);
    expect([...(cachedDeniedCodexAccountIdsForModel(ASTRA, now) ?? [])]).toEqual(["plus"]);

    // A rollout reached the account. The newer answer wins, so a refusal cannot strand an
    // account that has since been granted the model.
    seedCodexModelEntitlementsForTests("plus", [ASTRA], now, TEST_CLIENT_VERSION);
    expect(cachedDeniedCodexAccountIdsForModel(ASTRA, now)).toBeUndefined();
  });

  test("a success clears the refusal for that pair only", () => {
    const now = 1_800_000_000_000;
    recordCodexModelDenialEvidence("free", SOL, GEN, now);
    recordCodexModelDenialEvidence("free", ASTRA, GEN, now);

    clearCodexModelDenialEvidence("free", SOL, GEN);

    expect(cachedDeniedCodexAccountIdsForModel(SOL, now)).toBeUndefined();
    expect([...(cachedDeniedCodexAccountIdsForModel(ASTRA, now) ?? [])]).toEqual(["free"]);
  });

  test("refusal evidence expires, and outlives the five-minute roster window", () => {
    const now = 1_800_000_000_000;
    recordCodexModelDenialEvidence("free", SOL, GEN, now);

    // The roster TTL is where #4797's evidence disappeared. This must still be answering there.
    expect([...(cachedDeniedCodexAccountIdsForModel(SOL, now + 5 * 60_000 + 1) ?? [])])
      .toEqual(["free"]);
    expect([...(cachedDeniedCodexAccountIdsForModel(SOL, now + 6 * 60 * 60_000 - 1) ?? [])])
      .toEqual(["free"]);
    // It is still evidence about a moment, not a permanent verdict.
    expect(cachedDeniedCodexAccountIdsForModel(SOL, now + 6 * 60 * 60_000 + 1)).toBeUndefined();
  });

  test("only always-visible natives are recorded, so a 400 elsewhere cannot steer routing", () => {
    const now = 1_800_000_000_000;
    recordCodexModelDenialEvidence("free", "gpt-5.5", GEN, now);
    recordCodexModelDenialEvidence("free", DAYBREAK, GEN, now);

    expect(cachedDeniedCodexAccountIdsForModel("gpt-5.5", now)).toBeUndefined();
    // Daybreak is account-gated and fails closed through the eligibility path instead.
    expect(cachedDeniedCodexAccountIdsForModel(DAYBREAK, now)).toBeUndefined();
  });

  test("an excluded account stays unknown rather than denied", () => {
    const now = 1_800_000_000_000;
    recordCodexModelDenialEvidence("free", SOL, GEN, now);

    // The native-main read fence: an excluded account must produce the selection it does today.
    expect(cachedDeniedCodexAccountIdsForModel(SOL, now, {
      excludeAccountIds: new Set(["free"]),
    })).toBeUndefined();
    expect([...(cachedDeniedCodexAccountIdsForModel(SOL, now, {
      excludeAccountIds: new Set(["other"]),
    }) ?? [])]).toEqual(["free"]);
  });
});

/**
 * The detector that decides whether a 400 IS that refusal.
 *
 * It gained the wire model because `applyCodexAccountGatedWireNormalization` rewrites Daybreak
 * to `gpt-5.6-sol` before dispatch, so upstream names Sol while `route.modelId` is still
 * Daybreak. Comparing against the route model alone made the match fail for the only model that
 * is still account-gated, which disabled both its alternate-account retry and the eight-rung
 * same-account ladder that exists specifically for it.
 */
describe("unsupported-model refusal detection", () => {
  test("extracts the model upstream named", () => {
    expect(codexUnsupportedModelFromDetail(400, refusalBody(SOL))).toBe(SOL);
    // Case and whitespace are normalized exactly as before.
    expect(codexUnsupportedModelFromDetail(400, JSON.stringify({
      detail: `The '${SOL}'   model is  NOT supported when using Codex with a ChatGPT account.`,
    }))).toBe(SOL);
  });

  test("admits nothing but that exact envelope", () => {
    expect(codexUnsupportedModelFromDetail(400, JSON.stringify({ detail: "Bad request" })))
      .toBeUndefined();
    // Prose around the sentence is not the sentence.
    expect(codexUnsupportedModelFromDetail(400, JSON.stringify({
      detail: `note: The '${SOL}' model is not supported when using Codex with a ChatGPT account.`,
    }))).toBeUndefined();
    expect(codexUnsupportedModelFromDetail(400, JSON.stringify({ error: refusalBody(SOL) })))
      .toBeUndefined();
    expect(codexUnsupportedModelFromDetail(400, "not json")).toBeUndefined();
    // A different status is a different fact, whatever the body says.
    expect(codexUnsupportedModelFromDetail(403, refusalBody(SOL))).toBeUndefined();
  });

  test("matches the wire model when normalization rewrote it", () => {
    // Before the fix this was `false`: upstream names Sol, the route still says Daybreak.
    expect(isAllowListedCodexAccountModel400(400, refusalBody(SOL), DAYBREAK, SOL)).toBe(true);
    expect(isAllowListedCodexAccountModel400(400, refusalBody(SOL), DAYBREAK)).toBe(false);
    // The route model still matches on its own, so the unnormalized path is unchanged.
    expect(isAllowListedCodexAccountModel400(400, refusalBody(SOL), SOL)).toBe(true);
    // And an unrelated model is still not a match under either id.
    expect(isAllowListedCodexAccountModel400(400, refusalBody(ASTRA), DAYBREAK, SOL)).toBe(false);
  });

  test("the response-level predicate carries the wire model through", async () => {
    expect(await shouldRetryCodexPoolAccountModel400(refusalResponse(SOL), DAYBREAK, undefined, SOL))
      .toBe(true);
    expect(await shouldRetryCodexPoolAccountModel400(refusalResponse(SOL), DAYBREAK))
      .toBe(false);
    expect(await shouldRetryCodexPoolAccountModel400(refusalResponse(SOL), SOL)).toBe(true);
    expect(await shouldRetryCodexPoolAccountModel400(
      new Response("{}", { status: 400 }),
      SOL,
    )).toBe(false);
    expect(await shouldRetryCodexPoolAccountModel400(
      new Response(refusalBody(SOL), { status: 200 }),
      SOL,
    )).toBe(false);
  });

  test("a non-replayable refusal never opens an alternate-account retry", async () => {
    // The answer to a spent ambiguous-reset replacement arrives marked: the turn may already
    // have run, so even the exact unsupported-model refusal cannot send it from another account.
    const marked = refusalResponse(SOL);
    markResponseNonReplayable(marked);
    expect(await shouldRetryCodexPoolAccountModel400(marked, SOL)).toBe(false);
    expect(await shouldRetryCodexPoolAccountModel400(refusalResponse(SOL), SOL)).toBe(true);
  });
});

// ─── Credential generation (#4952) ───────────────────────────────────────────
//
// Denial evidence is about a CREDENTIAL, not an account id. Reauthenticating the
// same internal account keeps the id and increments the generation, and can swap
// the subscription underneath it — so a refusal earned by the old credential must
// not steer routing away from the replacement. The account-wide forget that used
// to be relied on sits behind a condition requiring a previously cached roster,
// so with no roster it never runs; these pin the store's own behaviour instead.

describe("denial evidence is scoped to the credential generation (#4952)", () => {
  beforeEach(() => {
    resetCodexModelEntitlementCacheForTests();
  });

  /** The liveness seam is a factory so one lookup loads the credential store once. */
  function onlyGenerationIsLive(live: number): void {
    setObservedDenialGenerationCheck(() => (_id, generation) => generation === live);
  }

  test("evidence from a superseded credential stops denying the replacement", () => {
    const now = Date.now();
    recordCodexModelDenialEvidence("pooled", SOL, 1, now);
    expect(cachedDeniedCodexAccountIdsForModel(SOL, now)).toEqual(new Set(["pooled"]));

    // The account reauthenticates: same id, generation 1 is no longer live.
    onlyGenerationIsLive(2);

    expect(cachedDeniedCodexAccountIdsForModel(SOL, now)).toBeUndefined();
  });

  test("a late refusal from the old generation cannot deny the replacement", () => {
    const now = Date.now();
    // The replacement has already been refused and re-granted, so nothing is recorded
    // for generation 2 — then generation 1's in-flight 400 finally lands.
    onlyGenerationIsLive(2);
    recordCodexModelDenialEvidence("pooled", SOL, 1, now);

    expect(cachedDeniedCodexAccountIdsForModel(SOL, now)).toBeUndefined();
  });

  test("a late refusal cannot overwrite newer evidence", () => {
    const now = Date.now();
    recordCodexModelDenialEvidence("pooled", SOL, 2, now);
    // Generation 1's refusal arrives afterwards; it must not take the entry back a
    // generation, which would make it vanish the moment the reader checks liveness.
    recordCodexModelDenialEvidence("pooled", SOL, 1, now);

    onlyGenerationIsLive(2);
    expect(cachedDeniedCodexAccountIdsForModel(SOL, now)).toEqual(new Set(["pooled"]));
  });

  test("a late success from the old generation cannot clear newer evidence", () => {
    const now = Date.now();
    recordCodexModelDenialEvidence("pooled", SOL, 2, now);
    // Generation 1's 200 lands after generation 2 was refused. Clearing here would
    // re-admit an account that the current credential has just been refused by.
    clearCodexModelDenialEvidence("pooled", SOL, 1);

    onlyGenerationIsLive(2);
    expect(cachedDeniedCodexAccountIdsForModel(SOL, now)).toEqual(new Set(["pooled"]));
  });

  test("a success from the same generation still clears, which is the ordinary case", () => {
    const now = Date.now();
    recordCodexModelDenialEvidence("pooled", SOL, 2, now);
    clearCodexModelDenialEvidence("pooled", SOL, 2);
    expect(cachedDeniedCodexAccountIdsForModel(SOL, now)).toBeUndefined();
  });

  // A `main-pool` context — the stored main login taking part in rotation — has a real account
  // id and NO pool credential generation, because its credential lives in auth.json. Dropping
  // its evidence would silently revert #4906 for that account: the pool would re-send the model
  // the login just refused, on every request. Its evidence is account-scoped instead.
  test("evidence with no generation is account-scoped, not discarded", () => {
    const now = Date.now();
    recordCodexModelDenialEvidence("main-pool-account", SOL, undefined, now);
    expect(cachedDeniedCodexAccountIdsForModel(SOL, now)).toEqual(new Set(["main-pool-account"]));
  });

  test("account-scoped evidence is not expired by a pool generation rolling over", () => {
    const now = Date.now();
    recordCodexModelDenialEvidence("main-pool-account", SOL, undefined, now);
    // No generation was ever claimed, so there is nothing for the liveness fence to supersede.
    onlyGenerationIsLive(7);
    expect(cachedDeniedCodexAccountIdsForModel(SOL, now)).toEqual(new Set(["main-pool-account"]));
  });

  test("an account-scoped success clears account-scoped evidence", () => {
    const now = Date.now();
    recordCodexModelDenialEvidence("main-pool-account", SOL, undefined, now);
    clearCodexModelDenialEvidence("main-pool-account", SOL, undefined);
    expect(cachedDeniedCodexAccountIdsForModel(SOL, now)).toBeUndefined();
  });

  // The write fence has to reject a stale refusal BEFORE it mutates the map, not only when the
  // same key already holds newer evidence. With no entry for its own key the stale row would be
  // inserted, and at the entry bound the insert evicts the oldest valid row — which no later
  // read fence can restore, because the evidence is simply gone.
  test("a stale refusal for an unseen key cannot evict valid evidence at the entry bound", () => {
    const now = Date.now();
    recordCodexModelDenialEvidence("first-pooled", SOL, 2, now);
    for (let i = 0; i < 511; i++) recordCodexModelDenialEvidence(`filler-${i}`, SOL, 2, now);
    expect(cachedDeniedCodexAccountIdsForModel(SOL, now)?.has("first-pooled")).toBe(true);

    // Generation 1 is dead and this account has no entry of its own. The insert would take the
    // map to 513 and evict the oldest row, which is the valid one recorded first.
    onlyGenerationIsLive(2);
    recordCodexModelDenialEvidence("late-stale", SOL, 1, now);

    const denied = cachedDeniedCodexAccountIdsForModel(SOL, now);
    expect(denied?.has("first-pooled")).toBe(true);
    expect(denied?.has("late-stale")).toBe(false);
  });

  // The issue asks for identity validation AFTER the exclusion read fence. An excluded account
  // — a draining profile switch, or a request-owned credential — must not cause a credential
  // store read on its behalf, and must stay unknown rather than denied.
  test("an excluded account is skipped before the liveness check reads anything", () => {
    const now = Date.now();
    recordCodexModelDenialEvidence("excluded", SOL, 1, now);
    let lookups = 0;
    setObservedDenialGenerationCheck(() => {
      lookups += 1;
      return () => true;
    });

    expect(cachedDeniedCodexAccountIdsForModel(SOL, now, {
      excludeAccountIds: new Set(["excluded"]),
    })).toBeUndefined();
    expect(lookups).toBe(0);
  });

  test("the credential store is opened at most once per lookup", () => {
    const now = Date.now();
    recordCodexModelDenialEvidence("pool-a", SOL, 1, now);
    recordCodexModelDenialEvidence("pool-b", SOL, 1, now);
    recordCodexModelDenialEvidence("pool-c", SOL, 1, now);
    let opens = 0;
    setObservedDenialGenerationCheck(() => {
      opens += 1;
      return () => true;
    });

    expect(cachedDeniedCodexAccountIdsForModel(SOL, now)).toEqual(new Set(["pool-a", "pool-b", "pool-c"]));
    expect(opens).toBe(1);
  });
});
