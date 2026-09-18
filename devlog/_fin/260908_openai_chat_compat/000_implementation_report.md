# OpenAI Chat freeform compatibility carry

Date: 2026-09-18. Source contribution: PR #3952 by @yxr1995-maker.

## Outcome

The carry retains the freeform tool-input repair and drops the unrelated Kimi prompt and Moonshot
transport changes. Current `dev` already owns bracket-suffix removal across provider derivation,
routing, Chat, Responses, and its focused adapter tests, so the branch copies were redundant.

`src/responses/apply-patch-envelope.ts` now accepts the contractual `input` wrapper for every
freeform tool. Bare `exec` also accepts one of `code`, `script`, `js`, `javascript`, `command`,
`cmd`, or `content`; bare `apply_patch` accepts one of `patch` or `content`. If more than one
alternate string field is present, the wrapper remains unchanged. An explicit `input` field wins
and a non-string `input` fails closed rather than falling through to an alternate field.

A complete outer Markdown fence is removed only for `exec` and `apply_patch`. Embedded fences and
all other freeform tool grammars remain byte-exact.

## Dropped pieces

The Kimi K3 prompt appendix duplicated the shared non-OpenAI tool-catalog guidance and mixed broad
agent behavior instructions into a provider adapter without an independent behavioral oracle.

The Moonshot switch from Chat Completions to Responses removed Chat-only parameter and tool-choice
locks while changing streaming, tool-call, and reasoning-replay contracts. The Responses adapter
does not consume those four lock fields, and the branch did not establish equivalent enforcement,
so that transport migration is not part of this carry.

## Verification contract

This lane forbids every local test, typecheck, build, install, and `ocx` invocation. Static review
covered the producer and restoration callers, the current shared suffix-strip implementation, the
Chat-only lock consumers, and focused regression assertions. Hosted CI is the executable proof.
