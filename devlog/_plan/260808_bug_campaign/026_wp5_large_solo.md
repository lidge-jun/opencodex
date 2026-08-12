# WP5 — the two large solo PRs

| PR | Size | Outcome |
|----|------|---------|
| #1244 preserve routed models in desktop picker | 58 files | **CI green, merge held on four conditions** |
| #1228 native image support for Cursor | 8 adapter files | **held for the author**, conflicting and stale |

## #1244 — the author's fix was better than the one I proposed

In WP15 I reported the CI failure at `15545b3d1`: `TypeError:
suppressedBareNativeSlugs.has` at `src/codex/catalog/sync.ts:427`, driven by
`tests/codex-v2-gate.test.ts:1211`, with the input destructured at `:385`
without a default. I named two fix shapes — default the input, or update every
caller — and left the choice to them.

They did neither. `2c9994a9d` adds the two missing sets to the **one test call
site**, two lines, and leaves `sync.ts` alone.

That is the correct fix, and my reasoning about why was also wrong. I told the
audit that required-field typing beats a default because `typecheck` enforces
every caller. The audit checked what I had not:

```
$ rg '"include"' tsconfig.json
15:  "include": ["src"]
```

**`bun run typecheck` never covered `tests/` at all.** So my "typecheck is the
caller-sweep proof" claim was empty — the failing site was in the one directory
the compiler does not read, which is exactly why it reached CI. The right
statement is narrower: the fields are genuinely required on
`ObservedCatalogEntryBuildInput`, production callers in `src/` are compiler-
checked, and a hand-built test literal is the residual gap that explicit empty
sets close honestly.

I had reached for "the author saved me work and was therefore right". The
conclusion survived; the argument for it did not.

### What I verified before holding

- Cross-platform CI **success** at `2c9994a9d` (run `31258863895`)
- full `bun run test` on that head — **10003 pass / 7 skip / 0 fail**, 623 files
- `bun run typecheck` clean
- catalog/convergence suites — 258 pass / 0 fail
- no semantic conflict with the merged #1212: `a4878de38` is an **ancestor** of
  #1244's merge base, so the convergence work is already underneath it
- of the 20 commits `dev` moved ahead, none touch #1244's source files; the only
  overlap is `docs-site/.../configuration/routing.md`

### Why it is still held

1. **Stale base and stale claims.** 20 behind, and the PR body still asserts
   "0 commits behind" and "remains draft" while the PR is non-draft. The
   evidence needs to exist at the head that would actually merge.
2. **A locale defect.** English documents that `-` clears `--effort`,
   `--alias`, `--display-name` and that the subcommands exist under
   `ocx route combo` (`guides/combos.md:264`). Russian omits both
   (`ru/guides/combos.md:224`); `ja`, `ko`, `zh-cn` carry them. Five-locale
   alignment was claimed, four are aligned.
3. **CI evidence standard, post-#1302.** One green run is currently weaker
   evidence than it looks, so a 57-file catalog change gets two completed
   non-cancelled runs at the same rebased SHA.

4. **Fresh activation evidence.** The description's screenshot is carried
   forward from #1056, but this branch is a reconstruction rather than that
   code, so it proves nothing about what would merge. A picker capture at the
   current head is a **condition**, not a request — I softened it to "a request
   rather than a blocker" in the first draft of this page, which quietly
   downgraded something the review had made a merge condition.

## #1228 — where the republish protocol stops

Conflicting, draft, untouched since 2026-08-07, four readiness boxes unticked.
Every other stale PR in this campaign got rebased and republished for the
author. This one did not, and the line is worth stating because it is the same
line WP15 crossed for #1244 and then had to retreat from.

The republishes were small and mechanical — a net diff that reapplies onto a
moved base with the author's intent unambiguous. #1228 adds native image
support across eight files of the Cursor adapter including the protobuf request
builder and live transport. Resolving those conflicts means re-deciding the
author's design against a base that moved underneath it, which is authorship,
not maintenance.

Told them so directly, offered to close it as stale if they would rather not
carry it, and noted that a `cancelled` shard is #1302 and mine to chase rather
than theirs.

## Fault recorded

Claimed `typecheck` proved a caller sweep it structurally cannot perform,
because `tsconfig.json` includes only `src`. I have run that command dozens of
times this session and cited it as evidence repeatedly; I had never read what it
covers.
