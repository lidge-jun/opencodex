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


## Current composition and cancellation amendment

The lower stack PR #3753 is merged as b9f2acc82 from cd6d4d346 (full
CI34020474748 and independent security/final reviews passed). Source #3706 remains c311e9598; its source-only
patch applies cleanly to this foundation. Preserve every opaque preflight and
client-reader repair; only handleComboResponses changes in core.

At the initial unreadable-task recovery site, a false helper result returns 499
when the caller signal is aborted, otherwise the existing unreadable-task 400.
At native exhaustion, recheck caller cancellation after routed-target waiting and
recovery, before adopting the last native failure. A successful helper remains
one-shot; normal failed recovery preserves the prior failure and never dispatches
unreadable ciphertext or persists recovered plaintext. Add deterministic abort
fixtures at both recovery sites using the existing fake upstream boundary.

Canonical forward providers defer account/model quota admission to the existing
native selector; caller eligibility, target cooldowns and attempted exclusions
still apply. Noncanonical hosts and third-party cached quota remain filtered.

No combo-only HTTPS restriction is added: this routes recovered content through
the same operator-configured provider transport as the already-supported all-routed
recovery case. Recovery credentials still go only to its existing fixed backend,
and explicit opt-in, loopback/caller guards and no-persist policy remain unchanged.
Introducing a new URL policy only for this combo branch would contradict the
existing configured-provider contract without evidence of a distinct boundary.

Also update the English guides/sub-agent-surface.md paragraph that currently says
combo routing is unchanged and native-only. The configuration pages alone would
leave that guide contradicting the newly reachable opt-in routed recovery path.

The parent now also preserves native preflight read resets/cancellation and
tee/eager failed terminal accounting, including semantic streamAborted parity.
The combo delta remains unchanged through that cascade; a fresh composition
review confirmed the same patch and the complete child runtime passed CI34020475627.
