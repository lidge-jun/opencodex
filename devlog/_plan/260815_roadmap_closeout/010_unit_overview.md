# 260815 Roadmap Closeout — Unit Overview

Source: external roadmap review captured 2026-08-15 (raw transcript in
`000_source_capture_raw.txt`). The review re-inventoried open `bug`,
`provider`, and `provider-compatibility` issues and produced a merge train.
This unit executes the parts of that train that can be landed with evidence.

## Execution model

One PABCD work-phase per decade doc. Work lands directly on `dev` (owner
pre-approved direct push for this unit, `--no-verify`), one focused commit per
unit. Each landed unit gets a comment on its linked issue naming the `dev`
SHA, then the issue is closed — unless the roadmap explicitly says otherwise.

## Units

| Doc | Unit | PR | Issue | Roadmap constraint |
|-----|------|----|-------|--------------------|
| 020 | gateway model-cache auth | #1755 | #1713 | security review of which credential is attached |
| 030 | openai-chat null tool deltas | #1754 | #1731 | parser and diagnostics must share one null predicate |
| 040 | Z.AI GLM-5.3 metadata | #1762 | #1734 | confirm official metadata before merge |
| 050 | Gemini thought signature | #1772 | #1735 | not a web-search-only patch; shared opaque-metadata layer |
| 060 | unified exec input contract | #1763 | #1730 | merge the common fix only; #1730 stays open |
| 070 | openai-chat encrypted schema | #1776 | #1774 | keyword-only strip, preserve literal data, bounded traversal |
| 080 | browser CORS preflight | none | #1773 | origin-gated, Vary, no auth side effects on OPTIONS |
| 090 | landed-state drift | — | #1467, #1436 | close only with focused smoke evidence |
| 100 | label normalization | — | several | mechanical |

## Explicit holds

- #1703 -> #1697 is not merged. Static-config provider inference can route a
  request to a provider the operator never selected for that turn, which is a
  privacy and billing boundary, not a defaulting convenience.
- #1730 is not closed by #1763. The PR's own description states it does not
  address the Camel first-turn provider-specific failure.
- Upstream labels are not applied to #1668 or #1419 without an external ticket.

## Out of scope

New bug filings, the P1/P2/P3 research waves, releases, and any security
write-up (which belongs in scratch, per `AGENTS.md`).
