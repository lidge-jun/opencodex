# 140 — closeout

## Where this landed

Every issue authored by `lidge-jun` is closed. `gh issue list --author lidge-jun --state open`
returns zero rows. Every `bug`-labelled pull request is terminal except one, and that one is
open by decision rather than by omission.

Final `dev` verification at `1a92d6b55`: **15005 pass / 16 skip / 0 fail**, typecheck exit 0.

## The one thing deliberately left open

**#2497** — native main token refresh and replay. It is the credential boundary AGENTS.md
places under explicit security review, it got one, and three blockers were verified by hand
rather than taken on a reviewer's word (`120_wp5_2497_security_review.md`):

1. `auth.json` publication renames before it links, so a crash between the two strands the file
   and nothing recovers it at startup.
2. The same-account fallback adopts a *different* pool refresh grant into native-main. Account-id
   equivalence is not grant ownership — this is the exact hazard `anthropic-routing.ts` fails
   closed on.
3. The "exactly one" 401 replay is one *logical* replay. The post-401 send goes through
   `fetchWithTransientRetry`, whose 3x3 ladder means one recovery can be up to nine physical
   sends. Nothing reaches the client twice, but upstream work can commit more than once.

(2) is a credential-ownership decision, not a defect to pick a side on silently: tightening it
to grant-only changes what happens to an operator who re-logged in through the pool and expects
main to follow. Fixing three security blockers inside someone else's 2,600-line credential PR
and admin-merging it is not a thing to do quietly.

## What the run found that nobody asked for

Three defects that only appeared because the work was verified rather than assumed:

- **`ocx uninstall` could not remove a config home OpenCodex created itself.** Two of our own
  writers produce files the ownership manifest never claimed. Only the disposable-host acceptance
  could surface this, because only it runs the production uninstall against a home the product
  built. Fixed in #2618.
- **Three regressions from combining #2463 and #1478**, each green in isolation and red together:
  a `structuredClone` that threw on a non-cloneable provider value, an alias route that swallowed
  the API-key-pool rename endpoint, and a command missing from both documentation sweeps. Fixed
  in #2614. This is the argument for a full-suite gate that a per-PR gate cannot make.
- **A session lane keyed on the parent thread** would have 503'd every parallel subagent after
  the first. Reproduced before fixing; a lane wants the most specific identity, which is the
  opposite of what account affinity wants.

## Recorded, not absorbed

- **#2622** — the Codex provenance ledger is never written; `updateIntegrationRecord` has no
  production caller. Found while the #1048 rows tried to assert on it. The rows now fail only on
  disagreement, because requiring an entry no production path can produce would have been testing
  an unimplemented writer.
- **#2568's activation default stays opt-in.** The issue asks for presence-driven activation by
  analogy with a 2-key API pool. An API-key pool spends the operator's own metered credit;
  rotating across subscription accounts spends a second subscription's quota, which is why the
  Anthropic pool shipped opt-in. Turning it on later costs nothing; a default-on rotation that
  surprises someone has already spent the quota. Escalated to the owner with the one-line change
  named.

## What earned its keep

Falsification. Reverting each fix to confirm its test actually fails caught a patch earlier in
this unit (#2488) whose test passed with the fix removed — it was pinning behavior that already
held. That patch was dropped and only the test kept. Every fix merged here was checked the same
way, and three of them (the parent-thread lane, the atomic adoption publication, both uninstall
hunks) are load-bearing only because that check said so.
