# Unanswered issue resolution: #239, #240, #242, #246, #253, #257

## Outcome

- #239: a Codex OAuth 409 now cancels the abandoned server flow and retries once.
- #240: Codex, OAuth, and API-key pools support display-only aliases through GUI, API, and CLI.
- #242: GitHub Copilot device codes are structured, prominent, copyable, and no longer hidden by an automatic foreground browser launch.
- #246: adaptive Anthropic thinking receives effort-sized total-token headroom and `max_tokens` is preserved as an incomplete response.
- #253: subscription-mode Claude launches no longer claim host-managed authentication without a host token.
- #257: freshly initialized configs carry the current OpenAI tier version, so an older immutable migration backup cannot block startup. Bare OpenAI model ids still intentionally fail closed when no canonical OpenAI provider is enabled.

[Decision Log]
- 목적과 의도: Reproduce and resolve every unanswered report against current `dev`, while preserving existing routing and credential-security invariants.
- 기존 구현 및 제약 조건: OAuth and API-key pools use different stores; Codex accounts use config plus a separate credential ledger. Browser APIs cannot promise a background tab. The OpenAI migration backup is intentionally immutable.
- 검토한 주요 대안: Overwrite old migration backups; auto-open device verification and rely on users switching windows; use aliases as lookup keys; expose a manual-only OAuth recovery button.
- 선택한 방식: Mark new configs as current instead of weakening backup immutability; suppress automatic device-flow navigation and expose the code structurally; persist aliases only as optional display metadata; automatically cancel and retry one stale Codex login.
- 다른 대안 대신 이 방식을 선택한 이유: It fixes the reported dead ends without changing credential identity, account ids, active selection, routing, or backup evidence.
- 장점, 단점 및 영향: Existing data remains backward compatible and aliases may duplicate safely. Copilot login now needs an intentional link click, but the code stays visible and no browser focus theft occurs. The native/main Codex App slot remains non-renamable because it has no OpenCodex-owned persisted account row.

## Verification

- Focused adapter, bridge, Claude env, OpenAI migration, OAuth store, Codex API, provider key API, CLI account, Copilot OAuth, and workspace auth tests.
- Repository TypeScript typecheck, GUI i18n lint, privacy scan, and full test suite before push.

## Pull request integration follow-up

- Merged the safe, independently useful changes from #229, #230, #231, #244, and #258 after diff and security review.
- Synchronized Japanese with provider and account locale keys that landed on `dev` after #244 was opened.
- Moved #230's header rewrite into an exported production helper so the regression test exercises the same code used by combo failover.

[Decision Log]
- 목적과 의도: Preserve contributor value while ensuring the merged `dev` tree, rather than each stale PR branch in isolation, remains buildable and regression-tested.
- 기존 구현 및 제약 조건: The Japanese branch predated new English locale keys, and the combo regression originally duplicated the production header deletion inside the test.
- 검토한 주요 대안: Reject the otherwise-complete Japanese localization; keep English fallback insertion manual; accept a test that only reproduced the protocol behavior without calling production code.
- 선택한 방식: Merge the valuable changes, populate missing Japanese keys with the repository's existing synchronizer and English fallback, and expose a narrow combo-header helper for direct testing.
- 다른 대안 대신 이 방식을 선택한 이유: This retains contributor work, follows the existing fallback policy, and makes future header regressions observable without widening runtime behavior.
- 장점, 단점 및 영향: Japanese remains available immediately and cannot fail key-parity typechecks; newly introduced strings may temporarily display English until translated. The combo helper adds a small exported test seam but centralizes the transport invariant.
