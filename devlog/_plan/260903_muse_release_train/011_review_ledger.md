# wp1 — Per-commit regression review (origin/main..origin/dev)

Baseline `v2.40.0` (`origin/main`). 36 commits. Risk classes and method:
`000_plan.md`, as corrected by audit round 1 (`005`).

Focused suites run for this review, all at the dev head, none of them the full
suite (forbidden for this unit):

| Batch | Files | Result |
|-------|-------|--------|
| Meta/Muse | `meta-muse-oauth`, `meta-model-api-provider`, `privacy-scan-meta-key`, `muse-spark-web-search-compat`, `opencode-go-muse-context`, `opencode-go-muse-vision`, `command-code-provider` | 97 pass / 0 fail |
| Combos + usage | `combos`, `kiro-pool-rank`, `server-combo-failover-e2e`, `usage-aggregate-cache`, `usage-ledger-scanner`, `usage-summary`, `api-key-attribution` | 274 pass / 0 fail |
| Cursor + catalog + CI | `cursor-catalog`, `cursor-claude-id`, `cursor-effort-rows`, `cursor-effort-table`, `cursor-display-names`, `cursor-discovery`, `codex-catalog`, `provider-config-batch-management`, `ci-workflows` | 500 pass / 0 fail |
| Responses + CLI + integrations | `responses-state`, `legacy-shell-compat`, `responses-custom-tool-repair`, `chat-completions-endpoint`, `claude-cli`, `cli-status-json`, `api-keys-routes`, `remote-catalog`, `client-connect`, `integrations-writer`, `grok-sync`, `codex-desired-state` | 498 pass / 0 fail |
| GUI marks | `provider-icons`, `provider-marks-assets`, `integration-marks` | 18 pass / 0 fail |

Total 1387 focused assertions' worth of files, zero failures. Plus
`bun run typecheck` exit 0 and `bun run privacy:scan` passed at the dev head.

## R3 — credential and workflow-permission changes

| SHA | PR | What it does | Evidence | Verdict |
|-----|----|--------------|----------|---------|
| `1aa839aa8` | #3337 | `meta-muse` provider importing the Muse Code CLI credential | Line-level read of `src/oauth/meta-muse.ts`. The credential never reaches an error string: Keychain stderr is discarded, the `security` child is killed on timeout, a rejected key produces `HTTP <status>` with no body, and the format check refuses anything not matching the Meta key shape (see below the table). `refreshMetaMuseToken` deliberately does not re-read the Keychain, so a `muse login` with a different account cannot silently overwrite a stored slot. 27 tests. `privacy-scan-meta-key` covers the scanner. | clean |
| `7ce0ba518` | #3262 | grants `contents: write` + `pull-requests: write` to the `bump-dev-version` call | Full diff read: 8 added lines, all inside the one job. The grant equals what `dev-version-bump.yml`'s own job already declares — a reusable-workflow call cannot give the callee more than the caller holds, which is why both v2.40.0 dispatches died at `startup_failure`. No other job in the file gains anything, and the callee is a repository-local path, not a third-party action. | clean |
| `7a529a2e8` | #3318 | `missing_coauthor_credit` gate; changes `pull_request_target` processing | The new code runs in `enforce-pr-target.yml` and `pr-hygiene.yml`, both privileged contexts. It reads `pr.title`, `pr.body` and commit messages and passes them to `resolveReferencedAuthors`, which resolves them through the GitHub API — untrusted text is used as a lookup key, never interpolated into shell. `tests/ci-workflows.test.ts` (part of the 500-pass batch) asserts no dispatch input reaches shell source. Fail-open on lookup failure, capped at five per run. | clean |
| `3c7c021ec` | #3296 | atomic dashboard provider-editor save; provider field admission | `PROVIDER_CONFIG_FIELD_POLICY` in `src/server/auth-cors.ts` classifies every `OcxProviderConfig` field as `editor`, `redacted`, or `runtime`, with `satisfies Record<keyof OcxProviderConfig, ...>` so a newly added field fails typecheck until classified. `apiKey` and `apiKeyPool` are `redacted`; MCP and desktop-executor blocks are redacted whole because both carry arbitrary env and headers. This is a tightening, not a loosening: it replaces an allowlist that had been inadequate. 356 lines of new tests in `provider-config-batch-management`. | clean |

The key-shape check named in the `1aa839aa8` row, kept out of the table because
its two pipe characters are cell delimiters to a Markdown parser:

```
/^LLM\|\d+\|[A-Za-z0-9_-]{10,}$/
```

## R2 — cross-cutting

