# 000 — Research: three gaps the 260904 triage found but did not close

A triage pass over open PRs and issues closed #3366, #3061, and merged #2877.
Three candidates were deliberately left open because the evidence said they were
NOT done. This unit closes them properly.

## Gap 1 — PR #3293 shipped half of itself

`claude-fable-5-1` pricing is on `dev`; its metadata is not.

```text
git show origin/dev:src/usage/expected-prices.ts | grep -c claude-fable-5-1   -> 4
git show origin/dev:src/generated/model-metadata.ts | grep -o '"claude-fable-5-1"'  -> (none)
git show origin/dev:scripts/model-metadata.source.json | grep -c claude-fable-5-1  -> 0
```

The pricing rows arrived through unrelated commits (`3d3c4fe26`, `ff1ac6b8c`,
`1aa839aa8`) that happened to touch `expected-prices.ts`. PR #3293 by
[@Veritas-7](https://github.com/Veritas-7) is the only source of the metadata
half, and it is still open and MERGEABLE.

That asymmetry is the actual defect: `expected-prices.ts` asserts an expected
price for a model the generated catalog does not know about. This is a
half-shipped feature, not a superseded one, which is why the triage left it open
rather than closing it as done.

## Gap 2 — issue #3431 asks for a credit the file's own rule requires

`CREDITS.md` on `dev` has 19 Carried-work rows and none for #3284.

Verified independently rather than taken from the issue text:

- `3d3c4fe26` is an ancestor of `origin/dev` and is the #3286 merge.
- `src/providers/antigravity-models.ts` on `dev` names `gemini-3.8-flash` 16
  times; the suffix ladder shipped.
- #3284 by [@mdwsk88](https://github.com/mdwsk88) is CLOSED, not merged.
- Maintainer [@Ingwannu](https://github.com/Ingwannu) closed it as superseded and
  wrote, in that closing comment: "Core implementation is already on `dev` via
  #3286 (`3d3c4fe26`), including the suffix wire ladder, picker collapse, Google
  adapter coverage, metadata/pricing, and remaining surfaces."

That last line matters procedurally. `CREDITS.md` says entries "must not be
inferred from diff similarity alone" and that every entry cites the maintainer's
own words. The closing comment IS that citation, so this row is admissible on the
file's own terms.

## Gap 3 — issue #3429 asks for a feature that was already closed once

This is the one that needs care.

PR #2994 by [@Ingwannu](https://github.com/Ingwannu) added `ultrafast` to the
pinned `gpt-5.6-sol` fallback catalog. It was closed unmerged on 2026-08-30 with
the maintainer verdict:

> Ultrafast는 프런트 노출 오류다. 피커에 칸을 올리면 고를 수는 있는데, 실제
> Ultrafast 속도가 나오지 않는다. 백엔드가 깨져서가 아니다.

Issue #2993 was closed with it. So "add ultrafast to the catalog" is a decision
that was already made and reversed, and re-landing it as a default would
reintroduce exactly the defect it was reverted for: a picker row that can be
selected but does not deliver the speed it names.

What #3429 reports is narrower and still true:

- `src/codex/catalog/parsing.ts` deletes `service_tier`, `service_tiers`,
  `default_service_tier`, and `additional_speed_tiers` from these rows, so the
  tier cannot survive a catalog regeneration even if the user edits
  `~/.codex/opencodex-catalog.json` by hand.
- When a user forces the tier through anyway, the request completes but the
  classification does not recognise it: `fastOutcome` reads `not-requested` and
  the confirmation reads `unknown`, with no speed label for ultrafast.

The second half is a straight defect regardless of the first: the proxy is
carrying a tier it refuses to name.

## The shape this unit takes

Opt-in, default OFF. With the setting unset, nothing changes for anyone — the
stripping still happens, the catalog is byte-identical, and #2994's verdict
stands. With the setting on, the operator has said "I know what this is", the
tier survives end-to-end, and the logs name it honestly instead of reporting
`unknown`.

That is what makes re-landing this defensible after #2994: the reversal was about
showing everyone a row that lies. An operator-enabled flag that also fixes the
classification does not.

The user additionally asked for the Codex Set page head to be relieved of the
"한도 도달 계정 일시 중지" and "할당량 새로고침" controls, moving them below, with
the Ultra Fast toggle surfacing there. That is the same surface, so it lands in
the same phase.

## Design read

Existing dashboard, no new visual language.

DESIGN_VARIANCE: 2, MOTION_INTENSITY: 1, density D5 — operator console for
repeated expert work. The page head is currently carrying three controls plus a
title on one row, which is what the user is reacting to; moving the two
account-scoped actions down to the section they act on is a density fix, not a
restyle.

Do's: reuse the existing Switch + label + description row pattern, the existing
`btn btn-ghost btn-sm` controls, and the existing quota-refresh i18n keys.
Don'ts: no new panel, no default-on behavior, no picker row without the wire
support behind it.

## Out of scope

PR #3332 (user deferred it explicitly), release scripts, workflows, auth paths,
`gui/dist`.
