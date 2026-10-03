# Published CLI UX stack

Outcome: **PUBLISHED_DRAFT**. The requested command-help UX is implemented and
published as three dependent PRs, with a small CLI deadline prerequisite that
hosted CI exposed. This is completed draft publication, not merge or full local
validation. No client integrations, installed app or live proxy were changed.

| Order | PR | Change | Base |
| --- | --- | --- | --- |
| 1 | https://github.com/lidge-jun/opencodex/pull/6506 | Capture one timestamp for restart observation deadlines | dev |
| 2 | https://github.com/lidge-jun/opencodex/pull/6498 | Explicit nested help and complete reference | codex/cli-restart-deadline |
| 3 | https://github.com/lidge-jun/opencodex/pull/6500 | Compact root and family navigation | codex/cli-ux-help-foundation |
| 4 | https://github.com/lidge-jun/opencodex/pull/6503 | Bounded typo guidance and early unknown-command rejection | codex/cli-ux-navigation |

Root help changed from92to26logical lines; the complete reference remains at
`ocx help --all`. Nested topics, canonical alias navigation, provider-help parity
and concise stderr recovery are covered by regression and real CLI evidence.
No suggestions execute automatically; existing machine capability JSON remains.

## Verification

- Help foundation:85focused passes plus final explicit-detail regression; changed
  graph1,036pass/1skip/0fail;11real CLI scenarios; independent reviewPASS.
- Navigation:135focused passes; changed graph1,097pass/1skip/0fail after preserving
  and migrating full-reference assertions;18CLI scenarios and40x24PTY capture;
  independent reviewPASS. Hosted subprocess restore-help migration passed5tests
  in an exact navigation snapshot and received independent review.
- Recovery:146focused passes; changed graph1,113pass/1skip/0fail;24CLI scenarios;
  independent reviewPASS with2,483oracle comparisons,75hostile cases,15CLI probes
  and73preflight admissions.
- Deadline prerequisite: deterministic clock-step RED/GREEN;43tests pass,
 117assertions; independent reviewPASS and five boundary probes.
- Typecheck, structure, generated skill surface, privacy, layout guards and
  documentation builds passed for their recorded implementation snapshots.
- `restack-range-diff.txt` in ignored evidence shows every UX commit is
  patch-equivalent after restacking. The final combined tree and each current
  remote head are checked again after this docs-only closure commit.

## Limits retained

The local full-suite run did not pass: four failures were recorded in011.
Three restart-lease failures reproduced on untouched4b98328dca; one initial
snapshot EISDIR remains unresolved despite a passing isolated diagnostic. Neither
later focused checks nor Linux hosted checks retroactively turn that run green.
All four PRs remain draft. Optional platform jobs skipped by workflow policy are
not described as passing platform validation. No merge/release/install occurred.

Exact final SHAs, tested merge SHAs, workflow events, run attempts and check states
are recorded after the closure commit in the PR bodies and the ignored final
receipt, avoiding a self-referential commit cycle. This unit moves from_plan to_fin
for the terminal published-draft outcome; earlier plan-path references are history.
