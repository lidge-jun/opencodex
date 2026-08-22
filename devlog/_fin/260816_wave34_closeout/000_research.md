# 000 — Wave 3/4 research: what the roadmap got right and wrong

Source: the external Wave 3-4 roadmap (same audit conversation, second answer). Baseline `origin/dev` = `7c348a032`.

The roadmap was written against a GitHub snapshot taken while the Wave 0/1/2 loop was still running, so it is stale in BOTH directions: it asks for work already done, and it invents symbols that do not exist while missing machinery that does.

## W3-00 — already satisfied

The roadmap opens with a public-dev convergence gate because it saw Wave 2 PRs still open. Verified now: PRs `#1805 #1806 #1741 #1825 #1817 #1819 #1788 #1780 #1792 #1703` are all MERGED and issues `#1786 #1824 #1785 #1700 #1767 #1668 #1697` are all CLOSED. The gate passes; no action.

## Roadmap symbols that do not exist

| Roadmap name | Reality |
|---|---|
| `materializeCodexUpstreamAuth()` | absent. The real shared builder is `headersForCodexAuthContext(headers, ctx)` at `src/codex/auth-context.ts:454`. |
| `CatalogConvergenceError` | absent. Failures are DATA, not throws: `CatalogDisposition` with `reason: provider-auth \| provider-network \| disk` at `src/codex/convergence-types.ts:160`. |
| `provider_family` / `route_account_key` / `conversation_root_key` / `model_key` | absent. A stronger contract already exists: `OcxReasoningReplayIdentity` at `src/types.ts:3-21`. |
| `clean/routed/recoverable/ambiguous/invalid` classifier | absent as one enum. Three separate classifiers exist: residue `clean\|residue\|indeterminate` (`src/codex/native-residue.ts:46`), integration record `missing\|ready\|invalid` (`src/codex/integration-record.ts:98`), coordinator `ready\|legacy-ambiguous\|unavailable` (`src/codex/convergence-types.ts:298`). |
| `adoption-pending` row | exists only in the ARCHIVED design doc `devlog/_fin/260804_codex_write_substrate/005_contract.md:709`, not in runtime. |
| `context_window_too_small` / `modality_unknown` / `compatible_fallback` | absent. |

## Roadmap machinery that already exists

- `DataPlaneAdmission` DOES exist (`src/server/auth-cors.ts:314`) as `configured\|environment\|loopback`. It is credential-identity-aware but NOT presentation-source-aware — it does not record whether the token arrived as dedicated header, bearer, or `x-api-key`.
- A fresh-disk, field-scoped mutation primitive already exists: `mutatePersistedConfig<T>()` at `src/config.ts:2884`, with rebase-up-to-3-times and exact-raw-string comparison.
- A baseline/live/persisted three-way merge already exists: `saveConfigPreservingClaudeCode` at `src/config.ts:3264`, though its baseline is armed only for long-lived server instances (`src/server/index.ts:556`), so unarmed CLI calls get lock + atomic write but no rebase.
- Real latency IS measured — but only inside `healthScore()` at `src/routing/health.ts:386`, scaled by `optimize.health`, never by `optimize.latency`.

## The security claim is wrong, and that matters

The roadmap asserts a direct main path forwards the caller's admission secret upstream. Traced at this SHA, that is **not** reachable:

- `/v1/responses` admission reads ONLY `x-opencodex-api-key`; bearer is rejected (`src/server/auth-cors.ts:441`, pinned by `tests/data-plane-admission-identity.test.ts:116`).
- Direct then runs `validateForwardAdmissionCredential` BEFORE upstream auth resolution and throws 401 on a recognized proxy secret (`src/server/responses/core.ts:970`; the validator executes at `src/server/auth-cors.ts:407`).
- Pool/main-pool overwrite Authorization with the stored account token (`src/codex/auth-context.ts:460`), proven by `tests/server-auth.test.ts:1543`.

A caller bearer IS forwarded in Direct, but only under canonical `authMode: "forward"` — intentional passthrough, not a leak.

So #1686 is real for the OPPOSITE reason the roadmap gives: the proxy **refuses** the bearer-admission flow instead of admitting it and substituting stored main auth. Implementing it means widening admission while GUARANTEEING overwrite — and relaxing `validateForwardAdmissionCredential` alone would create exactly the leak that guard currently prevents.

