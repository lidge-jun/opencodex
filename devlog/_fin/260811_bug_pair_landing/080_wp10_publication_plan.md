# 080 — wp10: publication plan

## What changed under us

While this unit was landing the seven pairs locally, four contributors pushed new
work to their branches. That is the single most important fact for publication,
because it means our local re-implementations are no longer the newest version of
several of these fixes.

| PR | Head we forked from | Head now | New commits |
|---|---|---|---|
| #1460 | `7bf8b84a1` | `642805c11` | rebased + byte-compare fix |
| #1462 | `2f9225915` | `d51bd2856` | rebased + `reject stale whole-document conflicts` |
| #1441 | `aa256f6d3` | `67bb96628` | 16 commits |
| #1434 | `89a96ce0e` | `3dad8a87c` | 8 commits incl. `bound antigravity replay snapshot flush` |
| #1461, #1465, #1452 | unchanged | unchanged | — |

Three of the four independently found and fixed the very defects this unit had
identified:

- **#1460** replaced its decoded-string comparison with `Buffer.equals`. Diffed
  against ours: semantically identical, differing only in the helper name
  (`currentCatalogFileBytes` vs `currentCatalogFileContent`) and comment wording.
- **#1434** now throws `REPLAY_FLUSH_INCOMPLETE_ERROR` on budget exhaustion and
  counts `"additional session contributes its own bytes plus one comma"` against
  the cap — the same two fixes, arrived at independently. Its suite is green:
  72 pass / 0 fail.
- **#1462** added `reject stale whole-document conflicts`, a more thorough design
  than ours: it arms provenance on every config load rather than only at server
  startup.

## What that implies

Publishing by force-pushing our commits over those branches would overwrite work
that is, in three cases, better than ours and, in all four cases, theirs. The
right move is the opposite: **merge the contributors' pull requests** and carry
forward only the corrections that their newest heads still lack.

## The one correction still needed

`#1462`'s newest head `d51bd2856` still breaks
`PUT /api/grok/selection with an empty list removes the field`:

```text
bun test tests/grok-management-api.test.ts   →   9 pass / 1 fail
```

That is the regression this unit found with the full suite and fixed in
`d6e4545b2`. `maintainerCanModify` is true on that branch, so the correction can
be pushed to it rather than landed behind the contributor's back.

### Except it is not a clean carry-forward

Cherry-picking `d6e4545b2` onto `d51bd2856` conflicts, because the contributor
redesigned that region rather than patching it. Reimplementing our rule inside
their design then failed one of *their* tests, and that failure is the
interesting part:

| Scenario | Ours (`d6e4545b2`) | Theirs (`d51bd2856`) |
|---|---|---|
| live deletes a field, disk still has it (`PUT /api/grok/selection` with `[]`) | fixed — 10 pass | broken — 9 pass / 1 fail |
| another writer adds a key after we loaded, we save something unrelated | **loses the key** | preserved (`config-user-edits`: "an independently loaded config rebases a non-server save") |

Both rules read the same evidence — a key present on disk and absent in the live
config — and reach opposite conclusions, because absence alone cannot say whether
the writer deleted the key or never had it. Our fix assumes deletion; theirs
assumes ignorance. Each is right about its own scenario and wrong about the
other's.

Making the distinction properly needs the live config to record deletion intent
at the point of deletion — there are eight or more `delete config.<field>` sites
across the management routes — or the baseline to be refreshed on every
cooperating write rather than armed once at server startup. Both are real changes
to the config subsystem, not a correction to smuggle into a bug-fix batch, and
the contributor is actively working in exactly this code.

**Disposition:** do not force our version onto their branch. Merge theirs, and
file the `PUT /api/grok/selection` deletion case as its own issue against the
design they just landed, with the two-scenario table above as the statement of
the problem. Our `d6e4545b2` stays on `dev` as the record of the failing case and
its repro.

## Publication order

Merge order follows the same dependency logic as the landing order, and each
merge is verified live rather than assumed:

1. `#1460` — catalog, self-contained.
2. `#1461` — sync preflight, maintainer branch, unchanged.
3. `#1465` — Windows install, maintainer branch, unchanged.
4. `#1452` — ARM64 ACL, maintainer branch, unchanged.
5. `#1434` — antigravity replay, contributor's newer head.
6. `#1441` — shim recursion, contributor's newer head, largest blast radius.
7. `#1462` — config, after pushing the Grok correction to its branch.

Every PR here targets `dev`, so GitHub will not auto-close the linked issues.
Each of #1459, #1453, #1454, #1449, #1429, #1439, #1273 is closed manually after
its fix is confirmed on `dev`.

## What happens to our local commits

Our maintainer corrections that the contributors did not independently make —
the Windows nonce ownership (`6312aef83`), the ARM64 typed sentinel (`4368bb352`),
the config delete-vs-edit rule (`1b655b74c`), the Grok disk-only-key fix
(`d6e4545b2`), and the convergence timeout (`f43110286`) — ride in on the
maintainer branches or get pushed to the contributor branch that needs them.

The duplicates — our byte-compare and our antigravity flush/cap commits — are
superseded by the contributors' own versions. That is the correct outcome: they
got there themselves, and the credit is theirs.
