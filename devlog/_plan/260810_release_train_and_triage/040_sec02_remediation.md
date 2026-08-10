# 040 — WP4: Lab evidence sanitization

Compatibility Lab assertion summaries carry provider-controlled text, and that
text is persisted in the `assertion_report` artifact and the observation event.
This work-phase makes the enforced boundary match the contract stated in
`structure/09_compatibility-lab.md`.

## Why this document carries no analysis

`AGENTS.md` §"Security working notes" gives the test: *is there already a
public diff that reveals this weakness?* Until the fix ships in a release, the
answer is no, so the finding detail, the leak reproductions, the residual
reasoning, and the bypass analysis stay in scratch. Only the shipped outcome is
recorded here.

An earlier revision of this file contained that analysis. It was caught by the
security re-review before push and moved to scratch. Worth restating: the rule
binds this agent exactly as `AGENTS.md` says it binds maintainers, and drafting
the plan in the public tree was a violation rather than a judgment call.

## What landed locally

Commits `7fda2c524` and the follow-up hardening from seven re-review rounds
(`4bcaef080`, `0449d72d4`, `3a958242e`, `31151acfa`, `4d010a4e5`, plus the
final casing/whole-match corrections). Local to `dev`; not yet pushed.

- `src/lab/artifacts/sanitize.ts` — the shared scrubber gains ordered rules for
  UNC paths, non-HTTP URIs, JWTs, emails, prefixed and contextual account
  identifiers, MAC addresses, IPv6 (including mapped and scoped forms), IPv4,
  and hostnames, plus URL-path segment scrubbing. Every rule replaces a value
  whole or not at all.
- `truncateUtf8` — byte-bounded truncation matching what the event validator
  measures, splitting neither a code point nor a redaction marker.
- `src/lab/observe/from-live.ts`, `from-conformance.ts` — both event
  constructors sanitize before truncating.
- `src/lab/artifacts/store.ts` — non-contract artifacts declare
  `sanitized_evidence_v2`. Contract classes bypass mutation, so their pinned
  digests are unchanged.
- `tests/lab-evidence-sanitization.test.ts` — 28 tests covering redaction,
  recorded residuals, adversarial timing, truncation boundaries, and activation
  on both constructors and both sinks.
- `structure/09_compatibility-lab.md` — documents the enforced boundary and the
  categories deliberately left alone.

## Process record

The plan passed **7 adversarial audit rounds** (19 blockers folded, none
rebutted), and the implementation then went through **7 rounds of
independent security re-review**, which found **17 further defects**. Every one
was reproduced locally before being fixed, and each fix carries a regression
test plus an ablation showing the test fails without it.

Two lessons are worth keeping, because both cost several rounds:

1. **Enumerating a list loses to a rule.** Path identifiers were found by
   splitting on a delimiter set that grew `/` → `?#&=` → and would have grown
   again for `:` action suffixes and `;` matrix parameters. The workflow guard
   was a denylist of command shapes that lost four separate times. Both were
   fixed by stating the invariant instead: match identifier shapes wherever
   they appear, and forbid executable content from naming the PR head at all.
2. **A sanitizer can fail by removing too much.** Widening a rule for punycode
   swallowed `provider.metric.p95` and `lib.v2-rc1`. Destroying a diagnostic
   breaks the same contract as leaking an address, so the suite now asserts
   both directions.

## Verification

- `bun test tests/lab-evidence-sanitization.test.ts` — 28 pass / 0 fail
- `bun test tests/lab-*.test.ts` — 159 pass / 0 fail
- full suite — see the unit outcome record for the final count
- `bun run typecheck` exit 0; `bun run privacy:scan` passed
- Activation proven by ablation rather than a green suite: reverting the event
  sink, and separately the sanitizer rules, each turned the new tests red.
