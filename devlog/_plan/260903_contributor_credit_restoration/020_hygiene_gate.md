# 020 — wp2: the co-author gate

## Slice

MODIFY `AGENTS.md` (the rule), `.github/scripts/pr-hygiene.cjs` (the check),
`.github/scripts/pr-hygiene.test.cjs` (the coverage).

## What the gate has to catch

The exact shape that produced this whole unit: a pull request whose own text
says it reimplements, supersedes, carries, or rebases someone else's pull
request, merging without a `Co-authored-by` trailer naming that person.

```
  title/body:  "Reimplements #2797 by @rrmlima."
  trailers:    (none)                              -> FAIL
```

## Where it goes

`collectDeterministicHygieneFailures` in `.github/scripts/pr-hygiene.cjs` is the
single entry point both `pr-hygiene.yml` and the quality gate call, and it
already composes two assessors: `assessHygiene` (patch shape) and
`assessSponsoredSurface` (paths). This is a third assessor over PR text, not a
change to either.

That matters for the input contract. `assessHygiene` reads `files`; the new
check reads the PR title, body, and commit messages. Those are already
reachable from the workflow — it calls `pulls.get` and can call
`pulls.listCommits` — but they are not currently passed down. The workflow
gains that fetch and passes them through.

## The check

```js
const CARRY_RE =
  /\b(?:re-?implements?|re-?implementation of|supersedes?|carry of|carries|rebase of|adopts the design from)\b[^\n]{0,80}?#(\d+)/gi;
const TRAILER_RE = /^co-authored-by:\s*(.+)$/gim;

function assessCarryAttribution({ title, body, commits, labels, referencedAuthors })
```

Rules, each one earned from a real case in the scan:

1. **Self-reference is not a carry.** A PR that says it supersedes an earlier
   PR by the same author must pass. The check therefore needs the referenced
   PR's author, which means one API lookup per referenced number. Cap it: at
   most five lookups, and a lookup failure is a pass, never a fail. A rate
   limit must not block a merge.
2. **Referencing your own earlier branch is routine.** #3112 and #3104 are the
   maintainer's own rebase branches. Same-author references are dropped before
   the trailer comparison.
3. **Match on identity, not on login.** The scan's eleven false positives all
   came from comparing a GitHub login against a git trailer: `terrytan95` never
   appears in `Co-authored-by: Terry Tan <tmy1995hflc@gmail.com>`. Compare
   against login, git author name, and git author email from the referenced
   PR's own commits — the three-way match the scan ended up needing.
4. **Trailers live in the squash body, which does not exist yet at PR time.**
   So the check reads the union of the PR body and every commit message on the
   branch: that is what the squash body is assembled from, and it is what the
   author can act on before merge.
5. **Escape hatch consistent with the existing design.** A new
   `attribution-approved` label clears it, entered in `labelDefinitions` and
   `HYGIENE_GATE_LABELS` beside the other five. It joins the head-specific
   sweep on `synchronize`, because a new commit can add a new carry reference.

## Failure code and hint

```js
missing_coauthor_credit:
  "This PR says it reimplements, supersedes, carries, or rebases another " +
  "author's pull request. Add a Co-authored-by trailer naming that author so " +
  "the credit survives the squash, or obtain attribution-approved.",
```

## Tests — RED before GREEN

In `.github/scripts/pr-hygiene.test.cjs`, beside the existing `assessHygiene`
cases:

| Case | Expect |
|---|---|
| body says "Reimplements #2797 by @rrmlima", no trailer | `missing_coauthor_credit` |
| same, with a trailer naming the login | pass |
| same, matched by git author name rather than login | pass |
| same, matched by email | pass |
| reference to a PR by the same author | pass |
| reference whose author lookup is unavailable | pass (fail-open) |
| `attribution-approved` present | pass |
| ordinary PR with no carry language | pass |
| "supersedes" inside a fenced code block | pass |

The first case is driven red against the unmodified assessor before the
implementation exists.

## Audit correction (A-phase, folded)

The draft said to reuse `stripNonRenderedRegions` for the fenced-code case. It
is defined at `.github/scripts/pr-quality.cjs:247` and is **not** in that file's
`module.exports` — the exported list ends at `stripPrTemplateBoilerplate`. So
the plan as written would not have run.

Two options, and the choice is not cosmetic. Exporting it from `pr-quality.cjs`
and importing it into `pr-hygiene.cjs` makes the hygiene assessor depend on the
quality gate's module, and the dependency currently runs the other way:
`pr-hygiene.yml` imports `authorHasPushPermission` from `pr-quality.cjs` at the
workflow level, while the two assessor modules stay independent. Inverting that
for one small regex helper buys a cycle risk for no benefit.

So `pr-hygiene.cjs` gets its own local fence/comment stripper. It is four lines,
it keeps the module standalone, and the two copies cannot drift in a way that
matters — each is asserted by its own test.

## AGENTS.md rule

A short paragraph under the issues-and-pull-requests section:

> Landing another author's work — reimplementing it, superseding it, carrying
> it, or rebasing it — requires a `Co-authored-by` trailer naming that author in
> the squash body. Saying so in prose is not equivalent: the trailer is what
> GitHub reads for the contributor graph, and a sentence in a commit body is
> read by nobody. `missing_coauthor_credit` enforces this.

## Verification

```bash
node --test .github/scripts/pr-hygiene.test.cjs
bun run typecheck
```
