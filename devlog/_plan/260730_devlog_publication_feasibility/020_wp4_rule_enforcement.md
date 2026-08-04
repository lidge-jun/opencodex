# 020 — WP4: keep security material out of a now-public devlog

One full PABCD cycle. Depends on WP3 (`010`): the rules describe a tracked devlog, so they
land after the conversion.

## Why this phase exists

Privacy was the enforcement mechanism. It is being removed, so something has to replace
it. The user's framing was right — review rules can do this job — but only if the rule is
stated for the new arrangement and backed by a check.

Note what the audit found: the two excised units were policy violations **already**.
`AGENTS.md` §Security working notes has forbidden this material in `devlog/` all along, and
it accumulated anyway because nothing enforced it. Restating the rule more loudly is not
the fix; the mechanical guard is.

## Diff 1 — AGENTS.md: correct the now-false submodule section

MODIFY `AGENTS.md`. The `## The devlog submodule` section (around lines 32-56) describes a
private submodule with a loose pointer. Every sentence in it becomes false after WP3.

REPLACE the section heading and body with:

```markdown
## The `devlog` directory

Planning notes, triage matrices, and investigation artifacts live in `devlog/`, tracked in
this repository like any other documentation. There is no submodule and no private mirror.

- `devlog/_plan/` — units still open, one directory per unit, decade-numbered docs.
- `devlog/_fin/` — closed units, moved here once a terminal outcome is recorded.
- `devlog/_chase/` — external reference material for parity comparisons. Reference
  *clones* are gitignored: they are third-party source with their own licenses and have no
  business in this repository's history.

Nothing in the build, test, typecheck, or privacy-scan path depends on `devlog/`, so a
contributor who ignores it entirely still passes every gate.
```

Then MODIFY the `## Security working notes` section. It currently says devlog is not an
acceptable location and gives the reason "both get cloned across machines and CI". That
reason changes but the rule does not — it gets stronger, because devlog is now public.
Amend the second paragraph:

BEFORE:

```
Use `.tmp/` in the working tree (already gitignored) or a `mktemp -d` path.
`devlog/` is **not** an acceptable location, and neither is a private
repository: both get cloned across machines and CI, both outlive the embargo,
and neither history is practical to purge afterwards.
```

AFTER:

```
Use `.tmp/` in the working tree (already gitignored) or a `mktemp -d` path.
`devlog/` is **not** an acceptable location — it is a public directory in a public
repository, so anything committed there is disclosed the moment it is pushed, and the
history is not practical to purge afterwards. A private repository is not an acceptable
location either: it gets cloned across machines and CI and outlives the embargo.

**This binds maintainers exactly as it binds contributors and agents.** The rule has been
violated before by maintainer-authored triage: two units of open account-boundary review
accumulated under `devlog/_plan/` and had to be excised before this directory could be
published (`devlog/_plan/260730_devlog_publication_feasibility/003`). Seniority is not an
exemption, and "it is only in the private half" is no longer a thing that exists.

The test to apply before writing a security note into `devlog/`: **is there already a
public diff that reveals this weakness?** If the fix has shipped, the writeup discloses
nothing new and belongs in `_fin/`. If the fix has not shipped, it goes to scratch.
```

## Diff 2 — devlog/README.md: same correction at the other entry point

MODIFY `devlog/README.md`. It opens by describing itself as a private repository consumed
as a submodule, and `:10-12` justifies privacy by the sensitivity of its content. That
justification is now the argument for the excision rule instead.

REPLACE the opening and the "Why this is a separate repository" section with:

```markdown
# devlog

Planning and investigation notes for [lidge-jun/opencodex](https://github.com/lidge-jun/opencodex),
tracked in that repository. Public.

## What belongs here

Closed records: plans, audits, measurements, and post-mortems for work that has shipped.
A `_fin/` unit is a record of something already visible in public git history.

## What does not belong here

Unreleased security findings, draft advisories, exploit or bypass reasoning, reproduction
steps for an unfixed defect, and pre-disclosure patch plans. These go to `.tmp/` in the
working tree or a `mktemp -d` path — never here, and never in a private mirror.

This applies to maintainers. It was violated before: two units of open account-boundary
review had to be excised before this directory could be published. The deciding question
is whether a public diff already reveals the weakness. If yes, the writeup is a closed
record and belongs in `_fin/`. If no, it is pre-disclosure material and belongs in scratch.
```

