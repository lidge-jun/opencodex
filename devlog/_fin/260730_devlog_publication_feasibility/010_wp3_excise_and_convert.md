# 010 — WP3: excise the live-triage units, then convert devlog to tracked files

One full PABCD cycle. Depends on `003` (the excision decision). This is the irreversible
phase: once the conversion is pushed, devlog content is public.

## Step 1 — excise, before anything else touches git

Move both units out of the tree entirely. Use a scratch path, not `.tmp/` inside the
repo, because `.tmp/` still lives in the working tree and the point is to get this
material off the machine's tracked surface.

```bash
OCX_SEC=$(mktemp -d /tmp/ocx-devlog-security-XXXXXX)
cd /Users/jun/Developer/new/700_projects/opencodex/devlog
mv _plan/260730_open_pr_backlog_triage "$OCX_SEC"/
mv _plan/260730_new_issue_pr_triage    "$OCX_SEC"/
git rm -r --cached _plan/260730_open_pr_backlog_triage _plan/260730_new_issue_pr_triage
echo "$OCX_SEC"   # record this path in the D summary
```

`git rm -r --cached` removes them from the devlog index. Commit that removal in the
devlog submodule BEFORE the parent conversion, so the pointer the parent adopts already
excludes them.

**This does not purge devlog's own history.** The material stays in the private
`opencodex-internal` history, which is acceptable: that repo is not being published. What
must be true is that the FILES the public repo adopts do not include them. Verify:

```bash
git ls-files | rg "260730_(open_pr_backlog|new_issue_pr)_triage" && echo "STILL PRESENT — STOP"
```

## Step 2 — fix the collateral reference

MODIFY `_plan/260730_devlog_publication_feasibility/002_publication_scan.md`.

That file cites `_plan/260730_open_pr_backlog_triage/030_account_pool_security.md` in the
§B table. After excision the citation dangles AND advertises what was removed. Replace
the row's location cell with a non-pointing description:

BEFORE: a table row naming the excised document by path and summarizing the weakness it
described. Not reproduced here — quoting it in this doc would republish exactly what the
excision removes.

AFTER: the row keeps its position but drops both the path and the weakness summary, e.g.
`| (excised — see 003) | Open-PR account-selection review. | Removed from the publication
set before conversion. |`

The same rule applies to this document: an instruction that says "delete this sensitive
sentence" must not carry the sentence as its own example.

## Step 3 — the conversion itself

MODIFY `.gitmodules`. Current content is the single devlog stanza:

```
[submodule "devlog"]
	path = devlog
	url = https://github.com/lidge-jun/opencodex-internal.git
	ignore = dirty
	update = none
	shallow = true
```

DELETE the file entirely — devlog is its only stanza, so an empty `.gitmodules` is worse
than no file.

MODIFY `.gitignore`. Lines 7-10 currently read:

```
# Maintainer-only planning notes. `devlog` is a private submodule
# (lidge-jun/opencodex-internal) pinned by gitlink; its contents are never
# tracked here. Commit inside the submodule, then bump the pointer separately.
devlog/
```

REPLACE with a rule that keeps the vendored trees and scratch patterns out while tracking
the notes themselves:

```
# Maintainer planning notes are tracked in this repository. Security material is
# NOT: see the "Security working notes" section of AGENTS.md. Reference clones and
# generated evidence stay untracked.
devlog/_chase/_cca/
devlog/_chase/_litellm/
devlog/_fin/opencode-cursor/
devlog/_plan/*/_ref_*/
devlog/**/*-security-redaction/
devlog/**/*_security_findings/
devlog/**/security-advisory-draft*
```

These mirror devlog's own `.gitignore`, which stops applying once devlog is not a separate
repository. Losing them silently is how the 129 MB LiteLLM tree would land in the public
repo.

Then remove the gitlink and add the content:

