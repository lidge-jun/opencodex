# wp1 — Regression review of the 36 dev-ahead-of-main commits

## Input

`git log --oneline origin/main..origin/dev` at the head recorded in
`000_plan.md`. Baseline is `v2.40.0`.

## Method

Each commit gets one row: SHA, PR, risk class (R0-R3 per `000_plan.md`), the
evidence actually checked, and a verdict of `clean`, `accepted`, or `blocker`.
A `blocker` must be fixed on `dev` before wp3 starts; an `accepted` row must
say why the residual risk is tolerable in a release.

Evidence is gathered without the full suite:

- `git show --stat <sha>` for the touch set of every commit.
- For R1/R2, the focused test file that owns the subsystem, run individually.
- For R3, a line-level read of the credential handling plus
  `bun run privacy:scan`.
- `bun run typecheck` once at the dev head covers the type-level seams that a
  per-commit read would otherwise have to reason about by hand.

## Special attention: the Meta/Muse line

Three questions decide whether this release is safe to publish:

1. **Does `meta-muse` ever write the imported credential anywhere a log or a
   scan can see it?** #3337's follow-up (`81c1ebe8c` on the feature branch,
   squashed into `1aa839aa8`) redacts scanned secrets and bounds the Keychain
   read. Verify the redaction covers the error paths, not just the happy path.
2. **Can the ToS warning be bypassed?** The provider is deliberately marked
   unsupported; the warning is the only thing standing between a user and an
   unauthorized use of their Muse Code subscription.

   The verdict rule, so a later reader reaches the same decision this unit
   did. A bypass is `UNSAFE` and blocks the release when it is EITHER of:

   - a **new** bypass introduced by a commit in this delta, or
   - any path that **discloses the credential** (a log line, an error body, a
     serialized config field).

   A bypass is **accepted** only when all three hold: it predates the delta,
   it applies identically to the other `HIGH_RISK` providers rather than
   singling out `meta-muse`, and it is recorded in `050_followups.md` with
   the file:line evidence. That is exactly one case here — the client-side-only
   acknowledgement on `POST /api/oauth/login` — and `005` §1 is why it
   qualifies. Anything that does not meet all three is `UNSAFE`.
3. **Does Muse Spark 1.3 leak into a provider that cannot serve it?** #3317
   added 1.3 on the 1.2 spec across the resellers; the registry must not
   advertise 1.3 on a provider whose upstream roster lacks it.

## Output

`011_review_ledger.md` — the per-commit table. Written in wp1's B phase, not
here.
