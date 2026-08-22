# 060 — WP11: two late security-boundary PRs (#1540, #1541)

Unit: `260812_five_bug_fix_campaign`
Baseline: `origin/dev` at `c125b612e` (`feat: add OpenCode Go quota usage (#1545)`).
Date: 2026-08-12.

## Why this phase exists

Both PRs were opened while WP10 was still in flight, and both carry the `bug`
label, so they belong to this campaign rather than to a new one. Each one is a
credential-path change, which is the category `MAINTAINERS.md` says gets an
explicit security review, so neither was going to land on a green suite alone.

| PR | Author | Churn | Claim |
|---|---|---|---|
| #1540 | soulbah | +2073 / -3, 19 files | opt-in recovery for backend-encrypted v2 `NEW_TASK` payloads |
| #1541 | luvs01 | +959 / -39, 18 files | replace credential-bearing live provider updates with an attested bodyless reload |

## Method

Same as WP10, and for the same reason: a PR description is a claim, not
evidence. An independent `gpt-5.6-sol` reviewer got a per-clause question list
for each PR, every blocker it returned had to be reproduced before I acted on
it, and the fix went on top of the contributor commits rather than replacing
them.

The question lists were deliberately shaped around what the descriptions
asserted. #1540 claims default-off, a loopback-only credential boundary, a
pinned destination, and no plaintext persistence — so each of those became a
question with a required file:line answer. #1541 claims a capability bound to
seven values, which invited the question of which of those seven actually
carry security and which are decoration.

## #1540 — what the review found

Default-off holds. Optional in the schema, absent from `getDefaultConfig()`,
and activation requires the literal `true`; an untouched config cannot reach
`recoverEncryptedAgentTask`. Disabled blast radius is nil: the one `const` →
`let` change is only reassigned inside the enabled branch.

The credential boundary holds, with two corrections to how it was described.
The JWT signature is not verified locally — claims are checked and the pinned
ChatGPT endpoint is the real signature authority. And the loopback decision
comes from the configured bind policy, not from the receiving `Bun.serve`
instance, so a remotely bound proxy's loopback listener is also denied. Both
fail closed; both are narrower than the prose suggested.

**The blocker: recovered plaintext reached disk.** `injectAssignment` mutates
`body.input` in place, the reparse rebinds `_rawBody` to that mutated body, and
the ordinary routed path hands `_rawBody` to `rememberResponseState`, which
persists request input to `responses-state.json`. The recovery cache's careful
15-minute TTL was undone one layer up, with no TTL on the disk copy at all.

Fix: bar the body from the continuation cache. Two decisions worth recording.
The marker is a `WeakSet` keyed on the body object rather than a field, because
`_rawBody` is serialized verbatim by the native passthrough and a field would
have been sent upstream — the field version was written first and backed out.
The check sits inside `rememberResponseState` rather than at the five call
sites, so a future call site cannot reintroduce the leak by forgetting a guard.

Red-before is by ablation: keep the new tests, remove the one-line guard, and
the suite goes to 2 fail. A third test asserts an *unmarked* body of identical
shape still IS stored, so the guard cannot pass by simply disabling the cache.

## #1541 — what the review found

The cryptography is sound. `timingSafeEqual` after an equal-length check,
provider/method/path/expiry genuinely MAC-bound so a captured capability cannot
be steered elsewhere, replay rejected by a bounded consumed-capability map, and
the secret rotating on restart. The wall-clock TTL fails closed in both jump
directions. The config-digest recheck is a real bounded TOCTOU fix: the digest
covers the same buffer that is parsed and adopted under the lock.

PID and port binding is decoration, not authentication — both are observable or
guessable, and the security root is the per-process attestation secret. Worth
saying plainly so nobody later relies on them.

**The blocker: a silently discarded reload outcome.** `notifyRunningProxy()`
threw away its `LocalProviderReloadResult` and login printed unconditional
success. Update the CLI while an older proxy is running and the credential
lands on disk, the reload is refused, the live process keeps the old
credential, and the operator is told it worked.

Fix: return the outcome, keep the two harmless cases (nothing listening, and a
provider outside the live-reload allowlist) distinct from a real failure so the
warning does not become noise, and document the restart requirement.

**A trap worth remembering.** The first fix wrote
`onLiveReload?.(await notifyRunningProxy(name))`. Optional-call short-circuiting
skips the entire argument list when the callback is absent, so the reload
stopped happening for every caller that did not pass one.
`tests/key-login-live-update.test.ts` caught it by asserting the live config
actually carried the overlay. The await is now split out, and a test pins the
callback-free shape specifically.

## Acceptance criteria

- Each blocker independently reproduced before any code change. — met
- Contributor commits preserved; fixes pushed on top with `--force-with-lease`
  against a verified remote SHA. — met
- Red-before demonstrated for every new regression test. — met
- `tsc --noEmit` exit 0, focused suites green, `privacy:scan` passing, all on
  the Linux CI host at the exact pushed head. — met
- Evidence-backed review comment on each PR, including the corrections to
  overstated claims. — met

## Outcome

| PR | Merge SHA | Focused suite | Notes |
|---|---|---|---|
| #1541 | `fb4f2fe99` | 389 pass / 0 fail | Medium fixed on top; my own short-circuit regression caught by an existing test |
| #1540 | `9bea7707b` | 377 pass / 0 fail | High fixed on top; red-before by guard ablation (2 fail) |

Review comments: [#1540](https://github.com/lidge-jun/opencodex/pull/1540#issuecomment-5270984576),
[#1541](https://github.com/lidge-jun/opencodex/pull/1541#issuecomment-5270913221).

## Side finding: issue #1302 reproduced on the CI host

Campaign CI left two orphaned `bun test` processes alive at 4h34m and 2h56m of
CPU, and my own full-suite run became a third. All three were `State: R` with
`wchan` 0 — spinning, not blocked, which rules out a deadlock or an unresolved
promise and means only a wall-clock timeout will ever stop them. `eventpoll`,
`eventfd`, and `timerfd` counts grew with elapsed time (4/4/6 versus 14/14/16),
consistent with the `EEXIST: epoll_ctl` reports on that issue, and one held an
open SQLite owner file *and its journal* — an uncommitted transaction — in a
per-test temp dir.

They also outlived their parent shell, which is why the shard reads as
cancelled rather than failed and why a rerun quietly passes. And they poison
neighbouring runs: three spinning processes on an 8-core box means any
timing-sensitive test in that window measures contention.

Posted as [a comment on #1302](https://github.com/lidge-jun/opencodex/issues/1302#issuecomment-5270494499)
with the suggestion to make the runner dump `/proc/<pid>/task/*/stack`, the fd
table, and per-thread states on timeout and exit non-zero, rather than keep
bisecting test files. `SIGQUIT` cleared all three, so a Bun crash dump is
available next time — that is the better first move before reclaiming the host.

This is diagnosis recorded against an issue that was explicitly out of scope
for this unit (`000_research.md`), not a fix. #1302 stays open.
