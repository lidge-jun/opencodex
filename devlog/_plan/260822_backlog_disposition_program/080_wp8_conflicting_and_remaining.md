# 080 — WP8: conflicting and remaining PR disposition

The tail of the backlog: ten PRs conflicting with `dev`, four drafts outside the other
lanes, and one on the wrong base. This phase runs last because several items are
superseded by whatever WP1–WP7 land.

## Wrong base — immediate

### #2357 — `[WRONG BRANCH] Add __omit__ reasoning-effort wire sentinel`
Base `main`, draft, `enforce-target` failing twice. The author labelled it themselves.
Addresses #2356 (ollama ≥0.32 rejecting high reasoning efforts).

Disposition: **CLOSE** with a reason directing the author to reopen against `dev`. The
underlying issue #2356 stays open with its triage intact. Closing is correct here — the
branch policy forbids feature PRs against `main`, and a retarget by a maintainer would
rewrite a contributor's PR base without their involvement.

## Conflicting with `dev` (10)

| PR | Size | Note |
|----|------|------|
| #2280 | 556+/15- | per-model synthetic max suppression; interacts with #2279 |
| #2230 | 1637+/61- | Gemini OAuth accounts; hygiene-blocked |
| #2222 | 1390+/168- | **superseded by WP5** — see `050` for the verdict |
| #2213 | 494+/101- | Grok direct-first tool projection |
| #2069 | 1650+/41- | antigravity account cooldowns; hygiene-blocked |
| #2041 | 26+/1- | auto_review_model override (tiny, addresses #1225) |
| #1794 | 1759+/8- | routed V2 subagents + OpenRouter endpoints |
| #1704 | 181+/7- | maintainer-authored combo quota GUI |
| #1645 | 1425+/151- | vision sidecars; likely superseded by the landed #2188 chain |
| #1557 | 2545+/69- | least-privilege data-plane catalog endpoint (#809) |

**Standing instruction from the maintainer triage, which governs this phase:** when a
conflicting PR overlaps the `types.ts`/`config.ts` split, *do not rebase — close and
reopen*. Rebasing a large branch across a file split produces a diff no reviewer can
audit. Each PR here is checked against that rule before any conflict resolution is
attempted.

#2222 is the clearest case: WP5 (`050`) already recorded that its approach is right but
its diff is stale, it smuggles a `refreshGrantFingerprint` semantic change that
contradicts an existing test, and it attaches a ~200-line lock rewrite to a bugfix.
Its disposition is CLOSE-as-superseded once WP5 lands, crediting the author.

## Drafts outside other lanes (4)

| PR | State | Note |
|----|-------|------|
| #2352 | draft, mergeable | native lifecycle after ownership reprobe; 860+/59- |
| #2326 | draft, `enforce-target` fail | GUI frontier shortcuts; needs a screenshot per the PR template |
| #2083 | draft, **APPROVED** | xAI Imagine image relay — approved but never marked ready |
| #2033 | draft, tiny | expose web-search sidecar enabled status, 14+/0- |

#2083 is notable: it carries an APPROVED review and is mergeable, but sits in draft. It
needs only a ready-for-review transition and exact-head verification.

## Accept criteria

1. Every open PR not disposed by WP1–WP7 has a recorded terminal disposition here.
2. No large conflicting branch is force-rebased across the `types.ts`/`config.ts` split.
3. Closures name the reason and, where the work was sound, credit the author and point
   at the superseding change.
4. Final `gh pr list` count reconciles against the `000` inventory of 45.

