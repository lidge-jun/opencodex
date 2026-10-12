# 030 — wp3: land #3104, then close #3009, #3064, #3039, #3067

PR #3104, author `lidge-jun`, branch `codex/3009-windows-cold-start`, label `bug`,
**APPROVED** by `Ingwannu` on exact head `4f691cddc252a13c5bea73cb9f5fbb1b5728521a`.
`+508 −66` across 5 files. Seven commits:

```
7b1b4ce1 fix(service): give a Windows cold start room to bind, without loosening…
b727f8f8 fix(service): forgive only what the code page mangled in a scheduler …
188e6186 fix(service): bind scheduler recovery to exact SID
4d83513b fix(service): fail closed on ambiguous scheduler ownership
97efe6f4 test(service): lock scheduler ownership guards
b29389a8 test(service): scope scheduler verification fixtures
4f691cdd test(service): exercise scheduler ownership oracles
```

## What it carries

Two issues, one file (`src/service.ts`), stacked deliberately because a conflicting pair
would have been more expensive to review than one sequence.

**#3009 — Windows cold start.** `confirmServiceServing` had a fixed 20 s deadline and
returned the moment the clock passed it. A Windows cold start does NTFS ACL hardening and
previous-session journal recovery before the listener exists, so a service that bound a few
seconds late and then stayed healthy was reported as a terminal failure with exit 1 — and the
caller's fallback starts a second proxy against a port that is about to be taken. Windows gets
45 s; nothing else changes. The zero-budget `expect(probes).toBe(1)` assertion that #3039
relaxed to `toBeGreaterThanOrEqual(1)` is restored, because "at least one" passes against
exactly the version it exists to forbid.

**#3064 — non-ASCII profile path.** `schtasks /query /xml` converts through the console code
page before the bytes exist, so reading as a buffer cannot recover them. A profile named
outside that page returns `C:\Users\???\...` and the exact comparison rejected a
registration this process had just created. The narrowing matters: #3067 compiled every
unrepresentable run to `[^\\/]*`, which forbids a separator but allows arbitrary ASCII, so a
wholly non-ASCII segment loses every anchor and
`C:\Users\<CJK>\.opencodex\service-launcher.vbs` matches
`C:\Users\Admin\.opencodex\service-launcher.vbs` — this process would then adopt, repair or
delete another account's task. Here an unrepresentable run matches only a run of substitution
characters, and every ASCII segment including every separator is matched literally.

## Approval is bound to a head that must change

The branch is ~27 commits behind `dev`, and its `macos` job is red on the `server-auth`
WebSocket assertion that #3128 fixed. So the approval on `4f691cdd` cannot be spent as-is:
rebasing moves the head, which invalidates it.

That is the correct outcome, not an obstacle to route around. The rebase is onto a `dev` that
has moved 27 commits, including `0ef04e640` (`fix(cli): stop start shadowing a live
configured-port proxy`) which is adjacent CLI/service territory. Re-review the rebased head
rather than treating the pre-rebase approval as transferable.

## Steps

1. Rebase `codex/3009-windows-cold-start` onto `origin/dev`. **Amended by audit round 1
   (blocker 5):** the dev-side overlap in `src/service.ts` is `330470e74` (#3118), not
   `0ef04e640` — that commit touches only `src/cli/dispatch.ts`, `src/cli/index.ts` and
   `tests/cli-dispatch.test.ts`. `src/service.ts` is the sole file changed on both sides.
2. `git range-diff` to prove all seven commits survived and no content changed beyond
   conflict resolution.
3. If a conflict was resolved, run `bun test tests/service.test.ts` locally — a focused check,
   permitted, and the file the PR's own evidence names (187 pass / 0 fail).
4. Force-push, wait for the full matrix.
5. Merge once green. Re-approval on the new head is required by the ruleset.
6. Close #3009 and #3064 manually — PRs here target `dev`, so GitHub's auto-close on
   `Closes #` does not fire (`AGENTS.md`, "Issues and pull requests").
7. Close **#3067** with a credit comment naming @ntdatt812, the merged commit, and what
   changed: the unsafe `[^\\/]*` wildcard and the lossy `UserId` comparison were replaced by
   substitution-only path matching and SID-exact ownership (`src/service.ts:2018-2052` on
   the PR head).
8. **Do not close #3039.** See below.

## Amended by audit round 1 (blocker 4): #3039 is not fully superseded

#3104 does not carry everything #3039 authored. The diagnostic message differs:

```
#3039  src/service.ts:742-753   Math.max(1, Math.round((elapsed() - startedAt) / 1000))
#3104  src/service.ts:742-750   Math.trunc(healthBudgetMs / 1000)
```

#3039's own comment states the intent: "The elapsed time, not the constant: a caller that
passes its own timeoutMs used to be told it had waited 20s whatever it waited." #3104 prints
the configured budget instead. Because #3104 also adds a post-deadline grace knock
(`src/service.ts:719`), the printed number can now understate the real wait — reintroducing
the exact defect #3039 fixed, inside the PR that claims to supersede it.

This does not block merging #3104: the budget message is not wrong about the budget, and the
ownership hardening is untouched. It blocks the closure. #3039 stays open with a comment
recording which contribution was not carried, so the elapsed-time diagnostic is a tracked
follow-up rather than a silent drop by a train that promised no judgment calls.

## Accept criteria

- Rebased head fully green including `macos`.
- `origin/dev` contains all seven commits' content.
- #3009, #3064 closed; #3067 closed with credit.
- #3039 **open**, with a comment naming the uncarried elapsed-time diagnostic.
