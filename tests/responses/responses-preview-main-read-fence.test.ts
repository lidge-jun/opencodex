import { describe, expect, test } from "bun:test";
import { repoPath } from "../helpers/repo-root";

/**
 * Request preview exists to predict what final authentication will decide, so the two must apply
 * the same native-main read fence. Final auth forbids those reads for three reasons and the first
 * of them is ownership: a request that authenticates with the CALLER's own credential may not
 * read, reconcile or score the physical main token (`resolveCodexAuthContext`). Preview computed
 * the same-named constant from recovery and drain state only, so a `thread_spawn` carrying a
 * forwardable caller bearer previewed with main included -- a fence violation and a
 * preview/final disagreement at once.
 *
 * Asserted on the source, like the sibling preview-site contract in
 * `tests/routing/subagent-fallback-preview-sites.test.ts`. Driving it end to end needs a
 * thread_spawn whose caller bearer is forwardable, an account-gated candidate model, and a
 * populated denial cache whose only entry is main; the fixture that arrangement demands is more
 * fragile than the divergence it would catch. What this does catch is the regression that
 * actually threatens the fix -- one of the two preview fences being reconstructed from drain
 * state alone again, which is how the recovery path came to repeat the omission.
 */
describe("preview and final agree on the native-main read fence (source contract)", () => {
  const requestPrepareSource = async (): Promise<string> =>
    Bun.file(repoPath("src", "server", "responses", "request-prepare.ts")).text();
  const authContextSource = async (): Promise<string> =>
    Bun.file(repoPath("src", "codex", "auth-context.ts")).text();

  const fenceExpression = (source: string): string => {
    const match = source.match(/const nativeMainReadsForbidden =([\s\S]*?);\n/);
    if (!match) throw new Error("no nativeMainReadsForbidden declaration found");
    return match[1]!;
  };

  test("final authentication still ORs request-owned ownership into its fence", async () => {
    // The thing preview is copying. If final auth ever stops fencing on ownership, the copy below
    // is no longer parity and this file should be revisited rather than quietly kept.
    const source = await authContextSource();

    expect(fenceExpression(source)).toContain("requestScopedMainCredential");
    // And it validates the caller's option against the header it will actually send.
    expect(source).toMatch(/options\.requestScopedMainCredential === true\s*\n?\s*&& hasCallerCodexBearer\(headers\)/);
  });

  test("the preview fence carries the same ownership term", async () => {
    const source = await requestPrepareSource();
    const fence = fenceExpression(source);

    expect(fence).toContain("previewRequestScopedMainCredential");
    // Still the other two inputs as well -- adding ownership must not have replaced them.
    expect(fence).toContain("nativeMainRecoveryBlocked");
    expect(fence).toContain("mainProfileDraining");
  });

  test("both preview sites derive ownership the way final auth validates it", async () => {
    const source = await requestPrepareSource();

    // The initial preview and the encrypted-recovery re-preview. Recovery recomputes rather than
    // reusing, because a subagent fallback above it may have re-routed and ownership is a
    // function of the route as well as the headers.
    const validated = [...source.matchAll(
      /\)\.requestScopedMainCredential\s*&&\s*hasCallerCodexBearer\(/g,
    )];

    expect(validated).toHaveLength(2);
  });

  test("no main exclusion is guarded by drain state alone", async () => {
    const source = await requestPrepareSource();

    // Every place preview withholds main from a credential-validating read. Each must be guarded
    // either by the shared fence above -- which the previous case pins to ownership -- or by its
    // own ownership term. The recovery site reconstructed this condition inline and lost the
    // ownership half; that is the regression this asserts against.
    const guards = [...source.matchAll(
      /excludeAccountIds:\s*([\s\S]*?)\?\s*new Set\(\[MAIN_CODEX_ACCOUNT_ID\]\)/g,
    )].map(match => match[1]!);

    expect(guards.length).toBeGreaterThanOrEqual(2);
    const unfenced = guards.filter(
      guard => !/nativeMainReadsForbidden|RequestScopedMainCredential/.test(guard),
    );
    expect(unfenced).toEqual([]);
  });

  test("selection-only stays derived from the drain alone, in both files", async () => {
    // The asymmetry is deliberate: final auth derives `nativeMainSelectionOnly` from the drain
    // without ownership, so adding an ownership term to the preview copy would diverge from it in
    // the other direction. Pinned so the symmetry above is not "fixed" onto this one too.
    for (const source of [await requestPrepareSource(), await authContextSource()]) {
      const derivations = [...source.matchAll(
        /nativeMainSelectionOnly\s*[:=]([\s\S]*?)mainProfileDraining === true/g,
      )].map(match => match[1]!);

      expect(derivations.length).toBeGreaterThanOrEqual(1);
      expect(derivations.filter(d => /equestScopedMainCredential/.test(d))).toEqual([]);
    }
  });
});
