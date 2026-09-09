# 070 — round outcome

This round advanced `dev` from `50e955604` to `29be459a3`. The mandate was "fix what
can be fixed, reimplement what cannot, merge both", with fork pushes authorized.

`dev` has since moved to `5511a424c` via #2774, a squash-merge from a different
work-stream. Both first-parent commits in the range arrived through PRs targeting
`dev` — the squash shows as a non-merge commit, which is what a squash-merge looks
like, not a direct push.

| PR | lane | outcome | evidence |
|---|---|---|---|
| #2740 | FIX | **MERGED** `29be459a3` | rebased under lease, patch-id `48b653f9a33b` unchanged; author added a GUI surface; both regressions mutation-verified |
| #2693 | REIMPLEMENT | **CLOSED-SUPERSEDED** by #2794 | three blockers closed, each mutation-bound |
| #2794 | new | **MERGED** `bdc1e97bb` | `eebd1913e`; a reviewer blocker found and fixed after the first green matrix, then admin-merged on user authorization |
| #2747 | FIX | **MERGED** `fe063d16e` | rebased, CI 20/0 green, approved; admin-merged on user authorization |

## Admin-merge authorization (2026-08-28)

The user authorized `--admin` merges, which resolves the self-approval deadlock that
held #2794 and the author-attestation box that held #2747. Both were already green:
#2794 at 23 success / 0 failure, #2747 at 20 / 0. The authorization removed a
*process* gate, not a verification one — nothing was merged that lacked evidence.

What it deliberately did **not** unblock:

- **#2638** — head moved to `e06ffbaa8` after my rebase, so my 15375/0 evidence no
  longer describes the tree under review. It also still fails `hygiene` on
  `unsponsored_surface`. Admin rights make that mechanically bypassable and it stays
  unmerged: the gate is asking for a security judgement on
  `src/codex/auth-context.ts`, and "I can force it" is not an answer to "has anyone
  reviewed this credential path".
- **#2745** — the fix lives on `codex/oauth-failover-identity-v2` and was never opened
  as a PR. Two blockers from the original review also remain open by my own
  admission (the `applyFailoverSnapshot` audit and the A -> 429 -> B recovery-path
  regression).
- **#2497** — unchanged; still needs the author's rebase.
| #2638 | FIX | **NEEDS_HUMAN** (security) | rebased clean, full suite **15375/0**; `hygiene` correctly holds on `unsponsored_surface` |
| #2497 | attempt | **NEEDS_AUTHOR** (semantic conflicts) | rebase attempted and aborted; 6 hunks, only 1 mechanical |
| #2745 | FIX | **NEEDS_HUMAN** (approval) | both blockers closed on `codex/oauth-failover-identity-v2` `2b3574a45`; suite 15358/0 |

## #2745: the defect was one `??`

`refreshed.apiBaseUrl ?? getOAuthCredentialApiBaseUrl(route.providerName)` reads
correct until you follow the second arm: `getOAuthCredentialApiBaseUrl` is
`validateCopilotApiBaseUrl(getCredential(provider)?.apiBaseUrl)` — the **active**
credential, with no account scoping. A generic 429 rotation never promotes the
account it rotated to, so for a legacy account B with no allowlisted origin, that arm
silently reached account A. B's bearer, A's host.

`copilotOriginForRefreshedCredential` now resolves from the refreshed snapshot alone
and otherwise fails closed to the canonical origin, consulting no other account:

| refreshed snapshot for B | resolved |
|---|---|
| own allowlisted origin | that origin |
| legacy, no origin | canonical — never A's |
| non-allowlisted origin | canonical |
| empty | canonical |

The test blocker was worse than "not behavioural": one assertion counted the buggy
expression and required it to appear **twice**, so fixing the defect would have
broken the test. Replaced with a behavioural test over all four arms, plus a topology
guard that strips comments first — the new helper's doc comment quotes the removed
expression to explain why it was wrong, and the first version of the guard read that
explanation as the defect.

Still open from the review and deliberately not claimed: the `applyFailoverSnapshot`
audit, and an executable A -> 429 -> B regression through the HTTP recovery path.

## Where I was wrong, in the useful direction

060 predicted #2638 would need a semantic rebase and probably stay stale. It rebased
across **195 commits with zero conflicts**, patch-ids unchanged, and the full suite
passes 15375/0 on the rebased tree — including `tests/core-lab-boundary.test.ts`,
which matters because the PR touches `core.ts` and `subagent-model-fallback.ts`.

So the reviewer's original objection was right *and* has now been answered: textual
mergeability proved nothing, so I measured behavior instead, and the behavior is
clean. What remains is not staleness — it is the security decision, and `hygiene`
holds it on `unsponsored_surface` naming `src/codex/auth-context.ts`. The
`maintainer-sponsored` label *is* that human judgement; an agent applying it would
be forging the gate rather than passing it.

#2497 went the other way and the contrast is the point. Same "far behind" shape, 402
commits, and it does **not** rebase: 6 conflict hunks across three credential files,
of which exactly one is mechanical. The decisive one is delete-vs-modify on the
entitlement path — `dev` deleted a block the PR modifies — which git cannot resolve
and I should not. Aborted, nothing pushed, triage in `.tmp/` per `AGENTS.md`.

"Too far behind" was never the real criterion. **Whether the conflicts are
mechanical is.**

## Two operational findings

