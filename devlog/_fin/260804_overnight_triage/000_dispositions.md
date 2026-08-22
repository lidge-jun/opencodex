# 000 — Overnight PR triage: nine PRs, four verdicts

Nine pull requests arrived overnight while the #951–#955 stack was in review.
The question for each: does it duplicate work already on the stack, is it a real
independent defect, or does it belong somewhere else entirely.

Measured 2026-08-04 against `origin/dev` and the stack head
`codex/915-cooldown-recovery-probe` at `493329df0`.

## Verdicts

| PR | Author | Verdict | Action |
|---|---|---|---|
| #967 | @Yuxin-Qiao | **two real defects in OUR #955** | carry onto layer 6 |
| #965 | @Yuxin-Qiao | correct fix for #962 | carry onto layer 6 |
| #963 | @MarcTCruz | duplicate of #965, broader and weaker | close, name #965 |
| #968 | @DevMello | real independent defect | carry onto layer 6 |
| #964 | @Yuxin-Qiao | real independent defect (#956) | leave open, own review |
| #966 | @Yuxin-Qiao | partial fix, fifth falsified design | leave open, request changes |
| #970 | @stephen-drew | real, out of stack scope | leave open |
| #961 | @Yuxin-Qiao | feature, not a bug | leave open |
| #969 | @Wibias | CI governance policy | out of scope |

## #967 — the one that matters most

@Yuxin-Qiao reviewed #955 and found two defects **in my own code**. Both verify.

**P1: monthly-classified snapshots were rejected.** My
`isCompleteCodexQuotaRecoverySnapshot()` picked the required window from the
plan NAME. The parser picks it from the window DURATION
(`isExplicitMonthlyWindow()`, `src/codex/quota.ts:104-109`), and a Team response
whose primary window is explicitly monthly parses to `monthlyPercent` only. So
the probe rejected every successful fresh read for those accounts:

```console
$ bun run .tmp/probe_967.ts   # on the stack head, BEFORE the fix
parsed        = {"monthlyPercent":12,"monthlyResetAt":1900000000}
recoverable?  = false      <-- Team monthly account can never recover
weekly parsed = {"weeklyPercent":12,"weeklyResetAt":1900000000}
recoverable?  = true
```

That is the same "cooled forever" failure #915 exists to fix, reintroduced for
monthly-window plans. It is also the *third* time this predicate has been wrong
in the same direction — first the plan allowlist, then `prolite`, now the
window-classification mismatch. The lesson has been consistent and I kept
missing it: this predicate must read what the parser actually wrote, never
re-derive the classification itself.

**P2: the probe's own token refresh looked like a replacement.**
`getValidCodexToken()` refreshes a near-expiry token inside the probe fetch and
advances the credential generation by exactly one
(`src/codex/account-store.ts:415-421`). My settle required the claim-time
generation to match exactly, so a successful fresh read under the refreshed
generation was thrown away and recovery waited another five minutes.

The fix fences the +1 transition on `replacedAt`, which is the right
discriminator:
`saveCodexAccountCredentialIfGeneration()` **preserves** `replacedAt`
(`:195-217`) while `saveCodexAccountCredential()` **stamps a fresh one**
(`:131-146`). So a probe-owned refresh and an external replacement are
distinguishable even though both bump the generation.

Verified after the fix — every fail-closed guard still holds:

```console
credits-only  -> false      windowless {} -> false      null -> false
exhausted 100 -> false      go+weeklyOnly -> false
team monthly  -> true       team weekly   -> true
```

Red-green: ablating P1 fails 2 tests, ablating P2 fails 1 different test.

## #963 vs #965 — the duplicate pair

Both claim "Fixes #962", both edit `src/codex/catalog/provider-fetch.ts`.
**#965 wins.**

#962 is specifically about a custom row *replacing* a same-slug provider row.
#965 models exactly that: it indexes the rows deduplication will replace and
fills only undefined capability fields from the replaced row, so it also
inherits live `/models` metadata such as normalized `capabilities`.

