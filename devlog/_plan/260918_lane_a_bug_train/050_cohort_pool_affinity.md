# #4780 — the binding unit becomes the conversation cohort

## What was verified before anything changed

The issue was filed rather than patched because it is a design decision. Before implementing it,
every claim in it was re-derived at the current head and against the pinned upstream clone.

At `origin/dev`, `codexPoolAffinityKey` resolves to `codexConversationIdentity(...).conversationKey`,
which was `HMAC(session ?? parent, thread)` — per thread, deliberately, and the function's own
comment said so.

Upstream keys the prompt cache on the tree, not the thread. In
`/Users/jun/Developer/codex/121_openai-codex` at `095da4b7e`:

- `codex-rs/core/src/client.rs` — `prompt_cache_key()` returns `responses_metadata.session_id`,
  or `{source}:{parent_thread_id}` for an internal session. Never the thread's own id.
- `codex-rs/core/src/agent/control.rs` — the comment is explicit: `session_id` "is equal to the
  root thread's ID", and that one `AgentControl` is "shared with every sub-agent spawned from
  that root".
- `codex-rs/core/tests/suite/prompt_cache_key.rs` — asserts `differentThreadIds: true` while
  root and child both send `promptCacheKey == expected_session_id`.

The clone's HEAD is 2026-09-08, so it does **not** contain openai/codex#44862 ("Preserve parent
cache affinity for ephemeral forks"), which merged on 2026-09-11 and makes an ephemeral fork
inherit its parent's session id for exactly this reason. Checking that was the point of the
exercise: the issue body is not stale, and upstream has moved further toward cohort keying since
it was written.

So two requests could carry an identical `prompt_cache_key` and be served by different accounts.
The split member asserts a warm prefix that is deterministically cold on its account. Nothing
fails — the prompt is replayed in full and the tokens burn, which is why no log line reports it.

## This is not a revert of #4546 wp8

Stated here, in the code, in `structure/`, and in the PR, because a reader who concludes
otherwise will flip it straight back.

wp8 fixed a genuine incoherence: a child bound under the RAW parent id, which is a different
identity from the root's own `app:HMAC(session, thread)` binding. Siblings therefore shared an
entry the root was not on, and a grandchild keying on its own parent landed on a key nobody had
ever bound. A cohort key cannot produce that, because the root's own binding IS the cohort key:
one identity for the tree instead of two competing ones.

What wp8 additionally gave each thread — a binding of its own — is what this gives up, knowingly.

## The cost, stated rather than buried

A tree gains cache locality and loses per-thread placement independence. Every member shares one
binding, so a fan-out cannot spread across accounts, and when that account is exhausted or retired
the whole tree moves together. That is correct for cache affinity and it is a behaviour change,
not a refinement. It also interacts with the send-budget and placement work #4546 introduced,
since a tree is now one binding for accounting as well as for routing — the issue flags that, and
it remains true.

## Order of work

1. The invariant first, as a regression: root, child and grandchild sharing a session resolve to
   one key; the unbound set is unchanged; the key stays inside its authenticated scope; and a
   move of the cohort carries every member.
2. The orphan guard, because the wp8 argument above has to be proved rather than asserted: a
   grandchild must never land on a key nobody bound. Covered for the session case and for the
   session-less chain, which is the one that could still split if each depth anchored on its own
   parent.
3. The derivation, then the first-placement hook.
4. `structure/providers/openai-tiers.md`.

## The session-less chain

The only case cohort keying cannot read off the headers. There is nothing that names the tree, so
the cohort is read from the parent's lineage record and falls back to `HMAC(parent, parent)` when
this scope has not seen that parent — the same key that parent derives for itself. Without the
record lookup a chain of parent-only turns would anchor on a different ancestor at every depth and
split the cohort again, which is the wp8 shape arriving through the other door.

## First placement

Largely dead now: a member of a tree any other member has bound resolves to that binding, so there
is nothing to place. `pickLineageServingAccount` is kept for the session-less unrecorded-parent
case and gated on the parent's key actually differing from the request's own, so it never re-asks
a question the binding lookup already answered. Removing the mechanism outright would have taken
the `lineage_parent`/`lineage_sibling` affinity reasons and their diagnostics with it, which is a
wider blast radius than this change needs.

## Retired coverage, named

Four placement tests encoded the per-thread contract and could not survive it changing. Each is
either rewritten for the cohort equivalent or explicitly retired with its replacement named:

- "every thread keys as itself" — retired; the key shape, the unbound set and the grandchild
  orphan property are pinned in the new cohort block instead.
- "a child with no binding starts on the parent's account under its OWN key" — retired; the
  cohort block asserts the child joins the existing binding.
- "a later move of the parent does not drag an already-bound child" — inverted deliberately, and
  the comment says so: the asymmetry is what #4780 gives up.
- "a compatible sibling places the child" — rewritten as the cohort rebinding off an ineligible
  account, keeping the negative assertion that a stale home contributes nothing.
