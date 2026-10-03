# wp4 — Complete model, picker, combo and policy editing

Depends on wp3. Class C3; deletion and public routing identities receive focused C4 review. Layer 3.

## Exact change map and contracts

| Files | Before → after / command |
| --- | --- |
| NEW src/cli/models-custom-runtime.ts; MODIFY models.ts | `models add P M [existing metadata flags] --live --json` POSTs /api/custom-models. `models remove UUID-or-P/M --live --yes --json` resolves on the same pinned target then DELETEs UUID; no local lookup/fallback. Local add/remove gain truthful JSON save/sync receipts while retaining local behavior. |
| NEW src/cli/models-order.ts; MODIFY models-runtime.ts, models-runtime-subcommands.ts | Add `models display-name P/M --set TEXT\|--clear --json` → PUT providers/P/model-display-names {modelId,displayName:string\|null}; pricing stays separate. Add `models order status`, `set --models CSV`, `set --mode default\|alphabetical\|provider\|most-used`, `reset`. Write pickerOrder/pickerOrderMode, never featured models. NEW src/cli/model-picker-ordering.ts implements the pure projection grounded in gui/src/model-picker-order.ts:43-92; do not import GUI runtime source into shipped CLI. Known independent sorting fixtures and a test-only GUI/CLI conformance comparison guard the deliberate duplicate projection. Default/reset sends pickerOrder:null and pickerOrderMode:null. Other modes derive a complete order from pickerAvailable plus exact observed identities; most-used fetches all/all usage and refuses usageIncomplete:true. Manual writes preserve featured-prefix constraints and reject ambiguous identities. Preserve native/routed public identities. |
| MODIFY src/server/management/route-registry.ts | Declare implemented model-display-names PUT with correct regex mechanism/module. Do not change the endpoint. |
| NEW src/cli/route-policy-write.ts; MODIFY route-policy.ts | `route policy create I --file PROFILE --json` PUTs {id,mode:create,profile}. update requires explicit --expected-revision copied from show; never silently reads a fresh revision or retries conflict. remove requires --yes and DELETE query id. Domain profile file covers alias/candidates/require/optimize/limits/unknownEvidence/compatibility, using existing validation. |
| MODIFY src/cli/combo.ts (extract combo-input.ts if needed) | Extend set with --image-input auto\|disabled, --reasoning-effort-mode strict\|adaptive, --targets-file FILE and explicit native-alias off while retaining bare legacy flag. Targets preserve reasoningEfforts/modelProfile/lastResort and ordering. Omitted fields remain omitted; defaultEffortMode and reasoningEffortMode stay distinct. |
| NEW src/cli/combo-stats.ts; wire combo.ts | `combo stats I --range 7d\|30d\|all --json` GET /api/usage with jev=1, comboId, range; show actual decisions/savings and incomplete evidence, not generic model usage. |

Update pure provider-models/agents-routing capabilities, exact usages, generated chapters, CLI model/routing docs and recipes; source owners cli-management/config/catalog/subagents as affected. Do not change routing evaluator/provider algorithms.

NEW tests/cli/cli-models-custom-runtime.test.ts, cli-models-order.test.ts, cli-models-display-name.test.ts, cli-route-policy-write.test.ts, cli-combo-parity.test.ts. Use existing tests/codex-integration/model-display-names-management-api.test.ts, tests/routing/routing-profile-management-editor.test.ts and model metadata regressions for real handler/persistence truth.

## Activation matrix

- Native and routed duplicate model labels remain separate identities; encoded provider/model delimiters survive requests.
- Display reset sends null; invalid label causes zero accepted write; saved/convergence-failed response remains visible.
- Ordering shows full current order; manual/policy/default/reset match GUI semantics; most-used consumes the correct usage scope and cannot drop unranked entries.
- Revision changes between read and update produce 409/exit 5 with no automatic overwrite. Create-existing, update-missing, invalid profile and nonconfirmed delete retain distinct failures.
- Targets-file and --targets are exclusive; unsupported nested fields/invalid effort/profile are refused. Existing omitted target metadata survives partial edits; scalar effort-mode names do not alias each other.
- JEV report uses exact query and preserves missing/incomplete totals. No real decision probe/upstream request is part of tests.
- Local and live custom model branches use different temporary homes/servers; prove no wrong-target writes and preserve catalog-only versus broader local-sync receipts.

## Shared completion contract

This phase follows 002_terminal_ux.md and 003_verification_strategy.md. Main owns registry/dispatch integration, layout-map registration, generated output and Git branch state; executor write scopes are disjoint and named before B. Existing method/path/body semantics come from the referenced source inventories, not endpoint-name guessing.

Update the phase's capability domain, generated references, relevant public CLI pages and owning structure contracts in the same layer. Every new test file enters scripts/test-layout/layout.json and tests/fixtures/test-layout-expected.json. Existing tests are retained; no baseline cap increases or green-on-retry acceptance.

Planned new test paths below become executable verification only after B creates them. The current baseline gates in 003 have actually run. C invokes the exact focused files, typecheck, structure and skill-surface checks, privacy where data is handled, a source-bound cxc receipt and real isolated CLI QA (stdout/stderr/exit/teardown). A successful function mock is transport proof only; relevant existing server tests or isolated real handlers verify accepted state. No live user proxy, credentials or upstream requests.

Before P>A, revalidate this document against the parent layer and record the prior D conclusion. Consult an architect for actual decision changes; independent A review is separate. C must preserve saved-versus-applied/refused outcomes. D records exact checks and ledger evidence before the next cycle. Publishing is main-owned; this request stops at open PRs.
