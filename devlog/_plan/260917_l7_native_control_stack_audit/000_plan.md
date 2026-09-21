# L7 — native control stack: read-only audit

Lane R-L7. Four open pull requests that GitHub shows as four independent
branches off `dev` are, in commit terms, one four-deep stack:

```text
#4782 native WebSocket steering
  └─ #4858 multi-agent function-result injection
       └─ #4861 typed result continuations + hosted output preservation
            └─ #4864 bounded steering waits + sparse replay output
```

This lane does not implement anything. It separates what each stage actually
adds, states the four stages as one contract a reviewer can check, decides in
code whether issue #4850 gates the stack, and records what still has to happen
before either flag is turned on. Corrections that belong to an author go to that
author's pull request as a review comment; no pull request is superseded,
rebased or reimplemented here.

## Units

- 010 — parent-relative diff of each stage.
- 020 — the four stages as one integration contract, with verdicts.
- 030 — whether #4850 (native-main read fence) is a precondition.
- 040 — stack hygiene, upstream evidence, and the activation decision.

## Write scope

`devlog/_plan/260917_l7_native_control_stack_audit/` only. No `src/`, no
`tests/`, no `structure/`, no `docs-site/`. The four audited branches are read
through `git show` and `git diff` against fetched `refs/pull/*/head`; nothing in
this branch touches them.

## Verification posture

Nothing is executed. No suite, no focused file, no typecheck, no build, no
proxy. Every claim below is either a source read at a named commit or a hosted
CI fact read from GitHub, and each is written so a reviewer can re-derive it
from the same command. Where a claim could not be established from source it is
recorded as unproven rather than assumed.

Reference points, all read on 2026-09-17:

| Ref | Commit |
|---|---|
| `origin/dev` | `f1dfda8e48b52a1734eb202550a0225f3e5f8ab1` |
| #4782 head | `76d7452afb38fd7cc5d9ff7fa4d573b06a9507e3` |
| #4858 head | `7a9a6d28dd8680cce890e06813e4a08796624d0a` |
| #4861 head | `59a1d6357e018d44104a50b1126350b72368c81d` |
| #4864 head | `7b548ad85e8f2a6af313198fa68a4111003cbb05` |
| #4868 head (undeclared fifth level) | `15a8e715851d53d13d3718b16c8ad4cdc8e6ec32` |
| openai/codex pinned checkout | `095da4b7e` |
