# 003 — Re-adjudication: the earlier blockers were wrong, the real ones are elsewhere

Supersedes the `UNSAFE` verdict in `002` §B. Written after the user asked the obvious
question: why not just move the security documents to scratch and proceed?

Answering it required determining WHICH documents actually block, and that check
overturned the previous conclusion.

## The two flagged units are SAFE to publish

`002` flagged `_fin/280_codex-multi-auth-security-patch-plan/` and
`_fin/145_common-security-hardening/` as undisclosed. That was wrong. The scan read the
patch plan's `NO-GO` framing and stopped there, without reading the sibling manifest or
checking whether the fixes shipped.

`10_final-verification-manifest.md:5` states `Phase 60 implemented, committed, and
post-commit verification passed`, and lines 42-46 attribute each of the five
account-boundary failures to a specific commit with its regression tests. Every one of
those commits is an ancestor of public `main`:

| Commit | Subject | On `main` |
|---|---|---|
| `1f0813c` | fix: fail closed codex pool auth context | yes |
| `0efb547` | fix: purge codex account lifecycle state | yes |
| `2204da8` | fix: bind codex account lifecycle to generations | yes |
| `278873a` | fix: guard codex credential refresh generation | yes |
| `9490cfc` | fix: guard non-loopback opencodex APIs | yes |
| `e752fab` | fix: redact codex auth privacy surfaces | yes |

Verified with `git merge-base --is-ancestor <sha> main` for each. The fixes are in public
history with public commit messages naming the weakness class. Publishing the writeup
therefore discloses nothing an attacker cannot already read from the diff — which is the
whole test that separates a closed record from an embargoed one.

The same holds for `145`, whose `90_final-review.md` records the phases as implemented,
committed, and independently reviewed, with its cited fixes likewise on `main`.

**Lesson for the scan definition in `002` §E:** a `NO-GO` or `must be fixed` phrase is a
snapshot of the moment the document was written, not its current status. Resolution must
be checked against repository history, not inferred from the document's own tone. The
`002` scan lacked that step and produced a false positive on the most alarming-looking
file in the tree.

## The real blockers are two LIVE triage units

| Unit | Files | Why it blocks |
|---|---:|---|
| `_plan/260730_open_pr_backlog_triage/` | 6 | Open security review of unmerged PRs. Multiple documents carry unresolved `NEEDS-CHANGES` / `NEEDS-SECURITY-REVIEW` verdicts on boundary-relevant work. Specifics deliberately omitted — see the note below. |
| `_plan/260730_new_issue_pr_triage/` | 6 | Live dispositions for unmerged PRs, several marked `NEEDS-SECURITY-REVIEW` with no landed fix. Specifics deliberately omitted. |

These are `_plan`, not `_fin` — open by construction. They describe weaknesses in
**unmerged** work, so there is no public diff to read them from. That is the honest
definition of pre-disclosure material, and it is exactly what `AGENTS.md` §Security
working notes already forbids storing in `devlog/`:

> Security work is done in scratch space, never in a tracked directory. That includes
> unreleased findings, severity assessments, draft advisories, exploit or bypass
> reasoning, reproduction steps for an unfixed defect, and pre-disclosure patch plans.

So these two units are policy violations today, independent of the publication question.
Moving them to `.tmp/` is not a concession made for publication; it is enforcing a rule
the repository already states.

## Excision plan

Move both directories intact to a scratch path. Splitting them file-by-file would leave
the surrounding triage context — which itself names the weaknesses — behind.

```
devlog/_plan/260730_open_pr_backlog_triage/   -> scratch
devlog/_plan/260730_new_issue_pr_triage/      -> scratch
```

12 tracked files across 2 units.

### Collateral

`002_publication_scan.md` in this unit cites
`_plan/260730_open_pr_backlog_triage/030_account_pool_security.md` as evidence. That
citation must be rewritten in the same change, or the excision leaves a dangling pointer
that also advertises what was removed. No tracked file outside either unit cites their
other documents by path.

### What is deliberately NOT excised

The 54 other units whose names contain `hardening` or `security` are closed records of
shipped fixes: transport, reliability, CI, UI, and provider-compatibility work. Excising
them would gut the archive for no security benefit. The distinguishing test is whether a
public diff exists that already reveals the weakness.

