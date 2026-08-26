# 090 — wp8: issue #2443, Codex Desktop wait integer coercion

## Item

`lidge-jun` issue #2443, "Codex Desktop wait.yield_time_ms / max_tokens still
rejected as 120000.0 after #2316".

## Investigation verdict

STATUS REPRODUCES, disposition FIX_SMALL. `src/lib/tool-argument-integers.ts:77`
allowlists only `timeout_ms`; commit `a9cb7661b` fixed #2316 alone, so the two
`wait` fields still forward as `120000.0` and `8000.0` through both bridge paths
at `src/bridge.ts:627` and `:1657`.

## The scoping decision

The obvious fix — adding both names to the global allowlist — is wrong.
`yield-time_ms` and `max_tokens` are ordinary names: Cursor has its own
`yield_time_ms` at `src/adapters/cursor/tool-definitions.ts:42`, and any
third-party tool may legitimately want a fractional `max_tokens`. The repair is
therefore keyed to the bare `wait` tool, with tool identity threaded through the
coercer and passed only when no namespace is present.

`tests/tool-argument-integers.test.ts:328` asserted the opposite contract for
`yield-time_ms`. It was written for #2316's narrower scope, and is updated here
deliberately rather than quietly deleted.

## Evidence

Red-green: 33 pass / 2 fail before the source change, 35 pass / 0 fail after.
`bun run typecheck` exit 0.

## Landing record

PR #2448, squashed onto `dev` as `81bf4b9a4`. Issue #2443 closed.

One CI wrinkle worth recording: the first macOS run failed on
`Codex autostart shim > Unix install rejects a recursive dynamic launcher`, a
test with nothing to do with integer coercion. Rather than merge past it, the
test was run on clean `dev` (1 pass) and on the PR branch worktree itself
(69 pass / 0 fail), which established the failure as environmental. The rerun
then came back green across all 23 checks.

