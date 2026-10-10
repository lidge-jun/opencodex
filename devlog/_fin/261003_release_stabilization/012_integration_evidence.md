# Progressive integration evidence

This records landed work and remaining gates, not a production release receipt.

## Landed scope ledger

| PR | Landed dev commit | Final PR CI | Disposition |
| --- | --- | --- | --- |
| #6513 | `e77bfb4901d405724edc4295caf5d9f0675a672e` | 37130246238 | #6508 fully superseded and closed |
| #6519 | `a141b83623a3f1677f23477e91b9a42a74f495f7` | 37131234397 | #6509 fully superseded and closed |
| #6516 | `36330ae2ef120daa75566280f9c0b1e51eb2a36b` | 37132320824 | #6504 proxy-error bug closed with explicit upstream/client limits |
| #6514 | `aa40fb4158260196669346ab0e0dd55f679fd13e` | 37132498856 | #6497 partially carried; source remains open |
| #6515 | `e601cefcebcc20b2e04a04821ab45df6538d98f9` | 37132811309 | #6496 fully superseded and closed |
| #6518 | `358b8ffd4c7f95237dadee1e9a5b4fedb671f4f4` | 37135487096 | #6378 superseded and closed after identity/cleanup review closure |
| #6517 | `a99de42e7a5986c2443805fa6d833b8152f967ff` | 37135315210 | #6076 subsequently marked MERGED by preserved ancestry |
| #6523 | `a41f67273c4937b852f26d726001641fe2026f63` | 37145111209 | #6507 account behavior carried; source superseded and closed, diagnostic-text logging excluded |
| #6527 | `ab68539036fa89e0734ea21aa6b525ae4cc3ae36` | 37146395644 | #6505 superseded and closed; nested-only HTTP follow-up pending |
| #6538 | `efc20e700b6fce67578e07b94336fc71aebc5a1c` | 37148359842 | Existing-format capacity guard; canonical #6370 remains excluded |

All listed runs are successful final-head pull_request runs. Their actual checkout
logs, selected executed jobs, actor/base/head gates and post-merge review counts
were inspected. Later integrations also compare the computed union with the actual
merged parent/tree and check repository line caps plus test-map parity. Full
cross-platform candidate coverage is still a separate unmet gate.

Canonical spend integration remains open.
The identity cleanup findings were repaired and closed at the exact merged head;
pairing's original technical objection was addressed with actual CLI/HTTP/native
evidence, without dismissing another maintainer's formal historical review. The
optional CodeRabbit queue was pending on #6517 and explicitly not counted as a
passing review; all published findings were resolved and independent review passed.
Final late-review checks remain required. A local broad import-graph run with failures is preserved as
failed diagnostic evidence, never relabeled as passing by these PR results.

The stored-main carry includes alternate-resolution cancellation, read-fence and
late pinned-selector/diagnostic/single-snapshot repairs. A final additive hard-lock
spy changed the head; the head-pinned guard stopped the attempted old-head merge,
and the new head received its own CI and narrow independent closure before landing.

## Large native HTTP uploads

PR #6513 merged into dev as `e77bfb4901d405724edc4295caf5d9f0675a672e`.
Reviewed head: `db094c49c7cce13500b1f1f63678f174261fc9af`.
Required scoped CI: run 37130246238, attempt 1, pull_request event, success.
The actual checkout log binds that head to base `9f89b7265b754eb681215ad327fc9459af37b9e1`.
All four Linux shards and expected scoped auxiliary jobs ran successfully; full
macOS/Windows suites were skipped by scope and remain for the final candidate.

The coordinator reviewed the final-send conversion, destination/egress/header/abort
boundaries and no-replay behavior, inspected local 199-pass/one-runtime-skip evidence,
and verified the six-failure mutation result. The documentation threshold finding
was fixed; zero review threads remained unresolved after merge. The maintainer
integration/security decision is recorded on the PR.

