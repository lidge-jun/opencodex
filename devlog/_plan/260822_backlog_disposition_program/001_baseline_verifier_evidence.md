# 001 — Baseline verifier evidence at unit open

Captured 2026-08-22 on `dev@ced9a85c5`, macOS darwin/arm64, before any code change in
this unit. These are the commands the decade docs name; PLAN-VERIFIER-REAL-01 requires
they be RUN, not merely cited.

## `bun test tests/tool-argument-integers.test.ts`

```
 24 pass
 0 fail
 32 expect() calls
Ran 24 tests across 1 file. [96.00ms]
EXIT=0
```

Reads the change target: **yes**. The file imports `src/lib/tool-argument-integers.ts`
and `src/bridge.ts` directly, which are exactly the modules WP3 modifies.

Baseline behaviours this suite already pins, which WP3 must not break:

- `never touches number-typed fields` — `'{"temperature":1.0}'` must return byte-identical.
- `leaves fields with no declared schema exactly as received`.
- `#1611 wiring: bridge emits repaired arguments`.

## `bun x tsc --noEmit`

```
EXIT=0
```

Completed in ~0.56s wall (521% CPU, warm). Reads the change target: **yes**, the
`tsconfig` include covers `src/`.

## Remote suite host

`ssh lidge` resolves to `lidge-AI-AI`, Linux x86_64, 16 cores, 30 GB RAM, bun 1.3.14 at
`/usr/local/bin/bun`, repository at `~/Developer/opencodex`. At probe time its checkout
was behind `origin/dev` (head `c378435022`); any full-suite run there must fetch and
check out the exact head under test before its output counts as evidence.

## Repository authority confirmed at open

```
gh api repos/lidge-jun/opencodex --jq .permissions
{"admin":true,"maintain":true,"pull":true,"push":true,"triage":true}

gh api repos/lidge-jun/opencodex/branches/dev/protection
404 Branch not protected
```

`dev` carries no branch protection, so merges are gated by this unit's verification
discipline rather than by GitHub. That makes the per-phase C evidence the only real
gate — treat it accordingly.

## Cross-check: #2320 and `Closes #2316`

The #2316 triage comment instructed that PR #2320 must not carry `Closes #2316`.
Verified at unit open: **#2320 is MERGED and its body still contains `Closes #2316`**,
yet **issue #2316 is still OPEN**. GitHub auto-closes a linked issue only when the PR
merges into the default branch (`main`); #2320 targeted `dev`, so the link never fired.
The risk is therefore latent, not realised: it would close #2316 spuriously at the next
`dev`→`main` promotion if the issue is still open then. WP3 closes #2316 on its own
merits well before that, which resolves the hazard without editing merged history.



---

# AMENDMENT (A-phase round 1, blocker B7) — the auto-close hazard claim is WITHDRAWN

The section above claimed the merged #2320 "would close #2316 spuriously at the next
`dev`→`main` promotion". That is wrong and is withdrawn.

Re-verified: the squash commit that landed on `dev` is

```
fix(cursor): classify bare 0-token resource_exhausted as context overflow (#2320)
```

It contains **no closing keyword**. GitHub ignores closing keywords in a pull request
body when the PR targets a non-default branch: no link is created at all, so there is
nothing for a later promotion to trigger. Promoting an already-created commit cannot
resurrect an ignored keyword.

The **state facts remain verified and stand**: #2320 is MERGED, its body still contains
`Closes #2316`, and #2316 is OPEN. Only the inferred future hazard was false. A real
hazard would require a *promotion commit that itself carries a closing keyword*, which is
a separate condition and is not present.