## Issue-by-issue disposition

| Issue | Roadmap wave | Verified disposition |
|---|---|---|
| `#1686` | W3-01/02 | Real. Needs source-aware admission + guaranteed substitution. Large, security-boundary. |
| `#1049` | W3-03/04 | Real. Legacy homes bypass the lock (`src/codex/inject.ts:901`); a test currently PINS that (`tests/codex-inject-write-lock.test.ts:144`). High migration risk. |
| `#1802` | W3-06 | **Already satisfied on dev.** `/api/sync` calls `loadConfig()` at the route boundary (`src/server/management/config-routes.ts:383`) and `syncModelsToCodex` writes Codex artifacts, not `config.json`. Needs a regression test, then close. |
| `#1835`/`#1838` | W3-06 | Both CLOSED as duplicates, but the technical report is still accurate: `config set/unset` reads outside the lock (`src/cli/config-command.ts:133`) then whole-snapshot saves (`:145`). Small, landable via existing `mutatePersistedConfig`. |
| `#1798` | W3-08 | Real. Restore is exact-byte restore-or-strip; an app-rewritten unmarked `openai_base_url` survives because ownership requires the marker (`src/codex/injected-marker.ts:53`, `src/codex/inject.ts:1193`). |
| `#1789` | W3-09 | Real. 403 → `credential` → `markAccountNeedsReauth` unconditionally (`src/codex/routing.ts:330`, `:1678`); a test PINS it (`tests/codex-routing.test.ts:377`). |
| `#1791` | W3-10 | Real. Storage is fixed `weeklyPercent`/`monthlyPercent`, not window-generic (`src/codex/quota.ts:7`); a 5-hour primary + 7-day secondary loses the true weekly window (`:439`). |
| `#1784` | W3-12 | Real. Cause discarded twice: `src/codex/management-convergence.ts:107` and `src/server/management-api.ts:177` both manufacture `reason: "disk"`. |
| `#1834` | W3-13 | CLOSED not_planned (template), refiled as **`#1837`**. Real: evaluator reads only health/quota/cost (`src/routing/evaluator.ts:397`); `components.latency` is never populated. |
| `#1830` | W4-03 | Real, and PR #1832 is CI-green but its evidence is thin — no test builds the real advertised catalog and asserts the 120KB budget with `exec`/`wait` present. |
| `#1524` | W4-08 | Real. Fallback reuses frozen eligibility (`src/server/responses/policy-fallback.ts:153`); `payloadEligible` checks only encrypted-task decryptability (`src/server/responses/core.ts:1463`). |
| `#1795` | W4-04 | Stays open. No live SenseNova/Kimi reproduction has been run. |

## W4 items already landed (verify only, do NOT reimplement)

`#1741` linear name recovery (`src/chat/inbound.ts:102`), `#1825` malformed→502 (`src/adapters/openai-chat.ts:292`), `#1817`+`#1844` Cursor nested-helper guidance (`src/adapters/cursor/tool-definitions.ts:194`). All present at `7c348a032`.

## PR #1840 correction

The roadmap warns it is a pending 331-file archive PR that will wreck rebases. It is already MERGED (`d07ec0a7d`), GitHub reports 369 changed files, and no open-branch conflict traces to it. No action.

## Scope decision for this unit

The roadmap's dependency chain ("migrate every writer before anything else") is overstated: `mutatePersistedConfig` already exists, so `config set/unset` needs no new primitive. The genuinely large primitives — legacy-home adoption (#1049) and drifted restore (#1798) — are independent of it.

Ordered by (real user impact) / (implementation risk), landing smallest-first:

1. `#1802` — evidence only, then close.
2. `#1837` — latency term or honest removal.
3. `#1789` — workspace outcome split.
4. `#1784` — typed cause propagation.
5. `#1791` — quota window generalization.
6. `#1835` — CLI set/unset through the existing primitive.
7. `#1823` — scoped signature replay (PR redesign).
8. `#1830` — real catalog serialization evidence.
9. `#1524` — capability preflight in fallback.
10. `#1686`, `#1049`, `#1798` — the three large ones, each its own cycle.
