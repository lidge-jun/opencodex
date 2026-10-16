# 052 — wp5 delivered changes and corrected verification policy

## Delivery

All seven active wp5 slices are merged. Source scope is E0 (#3530 contract follow-up), E1 (#3487), E2 (#2432), E3 (#3421), E4 (#3531), E6 (#3425 mechanism), E7 (#3329). E5 remains with the separate launchd stack and is explicitly retained in the remaining-work ledger.

| PR | Reviewed head | Merge commit |
|---|---|---|
| #3600 | d73d1bca047a1b75ac9be380a4e15aee9520a010 | 3191fe1aa56a30bf8f5fe970a386a5ef07b7bf43 |
| #3601 | 646d7207cc111aa5a289b4f0deb14873c957fc70 | 45045623bfc9c1ec7f8c55e47493da343b98a968 |
| #3602 | 4b289cd1c8e947acb0c2cb4f4d0a29aa8049a8e7 | f8ba644f3ad650b14af9cc420d4d42782939bfef |
| #3603 | 9a6582c4d70b206894d014a5f0c9dd9b60c8c1a1 | 850afb2e9f84979c87e914b248de482f44b34cd6 |
| #3604 | 94160289569bde7d35c32939a33525a1ca515dbe | 89c0a64fe2c59af1814230b0c85d61cd08672bd5 |
| #3605 | 6fbd8de6ed81d60a4988444c63b00331a20a1b10 | e1b9ec851958c46ad6210a989b62c7b367edefee |
| #3606 | 161382b51a3334c33f1849600cd222ced8070911 | 3ac31078244ea04c9abce0e50275ffaccf25455a |
| #3607 | 79e06e0f9e00724c47439b1571a3b15f4b145422 | e449165481a49b9d43ce750c2d07e6c3be12c0ba |
| #3597 | f014d14cb2c23257400e214c1024542f6aef8dd1 | 116389a78751d16d1e92892d869bf51d8387ffde |
| #3553 | 84855cfdd5e3f9ff98fd869277a5c41de57a2679 | 9c44963a040f846edcfc15a90a3d21476c5f11ca |

The extra rows are concrete corrective follow-ups: #3597 repairs trusted encrypted fallback eligibility, #3553 repairs TOML diagnostic boundaries, #3607 normalizes quota-reset markers.

## Current instruction precedence

- User changed delivery to admin merges, then final dev Linux-shard CI. Per-PR CI waits are no longer required.
- User changed subagents to gpt-6-astra, high. The parent adopted that setting on each new spawn; it did not change global agent defaults.
- No local tests, suites, or test:changed have run in this continuation. Typechecks and static checks only; execution remains hosted CI.
- Earlier in this campaign test:changed expanded to broad local suites against the user's prohibition. Those runs were stopped and disclosed. This record does not claim the whole session had zero local-suite execution.
- Earlier a shared user stash was accidentally popped/dropped. The exact stash object 32000d3956a9df2c9489a28aa24c6fa1eda45c45 was restored to refs/stash; no user stash content was intentionally discarded.
- Docker image execution remains unverified locally; the Dockerfile now requires a canonical generated manifest and checks its embedded identity during assembly.

## Remaining, not completed by this work-phase

- Correct Google location precedence and land its dependent fake-IP/launchd/Codex-toggle stack; reconcile #3489 against that stack.
- Close original carried PRs only when the full intended diff has landed; keep partial issues open.
- Inspect the final exact dev Linux CI run and fix real failures; a queued run is not success.
- Preserve already documented deferred items; do not close a source PR as fully superseded when only a subset landed.

