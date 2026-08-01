# 001 — failure-mode inventory

Ranked by damage. F1–F3 are the ones the design must actively defend; F4–F7 are
documented so a later change cannot reintroduce them silently.

## F1 — adopting a genuine user model (WORST)

A human writes their own `[model.my-local]` pointing at the opencodex proxy for their
own reasons. If our ownership test is loose enough to match it, the adoption sweep
DELETES their entry on the next sync. There is no undo in-product; only
`config.toml.bak-opencodex` (written once, at first injection — so possibly ancient).

Defence: adoption requires a signal a human would not plausibly reproduce, and the test
must be conjunctive rather than "any one of". `base_url` pointing at loopback is
explicitly NOT sufficient — pointing your own model at the local proxy is a legitimate,
documented thing to do.

## F2 — dangling `default` / `fork_secondary_model` after removal

`[models] default = "ocx-gpt-5-6-sol"` and `[ui] fork_secondary_model` name aliases by
string. Removing an adopted orphan without rewriting those references leaves Grok
pointing at a nonexistent model. On this machine `default` names an orphan, so this
fires on the FIRST run for the reporting user — it is the common path.

Defence: the sweep returns the alias renames it performed, and references are rewritten
in the same write. Any reference we cannot confidently rewrite means we do NOT remove
the orphan (fail safe toward leaving the file working).

## F3 — losing user settings to a duplicate-key rejection

Documented at `src/grok/inject.ts:64-74`: one `[[model.x]]` colliding with a generated
`[model.x]` makes Grok reject the entire config layer, taking unrelated user settings
with it. Adoption REMOVES reserved aliases, so it directly moves entries from the "safe,
routed-around" set into the "we now generate this name" set.

Defence: an alias is only freed for reuse after its orphan table is actually removed
from the content we write. Array-of-table (`[[model.x]]`) and sub-table
(`[model.x.sub]`) spellings are NEVER adopted — a genuine opencodex write is always a
plain `[model.x]`, so those spellings mark human authorship and stay reserved.

## F4 — partial-table removal corrupting the file

A TOML table runs from its header to the next header or EOF. Removing "the orphan" by
matching only the header line, or by a naive line count, can leave orphan key/value
lines behind — which then attach themselves to whatever table precedes them. That is
silent semantic corruption of a NEIGHBOURING table, which is worse than the bug we came
to fix.

Defence: removal operates on a header-to-next-header span computed from the same
canonicalized scan used for reservation, and the result is re-scanned to assert the
alias is gone and no stray keys remain at top level.

## F5 — the orphan is the ONLY entry for a model

If a model exists solely as an orphan and is not in the current catalog (a provider was
removed, a model was retired), adopting it means deleting it outright. The user loses
a model they may still be selecting.

Defence: this is acceptable ONLY because the entry is opencodex-owned and points at our
proxy — if the model is gone from the catalog, the entry was already dead (the proxy
would 404 it). Recorded here so the behaviour is deliberate, and the `default` rewrite
(F2) must still find a live target; if none exists, leave `default` alone rather than
point it somewhere arbitrary.

## F6 — CRLF / EOL damage

`injectGrokConfig` normalizes to `\n`, edits, then restores the dominant EOL
(`dominantEol` / `applyEol`). A sweep that edits outside that normalized window, or
that rejoins with a hardcoded `\n`, silently rewrites a Windows user's whole file.

Defence: the sweep runs INSIDE the already-normalized content, before the EOL is
re-applied. No separate EOL handling.

## F7 — idempotence

A sweep that adopts on every run (rather than converging) would rewrite the file
forever, defeating the `changed` flag that callers use to decide whether to report a
config change.

Defence: after one sweep the orphans are gone, so the second run finds nothing and
reports `changed: false`. Asserted by running the sync twice in a test.

## F8 — orphaned marker interaction

If the begin marker exists without its end marker, the region boundary is ambiguous and
the code already refuses to touch anything (`orphanedMarkerResult`). The sweep must
inherit that refusal rather than running against a file whose fence we cannot locate —
otherwise "adopt everything outside the region" could mean "adopt the entire file".

Defence: the sweep runs only after the existing orphaned-marker check has passed.