**A fork PR runs no product CI until a maintainer approves the workflow run.** Both
#2740 and #2747 sat in `action_required` showing 5 green checks — and the matrix had
never started. "5 checks passing" on a fork PR is not a weak signal, it is *no*
signal. Approve via `gh api -X POST .../actions/runs/<id>/approve`.

**A maintainer force-push resets the contributor's readiness checklist.** That is
`enforce-target` working correctly: an attestation about the old commit cannot cover
a new one. But it means the rebase creates work for the author. Two boxes become
objectively true and can be evidenced; the local-CI attestation and the
ready-for-review confirmation are theirs. Ask — do not tick them.

## The finding worth keeping

#2794 passed its focused suite 70/0 and still failed three CI shards. Five tests in
four other suites asserted `thoughtSignature === undefined` and the sentinel filled
it. The easy read was "stale assertions". Chasing *why* they disagreed found two real
defects: the replay cache ingested the sentinel as a genuine signature, and
`isLikelyRealThoughtSignature` — the predicate that exists to reject fabricated ids —
accepted it.

**When a change breaks another suite, the question is not whether that test is stale.
It is what that test knew that you did not.** Twice here, the answer was a defect.

## Standing gates, updated

1. Compile and test evidence from the MERGED tree, never the PR head.
2. Pairwise `git merge-tree` before two PRs sharing a file both land.
3. Green checks are not health unless `ci` / `test N/4` / `macos` are present — and
   on a fork PR, confirm the matrix actually **started**.
4. Green targeted suites are not health either; you chose the targets.
5. A rebase is verified by `patch-id` and `range-diff`, never by `git diff OLD NEW`,
   which reports the whole intervening range.
6. Force-push to a fork only with `--force-with-lease` pinned to the author's OID,
   to the author's remote, announced on the PR.
7. `gh run rerun` replays the same commit; only a rebase moves the base.
8. A gate that asks for human judgement (`maintainer-sponsored`) is not an obstacle
   to route around.

## Postscript: the review caught what green CI could not

#2794 had 23 green checks, a 15352/0 full suite, and four mutation-verified fixes.
Ingwannu then found that `antigravitySupportsThoughtSignatureSentinel` scanned the
**entire raw replay identity** rather than the model component. The Vertex key is
`vertex:<project>:<location>:<modelId>` and the project id is operator-chosen, so:

```
vertex:gemini-prod:global:gpt-oss-120b   -> true   (Gemini-only sentinel injected)
vertex:gemini-team:us:claude-fable-5     -> true
```

That is the same defect class the predicate exists to prevent — a Gemini-only token
reaching a non-Gemini model — reintroduced one layer up, in the fix for it.

**My tests could not have caught it.** Every Vertex case I wrote used a neutral
project name, so the positive control was doing double duty as the negative one. A
test suite written by the person who wrote the bug shares its blind spot; that is
what the review is for, and it is the third time in this campaign a reviewer found
something no amount of my own green output would have surfaced.

Fixed by reducing to the model component (last `:` segment, then last `/` segment,
anchored) rather than widening or blacklisting. Mutation-verified: the whole-string
scan fails exactly the new regression.

## Admin-merge authorization (2026-08-28)

The user authorized `--admin` merges, which resolved the self-approval deadlock and
the author-attestation box. Four landed: **#2794** (`bdc1e97bb`), **#2747**
(`fe063d16e`), the round docs **#2806** (`7dd01bfdd`), and #2740 earlier. Each was
already fully green — the authorization removed a *process* gate, not a verification
one, and nothing merged that lacked evidence.

#2770 was closed rather than merged: its branch predated six merges, so its diff
against current `dev` showed 2439 deletions. #2806 replaced it, cut from current
`dev`. #2745 was superseded by **#2807**, which carries the same fix rebased with
both review blockers closed.

## Where the admin merge stopped, and why

Two credential-path PRs were **not** merged despite the rights being available.

**#2638** fails `hygiene` on `unsponsored_surface` naming `src/codex/auth-context.ts`.
That gate asks whether a human has reviewed a credential path; admin rights answer a
different question. The `maintainer-sponsored` label *is* the judgement being
requested, so applying it forges the gate rather than passes it. The author has since
added `fix(codex): fence retry entitlement refresh`, which closes a real window — the
initial auth selection releases its admission before the first response arrives, so a
profile switch could overlap credential discovery. Re-verified at the new head
`e06ffbaa8`: **272/0** focused, **15465/0** full suite, `tsc` exit 0.

**#2807** is subtler and worth recording precisely. `hygiene` **passes** on it, because
`src/server/responses/core.ts` is not in `RESTRICTED_FILES` in
`.github/scripts/pr-sponsored-surface.cjs`. But `.github/CODEOWNERS:46` assigns that
exact file to `@lidge-jun`, and `MAINTAINERS.md:60` requires explicit security review
for credential handling — which is exactly what the diff does: it decides which origin
a rotated-to account's bearer is sent to.

So the automated gate says yes and the written policy says no. **The gate is narrower
than the rule it encodes**, and a passing check is not permission when the rule it
exists to enforce plainly applies. I am both the author and the code owner, so there
is no second pair of eyes on this credential path either way.

That asymmetry deserves fixing at the source: `src/server/responses/core.ts` belongs
in `RESTRICTED_FILES` if it belongs in CODEOWNERS' security boundary. Recorded as a
follow-up rather than changed here — widening a security gate mid-round, while holding
admin rights and an open PR that the widened gate would block, is exactly the kind of
self-serving edit that deserves its own reviewed change.

