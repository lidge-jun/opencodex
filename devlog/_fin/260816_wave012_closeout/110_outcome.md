# 110 — Outcome

Terminal outcome: **DONE** for Wave 0, Wave 1 and Wave 2.

Baseline `origin/dev` was `b81314cd2`; the wave closed at `72dcc600c`.

## What landed

| Unit | PR | Merge | Issue |
|---|---|---|---|
| 010 Wave 0 triage | — | — | none closed, by design |
| 020 | #1805, #1806 | `16bffe235`, `cf91d4c60` | #1786 CLOSED |
| 030 | #1741, #1825 | `948b55903`, `82f4563d1` | #1824 CLOSED |
| 040 | #1817, #1844 | `f74ae9ea4`, `d4bdbc968` | PR #1801 closed as superseded |
| 050 | #1819 | `767491c0c` | #1785 CLOSED |
| 060 | #1788 | `9f82c0003` | #1700 CLOSED |
| 070 | #1780 | `64206f36c` | #1767 CLOSED |
| 080 | #1792 | `366a56324` | #1668 CLOSED |
| 090 | #1703 | `72dcc600c` | #1697 CLOSED |

Wave 0 mutations: `#1802` gained `bug`; PR `#1822` moved from `bug` to `gui`; `#1049` records `#1798`/`#1802` as independent acceptance cases; `#92`/`#417` carry an explicit note that they stay out of the release-blocker count. Nothing was closed in that phase.

## Defects the plan review caught before implementation

Six review rounds against the decade docs produced 22 accepted corrections. The ones that would have shipped broken code:

- The `#1806` oracle scanned for `CODEX_SQLITE_HOME=`, which does not exist in a launchd plist (XML) and leaves a trailing quote in a systemd unit. It also asserted the wrong input string.
- The `#1700` sticky-rejection flag had no way to be set: `SseInspectorHandlers` has no per-payload callback, and adding one to the handler type alone would have left the tee consumers inert.
- The `#1767` allocator appended `_2`/`_3` without reserving suffix space, and would have sliced the hash tail off a finished string.
- The `#1668` snippet referenced a `jsonError` helper and an `httpVersionError` local that do not exist in that handler.
- The `#1697` predicate referenced an `AnthropicMessagesBody` type that does not exist, and its structural conditions alone would have matched ordinary short requests.
- The `#1697` capture instruction would have written raw request bodies into this public directory.
- `gatherRoutedModels()` does not filter by `disabledModels`/`selectedModels`; `filterCatalogVisibleModels()` does.
- `normalizePersistedClaudeCode` was only reachable through a `subagentEffort` short-circuit, so extending it alone would not have activated it.

## Defects found during implementation

- **`#1819` salvage could defeat a security boundary.** A Codex account namespace collision is a relationship between a combo and an account selector but is reported on the combo, so dropping that combo made the document parse and admitted the selector the schema had just refused. Those findings are now unsalvageable.
- **`#1819` diagnostics salvage initially swallowed the error itself.** Returning `source: "file"` after a successful salvage broke two persisted-combo tests, correctly: provider reload, catalog sync, cost reconcile and Codex admission all gate on `source`/`error`. Only the payload changes now.
- **`#1801` mixed-catalog misclassification.** `cursorRequestUsesCodeMode()` is true whenever freeform `exec` is visible without a bare bridge, which does not mean `exec` is the only visible tool; the guidance told the model a separately advertised tool was not callable.

## Verification

Every merge had exact-head Cross-platform CI green, including the Windows jobs for the Windows-specific units. Contributor-branch runs were authorized rather than treated as passing while `action_required`.

Full Linux suite on `ssh lidge` at the final head: **12651 pass / 15 skip / 16 fail**. Every failure also fails on `dev` at the same commit — GUI lint/doctor spawner harnesses, multi-process lock contention, a typecheck-contract case, and one `bun`-not-on-PATH harness case. No routing, adapter, config or server test fails.

The macOS `#1819` CI failure was a Bun segfault (`panic: Segmentation fault`, RSS 3.6GB), not an assertion; it passed on rerun.

The four Windows shards fail under `workflow_dispatch` on `dev` itself — 168 failures on both `dev` and the `#1703` head, with a symmetric 4-test difference in each direction and no classifier/router/inbound case among them. Those shards are skipped on the ordinary `pull_request` path, so this is a pre-existing condition of the dispatch route, not a regression. It is worth its own issue.

## Deliberately not done

- **Live per-session classifier affinity (`#1697`).** The draft inferred it from static `claudeCode.model`, which goes stale on a model-picker change and silently crosses provider/privacy/billing boundaries. Shipping only operator-declared targets was the honest scope; the session-scoped store plus a request-shape predicate is follow-up work, recorded in `090`.
- **`#1795`** stays open: no live SenseNova/Kimi reproduction has been run against the merged guidance change.
- **Waves 3-5** are out of scope for this unit.
- No release: nothing was promoted to `main`, no tag, no publish. Every close comment says the fix is on `dev` and ships with the next release.

