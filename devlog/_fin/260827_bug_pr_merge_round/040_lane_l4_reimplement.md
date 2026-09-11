# L4 — reimplement

Members: #2693, #2694, #2638, #2497. Ordered by how much external input each needs.

## #2694 — SenseNova bare exec_command

Does not compile (001): five tsc errors, including a call to
`failMalformedCodeModeExecCommand()` that is defined nowhere in the branch or on dev.
Its gate keys on `route.providerName === "sensenova"`, an id absent from
`src/providers/registry.ts` and present only in `src/providers/free-directory.ts:141`.
Its one test bypasses the gate entirely by hand-building the `toolNsMap`, so it would
pass even if the alias never activated in production.

Do NOT rewrite this before #2663 lands. Then:

- If #2663's general helper bridge already covers a bare `exec_command` call, close
  #2694 as NOOP with the sha.
- Otherwise implement the narrow gap on a dev-based branch, with a test that goes
  through the real request path so the provider gate is actually exercised.

## #2693 — Gemini 3 thought-signature fallback

Test-only diff whose test fails on its own branch (004). BLOCKED on one upstream fact:
does Gemini 3 on Antigravity honor `skip_thought_signature_validator` as a functionCall
`thoughtSignature`? Dev currently takes the opposite stance and refuses to forward
non-genuine signatures. Until that is answered, neither implementing nor closing is
justified — record the question on the PR and move on.

## #2638 — codex drain routing follow-ups

1341 added / 119 deleted across 7 files, of which 936 lines are tests
(`codex-routing.test.ts` +405, `subagent-fallback-handle-responses.test.ts` +423,
`codex-auth-context.test.ts` +108). Source: `src/codex/routing.ts` +283/-51,
`src/server/responses/core.ts` +52/-26, `src/codex/subagent-model-fallback.ts` +62/-24.

Blocking state: `hygiene` FAIL, `enforce-target` FAIL, CHANGES_REQUESTED, and the
`intake: hygiene-blocked` label. Diagnose the hygiene failure first — it decides
whether any of this branch is reusable.

The subagent-fallback path is the one `AGENTS.md` calls out specifically: the
synchronous activation chain in `src/server/index.ts` has nowhere to await, so an
`await` introduced there silently reroutes subagents to a different model than the
operator configured. Any rewrite must preserve that synchronicity and prove it.

Plan: extract the actual routing defect from the 283-line `routing.ts` change,
reimplement it minimally on a dev-based branch, keep whichever of the author's tests
pin real behavior, credit the author, close the original.

## #2497 — native main token refresh and replay

2622 added / 76 deleted across 20 files. CONFLICTING against dev on five files:
`src/codex/auth-context.ts`, `src/codex/model-entitlements.ts`,
`src/routing/analytics.ts`, `src/server/responses/core.ts`, `src/usage/log.ts`.
`hygiene` FAIL and `enforce-target` FAIL.

It touches `src/oauth/chatgpt.ts` (+88/-12) and `src/codex/main-account.ts`
(+551/-12) — OAuth token refresh and account credential storage. Per `MAINTAINERS.md`
that is the security boundary: authentication and credential/token handling require
explicit security review, and token logging or serialization is a release blocker.

Therefore this PR is `NEEDS_HUMAN` for the security decision regardless of how good the
code is. The merge round can prepare the ground — diagnose the hygiene failure, resolve
the five-file conflict semantically, isolate the actual refresh/replay defect — but it
does not land without that review.

Any security analysis written while doing so goes to scratch space (`.tmp/` or
`mktemp -d`), never into `devlog/`, per `AGENTS.md`.