#963 instead recomputes `catalogHintsFromProviderConfig()` for **every** custom
row, including custom-only rows with no provider counterpart — broader than
#962 requires. It cannot retain discovered metadata, since it rebuilds from
config rather than inheriting. And it rewrites an existing regression contract
to fit: `tests/catalog-vision-sidecar-modalities.test.ts` changes from "no
registry reasoning metadata leaks onto an unmatched custom override" to
expecting that leak, and drops three `fetch should not be called` guards.

Changing a test that encodes a deliberate prior decision, in order to make a
broader change pass, is the part that decides this. #965's ablation fails
exactly one test — the #962 regression — which is what a focused fix looks like.

## #966 — a fifth design, still falsified

#966 targets #914, which four prior designs already failed at an audit gate
(`devlog/_fin/260803_transport_attribution/000_plan.md`). It is a genuine
advance: it uses the real Bun 1.3.14 error labels including both alternating
ones, it does **not** repeat the hostname-resolution design, and it closes the
redirect counterexample on the pool Responses and Compact paths with manual
redirects. TLS/fake-IP codes correctly stay account-scoped.

But two falsifications survive, both reproduced live:

**Mixed 5xx → rejection still loses the attributable failure.**
`fetchWithTransientRetry()` discards prior transient responses when a later
attempt rejects (`src/lib/upstream-retry.ts:220-236`), so a genuine 503 followed
by a connection refusal is recorded as account-neutral. That is precisely the
hole the earlier audit documented.

**Falsification 3 survives on five expanded surfaces.** Manual redirects were
added only to Responses and Compact; the five sidecar paths #966 newly
classifies still use default-follow fetch, so a credential-bearing sidecar that
receives a 307 to a dead host is misclassified as neutral — after the origin
already read the `Authorization` header:

```text
redirect:"follow"  serverSawAuthorization:"Bearer credential-follow"  resolved:false
redirect:"manual"  serverSawAuthorization:"Bearer credential-manual"  resolved:true 307
```

So #966 is not mergeable as-is, and its sidecar expansion carries the unresolved
hole *beyond* #914's original sites. It does supersede #922 (which misses one
Bun label entirely, keeps default redirects, and bundles unrelated probe-lease
work while sitting at `CHANGES_REQUESTED`).

Neither lands on our stack. #914 remains open with a fifth design on record.

## The rest

**#968** (@DevMello) — the google adapter dropped `tool_choice` entirely: `none`,
`required`, and a forced tool all produced a wire body identical to `auto`, with
only a prose nudge in the system prompt. The wire compiler already validated
`toolConfig.functionCallingConfig`; the adapter simply never built it. Carries
cleanly onto the stack; same author as the already-carried #943.

**#964** (@Yuxin-Qiao) — the `nvidia` registry entry lacks `noVisionModels`, so
the vision sidecar never activates for NIM text-only models and raw image parts
reach a text-only upstream. Real, but it is a registry/provider change with no
relationship to this stack's theme; it deserves its own review rather than a
ride on a bug stack.

**#970** (@stephen-drew) — service re-registration during self-update. Real, but
30 files across CLI, GUI, and five docs locales, touching a
permission-sensitive install path. Out of scope here.

**#961** — provider custom headers via PATCH. A feature, not a bug.

**#969** (@Wibias, collaborator) — CI policy that auto-drafts contributor PRs
until a checklist is complete. Out of scope: it is a workflow change requiring
security review per `AGENTS.md`, and it encodes a contribution policy that is
the maintainer's call, not a bug fix. Worth noting the history — the #900–#905
stack was closed on exactly this kind of policy question, not on its mechanics.

## Layer 6 contents

Carry, in order: #967 (fixes our own defects), #965 (catalog), #968 (google
tool_choice). Everything else stays where it is, with a reason on record.
