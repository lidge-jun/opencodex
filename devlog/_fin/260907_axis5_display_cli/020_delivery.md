# Axis five delivery record

Outcome: DONE on 2026-09-07. The three feature layers landed in dev through owner-authorized admin integration. Original contribution credit is present in both carried commits and merge commits.

| Source | Delivery | Merge commit |
| --- | --- | --- |
| #3627 native OpenAI display names | #3820 | 1e16fe4c077ecf353d79c46873d8039d9176704d |
| #3780 provider list JSONL | #3821 | be24986e5ff8474ca6699895855f0ad9352e9d86 |
| #2716 discovered-model name editor | #3824 | 44c69fdd619b272066113388edd80f6c59b0682a |

The source pull requests were closed after landing. The late #3627 head 81f150e4 added metadata wording already covered by the delivery; its runtime files were checked byte-for-byte against dev before closure.

## Delivered behavior

Native labels are reversible overlays on supported bare native rows. IDs, capabilities and routing remain intact; restoring a label still respects existing pinned Astra normalization. Both retained synchronization and convergence pass the same configuration map.

JSONL emits one configured-provider object per line using the existing JSON fields. Both conflicting flag orders fail without stdout. Multi-provider parity and escaping are covered, and all translated CLI tables and generated capability documentation were updated.

The editor preserves exact selectors, validates labels, supports reset, and recovers confirmed saves separately from failed refreshes and unknown transport outcomes. Stalled operations use the existing bounded-fetch mechanism. Draft reconciliation preserves the mounted dialog and focus behavior. Desktop/mobile Korean rendering and save/reset/validation/focus were driven against the compiled CI artifact with disposable fixtures.

## Verification boundaries

- Feature head f51ec2421c49df0fd4eac8a9a56a6283b426387d: [Cross-platform CI attempt 2](https://github.com/lidge-jun/opencodex/actions/runs/34068041704/attempts/2), 25 successful jobs. Dashboard tests: 1,737 passed, zero failed. Typecheck, lint, scans and build passed.
- Late platform base changes had zero overlap with the 39-file feature delta and passed [their 26-job CI](https://github.com/lidge-jun/opencodex/actions/runs/34068218011). Independent compatibility review checked the decompression diagnostics and container lifecycle interaction.
- Prospective merge tree 85c9b25818a93859a6d6fc824e2ed0678da46c8f passed 370 focused tests on isolated Linux with project Bun 1.4.0: 344 catalog/CLI tests and 26 editor tests, zero failures. The transmitted source archive SHA-256 was ae191e1f0a809e75c9c198bc92233964880541f6747e4603a47b2c180f773d49.
- The actual final runtime merge 44c69fdd619b272066113388edd80f6c59b0682a has exactly that tested tree. This is focused merged-tree evidence plus full feature-head CI, not a claim of full CI on the final merge commit.
- No local test suite, typecheck or build ran. Pushes used --no-verify. Lower-layer CI was deferred until a final-head failure, and no cancelled or missing check was presented as passing.
- Public documentation was source-reviewed. This axis did not run a documentation build.

## Diagnostic disposition

One Mac shard reached its 20-minute limit after an unchanged history-lock test. The full Mac control had two Cursor decoded-frame-silence assertion failures; the separately annotated server-auth stream reset was intentional and its test passed. Only the unsuccessful Mac jobs were replayed, with unchanged source and limits, and they passed. The [baseline control comparison](https://github.com/lidge-jun/opencodex/actions/runs/34069848260) also passed. These observations do not establish the stall or timing root cause. No threshold increase, assertion suppression, or unrelated harness fix was included; deeper investigation remains deferred.

## Attribution

- Éverton Toffanetto
- 투린
- Zig Zag

Original author identities remain in the landed commits; this note lists names without contact addresses.

The preceding numbered files are the historical roadmap and audits; their original _plan locations refer to the planning phase before this closeout.