## Residual work that publication still requires

Excision clears the security blocker but not the other two findings from `002`:

1. **Personal data** — 109 email matches, 1174 absolute home paths carrying a username,
   15 private repository URLs. Needs a sanitization pass.
2. **Privacy-scan coverage** — `devlog/` sits in `EXCLUDED_PREFIXES`
   (`scripts/privacy-scan.ts:12`), so publishing grants zero scan coverage. Removing that
   entry before sanitization turns CI red on item 1.

Both are mechanical rather than judgment calls, so they belong to the conversion
work-phase rather than to a human decision gate.

---

## Personal-data axis re-measured — also a false positive

`002` §C reported 109 email matches and 1174 home paths as a sanitization requirement.
Both counts were index-unscoped and both collapse under inspection.

### Emails: nothing new is disclosed

Scoped to the publication set (vendored `_chase` trees excluded, since they are already
untracked), there are **23 distinct addresses**. Classified:

| Class | Disposition |
|---|---|
| `*@users.noreply.github.com` | GitHub-issued public handles; already public by construction |
| `*@example.test`, `*@example.com`, and a short list of obviously-fake values | fixture placeholders |
| Everything else | checked against `git log main --author=<addr>` |

Only three addresses are not already commit authors on public `main`, and none is a leak:

- an upstream `openai/codex` commit author address, quoted in a research table alongside
  the public commit SHA and PR number.
- a `Co-authored-by:` trailer address from a public opencodex PR.
- a fabricated address inside a sample CLI output block.

The two addresses `002` singled out as high severity are the maintainer's own (2076
commits on `main`) and a contributor's (1 commit on `main`). Both are already in public git history as
commit authorship, which is unavoidable and normal for any git project. devlog adds
nothing.

**No email sanitization is required.**

### Home paths: one username, already public

1160 of the 1164 home-path matches are `/Users/jun/`. The remaining four are `user`,
`test`, `u`, and `me` — placeholders.

`jun` is the maintainer's own local account name on their own project. It is not a
third-party identifier, and the maintainer's identity is already public through commit
authorship and the repository owner name. The paths are working-directory context in
evidence blocks, which is what makes the evidence reproducible.

**No path sanitization is required for security.** Normalizing them to `~/` or
`$HOME/` would be a readability improvement, not a privacy fix, and it would edit 169
files for cosmetic benefit. Recommend skipping it.

## Revised blocker list

After both re-adjudications, exactly one thing blocks publication:

| Item | Status |
|---|---|
| `_fin/280_...` and `_fin/145_...` security plans | NOT a blocker — fixes verified on public `main` |
| Emails | NOT a blocker — already public or placeholders |
| Home paths | NOT a blocker — maintainer's own, already public |
| `_plan/260730_open_pr_backlog_triage/` | **EXCISE** — open security review of unmerged work |
| `_plan/260730_new_issue_pr_triage/` | **EXCISE** — same |
| `privacy-scan.ts` excludes `devlog/` | Must be fixed as part of the conversion, not before it |
| `repo-hygiene.test.ts` asserts the submodule shape | Must be rewritten as part of the conversion |

Two directories, 12 tracked files. That is the whole excision.

## Why the earlier scan over-reported

Recorded so the scan definition in `002` §E can be corrected rather than repeated:

1. **It scanned the working tree, not the index.** That pulled in gitignored third-party
   vendored source and inflated every count, including the size figure.
2. **It treated a document's own alarm language as its current status.** `NO-GO` and
   `must be fixed` describe the moment of writing; resolution lives in repository history.
3. **It treated any email or home path as PII** without asking whether the same
   information is already public through commit authorship.

The corrected rule: scope to `git ls-files`, verify resolution against `main` ancestry,
and ask "does publishing this reveal something a public diff does not" before flagging.


---

## Note on this document's own disclosure surface

An earlier draft of the table above named each excised document alongside the specific
weakness it described. That defeated the purpose: the excision removes the files, but a
surviving public document that summarizes their contents leaks the same information at
lower fidelity.

Corrected. This unit now records WHAT was removed and WHY the category is blocking, without
restating the individual findings. Anyone with legitimate need reads them in scratch space
or in the private `opencodex-internal` history.

The general rule this establishes: an excision note is itself part of the publication set
and must pass the same test as the material it removes.
