# 030 — wp3: release-note credit sections

## Slice

No file changes. Edits GitHub release bodies through `gh release edit`.

## Why this is possible at all

A release body is mutable; a tag is not. This is the only surface where the
credit can be added to the artifact that shipped the code, rather than beside
it.

## Which releases

Resolved by `git tag --contains <sha>` for every SHA in `CREDITS.md`, taking
the earliest non-preview tag per commit:

| Release | Uncredited landings inside it |
|---|---|
| `v2.23.0` | `cb48c2e11` (#1801 @jonathanli12) |
| `v2.34.0` | `8412fe156` (#2675 @Ingwannu) |
| `v2.35.0` | `d829215af`, `bdc1e97bb` (#2693 @yxr1995-maker) |
| `v2.36.0` | `1d9b389c1`, `eb52973c5`, `de91dfde4`, `8d1dc1f5d`, `c986d1d20`, `5734a1caf`, `bb3321ca8`, `8877df0ee`, `607042b02` |
| `v2.37.0` | `870a2adb6` |
| `v2.39.0` | `b46164e78`, `0ef04e640`, `330470e74`, `e9d198a3c`, `a73a4c998` |
| `v2.40.0` | `d23eab43a`, `408652698`, `52d941640`, `b14b741dc`, `fecb77a91`, `88c427522`, `ef7b3c9cf` |

`15b43e51c` (#3300 @S0RYUASUKA) is on `dev` and in no tag yet. It needs no
edit — the next release note covers it, and `CREDITS.md` already carries it.

Preview tags are skipped: they carry the same commits as their release and
would double-name the same people.

## Section shape

Appended, never replacing the existing body:

```markdown
## Contributor credit

This release contains work carried from contributor pull requests whose landing
commits do not name their authors in a `Co-authored-by` trailer. The omission is
in git history and cannot be repaired there; the record is
[CREDITS.md](https://github.com/lidge-jun/opencodex/blob/dev/CREDITS.md).

- #2797 by @rrmlima — landed as `5734a1caf`
- ...
```

## Order of operations

wp3 runs after `CREDITS.md` is on `dev`, so the link resolves when the note is
published. A release note pointing at a 404 would be worse than no note.

## Verification

`gh release view <tag>` after each edit, confirming the section is present, the
pre-existing body is intact, and the link resolves. Read back, not write-and-
assume: `gh release edit --notes` replaces the whole body, so the existing text
must be fetched, appended to, and written in one pass.

## Risk

This is the only phase that writes to a published artifact. It is idempotent by
construction — the appended section is detected by its heading before writing,
so a re-run does not stack duplicates.
