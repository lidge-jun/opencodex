# Phase 2 (wp3): close resolved, duplicate and superseded items

## Input

A read-only `gpt-6.1-sol` triage explorer lists candidate items with evidence
(merged PR, SHA, `origin/dev` path:line) and a confidence level. Main acts only on
high-confidence items after checking the cited evidence.

## Actions

| Kind | Action | Comment content |
|---|---|---|
| Issue fixed on `dev` | close as completed | fixing PR and SHA |
| Issue fixed by a PR landed in wp2 | close as completed | the landed PR |
| Duplicate issue | close as duplicate | link to the canonical issue |
| PR superseded by merged work | close | the merged PR that carries the change |
| Duplicate open PRs | close the weaker one | the kept PR and why |

Items with unresolved maintainer objections, feature requests that are merely old, and
anything uncertain stay open and are listed in the wp4 record.
