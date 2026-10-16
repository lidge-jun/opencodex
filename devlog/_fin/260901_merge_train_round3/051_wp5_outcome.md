# 051 — wp5 outcome: #3077 closed, #3109 and #3112 rebased

The phase that changes no `dev` state. All three items done.

## #3077 — closed

It proposed `2.39.0-preview.20260831`; `origin/preview:package.json` carries
`2.39.0-preview.20260901`. Merging it would have moved the prerelease line **backwards**.
Verified both sides before closing rather than trusting the plan's note.

The problem it was opened for — `release version line` going red on `preview` after a
promotion — has since been addressed on the version-bump path by #3129 (`6f415baef`).

## #3109 — rebased, one commit dropped

`926a8d8c4` -> head `b3b502045`, five commits on current `dev`.

The dropped commit is `926a8d8c` (`test(auth): pin websocket refresh account`), which the
review asked to remove as out of scope. It was tracked separately, as the review asked, and
landed as #3128 — so keeping it here guaranteed a conflict against its own successor.

```
1: f887a855c = 1: d63785643 fix(compact): route combo compact requests through failover path
2: a4aba1495 = 2: c3888a6ed test(compact): cover combo failover and streaming
3: 399726aae = 3: 9c9146faf preserve opaque compaction ciphertext
```

`tests/server-auth.test.ts` is gone from the diff, which was the point.

## #3112 — rebased, all four commits

`1ade87086` -> head `f3c4e9f75`, all four `=` by `range-diff`.

One trap worth recording: the **local** branch `codex/2999-native-main-refresh-claim` was
not the PR head. It carried a `docs(devlog): record wp5, wp6 and wp7 receipts` commit that
the PR does not have, and rebasing it conflicted against
`260831_bug_triage_nonprio70/070_outcome.md` — content this train had already landed via
#3114. Rebasing the local branch would have pushed a different PR than the one under review.
Fetched `pull/3112/head` and rebased that instead.

**Neither PR's blockers were touched.** #3112's three credential-path findings — the shared
30s signal across claim acquisition and refresh, the over-broad `!signal?.aborted` quarantine
gate, and transient contention logging "reauthentication required" — all stand, and it needs
a fresh security review before it lands. #3109's production direction was already called a
strong merge candidate; what it needed was a live head and the out-of-scope commit gone, and
it now has both.

## The correction both comments carry

Each PR's review cited the WebSocket flake as fixed by #3128. It is not, and both comments
say so with the evidence, because a wrong "known flake" citation is worse than none — it
teaches the next reviewer to dismiss a red that might be real.

`git merge-base --is-ancestor 33d32b6a3 <carry head>` returns true, and the assertion still
fired on #3133's first run. #3128 pinned the account namespace in three lines; the race is
elsewhere.

**The explanation those comments carry is itself now superseded.** They describe a 60 s
margin against `REFRESH_SKEW_MS`. wp7 later proved that wrong in both direction and
quantity: the credential's margin is months, and what actually varies is the *quota cache
age* the startup prime measures. See `060_wp7_websocket_refresh_flake.md`. The operational
advice in those comments — rerun rather than read a single red as a regression — still holds,
which is why they were not amended a second time.
