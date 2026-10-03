# wp5 — Complete account policy, login options and model-runtime settings

Depends on wp4. Class C3 with scoped C4 credential/cost/ownership review. Layer 4. Existing v2/account/agent roots remain; no duplicate agent-mode family.

## Account and auth contracts

NEW src/cli/account-policy.ts, MODIFY account.ts/account-extended.ts/account-auth.ts only at owned dispatch/parsing seams:

- `account pool P [--enabled on|off] [--threshold N] [--quota-window W] [--strategy S] [--sticky N] --json`: GET/PUT unified /api/pool/settings. Respect per-provider supported fields; absent fields preserved. Pool enabled is not threshold zero. Existing strategy/sticky/Anthropic per-account commands remain.
- `account auto-switch openai ACTION --account I --json`: resolve ID/alias/main, PUT /api/codex-auth/auto-switch {id,threshold}; inherit sends null. Without --account preserve existing pool scope.
- `account credits openai I on|off --json` or `account credits openai --all on|off --json`: exclusive selectors, exact /accounts/credits {id,creditsAfterLimit} or {all}. Clearly name paid-credit opt-in; display preference never implies permission. Read-back is the roster.
- `account quota-activation openai I --window W on|off --json`: PUT settings {codexQuotaAutoRefresh:{id,window,enabled}} with existing window vocabulary and no other settings changes.
- `account anthropic-reset-grants [I] --json`: GET-only existing endpoint. No consume command; session-only spend stays a GUI handoff.
- Extend account login with explicit --open-browser on|off and --add-account on|off. Omitted flags preserve prior CLI defaults, not a guessed new default. Device, account id and flow id remain distinct. No automatic human verification.
- NEW logout-command.ts, MODIFY dispatch.ts: `logout P --live --json` uses fixed runtime logout endpoint; no local credential removal before target selection or after failure. No-live retains removed/not-found behavior. No new stored credential system.

## Runtime/model settings contracts

NEW src/cli/agent-settings.ts and v2-runtime.ts; MODIFY agent.ts, system-command.ts, v2.ts and dispatch/registry where needed:

- system settings adds --show-codex-credits, --account-picker, --main-account-hard-lock, --ultra-fast-tier, --fast-rows booleans mapped to existing keys only. Provider Fast is separate.
- agent injection/guidance adds --sync-codex-defaults on|off, preserving model/effort/null semantics and normalized returned state.
- agent sidecar web adds --stream-routed-output; vision adds --timeout-ms. Partial fields must retain siblings and inherited helper behavior.
- agent memory-models show/set/clear: fixed settings memoryModels block with extract/consolidation model + optional reasoningEffort. set accepts --extract-model/--extract-effort and --consolidation-model/--consolidation-effort, or exclusive --file. Each invocation replaces the full memoryModels block; omitted phase means off, effort without a model is refused, clear sends null. No empty phase objects. Reuse existing memoryModelsSchema.
- agent compaction-routing show/set/clear: set accepts required --model plus optional --effort, --triggers manual,auto and --sources selectors, or exclusive --file; clear sends null. Each set replaces the full block; omitted triggers/sources retain server default/all scope. Reuse compactionRoutingSchema; preserve exact selectors, no surprise upstream call.
- Existing v2 status/on/off/mode/keep-native-v1/threads/mode-hint gain explicit --live and --json. Live maps exactly to GET/PUT /api/v2: enabled, multiAgentMode, keepNativeChatGptOnV1, maxConcurrentThreadsPerSession, multiAgentModeHintText. Only explicit --acknowledge-surface-advisory writes true; never auto-ack. Parse output/target flags and reject extra operands before local writers. Local transition/hint helpers remain; JSON reports local changed/sync outcome, not fabricated server receipts.

All commands reuse established API and identity helpers. Runtime base is pinned across resolution/write. No credential writes or settings switches are performed against the operator's proxy in development QA.

Metadata and docs: capabilities-accounts/agents-routing/observe-system, exact help, skill recipes and public account/agent docs. Update cli-management.md, config.md, subagents.md, account-control/provider ownership docs and Desktop integration contracts only where changed.

NEW tests/cli/cli-account-policy.test.ts, cli-account-login-options.test.ts, cli-logout-runtime.test.ts, cli-agent-settings.test.ts, cli-system-settings-parity.test.ts, cli-v2-runtime.test.ts. Reuse existing account pool, threshold, native-main, schema and v2 tests. No additions to capped codex-v2-gate file.

## Activation matrix

Invalid/mixed selectors, unsupported pool fields, off/false/zero/null, threshold inheritance and account-not-found are distinct. Credits all/one cannot combine and never consume reset grants. Quota activation writes only its nested mutation. Login cancellation/expiry/refusal retains flow identity and no hidden fresh retry. Live refusal cannot fall back to local auth/config.

Memory phases round-trip independently; disabling removes effort; compaction clear/null is distinct from omitted setting. v2 local and live targets use disjoint fixtures; hybrid conflicts and persisted-but-convergence-failed receipts remain visible. Machine output remains one safe JSON payload with no progress prose or secret values. Explicit security review covers spend intent, auth scope and native ownership.

## Shared completion contract

This phase follows 002_terminal_ux.md and 003_verification_strategy.md. Main owns registry/dispatch integration, layout-map registration, generated output and Git branch state; executor write scopes are disjoint and named before B. Existing method/path/body semantics come from the referenced source inventories, not endpoint-name guessing.

Update the phase's capability domain, generated references, relevant public CLI pages and owning structure contracts in the same layer. Every new test file enters scripts/test-layout/layout.json and tests/fixtures/test-layout-expected.json. Existing tests are retained; no baseline cap increases or green-on-retry acceptance.

Planned new test paths below become executable verification only after B creates them. The current baseline gates in 003 have actually run. C invokes the exact focused files, typecheck, structure and skill-surface checks, privacy where data is handled, a source-bound cxc receipt and real isolated CLI QA (stdout/stderr/exit/teardown). A successful function mock is transport proof only; relevant existing server tests or isolated real handlers verify accepted state. No live user proxy, credentials or upstream requests.

Before P>A, revalidate this document against the parent layer and record the prior D conclusion. Consult an architect for actual decision changes; independent A review is separate. C must preserve saved-versus-applied/refused outcomes. D records exact checks and ledger evidence before the next cycle. Publishing is main-owned; this request stops at open PRs.
