# Cache lane handoff index

The cache lane contains independent dev PRs, with no native stack or artificial dependency chain. Main implementation used managed worktree slot `7e43`; the coordination task owns integration and original-PR closures. This index preserves source dispositions. Exact final-head CI and source-review snapshots are exported to the [prefix PR description](https://github.com/lidge-jun/opencodex/pull/4347) and read back at delivery; private execution paths and raw scratch evidence are excluded.

| Source | Delivered PR / branch | Outcome and remaining evidence |
| --- | --- | --- |
| #4118 | [#4338](https://github.com/lidge-jun/opencodex/pull/4338), `codex/260912-60plus-cache-claim` | Claim deferral adopted. Parent integrated as `75d3e5c78f9ac7fc7125ee27294a962456bf32bb` ; the source PR is closed/unmerged, and the closer is not established. Exact carried head `d27db6dd56c481572728bc99043e2c528f11e1bc`: [hosted CI 34673563105](https://github.com/lidge-jun/opencodex/actions/runs/34673563105) SUCCESS, 19 jobs successful / 2 skipped. |
| #4050 | [#4340](https://github.com/lidge-jun/opencodex/pull/4340), `codex/260912-60plus-cache-affinity` | Go affinity adopted and reverse Go-to-ChatGPT native identity repaired. Parent integrated as `81f0c78d7a2bf56e759511e89f450c7d49e0a42e`. Final source head `d354924f0af38a48f5768fca0cd09c5145bdb4bd`, fresh repair/conflict audit PASS, blocker 0. [Hosted CI 34674962749](https://github.com/lidge-jun/opencodex/actions/runs/34674962749) pending at this checkpoint. |
| #4052 | [#4347](https://github.com/lidge-jun/opencodex/pull/4347), `codex/260912-60plus-cache-prefix` | Reimplemented behind literal-true operator configuration; ordinary callers preserve roles and keys. Fresh public P1/P2 findings superseded the first helper approval. The repaired parser uses decreasing line/fence cursors and exact single-space grammar; fresh algorithm audit PASS at `e1d262acee27d55388cccdb96430669e944fbd90`. Final repaired source head `4f6cd1ad3f0215f9cbfd5be53a55b5b6f7cd90f0` is integrated by the parent as `489af939bc68b665bfb2c3226a34267098838ab8`. The parent resolved both public findings after reading the repair. [Hosted CI 34675829597](https://github.com/lidge-jun/opencodex/actions/runs/34675829597) remains pending at this checkpoint. Final terminal evidence is exported in the PR body. |
| #3433 | [#4365](https://github.com/lidge-jun/opencodex/pull/4365), `codex/260912-60plus-cache-hermes` | Transport contract tests only, no runtime synthesis. Exact source head `b254efc8385ce2a9dc34b9a5ac7d2a449605d75d`, independent source audit PASS, blocker 0. [Hosted CI 34674763850](https://github.com/lidge-jun/opencodex/actions/runs/34674763850) pending at this checkpoint. Live issue acceptance below remains open. |

## Hermes acceptance still open

The [latest controlled field-presence observation](https://github.com/lidge-jun/opencodex/issues/3433#issuecomment-5551855276) omitted measured identity fields. The [maintainer follow-up](https://github.com/lidge-jun/opencodex/issues/3433#issuecomment-5556427205) requests a real client-assigned identity stable within a conversation and distinct for a fresh conversation, then comparison at the outbound boundary. Synthetic A/A/B fixtures verify the OCX Direct transport contract when executed; they do not prove actual Hermes emission, Pool cohort stability or improved cache hits. #3433 is not solved by the Claude PRs. #3719 thinking replay is separate.

## Review and attribution

Carry commits preserve luvs01 credit for #4118; David Wang plus original GPT-6 Astra/Claude Fable trailers for #4050; Warexpor and Cursor Agent for #4052. No code from other authors is relabeled as sole authorship.

The first affinity source review missed reverse native routing; the repair was independently reviewed before parent integration. The first prefix helper review missed quadratic scanning and broad inner whitespace; it was superseded by a fresh algorithm review after correction. A green original-PR run or plan approval never substitutes for final implementation review. Outstanding GitHub objections and final-tip status are re-read before the coordinating maintainer's decision.

## Execution record

Each work phase used its own persisted P-A-B-C-D cycle: roadmap, claim, affinity, prefix, native-affinity repair, prefix adaptation, affinity adaptation, Hermes contract, serial affinity slot, linear prefix repair, final prefix slot, then hosted-evidence verification. Source and conflict reviews used inherited-model read-only subagents; no native architect role was claimed.

Local tests of every size, build, typecheck and install were **NOT RUN** by explicit instruction. Local receipts contain text/applicability checks only. Product execution belongs to the linked GitHub-hosted runs; skipped Windows full shards and macOS control are not passing executions. Pushes used `--no-verify`, with exact old-head leases for owned branch rebases. This task did not merge, release, publish packages, restart services or change user runtime settings.

## Final evidence-cycle record

The final evidence B phase produces this tracked update as its documentation artifact. An earlier C transition was rejected by SOURCE-DELTA-01 because only scratch metadata and the PR body had changed; that rejected transition did not advance the FSM. The evidence branch now records the actual delivered source heads, parent integrations and unproven closure attribution. It changes no runtime code. Hosted terminal results must still be read before this cycle closes; an evidence document is not a product-test pass.

## Resumed terminal-CI reconciliation

The original final-tip results are now terminal: affinity run `34674962749` FAILED (native restore/injection fixtures); prefix run `34675829597` FAILED (the same restore family plus Cline registry/CLI/localization/icon/test-layout expectations); Hermes run `34674763850` FAILED (Combo active-reactivation GUI fixture). Their passing cache assertions do not make those runs green. Claim run `34673563105` remains SUCCESS and was not rerun.

Shared fixture repair #4390 is merged at `20861aebf56c6f8ec2b0d8d04d1d0b54441650bb`, containing the delivered affinity and repaired prefix heads by verified Git ancestry. Its [hosted CI 34688482827](https://github.com/lidge-jun/opencodex/actions/runs/34688482827) succeeded: 19 jobs successful, 2 skipped. This is new cumulative integration evidence, not a relabeling of the old failed results. Cache runtime sources were not rewritten to fix another lane's failure.

The remaining open Hermes PR #4365 is refreshed onto `392e182a004d61b38c7cf652642e63b9a11d9a65` without conflicts, preserving its test-only delta. Its new final head and hosted outcome are exported to that PR description and the scratch handoff after source audit and publication. Merged evidence PR #4377 is left intact. The host goal is blocked; persisted phase C is preserved and neither is claimed completed. Local product suites/build/typecheck/install remain NOT RUN.

Final Hermes slot: the coordinator pinned `c311f9bf7f5003af29fa8e7ebc2f2b5db20267f6` after the pnpm/Devin fixture corrections. The test-only PR is rebased onto that fixed base without conflicts or runtime edits. Its exact final-head source review and hosted run replace the earlier `524afd8d80` candidate evidence in the PR description. The previous failed runs remain historical failures, and actual Hermes client-field acceptance remains open.
