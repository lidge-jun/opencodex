> **SUPERSEDED IN PART — read `000_research_inventory.md` amendments 1 and 2 first.**
>
> Two things in this document are wrong and were corrected after it was written:
>
> 1. **It is NOT a stack layer and does NOT root on #2134.** No dependency edge exists;
>    the shipped PR (#2137) is based on `dev` as a sibling.
> 2. **The substitution predicate is NOT "native ChatGPT pool".** Pool-only would exclude
>    `codexAccountMode: "direct"` and re-break #1686, whose Direct admission is only safe
>    BECAUSE substitution still runs. The shipped predicate is
>    `route.codexAccountMode !== undefined`, covering pool AND direct. Do not "correct" it back.


# 010 — Layer 1 (stack bottom): fix issue #2132, bearer admission must not force a ChatGPT credential

Work-phase: wp2. Branch: `codex/fix-bearer-admission-2132`. Base: `codex/fix-subagent-roster-truncation` (PR #2134).
Absorbs: nothing (no PR exists). Closes: #2132.

## Why this is the stack bottom

It is the highest-scoring item in the backlog (96) and it shares `src/server/responses/core.ts`
with layer 2 (#2131). Layer 2 must be based on this, or the two edits to that file collide.

## Defect

Reported in #2132: after v2.23.0, a key-auth provider (Cloudflare/etc.) returns 401
`No usable Codex main credential` when `~/.codex/auth.json` holds no ChatGPT token. Bearer
admission sets `substituteMainCredential` unconditionally, so a route that needs no ChatGPT
identity is still gated on one.

## P-phase re-verification required (stale check)

Before editing, confirm against the CURRENT tree — the lane read `dev`, not this branch:
1. `rg -n "substituteMainCredential" src/` — enumerate every producer and consumer.
2. Read `src/server/responses/core.ts`, `src/server/responses/compact.ts`,
   `src/codex/auth-context.ts` and establish where the flag is set and where it is read.
3. Reproduce the admission decision in a unit context with a key-auth provider and an
   auth.json containing no ChatGPT token. If the current code does NOT reproduce, stop and
   amend this doc rather than writing a fix for a defect that is not there.

## Intended change

Make the substitution conditional on the resolved route actually requiring a native/ChatGPT
credential. A key-auth routed provider carries its own credential and must be admitted
without one. Exact call sites are fixed during the stale check above; the invariant is:
`substituteMainCredential` is set only when the route's credential source is the native
ChatGPT pool.

Out of scope: changing what happens once a native route legitimately lacks a credential,
and any change to the pool/account selection itself.

## Test plan (must fail RED first)

New `tests/bearer-admission-key-auth.test.ts`:
1. key-auth routed provider + auth.json with NO ChatGPT token -> request is admitted (no 401).
2. native gpt route + no ChatGPT token -> still fails closed with the existing error.
3. key-auth provider + ChatGPT token present -> unchanged behavior (no regression).

Drive the file against the unpatched tree first and record the failure output; a test that
passes before the fix does not prove anything.

## Verification

`bun run typecheck`; `bun test --isolate` on the new file plus the existing responses/auth
suites; full `bun test --isolate tests` before marking review-ready; `bun run privacy:scan`.

## Standalone thesis (DEV-STACK-03)

"A provider that carries its own key must not be gated on a ChatGPT credential." Builds and
passes its own tests at its own tip, independent of layer 2.