```bash
cd /Users/jun/Developer/new/700_projects/opencodex
git rm --cached devlog          # drops the 160000 entry, keeps the directory on disk
rm -rf devlog/.git              # ESCALATE: confirm with the user first; this severs the
                                # private remote binding. Prefer `mv devlog/.git` to a
                                # scratch path so it is recoverable.
git add devlog
git commit
```

Order matters: `git rm --cached devlog` must precede `git add devlog`, or git refuses to
replace a gitlink with a tree.

## Step 4 — privacy-scan coverage

MODIFY `scripts/privacy-scan.ts`. Lines 11-16:

BEFORE:

```ts
const EXCLUDED_PREFIXES = [
  "devlog/",
  "gui/dist/",
  "node_modules/",
  "tests/.tmp-",
];
```

AFTER:

```ts
const EXCLUDED_PREFIXES = [
  "gui/dist/",
  "node_modules/",
  "tests/.tmp-",
];
```

Removing this entry is the whole reason the conversion is defensible: it is what makes
"public" also mean "scanned". Leaving it would publish 1600 files that CI never checks.

Run `bun run privacy:scan` immediately after. If it fails, the failure is real signal
about content that should not be public — treat it as a WP3 blocker, not as a reason to
re-add the exclusion.

## Step 5 — repo-hygiene rewrite

MODIFY `tests/repo-hygiene.test.ts`. The `describe("devlog submodule stays loose")` block
at lines 84-121 asserts the old shape. Its three tests:

1. `devlog is the only gitlink, and no devlog file is tracked here` — inverts.
2. `gitmodules keeps the submodule non-blocking` — the file no longer exists.
3. `no workflow checks out submodules` — still valid and worth keeping.

REPLACE the block with a tracked-devlog policy. The intent to preserve is "no gitlink can
break `actions/checkout` for a contributor", which is now stated as "there are no gitlinks
at all":

```ts
/**
 * devlog notes are tracked in this repository, and no submodule remains.
 *
 * The failure mode this locks down has happened twice: a `160000` gitlink lands in
 * the index for a path no workflow initializes, and `actions/checkout` fails for
 * every contributor. With devlog converted to ordinary files, the invariant is
 * simply that NO gitlink exists.
 */
describe("devlog is tracked, with no submodule left behind", () => {
  test("no gitlink is tracked anywhere", () => {
    const gitlinks = trackedEntries().filter((entry) => entry.mode === "160000");
    expect(gitlinks.map((entry) => entry.path)).toEqual([]);
  });

  test("devlog markdown is tracked as ordinary blobs", () => {
    const devlogFiles = trackedFiles().filter((path) => path.startsWith("devlog/"));
    expect(devlogFiles.length).toBeGreaterThan(1000);
    expect(devlogFiles.some((path) => path.endsWith(".md"))).toBe(true);
  });

  test("no .gitmodules file remains", async () => {
    expect(existsSync(new URL("../.gitmodules", import.meta.url))).toBe(false);
  });

  test("vendored reference clones stay untracked", () => {
    const vendored = trackedFiles().filter((path) =>
      path.startsWith("devlog/_chase/_litellm/") || path.startsWith("devlog/_chase/_cca/"),
    );
    expect(vendored).toEqual([]);
  });

  test("the excised security-triage units are not tracked", () => {
    const excised = trackedFiles().filter((path) =>
      /^devlog\/_plan\/260730_(open_pr_backlog|new_issue_pr)_triage\//.test(path),
    );
    expect(excised).toEqual([]);
  });

  // keep the existing "no workflow checks out submodules" test verbatim
});
```

The last two tests are the ones that matter long-term: they are the mechanical guard that
stops a future `git add -A` from re-introducing the vendored trees or the excised units.

## Accept criteria

