# Mixed encrypted combo recovery

Depends on opaque-recovery for tested preflight/terminal composition; class C4. Carry #3706 c311e9598f9c4f3daf8cccdf1e27ba913ba94b30, source base 6dd23d6314c41f1113639e042353aae9e6614e62. Co-authored-by: yxr1995-maker <257504378+yxr1995-maker@users.noreply.github.com>. Preserve source commit snapshots, avoid replaying obsolete source branch merge commit 97f453ab.

## Exact diff map
- MODIFY src/combos/resolve.ts targetProviderIsUsable and pickComboTarget/pickComboTargetWithWait: canonical OpenAI account/model selector owns quota decisions, provider cached summary cannot veto canonical target; third-party/noncanonical provider quota still filters, including wait eligibility.
- MODIFY src/server/responses/core.ts handleComboResponses: select actually payload-compatible target before deciding recovery; extract bounded recoverUnreadableEncryptedTask and encryptedTaskRecoveryAttempted; if native configured but disabled/cooling/no selectable native, recover once only when a usable routed target exists. Native model/account authorization exhaustion permits one recovered routed dispatch, excluding attempted targets. Preserve lastFailure and no-readable-target failures.
- Preserve clientCancelledResponse mapping at BOTH recovery sites when recovery aborts. The source PR helper returning false must not turn caller cancellation into unreadable-task HTTP 400.
- MODIFY tests/server/agent-task-recovery-combo.test.ts and tests/codex-integration/combos.test.ts; broader existing recovery/security/fallback/combo-preflight fixtures remain authoritative.
- MODIFY all eight existing docs-site/src/content/docs/**/reference/configuration/agents.md pages, describing actual selectable-native vs configured-native behavior.

Before: a merely configured native target suppresses recovery even when not usable; canonical provider summary may veto before account selection. After: native direct preference stays, usable routed recovery becomes reachable only once with explicit opt-in and no plaintext persistence.

## Activation / verifier
Remote tests cover native disabled/cooldown, native 401 exhaustion, canonical summary exhausted with eligible account, noncanonical quota veto, caller eligibility, cooldown waiting, all targets unavailable skips recovery, recovery failure never dispatches plaintext/ciphertext, aborted recovery at both sites returns cancellation, no retry after client output. Preserve 32-inflight and no-persist safeguards where owned by recovery helper.
CodeRabbit HTTPS-only suggestion is assessed against existing http provider policy: do not invent combo-only URL permission changes. Record evidence-backed rebuttal or a narrowly necessary fix during P/security audit. This carry does not change provider URL policy or credentials. Exact-head CI + independent security review required; no live Kiro or local suites.