Keep the existing `_plan` / `_fin` / `_chase` layout description and the reference-clone
note.

## Diff 3 — MAINTAINERS.md

MODIFY `MAINTAINERS.md`. Read it at P; if it has a security-review section, add one line
pointing at the rule rather than restating it:

```markdown
Security material never lands in `devlog/`. See the "Security working notes" section of
[`AGENTS.md`](./AGENTS.md); it binds maintainers, and the pre-publication excision in
`devlog/_plan/260730_devlog_publication_feasibility/003` is why that sentence is explicit.
```

If the file has no natural home for it, skip this diff and say so in the D summary rather
than inventing a section.

## Diff 4 — the enforceable check

This is the load-bearing part of the phase. A rule with no check is what produced the
violation being cleaned up.

The `privacy:scan` change in WP3 already covers credential-shaped material. What it cannot
see is prose describing an unfixed defect. A full-fidelity check for that is not possible,
but a cheap high-signal one is: flag documents that combine an open-status marker with
security vocabulary.

NEW test in `tests/repo-hygiene.test.ts`:

```ts
/**
 * Security material must not accumulate in the now-public devlog.
 *
 * This cannot detect every pre-disclosure note — prose is not checkable — but it
 * catches the shape the violation actually took: an OPEN triage document
 * (`_plan/`, carrying a NEEDS-CHANGES / NEEDS-SECURITY-REVIEW verdict) that also
 * discusses a security boundary. Closed records in `_fin/` are exempt by design:
 * a shipped fix has a public diff, so its writeup discloses nothing new.
 */
test("no open devlog plan carries an unresolved security verdict", async () => {
  const openPlans = trackedFiles().filter(
    (path) => path.startsWith("devlog/_plan/") && path.endsWith(".md"),
  );

  const offenders: string[] = [];
  for (const path of openPlans) {
    const text = await Bun.file(new URL(`../${path}`, import.meta.url)).text();
    const unresolved = /NEEDS-SECURITY-REVIEW|NEEDS-CHANGES/.test(text);
    const securityBoundary =
      /account.boundary|credential destination|auth bypass|unauthenticated endpoint/i.test(text);
    if (unresolved && securityBoundary) offenders.push(path);
  }

  expect(offenders).toEqual([]);
});
```

Two deliberate design choices:

- **`_fin/` is exempt.** Applying this to closed records would fail on the 280 and 145
  units, which are safe precisely because their fixes shipped. Exempting `_fin/` encodes
  the "is there a public diff" test structurally.
- **It requires BOTH signals.** An open plan discussing auth is normal; an open plan
  carrying an unresolved review verdict about an auth boundary is the violation shape.
  Requiring both keeps the false-positive rate low enough that the check survives.

Known limitation to state in the D summary: this catches the observed pattern, not the
general case. A maintainer writing a careful pre-disclosure note without those markers
would pass. The check is a tripwire, not a proof.

## Accept criteria

1. `AGENTS.md` §Security working notes states the rule binds maintainers, with the
   public-diff test spelled out.
2. `AGENTS.md` no longer describes devlog as a private submodule.
3. `devlog/README.md` no longer describes itself as a private repository.
4. Both files name scratch space (`.tmp/` or `mktemp -d`) as the only acceptable location.
5. The new hygiene test passes against the post-excision tree.
6. The new hygiene test FAILS when one excised unit is temporarily restored — proving it
   is not vacuous.
7. `bun run typecheck` and `bun run privacy:scan` pass.
8. `rg` confirms no remaining tracked file describes devlog as private or as a submodule.

### Activation scenarios

| Path | Trigger | Observable |
|---|---|---|
| the new tripwire fires | restore `_plan/260730_open_pr_backlog_triage/030_account_pool_security.md` temporarily | test FAILS naming that path; then remove it again |
| `_fin` exemption holds | tree contains `_fin/280_...` with its NO-GO language | test PASSES, proving the exemption is deliberate and not accidental |
| both-signals requirement | a fixture with only `NEEDS-CHANGES` and no security vocabulary | test PASSES, proving it does not flag ordinary triage |

Criterion 6 is the one that matters. A filter over a list that is already empty passes
forever while asserting nothing; drive it red once and paste the failure into `checkOutput`.

## Verification gate

All eight criteria asserted, the three activation scenarios driven, and the full
`bun test --isolate tests` suite green alongside typecheck and privacy:scan.
