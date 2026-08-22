# 010 — Review dispatch plan

## Shape

Eight `gpt-5.6-terra` reviewers at `high` reasoning effort, one per family, all
spawned in the same round. Families are cut so that each reviewer owns a single
coherent subsystem and no two reviewers read the same diff — a disjoint read set
keeps their findings independently meaningful.

| Family | Items | Why grouped |
|--------|-------|-------------|
| F1 json-integrations | #1637, #1632, #1635, #1631 | Two PRs and the two issues they answer, same serializer/conflict surface |
| F2 usage-server | #1638, #1636, #1601 | Usage window fix plus the Bun listener fix and its report |
| F3 cursor-applypatch | #1634, #1615 | Cursor adapter surface |
| F4 codex-routed | #1623, #1613, #1608 | Routed Codex contracts, replay expiry, websocket buffering |
| F5 windows-service-packaging | #1627, #1626, #1625, #1617, #1612 | Service lifecycle, packaging, container start |
| F6 antigravity-discovery | #1640, #1639 | Model discovery and the Gemini 3.7 Flash PR |
| F7 lab-quota | #1628, #1624, #1609 | Lab evidence core, quota policy, rollback snapshots |
| F8 feature-issues | #1619, #1616 | Feature proposals needing a product read |

## Method the reviewers are bound to

Each packet requires the reviewer to open the real diff (`gh pr diff`), read the
surrounding code in the local checkout, read existing reviewer comments so it can
adjudicate rather than repeat them, and — for issues — verify the reporter's claim
against the actual file the reporter cites.

The repository's own review guidelines are carried into every packet: English
only, file-and-line specificity, security boundary as highest priority, Bun-native
runtime constraints, regression-test adequacy (explicitly: a test that also passes
on unpatched code is not a regression test), docs sync, and the privacy scan.

## Authority boundary

Reviewers return text. They do not post, merge, push, or mutate git state. The
main session posts every comment itself. This keeps one accountable writer on the
repository and prevents eight agents from racing on the same issue thread.

## Return contract

A single fenced JSON array per reviewer, one object per item:
`number`, `kind`, `disposition`, `risk`, `summary_for_maintainer`, `comment_body`.
`comment_body` is the finished markdown comment; the disposition line is its last
line. The maintainer-facing summary stays out of the posted comment.

## Dispositions

PRs: `MERGE-READY`, `NEEDS-CHANGE`, `NEEDS-INFO`, `DEFER`.
Issues: `ACCEPTED`, `NEEDS-INFO`, `DUPLICATE of #n`, `WONTFIX`.

`MERGE-READY` is defined as "I would stake today's release on this diff", which
is what makes the WP4 merge set fall out of WP2 rather than being decided twice.

## Failure handling

A reviewer that returns nothing after three wait cycles is a failed dispatch: it
is retired and respawned once with the failure folded into the packet
(DISPATCH-RETIRE-01). A reviewer whose output is unparseable JSON is asked for the
block again rather than re-run from scratch.