Source #6508 remained at the fully carried head `dd4fc9a8f732699d88f46058c3298073d9aa2317`.
It was commented, labeled superseded and closed after landing, with source author
credit retained. Child #6516 must consume the actual landed dev base before merge.

## Shared registry repair

B's separate commit `29a9e91f400d24ac746a18dfe3af357f5da6dec3` removes 31 identical
duplicate entries from each test-layout registry. The coordinator independently
verified duplicate-value equality and unchanged parsed mappings. C/D may adopt that
same repair while retaining their unique registrations. This does not raise a cap
or remove a test; hosted union checks still govern each candidate.

## Native acceptance limits

The Windows production command helper compiled and ran on Windows 11: three tests
passed. A separate native CommandLineToArgvW probe passed four quoted-path cases
and the expected failure of an unquoted negative control. The source hash is
`6c8e206b36e8330c6fd1888960d798144de29319d7debb8cfbb567173117c583`.
These results do not establish packaged registration/migration or login startup.

A focused source review falsified the suspected Task Manager override regression:
the pinned auto-launch 0.5.0 status implementation checks StartupApproved before
the migration writer is called. No code change follows that disproven hypothesis.
Native disabled-registry behavior remains untested.

No running real launcher was available for #6220's direct/routed tool-followup
acceptance. It remains NOT EXECUTED. Neither this fact nor an administratively
closed issue is converted into passing runtime evidence.

## Model-refusal carry and combined boundary check

PR #6527 landed at corrected head `af350a1924ee55ddc60fe9fa04289d1aa494f437`
with independent family-level review and explicit security review. Its applicable
CI ran against current dev `a41f67273c4937b852f26d726001641fe2026f63`; the merged
union tree matched the reviewed head tree. Source #6505 was closed as superseded
after the carry landed, with attribution preserved.

The original late-review correction was insufficient for mixed root/response
envelopes. The replacement applies a shared field-presence rule, with null and
nonmatching values covered. Local evidence records four failures before repair,
79 passes after repair, and 374 broader focused passes. The HTTP400 constraint
and existing SSE status reconstruction remain explicit limits.

After integrating the nine implementation carries into the coordinator checkout,
`bun run test` with eight explicit files passed 281 tests / 1422 assertions. The
files cover native upload boundaries, Claude outbound and Messages errors, Ollama
replay, combo plan/model refusal, stored-main refresh, alternate cancellation and
grant refusal. The command and full output are retained in the ignored integration
receipt. This is a combined boundary check, not the separate final independent
parallel regression or complete platform CI; both remain pending.

## Inclusion decision and outstanding repairs

The canonical spend migration proposed for #6370 is excluded from this release.
Upgrade and recovery compatibility acceptance did not pass; the original PR stays
open and its implementation work remains preserved in the owning worktree. This
decision does not declare existing spend behavior correct. The independent existing-format capacity guard in PR #6538 landed after review
and successful exact-head CI37148359842. Its ledger format and hashing are unchanged.
Private investigation and review evidence remain in ignored scratch.

A post-merge review of #6527 identified a nested-only HTTP error-carrier case that
still stops fallback. It is assigned to follow-up PR #6540 with independent
closure and fresh CI; final regression cannot start from the current known-defective
head. Lane C fixture repairs also remain pending. Final independent regression has
not run; it starts after pending repairs land and their required checks pass. PR #6536
(`dd9a980ec071285e628a35d8cdefaea785b8916b`) separately archives Lane B's public
record, with corrected checkpoint counts and successful docs-only CI37147122129.
Its skipped runtime jobs are not counted as runtime verification.

The #6538 review records a nonblocking diagnostic limitation: native handlers can
report a generic spend-exhausted reason when capacity prevented booking. The send
is refused correctly. Supplied focused evidence totals 213 passes, and the original
capacity probe changes from failure before repair to success after it. Final
combined acceptance remains pending the other scoped repairs.
