# 820 — Second main-to-dev regression cycle and final delivery

## Loop spec

- Archetype/trigger: satisfy-spec second independent regression cycle, explicitly required by the user after810.
- Goal: verify the composed result again using a pinned-main module-export contract and the full801matrix, then deliver one final aggregate PR and records.
- Non-goals: new product features, new debt splits, silent baseline refresh, weakened assertions, local suites, release/deploy or peer-task communication.
- Verifier: new contract test plus existing focused and full remote gates, independent adversarial review, final hosted CI, actual merged-dev tree/ancestry and post-merge result.
- Stop: all801rows have evidence, final aggregate is admin-merged, source tree/ancestry confirmed, old PRs accurately superseded, and records delivered.
- Memory:800/801/810/820, immutable000_3main baseline data, new goalplan/ledger and per-head remote artifacts.
- Outcomes: DONE only for this cutoff; unresolved regression/authority/data-integrity issues remain incomplete. Old68rows are not marked resolved.
- Escalation/resources: existing credentials and isolated task-owned staging only; unlimited user-authorized time/tokens; gpt-6-astra high internal workers, no recursion. Main reclaims after two failed workers; added write scope requires a P amendment.

## Exact additions in B

NEW `tests/fixtures/split-train-main-exports.json`: copy000_3_main_export_baseline.json byte-for-byte after810 validates it. Its14module/244value-export names were extracted from pinned main48f818 with Bun.Transpiler.scan; a synthetic check confirmed type declarations are omitted and no source modules executed. All14source files had no export-star declaration. This is an independent historical baseline, not current-DUT output.

NEW `tests/ci-workflows/split-train-main-export-contract.test.ts`:

```ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fixturePath } from "../helpers/repo-root";
import * as surface0 from "../../src/lib/redact";
import * as surface1 from "../../src/providers/openai-tiers";
import * as surface2 from "../../src/adapters/anthropic-image-normalize";
import * as surface3 from "../../src/adapters/cursor/native-exec-desktop";
import * as surface4 from "../../src/adapters/cursor/tool-definitions";
import * as surface5 from "../../src/adapters/xai-tool-schema";
import * as surface6 from "../../src/vision/index";
import * as surface7 from "../../src/responses/parser";
import * as surface8 from "../../src/claude/inbound";
import * as surface9 from "../../src/server/system-env";
import * as surface10 from "../../src/codex/prompt-layers";
import * as surface11 from "../../src/combos/types";
import * as surface12 from "../../src/codex/log-guard/inspect";
import * as surface13 from "../../src/clients/config-export";

const baseline = JSON.parse(readFileSync(fixturePath("split-train-main-exports.json"), "utf8")) as {
  baselineCommit: string;
  modules: Record<string, string[]>;
};
const surfaces: Record<string, object> = {
  "src/lib/redact.ts": surface0,
  "src/providers/openai-tiers.ts": surface1,
  "src/adapters/anthropic-image-normalize.ts": surface2,
  "src/adapters/cursor/native-exec-desktop.ts": surface3,
  "src/adapters/cursor/tool-definitions.ts": surface4,
  "src/adapters/xai-tool-schema.ts": surface5,
  "src/vision/index.ts": surface6,
  "src/responses/parser.ts": surface7,
  "src/claude/inbound.ts": surface8,
  "src/server/system-env.ts": surface9,
  "src/codex/prompt-layers.ts": surface10,
  "src/combos/types.ts": surface11,
  "src/codex/log-guard/inspect.ts": surface12,
  "src/clients/config-export.ts": surface13,
};

test("split-train baseline retains its pinned provenance and coverage", () => {
  expect(baseline.baselineCommit).toBe("48f8186647d9ffb108d226dcfa91a64225aae2a7");
  expect(Object.keys(baseline.modules).sort()).toEqual(Object.keys(surfaces).sort());
  expect(Object.values(baseline.modules).reduce((count, names) => count + names.length, 0)).toBe(244);
});

for (const [path, names] of Object.entries(baseline.modules)) {
  test(`${path} preserves pinned main exports`, () => {
    expect(Object.keys(surfaces[path]!)).toEqual(expect.arrayContaining(names));
  });
};
```

MODIFY `scripts/test-layout/layout.json` explicit map and `tests/fixtures/test-layout-expected.json`: add the basename `split-train-main-export-contract.test.ts` with value `ci-workflows` in sorted order, following existing repo-hygiene registrations. Do not alter other entries.

The guard protects these module export names, not arbitrary semantic equivalence, signatures or every program input. It permits additional exports. Existing focused behavioral tests, per-stack body/type/state review and the full matrix provide the other proof; this is not a new semver promise for unrelated internal helpers.

## Independent second-pass checks

1. Re-open810's actual findings and classifications. Use a fresh reviewer to challenge intentional-change explanations, missed caller paths, error/permission boundaries and retained source fixes.
2. Run the new guard and layout tooling remotely. Demonstrate oracle activation once by temporarily substituting an empty observed surface for redact in the remote test table; require its assertion failure, restore and require green. Label this a test-oracle control, not a reproduced product bug.
3. Repeat the main-to-final-candidate comparison with the801matrix, targeted high-risk cases, full runtime suite, typecheck, privacy and build/component/UI evidence appropriate to the actual diff. Do not count cycle1logs as cycle2execution.
4. Finalize reviewed source and public-safe documentation locally. Transfer unpublished final commits with a Git bundle for exact-head remote proof; the receipt must match the final clean candidate.
5. Publish only this stabilized head, create one templated aggregate PR, and run/observe its actual CI. A real corrective change requires fresh evidence for the new final head, never a skip or blind rerun.
6. Admin merge with expected-head protection after successful checks/review. Confirm the actual merge tree equals the tested integration tree, fetch dev and prove ancestry. Verify the actual merged dev against the pinned-main matrix and normal final dev CI before closing this second cycle.
7. Close old14PRs as superseded only after content delivery and fresh head checks prove no later edits would be lost. Preserve originals/checkpoint refs and link final delivery; do not call old PRs individually merged.

## Acceptance

- Two distinct completed PABCD regression cycles exist, with separate source/harness deltas, review and receipt evidence.
- The14-module baseline fixture is immutable/provenanced; its guard executes and fails under the named oracle control.
- Per-stack and whole main-to-final-dev results distinguish intended changes from regressions, with no unresolved failures hidden.
- All source, data registrations and reviewed devlog are in the final delivered head; no intermediate heads were published merely to start CI.
- Actual CI, admin merge/tree/ancestry, post-merge verification and old-PR disposition are recorded. No claim that remaining61debt implementations were performed.
