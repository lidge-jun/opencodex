import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

/**
 * The two subagent-fallback preview sites in `prepareResponsesRequest` must ask the same
 * question, and the only practical way to check that is to read the source.
 *
 * Split out of `subagent-fallback-handle-responses.test.ts`, which carries the end-to-end pool
 * harness and had reached its file-size cap. Nothing here needs that harness: these cases open no
 * server, install no credential, and touch no account state, so they were the part of that file
 * paying for a fixture they never used.
 */
describe("native fallback account preview sites (source contract)", () => {
  const requestPrepareSource = async (): Promise<string> => Bun.file(
    fileURLToPath(new URL("../../src/server/responses/request-prepare.ts", import.meta.url)),
  ).text();

  /**
   * Recovery must carry the ENTITLEMENT filter too, not only the quota scope (#2509).
   *
   * The end-to-end case in the sibling file grants the roster to both pool accounts, so it can
   * only prove the SCOPE is re-previewed per candidate. The recovery path re-previewed the scope
   * but passed no eligible-account set, so it could select an account with no entitlement to the
   * recovered model and fail closed at final auth — the same stale-selection class as the quota
   * scope, one layer over.
   *
   * Asserted structurally on the source, like the route-inventory contract: driving it end to end
   * needs a recovered encrypted assignment AND an account-gated candidate whose entitlement
   * differs per account, and the resulting fixture proved more fragile than the thing it checks.
   * What this does catch is the regression that actually threatens the fix — one of the two
   * preview sites silently losing the eligibility argument again.
   */
  test("both fallback preview sites pass the model-eligible account set (#2509)", async () => {
    const source = await requestPrepareSource();

    const previews = source.match(/subagentFallbackAccountPreview = \([^)]*\)/g) ?? [];
    // Two assignment sites: the primary selection path and the encrypted-recovery path.
    expect(previews).toHaveLength(2);
    // Neither may drop the third parameter — that is exactly how recovery lost it.
    for (const preview of previews) {
      expect(preview).toContain("modelEligibleAccountIds");
    }
  });

  /**
   * And both must actually forward it into the preview call, not merely accept it.
   *
   * Neither the argument list nor the options object is pinned to an exact shape: #4546 appended
   * the pool lineage after `modelId`, #4768 added `deniedModelAccountIds` beside the eligible set,
   * and pinning either would fail on unrelated growth while still not catching the regression
   * this exists for -- a site dropping `modelEligibleAccountIds` on the way in.
   *
   * Read by BRACE BALANCE rather than by a "no closing brace" character class, which was the same
   * over-pinning in a shape that did not look like one. `[^}]*` quietly assumed the options object
   * contained no nested literal, so when the #4768 follow-up gave `deniedModelAccountIds` an
   * options argument of its own, the matcher found ZERO sites and reported both call sites
   * missing -- failing on exactly the growth the comment above promises it tolerates, and failing
   * in the direction that looks like the real defect.
   */
  test("both sites forward the eligible set into the preview call itself", async () => {
    const source = await requestPrepareSource();

    const forwarded = [...source.matchAll(
      /\{\s*\.\.\.(?:previewSelectionOptions|recoverySelectionOptions),/g,
    )].map(match => {
      const start = match.index ?? 0;
      let depth = 0;
      for (let i = start; i < source.length; i++) {
        if (source[i] === "{") depth += 1;
        else if (source[i] === "}" && (depth -= 1) === 0) {
          return { options: source.slice(start, i + 1), tail: source.slice(i + 1, i + 40) };
        }
      }
      throw new Error("unbalanced selection options literal at offset " + start);
    });

    expect(forwarded).toHaveLength(2);
    for (const { options, tail } of forwarded) {
      expect(options).toContain("modelEligibleAccountIds");
      // Still the PREVIEW call rather than any other object spread from these options: the
      // literal is the argument immediately before `modelId`.
      expect(tail).toMatch(/^,\s*modelId,/);
    }
  });
});