1. `git ls-files -s devlog | head` shows `100644` blobs, no `160000`.
2. `.gitmodules` does not exist; `git submodule status` prints nothing.
3. `git ls-files devlog | wc -l` is close to 1608 (1620 minus the 12 excised).
4. No tracked file matches `devlog/_chase/_litellm/` or `devlog/_chase/_cca/`.
5. No tracked file matches the two excised unit paths.
6. `bun run privacy:scan` passes with `devlog/` no longer excluded.
7. `bun run typecheck` passes.
8. `bun test tests/repo-hygiene.test.ts` passes with the rewritten block.
9. A fresh `git clone` of local dev into a temp dir shows readable devlog markdown with no
   submodule step.
10. The user's in-flight GUI work and untracked `go/` are untouched.

### Activation scenarios

| Path | Trigger | Observable |
|---|---|---|
| vendored-exclusion rule | `git add devlog` with `_chase/_litellm` present on disk | those paths absent from `git diff --cached --name-only`; prove the ignore rule fired rather than assuming |
| excised-unit guard | temporarily re-create one excised file and run the hygiene test | test FAILS, proving the guard is live and not vacuous |
| privacy-scan coverage | run the scan with a deliberately planted fake key in a devlog file | scan FAILS; revert the plant |

The excised-unit guard and the scan-coverage check are both trivially vacuous if written
wrong (a filter over an empty list always passes). Drive each in its failing direction
once and record the failure output.

## Verification gate

All ten criteria asserted, plus the three activation scenarios driven in their failing
direction. `bun run typecheck`, `bun run privacy:scan`, and the full
`bun test --isolate tests` suite green.

---

## Appendix — the vendored-exclusion stanza, executed

The single most dangerous mistake in this phase would be a `.gitignore` rule that fails to
keep `_chase/_litellm` (129 MB of third-party source, including `.env.production` and
terraform `secrets.tf` filenames) out of the public repo once devlog's own `.gitignore`
stops applying. So the rule was executed in an isolated scratch repository rather than
reasoned about.

Setup: fresh `git init`, the directory shapes recreated, `.gitignore` containing only

```
devlog/_chase/_cca/
devlog/_chase/_litellm/
```

Result:

```
devlog/_chase/_litellm/LICENSE                              IGNORED
devlog/_chase/_litellm/ui/litellm-dashboard/.env.production IGNORED
devlog/_chase/_cca/LICENSE                                  IGNORED
devlog/_plan/u1/000_plan.md                                 tracked-eligible
devlog/_fin/x/010.md                                        tracked-eligible

git add -A then git diff --cached --name-only:
  .gitignore
  devlog/_fin/x/010.md
  devlog/_plan/u1/000_plan.md
```

The exclusion holds at depth (the `.env.production` is four levels below the ignored
directory) and `git add -A` stages only the notes. Confirmed by execution.

### A measurement trap worth recording

The first attempt to verify this used
`git check-ignore --no-index --exclude-from=<file> <path>` against the real repository and
reported every vendored path as NOT ignored — an apparent leak. That was a measurement
artifact of combining `--no-index` with `--exclude-from` on paths inside an existing
submodule mount, not a real result.

The lesson generalizes: verify ignore rules in an isolated repository whose only ignore
input is the rule under test. A false alarm here would have blocked a safe conversion; a
false negative would have published third-party secrets. Neither is acceptable from a
command whose semantics are this easy to get wrong.

### Residual requirement for B

devlog's own `.gitignore` also carries security-shaped patterns and `_plan/*/_ref_*/`.
Those were verified in the same isolated-repo manner after prefixing:

```
devlog/_plan/u1/_ref_upstream/a.md            IGNORED
devlog/_fin/y-security-redaction/b.md         IGNORED
devlog/_fin/z_security_findings/c.md          IGNORED
devlog/_plan/u2/security-advisory-draft-1.md  IGNORED
devlog/_plan/u2/000_ok.md                     tracked-eligible

git add -A staged only: .gitignore, devlog/_plan/u2/000_ok.md
```

All four survive the `devlog/` prefix, including the `**` forms and the single-`*`
`_plan/*/_ref_*/` shape. No residual verification is outstanding for the ignore rules.
