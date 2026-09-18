import { beforeEach, describe, expect, test } from "bun:test";
import {
  cachedDeniedCodexAccountIdsForModel,
  clearCodexModelDenialEvidence,
  recordCodexModelDenialEvidence,
  resetCodexModelEntitlementCacheForTests,
  seedCodexModelEntitlementsForTests,
} from "../../src/codex/model-entitlements";
import {
  codexUnsupportedModelFromDetail,
  isAllowListedCodexAccountModel400,
  shouldRetryCodexPoolAccountModel400,
} from "../../src/server/responses/core-codex-account";

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

    recordCodexModelDenialEvidence("free", SOL, now);

    expect([...(cachedDeniedCodexAccountIdsForModel(SOL, now) ?? [])]).toEqual(["free"]);
    // Model-scoped: refusing Sol says nothing about Astra on the same account.
    expect(cachedDeniedCodexAccountIdsForModel(ASTRA, now)).toBeUndefined();
  });

  test("a confirmed roster grant outranks an earlier refusal", () => {
    const now = 1_800_000_000_000;
    recordCodexModelDenialEvidence("plus", ASTRA, now);
    expect([...(cachedDeniedCodexAccountIdsForModel(ASTRA, now) ?? [])]).toEqual(["plus"]);

    // A rollout reached the account. The newer answer wins, so a refusal cannot strand an
    // account that has since been granted the model.
    seedCodexModelEntitlementsForTests("plus", [ASTRA], now, TEST_CLIENT_VERSION);
    expect(cachedDeniedCodexAccountIdsForModel(ASTRA, now)).toBeUndefined();
  });

  test("a success clears the refusal for that pair only", () => {
    const now = 1_800_000_000_000;
    recordCodexModelDenialEvidence("free", SOL, now);
    recordCodexModelDenialEvidence("free", ASTRA, now);

    clearCodexModelDenialEvidence("free", SOL);

    expect(cachedDeniedCodexAccountIdsForModel(SOL, now)).toBeUndefined();
    expect([...(cachedDeniedCodexAccountIdsForModel(ASTRA, now) ?? [])]).toEqual(["free"]);
  });

  test("refusal evidence expires, and outlives the five-minute roster window", () => {
    const now = 1_800_000_000_000;
    recordCodexModelDenialEvidence("free", SOL, now);

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
    recordCodexModelDenialEvidence("free", "gpt-5.5", now);
    recordCodexModelDenialEvidence("free", DAYBREAK, now);

    expect(cachedDeniedCodexAccountIdsForModel("gpt-5.5", now)).toBeUndefined();
    // Daybreak is account-gated and fails closed through the eligibility path instead.
    expect(cachedDeniedCodexAccountIdsForModel(DAYBREAK, now)).toBeUndefined();
  });

  test("an excluded account stays unknown rather than denied", () => {
    const now = 1_800_000_000_000;
    recordCodexModelDenialEvidence("free", SOL, now);

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
});
