# 000 - Master plan: Router Intelligence / Routing Control Plane

Status: ACTIVE
Created: 2026-08-04
Owner: Codex agent (this programme)
Target repository: `lidge-jun/opencodex` (`upstream`), target branch `dev`
Stack base: `upstream/dev` `e44d234f08e03dd4dbf0c4aa13af43046d86b0a6`

This unit implements the missing routing-intelligence vertical: durable "why
this route?" decision traces, a rebuildable full-history query index, routing
analytics, and explicit user-configured policy profiles with capability,
health, quota and cost scoring. It is **inference routing only**: no Agent
Fabric tasks, harness handoffs, ACP/A2A, worktree orchestration, agent teams,
or portable coding-task state.

## 1. Verified current state (2026-08-04, live repository)

Environment:

- Bun: `1.3.14` (`bun --version` in the dedicated worktree)
- Package version: `2.10.0` (`package.json`)
- Remotes: `origin` = `Wibias/opencodex` (user fork), `upstream` = `lidge-jun/opencodex`
- `origin/dev` = `be177ea501e5007f4a56d19d069ef5cd76ea24b9` (2026-07-30, merge of #761)
- `upstream/dev` = `e44d234f08e03dd4dbf0c4aa13af43046d86b0a6` (2026-08-04, merge of #949)
- `origin/dev` is a strict ancestor of `upstream/dev` (`git merge-base` = `be177ea`)
- Stack base decision: **`upstream/dev` head** is the base for every branch
  because PRs target `lidge-jun/opencodex:dev` and the routing/combos/quota
  infrastructure this programme extends only exists on `upstream/dev`
  (landed 2026-08-01..04). `origin/dev` is recorded above for provenance.
- Worktree: `D:\codex-worktrees\ocx-router-intelligence` (one task = one
  folder = one branch; branches switch inside it, worktree stays clean)
- Test baseline: full `bun run test` was started in the background on a clean
  `upstream/dev` checkout; result recorded in `001_pr_stack_status.md`. The
  suite is large (~8k tests; a 15-minute foreground run did not finish on
  this machine, so the baseline is collected out-of-band).

Relevant existing modules (all verified by direct read):

| Module | Role for this programme |
|---|---|
| `src/router.ts` | Central `routeModel(config, modelId)` resolver. Precedence: codex account namespace -> combo -> explicit `<provider>/<model>` -> bare OpenAI family -> `defaultModel` -> pattern -> provider model lists -> `config.defaultProvider`. Returns `RouteResult { providerName, provider, modelId, codexAccountMode?, codexAccountId?, codexAccountNamespace?, combo? }`. **RI-01 capture point.** |
| `src/combos/types.ts` | Combo schema validation (`comboConfigIssues`, alias rules, `NATIVE_OPENAI_FAMILY_PATTERN`), normalization (`normalizeComboConfig`), `COMBO_NAMESPACE = "combo"`, `resolveComboId`, `getCombo`, `isValidComboId`. **RI-04 mirrors this pattern for profiles.** |
| `src/combos/resolve.ts` | `pickComboTarget` (failover / smooth weighted round-robin), `advanceComboAfterFailure`, `noteComboSuccess/Failure`, `tryPickComboModel`. Candidate/attempt semantics RI-01 traces. |
| `src/combos/failover.ts` | Per-target cooldown (`coolComboTarget`, `isComboTargetInCooldown`). |
| `src/combos/request.ts` | `comboIdFromRawBody`, `concreteComboRequestBody` (target model rewrite). |
| `src/codex/routing.ts` (1677) | Codex account-pool routing: per-account upstream health maps, cooldown (retry-after / reset-derived / default), quota recovery probe leases, thread affinity, pool strategies (quota / round-robin / fill-first), `recordCodexUpstreamOutcome`, `getCodexAccountHealthSnapshot`, `isCodexAccountInCooldown`, soft-avoid, `computeCodexUsageScore`. **RI-06/07 evidence source.** |
| `src/codex/auth-context.ts` | `resolveCodexAuthContext`, account selection + credential fencing. Boundary: RI-07 must not change exact-account fail-closed semantics. |
| `src/usage/log.ts` | `PersistedUsageEntry`/`PersistedUsageAttempt`, `appendUsageEntry` -> `normalizeUsageEntry` whitelist serializer, revision-keyed cooperative reads, 64 MiB / 200k-entry management truncation, `readRecentUsageEntries` for hydration. **RI-01 extends this schema additively.** |
| `src/server/request-log.ts` | `RequestLogContext` -> `RequestLogEntry` -> `addRequestLog` (retains ring + `appendUsageEntry` with failure diagnostics) and `addFinalRequestLog`; `requestLogEntryFromPersistedUsage`; `hydrateRequestLogsFromDisk`. **RI-01 hydration + DTO extension points.** |
| `src/server/management/logs-usage-routes.ts` | `GET /api/logs` (in-memory ring, offset/limit/tail), `/api/usage` summary. SQLite mentions are Codex `state.sqlite` busy-error strings only - no usage index exists. |
| `src/server/management/shared.ts` | `requestLogDto` with display-only cost/TPS metrics; `costResult`, `unavailableCostReason`. |
| `src/usage/summary.ts` | Daily rollups (`summarizeUsage`), ranges/surfaces. No percentiles, no breakdowns. |
| `src/usage/cost.ts`, `src/usage/expected-prices.ts` | `estimateRequestCost`, `estimateComboCost`, `normalizeCostTokens`, `tokensPerSecond`, `serviceTierContext`; expected-price overlay with `source: "expected"`. **RI-08 evidence source.** |
| `src/providers/quota.ts` (1276) | Provider quota reports + cache (`fetchProviderQuotaReports`, `clearProviderQuotaCache`). **RI-07 evidence source.** |
| `src/providers/context-cap.ts` | Global/provider context caps. **RI-05 requirement input.** |
| `src/codex/catalog/` | Catalog aggregation (`CatalogModel`: contextWindow, inputModalities, reasoningEfforts, ...), native windows (`nativeOpenAiContextWindow`), provider-fetch/sync. **RI-05 capability evidence.** |
| `src/config.ts` | `validateConfigCandidate`; combos validated via `comboConfigIssues` (~line 1233); `saveConfigPreservingClaudeCode`. **RI-04 wiring point.** |
| `src/types.ts` | `OcxConfig` (line 542), `combos` (line 775), `OcxComboConfig` (794). **RI-04 adds `routingProfiles` here.** |
| `src/cli/index.ts`, `src/cli/combo.ts` | Hand-rolled dispatch; `ocx route combo <id>` already exists. **RI-04/09 CLI wiring points.** |
| `gui/src/pages/Logs.tsx` (1059), `Combos.tsx`, `gui/src/i18n/{en,de,ja,ko,ru,zh}.ts` | Existing dashboard grammar and strict locale-key enforcement (`lint:i18n`). **RI-10 surfaces.** |
| `docs-site/src/content/docs/reference/configuration/routing.md` (96), `guides/combos.md` (286) | Docs anchors for configuration and combos. **RI-04/10 docs.** |

Mandatory searches (run on `upstream/dev` tree; authoritative):

- `route decision`, `decision trace`, `routing profile`, `policy profile`,
  `candidate exclusion`, `health score`, `quota headroom`,
  `latency percentile`, `cursor pagination`: **zero matches** in `src/`,
  `tests/`, `gui/src/`, `docs-site/src/`. The vertical is genuinely missing.
- `bun:sqlite`: used by `src/oauth/kiro-credentials.ts`,
  `src/codex/history-provider.ts`, `src/codex/model-cache.ts`,
  `src/codex/native-profile-store.ts`, `src/storage/*`. Bun's built-in SQLite
  is therefore available and in active use; no third-party DB dependency is
  needed for RI-02.
- `SQLite`: `src/server/management/logs-usage-routes.ts` mentions
  `state.sqlite` only in Codex-busy error strings. **No usage-history index
  exists.**

Related in-flight work (checked 2026-08-04; no blocking overlap):

| In-flight item | Relationship | Boundary this programme keeps |
|---|---|---|
| PR #922 `fix/914-account-neutral-network` (luvs01, DRAFT, 19 commits, updated 2026-08-04) | Implements host/account transport-health separation for #914 | RI-06 consumes its outcome classification (`connect-neutral` / host ledger) as health evidence. We do **not** re-implement failure classification, redirect policy, or host circuits. |
| PR #966 `codex/260804-issue914-transport-attribution` (Yuxin-Qiao, DRAFT, updated 2026-08-04) | Alternative #914 implementation (pre-connection classifier + host ledger) | Same: consumed as evidence input, never duplicated. The two PRs overlap each other; that is a maintainer decision, not ours to close - neither is stale. |
| PR #715 `feat/priority-levels` (DRAFT) | Codex pool selection order | Documented boundary: pool strategies remain authoritative inside their scope; policy profiles own candidate selection only when explicitly invoked. |
| PR #988 `codex/providers-copy-doctor` (GUI) | Providers/combos layout work | RI-10 keeps its GUI surface to new pages + Logs/route-detail additions; conflict-check `Providers.tsx`/`Combos.tsx` ownership at RI-10 time. |
| PR #998 `codex/260803-integration-switches` | Write-substrate changes | Watch for conflict with `request-log.ts`; rebase boundary noted in ledger. |
| `devlog/_fin/260803_transport_attribution` | #914/#919 policy unit | Now embodied by #922/#966; we consume, not implement. |
| `devlog/_fin/260803_cooldown_recovery_probe` | #915 recovery probe (Not started) | RI-06 reads cooldown state only; never touches probe leases/generations. |
| `devlog/_fin/260730_kiro_usage_cumulative_cache` | Usage persist layer (`usage/log.ts`) | Our JSONL extension is additive (`routeDecision` field); we do not touch the `normalizeUsageValue` whitelist or `contextTotalTokens`. |
| `devlog/_fin/260804_stacked_pr_ci` | Empty placeholder created 2026-08-04 | Referenced; no concrete overlap. |

## 2. Reuse-versus-new-work table

| Work item | Reuse | New work |
|---|---|---|
| Trace types + bounds | `PersistedUsageEntry` shape, `capMetadataString`/whitelist discipline in `usage/log.ts`, `RequestLogContext` plumbing | `src/routing/trace.ts` (types, builder, normalizer, redaction, truncation) |
| Trace capture | `routeModel()` call sites in `src/server/responses/core.ts`, `compact.ts`, `chat-completions.ts`, `claude-messages.ts`, `fetch-helpers.ts` | One-line `routeDecision` attachment per call site; candidate derivation for combo routes from `getCombo` + `isComboTargetInCooldown` |
| Full-history index | `bun:sqlite` (already used repo-wide); `usageLogRevision` file-identity discipline | `src/routing/history/*` (schema, indexer, cursor, queries, rebuild) + `ocx logs rebuild-index` |
| Cursor API | `jsonResponse`/auth-cors helpers, management route registration | `GET /api/request-history`, `GET /api/request-history/:id` |
| Analytics | `usage/summary.ts` rollup style | Percentiles, rates, breakdowns, confidence, truncation flags over the SQLite index |
| Profile schema | Combos validation/normalization pattern (`comboConfigIssues`) | `src/routing/profile.ts`, config wiring in `src/config.ts` + `src/types.ts` |
| Policy execution | `routeModel` integration point, catalog capability data | `src/routing/evaluator.ts` + `policy-execution.ts` |
| Health scoring | `src/codex/routing.ts` health/cooldown APIs, `recordCodexUpstreamOutcome` fields | Deterministic formula + trace components (`src/routing/health.ts`) |
| Quota scoring | `src/providers/quota.ts`, codex quota caches | Unknown-safe evidence adapter + scoring (`src/routing/quota.ts`) |
| Cost scoring | `src/usage/cost.ts`, `expected-prices.ts` | Cost limits, provenance, incomplete-estimate flags (`src/routing/cost.ts`) |
| Explainability | `requestLogDto`/management API patterns, `handleLogsUsageRoutes` | `GET .../route-decision`, profile endpoints, `ocx logs explain`, `ocx route policy evaluate` |
| GUI | `Logs.tsx` detail modal grammar, `Combos.tsx` card grammar, i18n key discipline | Profiles list/detail/dry-run view, why-this-route view, analytics chips |
| Docs | `routing.md`, `combos.md` structure, five locales (en/ja/ko/ru/zh-cn) | Policy profiles guide, history API, explainability, migration notes |

## 3. Architecture decision records

- **ADR-1 - Canonical ledger stays authoritative.** `usage.jsonl` remains the
  canonical append-only request evidence. `routing-history.sqlite` is a
  disposable, rebuildable derived query index. No index state is ever written
  back into the JSONL, and the index never owns data the JSONL does not carry.
- **ADR-2 - Trace rides the usage entry.** `RouteDecisionTraceV1` is persisted
  as an optional, additive field (`routeDecision`) on `PersistedUsageEntry`.
  Rejected alternative: a separate trace store (two-phase commit hazards,
  ordering complexity, duplicated privacy surface). Old rows parse; new rows
  are forward-compatible by whitelist normalization.
- **ADR-3 - Selection and execution stay separate.** The trace records the
  selection decision before dispatch. Fallback execution attempts remain the
  existing `attempts[]` array on the usage entry. The trace's
  `selected`/`candidates` never mutate after dispatch; the explain API merges
  trace + attempts + final outcome at read time.
- **ADR-4 - Explicit routing keeps precedence.** Policy routing activates
  only for an explicitly requested `policy/<id>` or configured alias. Existing
  selectors (account namespace, provider/model, `combo/<id>`, native model
  ids, default-provider) are byte-for-byte unchanged.
- **ADR-5 - Unknown is not zero.** Unknown capability/health/quota/price stays
  unknown in evidence. Each profile's `unknownEvidence` map (allow /
  penalize / exclude) decides scoring; safe defaults: capability `exclude`,
  health `penalize`, quota `penalize`, cost `penalize`.
- **ADR-6 - Deterministic scoring.** Weights normalize by exact division with
  fixed-point truncation; candidates score component-wise with documented
  constants; ties break by candidate declaration order, then provider/model
  lexicographic order. No randomness, no wall-clock jitter.
- **ADR-7 - Revision digest.** Profile revision = first 16 hex chars of
  SHA-256 over canonical normalized JSON (sorted keys, trimmed strings). Every
  decision trace for a policy carries `profile.id` + `profile.revision`.
- **ADR-8 - Index rebuild contract.** `schema_meta` stores schema version,
  source file identity (dev/ino/birthtime/size/mtime), and indexed byte
  offset. Missing/corrupt/stale/incompatible index or a changed source
  identity => full rebuild from JSONL (transactional batches, `requestId`
  primary key dedupe). Partial final JSONL lines are skipped and re-read on
  the next append. Crash during indexing rolls back to the last committed
  batch (WAL + batch transaction).
- **ADR-9 - Keyset cursor pagination.** `ORDER BY timestamp DESC,
  request_id DESC`, cursor = base64url(`{t, i}`) of the last returned row.
  No offset for unbounded history; max page size 100; invalid cursors return
  `400 invalid_cursor`.
- **ADR-10 - No automatic self-tuning.** Analytics are read-only. The system
  never rewrites profile weights, budgets, or candidate sets from observed
  outcomes. Explainability is the only feedback loop.
- **ADR-11 - Transparent formulas.** Health/quota/cost scores use explicit
  deterministic formulas with named constants (documented in `src/routing/`
  and the docs). No learned model, no hidden priors.

## 4. Durable data model

### 4.1 `usage.jsonl` row extension (RI-01)

```ts
interface RouteDecisionTraceV1 {
  version: 1;
  decisionId: string;            // 12-hex, random per decision
  createdAt: number;             // epoch ms
  requestedModel: string;        // capped 128 (MAX_TRACE_STRING)
  routeKind: "explicit-account" | "explicit-provider" | "native"
           | "combo" | "policy" | "default-provider";
  profile?: { id: string; revision: string };   // policy routes only
  requirements: RouteRequirementEvidence[];      // max 16
  candidates: RouteCandidateTrace[];             // max 8
  selected: {
    candidateIndex: number;      // index into candidates
    provider: string;            // capped 128
    model: string;               // capped 128
    accountRef?: string;         // opaque id or privacy-safe handle, capped 128
    reason: string;              // stable code, capped 128
    tieBreak?: string;
  };
  truncated?: { candidates?: true; exclusions?: true; strings?: true };
}
```

`RouteCandidateTrace`: `{ provider, model, accountRef?, eligible, exclusions
(max 16 of `{code, detail?}`), capability?, health?, quota?, cost?, score? }`.
Evidence shapes:

- `capability`: `{ contextWindow?, tools?, image?, structuredOutput?,
  reasoningEfforts?, serviceTier?, localOnly?, remoteAllowed?,
  encryptedCodexTasks? }` - every field `number | boolean | "unknown"`.
- `health`: `{ cooldownUntilMs?, softAvoidUntilMs?, successRate?, failures?,
  incompleteStreamRate?, recentLatencyMs?, sampleCount?, recencyWeight? }`.
- `quota`: `{ known, headroomTokens?, exhausted?, resetAtMs?,
  reauthOrCooling?, reservedHeadroomTokens?, source }`.
- `cost`: `{ estimatedUsd?, priceSource?, incomplete?, limitUsd? }`.
- `score`: `{ total, components: { capability?, health?, quota?, cost?,
  latency?, configuredPriority? } }`.

Bounds: `MAX_CANDIDATES = 8`, `MAX_EXCLUSIONS_PER_CANDIDATE = 16`,
`MAX_REQUIREMENTS = 16`, `MAX_TRACE_STRING = 128`, `MAX_TRACE_BYTES approx 16 KiB`
(enforced by builder; oversized inputs truncated with `truncated` flags).
Stable wire values only; no localized strings in persisted data.

### 4.2 `routing-history.sqlite` (RI-02, derived index)

```sql
CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);  -- schema_version, source_path/dev/ino/birthtime_ms/size/mtime_ms,
    -- indexed_offset, indexed_rows, built_at_ms, last_error

CREATE TABLE requests (
  request_id       TEXT PRIMARY KEY,
  timestamp        INTEGER NOT NULL,
  provider         TEXT NOT NULL,
  model            TEXT NOT NULL,
  requested_model  TEXT,
  status           INTEGER NOT NULL,
  surface          TEXT,
  inbound_protocol TEXT,
  api_key_id       TEXT,
  conversation_id  TEXT,
  route_kind       TEXT,
  profile_id       TEXT,
  profile_revision TEXT,
  fallback         INTEGER NOT NULL DEFAULT 0,   -- attempts.length > 1
  duration_ms      INTEGER NOT NULL,
  first_output_ms  INTEGER,
  usage_status     TEXT,
  usage_json       TEXT,
  total_tokens     INTEGER,
  error_code       TEXT,
  terminal_status  TEXT,
  close_reason     TEXT,
  attempt_count    INTEGER NOT NULL DEFAULT 1,
  decision_json    TEXT,   -- RouteDecisionTraceV1 when present
  row_json         TEXT NOT NULL  -- full normalized PersistedUsageEntry
);
CREATE INDEX idx_requests_ts ON requests(timestamp DESC, request_id DESC);
CREATE INDEX idx_requests_provider ON requests(provider);
CREATE INDEX idx_requests_model ON requests(model);
CREATE INDEX idx_requests_requested_model ON requests(requested_model);
CREATE INDEX idx_requests_status ON requests(status);
CREATE INDEX idx_requests_conversation ON requests(conversation_id);
CREATE INDEX idx_requests_api_key ON requests(api_key_id);
CREATE INDEX idx_requests_profile ON requests(profile_id);
```

Indexer appends by byte offset, skips a trailing partial line, and commits
batches of 500 rows in one transaction (WAL mode). Duplicate `request_id`
replay is ignored (`INSERT OR IGNORE`). File identity change, size regression
(truncation), or `PRAGMA integrity_check` failure => automatic full rebuild
plus a `last_error`/`rebuilt_at` audit row.

### 4.3 Routing profile config (RI-04)

```jsonc
{
  "routingProfiles": {
    "fast": {
      "alias": "ocx/fast",                  // optional; canonical id is policy/fast
      "candidates": ["anthropic/claude-sonnet-5", "openai/gpt-5.6-sol", "google/gemini-3.6-pro"],
      "require": { "tools": true, "minContextWindow": 128000 },
      "optimize": { "latency": 0.55, "health": 0.25, "cost": 0.10, "quota": 0.10 },
      "limits": { "maxEstimatedCostUsd": 0.50 },
      "unknownEvidence": { "capability": "exclude", "health": "penalize", "quota": "penalize", "cost": "penalize" }
    }
  }
}
```

Normalized profile: strategy-free v1 (explicit candidate allowlist only; no
implicit expansion), `alias` optional (one `/` segment at most, bare aliases
reject the native OpenAI family per the combos rule), hard `require`
requirements evaluated before scoring, weights normalized to sum 1 with
deterministic truncation, revision digest per ADR-7.

## 5. Privacy and security threat model

- Never persisted anywhere in this vertical: prompt bodies, message bodies,
  tool arguments/results, API keys, OAuth tokens, raw account emails, raw
  provider quota responses, authorization headers, hidden reasoning / CoT,
  raw upstream response bodies.
- Account references: existing opaque ids (`codexAccountId`, `apiKeyId`) or
  privacy-safe handles only. Provider quota evidence is reduced to
  `{known, headroomTokens?, exhausted?, resetAtMs?, reauthOrCooling?}` -
  never the raw response.
- Diagnostic strings: capped at `MAX_TRACE_STRING` and passed through the
  existing `redactSecretString` discipline where they originate from upstream
  text. Trace builder rejects `provider.apiKey` and URL credentials by
  construction (it only receives names/ids, never config objects with
  secrets).
- The SQLite index lives in the config dir with the same `0o600` file mode as
  `usage.jsonl` and carries only data already present in the canonical ledger.
- `privacy:scan` gate must stay green; any new log/CLI output uses bounded,
  redacted values.
- Trust boundary: management APIs already require a dashboard session / admin
  token (`auth-cors`); new endpoints register through the same path.
- Threat model summary: local attacker with filesystem access already owns
  `usage.jsonl`; the index adds no new secret surface. Network attacker sees
  no new data (index is local). Upstream attacker cannot inject into the
  index beyond what already lands in the canonical ledger; row parsing is
  defensive (malformed JSONL rows are skipped, oversized traces truncated).

## 6. Compatibility strategy

- Old `usage.jsonl` rows (no `routeDecision`) parse unchanged.
- New rows remain valid for every existing reader (`requestLogEntryFromPersistedUsage`,
  `/api/logs`, `/api/usage`, per-key rollups) because the field is additive
  and the normalizer whitelists it.
- Existing config files need no migration: `routingProfiles` is optional and
  absent-by-default.
- `/api/logs` contract unchanged by RI-02; the new `/api/request-history` is
  additive.
- Combo and Codex pool behavior is untouched by all ten PRs; policy routing
  is inert until a `policy/<id>`/alias model id is requested.
- All new API/CLI output uses stable wire codes plus display-ready summaries;
  no locale strings in persisted data.

## 7. Migration and recovery strategy

- RI-01: additive field; no migration. Hydration of old rows is automatic.
- RI-02: first open creates the schema; subsequent opens append by offset.
  `ocx logs rebuild-index` forces a full rebuild. Corruption => automatic
  rebuild (documented in `last_error` + `rebuilt_at`).
- RI-04+: config validation rejects invalid profiles at load; a broken config
  fails closed exactly like a broken combo (existing `validateConfigCandidate`
  behavior) and never falls back to scoring existing routes.
- Rollback: each PR is independently revertable. Removing RI-01's field write
  is safe (readers ignore it); removing RI-02 deletes only the disposable
  index; removing RI-04..10 leaves canonical routing byte-identical.

## 8. PR dependency graph

```text
dev (upstream e44d234f)
`- RI-01 feat/ri-01-route-decision-traces
   `- RI-02 feat/ri-02-request-history-index
      `- RI-03 feat/ri-03-routing-analytics
         `- RI-04 feat/ri-04-policy-profile-core
            `- RI-05 feat/ri-05-capability-aware-routing
               `- RI-06 feat/ri-06-health-aware-routing
                  `- RI-07 feat/ri-07-quota-aware-routing
                     `- RI-08 feat/ri-08-cost-aware-routing
                        `- RI-09 feat/ri-09-route-explainability-api
                           `- RI-10 feat/ri-10-routing-intelligence-ui
```

Each PR targets its predecessor's head while open; after merge it can be
retargeted to `dev`. Branches are pushed to `origin` (Wibias fork), draft PRs
target `lidge-jun/opencodex:dev`. **Never merged by this programme.**

## 9. Acceptance criteria per PR

- **RI-01**: traces exist for all five existing route kinds; same
  provider/model before/after; combo/pool tests unchanged; old JSONL rows
  parse; oversized traces truncate deterministically; no secrets/prompts in
  traces; trace round-trips through usage.jsonl -> `/api/logs`.
- **RI-02**: index rebuilds from empty/missing/corrupt/truncated/replaced
  JSONL; partial final line skipped; duplicate replay ignored; cursor stable
  under append; invalid cursor 400; page bounds enforced; `/api/logs` and
  usage.jsonl untouched; `ocx logs rebuild-index` works.
- **RI-03**: success/failure/fallback rates, attempt count, p50/p95/p99
  duration + TTFT, incomplete-stream rate, cooldown-failure count,
  provider/model/account breakdown, profile breakdown, estimated cost per
  success, coverage + confidence + truncation indicators - all sourced from
  the index; no routing change.
- **RI-04**: schema validation, collision rules, revision digest, normalized
  weights, dry-run evaluator, management API + CLI read/dry-run; no production
  routing change.
- **RI-05**: `policy/<id>`/alias requests execute with hard capability
  requirements (context window, text/image input, tools, structured output,
  reasoning effort, service tier, local/remote, encrypted-Codex-task
  readability) using catalog/registry evidence; unknown handling per profile;
  deterministic priority scoring; all other routes unchanged.
- **RI-06**: health score from cooldown, recent success rate, consecutive
  failures, incomplete-stream rate, latency, sample count, recency, failure
  class; network-neutral and client-cancel never damage health; low sample =
  reduced confidence; cooldown stays authoritative; components in trace.
- **RI-07**: quota evidence from existing sources with unknown-safe handling;
  headroom preference; reset/exhausted/reauth state; reserved headroom;
  profile min-headroom; exact account selectors fail closed; pool strategies
  authoritative; selection/account-pool boundary documented.
- **RI-08**: cost estimate + price source + incomplete flag + limit
  exclusion + cost component in trace; no billing/budgets.
- **RI-09**: `/api/request-history/:id/route-decision`,
  `/api/routing-profiles`, `/api/routing-profiles/dry-run`, `ocx logs explain
  <id>`, `ocx route policy evaluate <profile>`; stable codes + display
  summaries; attempt sequence + outcome included.
- **RI-10**: GUI surfaces (profiles list/detail/candidates/requirements/
  weights/unknown-evidence/dry-run; why-this-route with exclusions, scores,
  fallback timeline; analytics) with existing grammar, no invented green
  health for unknown evidence, accessible + keyboard-operable, all locale
  keys present in all six GUI locales (en/de/ja/ko/ru/zh), responsive; docs
  (config, CLI, API, migration, combo-vs-profile distinction) in all five
  docs-site locales (en/ja/ko/ru/zh-cn - the docs site intentionally ships
  no German edition; the GUI does).

## 10. Test strategy

Per-PR gates: `bun x tsc --noEmit`, focused `bun run test <files>`, and
`bun run privacy:scan`; full suite once per PR where feasible (recorded in
ledger). GUI PRs add `bun run lint:gui`, GUI unit tests, production build,
locale parity, and a screenshot in the PR body (required by `enforce-target`
when the description mentions `gui`). Docs PRs run the docs build and link
validation where available.

Mandatory matrix coverage (per the programme brief):

- Trace: explicit routes unchanged; combo routes unchanged; old JSONL parse;
  oversized truncation; no secrets; corruption; trace matches decision.
- Index: empty, large, corrupt, missing DB, old schema, partial final line,
  replacement, truncation, duplicate replay, concurrent query during append,
  cursor stability, invalid cursor, page bounds, rebuild equivalence.
- Policy: explicit routes unchanged; combo unchanged; alias collision; all
  candidates excluded; unknown capability/health/quota/price; deterministic
  tie; hard cost limit; cooldown; client cancellation; account-neutral
  network error; fallback after selected-target failure; trace-exactly-
  matches-decision.

## 11. Rollback strategy

Per-PR revert order is reverse of the stack. RI-01 removal is lossless for
new features (field simply stops being written); RI-02 removal deletes a
disposable index; RI-04..10 removal restores canonical routing with zero
behavioral delta. Config files written with `routingProfiles` remain valid in
older versions (unknown top-level keys are tolerated; to be verified against
`validateConfigCandidate` behavior in RI-04 and documented).

## 12. Rejected alternatives

- Separate trace store (ADR-2): ordering/commit hazards, duplicated privacy
  surface.
- Full-file JSONL scan for analytics instead of SQLite index: O(file) per
  query, already bounded at 64 MiB/200k entries for management reads; fails
  the full-history query requirement.
- Third-party DB (better-sqlite3 etc.): `bun:sqlite` is available and used;
  a new native dependency is unjustified.
- Implicit candidate expansion ("all models on the internet"): rejected for
  determinism, privacy, and explainability; v1 is explicit allowlist only.
- Automatic weight self-tuning from analytics: rejected (ADR-10); explainable
  routing is the product.
- ML-based health prediction: rejected (ADR-11); transparent constants.
- Persisting raw quota responses / upstream bodies for richer traces:
  rejected by the privacy threat model.

## 13. Final user-facing behavior

- Every request records a bounded, privacy-safe route-decision trace that
  answers: which candidates were considered, why each was rejected/penalized,
  which evidence was used, which profile/revision decided, what was selected,
  and what happened during fallback.
- `ocx logs explain <request-id>` and the GUI "why this route?" view render
  the full explanation from the durable trace + attempts + outcome.
- `/api/request-history` gives cursor-paginated full-history querying with
  filters; `/api/routing-analytics` gives reliability/latency/cost
  breakdowns with confidence and truncation indicators.
- `routingProfiles` in config.json let a user declare policy profiles
  (`policy/fast` or a public alias) with hard requirements, optimization
  weights, cost limits, and unknown-evidence policy; dry-run evaluation is
  available via CLI and management API before any traffic is routed.
- Explicitly requested policy profiles execute with capability-aware scoring;
  health, quota and cost scoring are additive, deterministic, and auditable.
- Nothing auto-tunes; routing stays explainable and user-configured.

## 14. Exact non-goals

- No Agent Fabric tasks, harness handoffs, ACP, A2A, worktree orchestration,
  agent teams, or portable coding-task state.
- No automatic self-tuning or silent profile mutation.
- No monthly billing, invoicing, or hidden automatic budgets.
- No implicit candidate discovery beyond the configured allowlist.
- No changes to explicit account/provider/native/combo/default routing
  behavior.
- No re-implementation of #914/#919 transport attribution (owned by #922/
  #966; consumed as evidence).
- No changes to Codex pool selection order (#715) or cooldown recovery probes
  (#915); RI-06/07 only read their state.
- No prompt/message/tool content persistence anywhere.
- No generic enterprise dashboard redesign in RI-10.

## 15. Related docs

- Stack ledger: `devlog/_fin/260804_router_intelligence/001_pr_stack_status.md`
- Combos vs policy profiles: `docs-site/src/content/docs/guides/combos.md`
  (extended in RI-10); configuration reference `routing.md` (extended in
  RI-04/RI-10).