| SHA | PR | Seam crossed | Verdict |
|-----|----|--------------|---------|
| `878f75417` | #3317 | model catalog: Muse Spark 1.3 on the 1.2 spec across command-code and opencode-go | clean — 1.3 is registered only where the reseller actually serves it; `opencode-go` keeps only the contributor tier, matching its roster. Vision and context tests pin both. |
| `ff1ac6b8c` | #3321 | provider registry + pricing: the direct `meta-model` provider | clean — id chosen as `meta-model` specifically so it cannot capture the live `meta/` selector prefix at `router.ts`, and so it derives `META_MODEL_API_KEY` rather than the CLI's `META_API_KEY`. Parity test updated in the same commit. |
| `3d3c4fe26` | #3286 | model catalog across Antigravity, Google, sidecar | clean — closed out by its own devlog unit (`f0bbaaf6a`), catalog tests green. |
| `862e914c2` | #3274 | `/v1/models` row shape (`max_output_tokens`) | clean — contract tests updated across five files in the same commit. |
| `410a48a4f` | #3275 | Cursor Claude-id normalizer replacing three seeds | clean — 85 new assertions in `cursor-claude-id`, plus catalog and pricing tests. |
| `bc8ea072d` | #3273 | Cursor effort table read from the installed bundle; new `models-capabilities` input | clean — 117 assertions in `cursor-effort-table`, cached by bundle path, mtime and size, with a static fallback for a missing or malformed bundle. |
| `2ab9d9486` | #3276 | opt-in effort-variant rows; touches `server/index.ts`, `chat-completions.ts`, `claude-messages.ts`, `responses/core.ts` | clean — the widest seam in the Cursor group, and the one with the most new coverage: 314 assertions in `cursor-effort-rows`. Opt-in by config, so an operator who does not set it sees no row change. |
| `7ce713e8d` | #3277 | GUI Cursor tab shows effort-ladder provenance | clean — nine locales updated in the same commit and `locale-parity` extended, which is the check that would otherwise let a new string ship English-only. |
| `85d40ca35` | #3270 | usage aggregation rewritten to an incremental ledger scan | clean — the largest change in the delta (1570 lines in `usage/summary.ts`), and the one with the most new coverage: `usage-aggregate-cache` (301) and `usage-ledger-scanner` (498) are both new files. Management-API docs updated in the same commit. |
| `e9a5b0f13` | #3298 | combos fail over on provider-scoped quota caps; adds a `responses/core.ts` call site | clean — 51 new assertions in `combos`; the failover reads a cap it previously ignored, so the change can only widen the set of requests that survive. |
| `2e74a35d4` | #3302 | combo resolution skips exhausted provider quotas | clean — covered by `combos` plus a dedicated `server-combo-failover-e2e` scenario. |
| `6b2dfde11` | #3294 | shorter request-rate cooldowns; `Retry-After` on a combo 503 | clean — 53 new assertions; the 503 now carries the header a client needs to back off correctly, which is a strict improvement on an opaque 503. |
| `fd324dc88` | #3256 | Kiro reset-aligned cooldown without `Retry-After` | clean — 110 assertions in `kiro-pool-rank`; scoped to the Kiro pool's own ranking, and shares `combos/failover.ts` with the three rows above, all four verified together in the 274-pass batch. |
| `938c0136a` | #3246 | tool-bridge shape for `write_stdin` | clean — repair and undeclared-tool guards both extended. |
| `b3e205e99` | #3309 | integrations: hub clients routed through loopback | clean — a narrowing; three integration test files extended. |
| `ee24bab40` | #3269 | `service-lifecycle` triggers on `release.yml` | clean, and load-bearing for this very release: it is why a workflow-only change still trips the lifecycle gate. |
| `272ff6b11` | #3265 | moved `dev` to 2.41.0 after v2.40.0 | clean — this is the version the release train is about to publish. |

## R1 — scoped runtime

| SHA | PR | Subsystem | Evidence | Verdict |
|-----|----|-----------|----------|---------|
| `38f8a8164` | #3330 | Cursor picker keeps the `cursor/` slug for unbranded rows | `cursor-display-names` rewritten in the same commit; in the 500-pass batch | clean |
| `472c785c2` | #3308 | `ocx status` reports a reachable dashboard URL | `cli-status-json` +35 lines; in the 498-pass batch | clean |
| `906511f73` | #3310 | `connect` uses the catalog inactivity timeout | `remote-catalog` +50, `client-connect` +8; docs and skill page updated with it | clean |
| `eac662eb1` | #3307 | rotation creation time returned by the API-key route | `api-keys-routes` +40; a one-field addition to a response | clean |
| `4cf3e9187` | #3297 | liveness probes retried before `ocx claude` spawns a proxy | `claude-cli` +17; retry only, no new spawn path | clean |
| `34c9e9802` | #3289 | stops the background write storm on `responses-state.json` | `responses-state`; 9 lines in `src`, the rest devlog. A write-frequency reduction | clean |
| `b0a42ca2f` | #3254 | chat-native shares the transient send budget across recovery | `chat-completions-endpoint` +145 | clean |
| `fc08fc2f7` | #3290 | log panel no longer jitters as rows scroll in | GUI-only; `logs-auto-refresh` and `viewport-scroll-caps` extended | clean |
| `15b43e51c` | #3301 | provider-option E2E made hermetic | test-only; removes an external dependency from a test | clean |

## R0 — docs only

| SHA | PR | What | Verdict |
|-----|----|------|---------|
| `bb27c26be` | #3319 | contributor-credit unit closeout | clean — `devlog/` only |
| `af314b0a7` | #3311 | bug-drawdown campaign closeout | clean — `devlog/` only |
| `f0bbaaf6a` | #3292 | Gemini 3.8 rollout closeout | clean — `devlog/` only |
| `529639a57` | #3278 | Cursor Private Inference guide | clean — `docs-site/` only |
| `345e2175c` | #3272 | Cursor bundle effort-table roadmap | clean — `devlog/` only |
| `7424719ab` | #3267 | Windows CI repair and v2.40.0 outcome | clean — `devlog/` only |

Each R0 diff was checked with `git show --stat` to confirm it touches no path
outside `devlog/` or `docs-site/`; nothing in the build, typecheck, or test
path reads from either.

## Findings

**No blockers.** One accepted residual, carried from audit round 1 (`005` §1)
and detailed in `050_followups.md`: the Terms-of-Service acknowledgement for
`HIGH_RISK` OAuth providers is enforced client-side, so `POST
/api/oauth/login` and `ocx account login` do not surface it. Accepted for this
release because it predates the delta, applies identically to `anthropic` and
`google-antigravity`, sits behind management auth, and involves no credential
disclosure. Publishing v2.41.0 does not change that exposure for anyone.
