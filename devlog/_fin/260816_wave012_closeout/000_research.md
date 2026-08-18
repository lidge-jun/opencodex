# 000 — Wave 0/1/2 closeout research

Source roadmap: external audit conversation (2026-08-16) that produced a six-wave plan over the open `bug` issue/PR set. This unit executes Wave 0, Wave 1 and Wave 2 only. Waves 3-5 stay out of scope.

Baseline: `origin/dev` = `b81314cd29b78fecb447df882dc4fc1a987434b9`.

## Wave scope as received

Wave 0 (triage only, no issue closes):

- `#1802` needs the `bug` label (currently `cli` only).
- `#92` / `#417` stay out of the release-blocker count as `upstream-tracking`.
- PR `#1822` label review (`bug` vs GUI UX follow-up).
- `#1049` records `#1798` / `#1802` as independent acceptance cases.

Wave 1 (low-risk merges): `#1805`, `#1806` then close `#1786`, `#1741`, `#1825` then close/reclassify `#1824`, absorb `#1801` tests into `#1817` then close `#1801`.

Wave 2 (blocker work): `#1819` to `#1785`, `#1788` to `#1700`, `#1780` to `#1767`, `#1792` to `#1668`, `#1703` to `#1697`.

## Verified triage state (gh, 2026-08-16)

| Item | State | Labels |
|---|---|---|
| `#1802` | OPEN | `cli` |
| `#92` | OPEN | `bug`, `upstream-tracking`, `tools` |
| `#417` | OPEN | `bug`, `upstream-tracking`, `cli` |
| `#1049` | OPEN | `bug`, `cli` |
| `#1798` | OPEN | `bug`, `cli` |
| PR `#1822` | OPEN | `bug` |

`#92` and `#417` already carry `upstream-tracking`, so Wave 0 for them is a reporting convention, not a label mutation. The repository label set already contains `upstream-tracking`, `provider-compatibility`, `needs-info`, `maintainer-sponsored` and `intake: hygiene-blocked`; no new label needs creating.

Target issues, all OPEN at baseline: `#1786`, `#1824`, `#1785`, `#1700`, `#1767`, `#1668`, `#1697`. `#1795` stays open (live SenseNova/Kimi reproduction still missing).

## Audit findings per PR (5 parallel read-only audits)

`#1805` — head `8946a1026120c59870310575c1623873a3660f4f`. Windows test-sandbox profile shape in `scripts/test.ts` plus two Windows-only regressions in `tests/test-runner.test.ts`. No diff-level blocker; only `REVIEW_REQUIRED` governance.

`#1806` — head `960013e312970494e6eb7a3209b33491627f4316`. Makes `currentCodexSqliteHomeAbsolute()` target-aware in `src/service.ts:112` so POSIX artifacts keep `/var/...` literals on a Windows host. Body says `Closes #1786`. Live blocker: `tests/service.test.ts:692` ("still absolutizes a relative sqlite home") never asserts absoluteness — it only rejects one exact raw string, so it stays green for an arbitrary non-absolute transform.

`#1741` — head `9118aef00e537f2abb09a3de3445f0cfd6b9bb18`. Request-local map for tool-call name recovery in `src/chat/inbound.ts` plus a 1,000-call linearity regression. No diff blocker; exact-head Cross-platform CI and React Doctor are `action_required` (never executed).

`#1825` — head `65dac3fe651ea091f4ccf924b6691929002789fc`. Classifies malformed provider tool calls as `502` / `upstream_error` and adds bounded, debug-gated structural fingerprints. Exact-head Cross-platform CI green. No diff blocker. History note: commit `c8d136c21` temporarily added a `contents: write` workflow that `2e28fb2cc` removed; the final aggregate diff has no `.github/` change.

`#1817` — head `b8cea1d0d2f33a5bce8277425461ab245efeda28`. Shared tool-catalog nudge contract plus `apply_patch`-scoped envelope guidance. Exact-head CI green. `src/bridge.ts` is untouched (identical blob), so fail-closed 502 enforcement is preserved. No diff blocker.

