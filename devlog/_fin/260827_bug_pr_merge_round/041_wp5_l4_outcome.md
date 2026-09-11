# wp5 — L4 lane outcome

## #2694 — NOOP, closed

The landed #2663 (`cebe005db`) does provider-agnostically what #2694 hand-built for
one provider. Measured on current dev:

```
exec_command  -> exec
shell_command -> exec
apply_patch   -> exec
compiled: const result = await tools.exec_command({"cmd":"pwd"});
          text(result);
```

That is the same wrapper `codeModeExecCommandInput` produced. Closed with the five
`tsc` errors and the nonexistent `sensenova` provider id spelled out, so the author
knows why it could not have landed as written.

## #2690 — landed whole, NOT reimplemented

003 reclassified this L3 -> L4 on the reviewer's finding that the fix imports the
module the refactor creates, so "take the fix, leave the refactor" was incoherent.
The plan then said: rebase and land whole, or reimplement against the existing helper.

The author (olddonkey) rebased it themselves onto post-#2684 dev, twice, ending at
`669efd568`. So the reimplement never became necessary — the branch merges clean and
the merged tree passes:

```
git merge-tree origin/dev pr2690-fresh   -> exit 0 (no conflict)
bun x tsc --noEmit (merged tree)         -> clean
bun test xai-tool-schema, xai-transport,
         openai-responses-passthrough,
         azure-model-router-tool-schema  -> 165 pass / 0 fail
```

The Azure suite is the one that matters there: it is #2684's, in the region #2690
conflicted with. Both now coexist. Merged as `3d986ef9c`.

Lesson worth keeping: ordering #2684 first (005, correction 2) was what made this
cheap. Had #2690 landed first, #2684 would have been the one needing a rewrite.

## #2693 — BLOCKED on an upstream fact, left open

Test-only diff whose test fails on its own branch;
`skip_thought_signature_validator` exists nowhere in `src/`. The blocking question is
posted on the PR: does Gemini 3 on Antigravity actually honor that sentinel as a
functionCall `thoughtSignature`? Dev deliberately refuses to forward non-genuine
signatures, so implementing the fallback without that fact risks trading a clean 400
for a silently degraded turn. Left OPEN rather than closed — it is a real question,
not a rejected patch.

## #2638 and #2497 — NEEDS_HUMAN, security boundary

Both are hygiene-blocked for the same reason, and it is the correct reason.

```
unsponsored_surface — This changes an authentication, workflow, release-automation,
or dependency surface. MAINTAINERS.md requires security review for these.
Paths: src/codex/auth-context.ts
```

### #2638 is in better shape than its label suggests

Its auth surface is 14 lines in `src/codex/auth-context.ts`: hoisting
`nativeMainSelectionOnly` to a const, and widening ONE condition from
`nativeMainTrafficBlocked` to `nativeMainReadsForbidden` so a turn drain reports the
temporary fence instead of a permanent model-entitlement denial. No other auth,
credential, OAuth, token, workflow or release path is touched
(`git diff --name-only` over auth-ish patterns returns only that file and its test).

Verified at the merged tree:

```
git merge (dev + pr2638)     -> MERGE_OK
bun x tsc --noEmit           -> clean
codex-auth-context, codex-routing, subagent-fallback-handle-responses,
core-lab-boundary            -> 267 pass / 0 fail
src/server/index.ts, lifecycle.ts, router.ts -> NOT TOUCHED
```

That last line matters: `AGENTS.md` warns that an `await` added to the synchronous
activation chain silently reroutes subagents to a different model than the operator
configured. This PR does not touch those files, and `core-lab-boundary` passes.

### #2497 is the heavier one

2622/76 across 20 files, CONFLICTING on five including `src/server/responses/core.ts`,
and it touches `src/oauth/chatgpt.ts` (+88/-12) and `src/codex/main-account.ts`
(+551/-12) — OAuth refresh and credential storage.

### Why this round stops here

`MAINTAINERS.md` requires explicit security review for these surfaces, and the gate
asks for a maintainer to apply `maintainer-sponsored` after reviewing. An agent
applying that label to clear its own PR would defeat the check entirely — the label
IS the human judgment. So both are reported with evidence and left for the maintainer.

This is `NEEDS_HUMAN`, not `BLOCKED`: nothing external is missing, a person's
decision is.
