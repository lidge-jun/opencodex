# 110 — #2114 disposition: unblock, do not compete

Outcome: **no code PR.** Two comments — the containment on #2029
(`5342888183`) and the ownership record on #2114 (`5342892253`).

## What the reviewer actually objected to

Read rather than summarized. @Ingwannu on #2029:

> A missing user bus does not prove that `~/.config/systemd/user/opencodex-proxy.service`
> is absent. The definition can remain on disk while the user manager is
> unavailable, and it can name another `CODEX_HOME` or `OPENCODEX_HOME`.
> Returning absent before inspecting that artifact lets the ownership preflight
> treat the machine as unclaimed and overwrite a foreign or interrupted
> installation.

That is the same hazard `020` arrived at independently and wrote down as
"test 3". Two people reaching it separately is the strongest signal in this
whole unit that it is the real constraint.

## The finding that made this a comment instead of a PR

The reviewer asked for: inspect the unit file, absent → `absent`, exists →
present claim with registration absent, unreadable → `unknown`.

**`inspectSystemd` already does exactly that**, at lines 289-313 — check
`artifactPresence(definitionPath)`, `readFileSync`, parse
`unitEnvValue(body, "CODEX_HOME")` and `OPENCODEX_HOME`, return a `present`
claim. The no-bus branch simply returns before reaching it.

So the containment needs **no new machinery** — only a different control path
through code that is already there. A separate PR would have re-implemented
something sitting twenty lines below.

## Why not just open our own PR anyway

#2114 and #1939 are one classifier with two symptoms: a refused sync there, a
process-lifetime native-main 503 here. A second PR on the same function means
two people making the same fail-closed security-adjacent call, and whichever
lands second silently overwrites the first.

The stderr shapes make the overlap concrete. #2029 matches two messages and
pins everything else as `unknown`; #2114's shape is a third
(`Failed to connect to user scope bus via local transport…`) and is currently
on the pinned side.

## What was offered

- The concrete code shape, reusing the existing helpers.
- The locale-fragility tradeoff **stated rather than hidden**: string matching
  will miss a non-English systemd. Worth noting that with the disk check, a
  mismatch degrades to a missed recovery rather than a wrong admission — which
  is a much safer thing to be locale-sensitive about. Alternative named
  (`LC_ALL=C`) without pretending it is free.
- Six regressions, including the #2114 stderr and the existing
  non-bus-non-zero assertion kept as the over-widening guard.
- A rebase note: the review's "125 commits behind" is stale, but `dev` has since
  taken the split, so a rebase is needed regardless.

## What was deliberately not done

No push to a contributor branch, no competing PR, and #2114 left **open and
linked** rather than closed as a duplicate — the 503 symptom is distinct enough
that someone hitting it should find that thread rather than a redirect.