`#1801` — head `f1db2592b398b5a49ec875c75c140a981542356f`, draft. Cursor Code Mode guidance with a real correctness blocker at `src/adapters/cursor/tool-definitions.ts:217`: `cursorRequestUsesCodeMode()` returns true whenever freeform `exec` is visible without a bare shell bridge, even when another non-shell top-level tool is also visible, and the guidance then declares those tools non-top-level. Its three tests are unique coverage, not duplicates of `#1817`.

`#1819` — head `65822b008740af75cd2568595cb60602de80d899`, draft. All four claimed blockers verified at head:

1. `configDiagnosticsFromRaw` still returns `getDefaultConfig()` with `source: "fallback"` (`src/config.ts:2479`); the salvage added to `loadConfig` (`src/config.ts:2175-2195`) has no diagnostics counterpart, and the file comment says that result can be persisted over providers/keys.
2. Salvage is one-pass (`src/config.ts:2179-2198`): dropping an invalid combo can invalidate a routing profile that referenced it, and the second parse failure discards the whole config.
3. Raw operator-controlled entry IDs reach `console.error` (`src/config.ts:3505-3523`) without `redactSecretString`.
4. No management-auth regression accompanies the new fallback path.

`#1788` — head `cfbb3cdec5bc85154bfe8a672d9e34f9acceb2f6`, draft. No-catalog passthrough, caller/outbound catalog union and non-streaming state exclusion are correct. Remaining blocker: `rememberPassthroughResponseChecked` (`src/server/responses/core.ts:2311-2320`) only inspects the terminal response `output`, so a stream that emits an undeclared `apply_patch` in `response.output_item.added` and then a `response.completed` with `output: []` can still enter continuation state after the client received `response.failed`.

`#1780` — head `388c4c25174ff5a709c5e1ca15ef625b55a6e9e8`. Three verified defects: `?? rawId` restores empty IDs (`src/adapters/anthropic.ts:578` and `:649`); `requiredIds` holds normalized IDs but the result scan compares raw ones (`src/adapters/anthropic.ts:660-667`), so every rewritten pair produces an orphan plus a synthetic missing result; and the stateless transform is not injective (`src/adapters/tool-call-id.ts:6,20`).

`#1792` — head `8f41eb78e9a751fadb9a9043a7ed3e9e35d9c956`, draft, `CHANGES_REQUESTED`. The loader rejects `null` (`src/config.ts:738`) while the management validator accepts it (`src/config.ts:917`) and POST persists the provider as submitted (`src/server/management/provider-routes.ts:475,547`); PATCH already deletes the key. It also touches `src/server/auth-cors.ts`, which is on the restricted list in `.github/scripts/pr-sponsored-surface.cjs`, so PR hygiene fails with `unsponsored_surface` and the PR carries `intake: hygiene-blocked`.

`#1703` — head `52cdbfc81adef7e3cc17a5e43a1b17428661fffc`, draft. Affinity comes from static `claudeCode.model` (`src/claude/inbound.ts:75`), classifier detection is slug-only (`:28`), and `src/router.ts:699` picks the first enabled Anthropic-adapter provider by object insertion order with no model-availability check. That is the silent provider/privacy/billing crossing the issue warns about; the PR is on design hold.

## Cross-cutting facts

- Contributor branches show `action_required` CI: workflow runs need maintainer authorization before any exact-head test matrix exists. `gh pr checks --required` reporting "no required checks" is not evidence of a green suite.
- Full-suite validation runs on `ssh lidge` (`/home/lidgeai/Developer/opencodex`, `bun test --isolate tests`), never on the local workstation.
- `main` promotion, tags and npm publish are out of scope. Issues and PRs are closed under maintainer authority once the fix is on `dev`, with a release-pending note.

