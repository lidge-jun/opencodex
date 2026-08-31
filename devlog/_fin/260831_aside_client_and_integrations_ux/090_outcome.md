# Outcome

Unit closed 2026-08-31. Every phase in this unit is on `dev`.

| Phase | Doc | PR | On `dev` as |
|---|---|---|---|
| wp1 | 000 | -- | docs only |
| wp2 | 010 | #3047 | `8c1294828` -- Aside export client + registry |
| wp3 | 020 | #3048 | `93b7ee80a` -- Aside GUI surface, nine locales |
| wp4 | 030 | #3050 | `efa2ba5ad` -- rollback journal stops flooding |
| wp5 | 040 | #3049 | `704d0d91a` -- brand marks for the export clients |
| wp6 | 050 | -- | the stacked chain itself |
| wp7 | 060 | #3082 | `44b4de39d` -- the last three marks |
| wp8 | 070 | #3083 | `d86ec3e03` -- marks on every surface |
| wp9 | 080 | #3084 | `2a90cdaa9` -- conflict overwrite |

Two follow-ups landed after the table above, both from auditing the merged head
rather than from the plan:

| what | PR | on `dev` as |
|---|---|---|
| Grok mark masked so it survives the dark theme | #3086 | `0cc73411a` |
| `--overwrite-conflict` for the CLI, plus mobile dialog guards | #3088 | `91b2c4e19` |

#3065 (`7853e8e05`) and #3074 landed alongside wp5: Aside's own mark plus the
first version of the single-ink rule, and the property guards the pair relies on.

wp7 through wp9 were appended after the original six, planned in #3081
(`873d08e63`). The unit grew because the page repair exposed what the marks work
had left behind: three clients still drawing a monogram, and marks present on the
API-keys rows but nowhere else on the page that names the same clients.

## What the plan got wrong

**A mark's absence upstream is not the same as its absence in a repository.**
060 assumed each of the three vendors publishes an SVG somewhere findable. None
did in usable form: the Hermes repo favicon is 113 bytes of `<text>`, the
MiniMax docs asset is a 129x32 wordmark, and Gajae Code has no vector anywhere.
Two of the three marks are traced from raster art, which the plan did not
anticipate and which the README now records per asset.

**Masking is a decision about trademark, not about ink count.** 040 framed the
mask set as "single-ink logos", which would have swept in `openai.svg` (one fill,
but that fill is OpenAI's brand green) and `grok.svg` (genuinely neutral, but
xAI's published file with a literal fill). Both stay images. The rule in
`integration-marks.ts` is now derived from one id-keyed set with the two
exclusions argued in place, rather than restated per surface.

**A guard can pass for the wrong reason.** 080 listed a stranding test for the
forced `foreign-edit` path. Its first implementation passed with the fix removed,
because every path the old record owned was also one the new contribution writes,
so dropping the old fragments changed nothing observable. It was rewritten around
a layout the new write does not cover -- which is what an upgrade actually leaves
behind -- and only then failed when falsified.

**Three declarations of one union had no guard.** 080 did not notice that
`OperationKind` is declared in `src/integrations/journal.ts`, restated in the
management envelope and restated again in the GUI adapter, with no import between
them. The doc comment in `journal.ts` claimed a test asserted the three agree.
None did, so a kind added in one place rendered as a raw i18n key with no type
error anywhere. `tests/integrations-journal.test.ts` now reads all three.

**A documented tradeoff was a defect.** 070 recorded `grok.svg` as staying an image
because masking would be "editing someone else's mark". Measured on the dark card
surface it was about 1.9:1 -- the glyph was effectively invisible, and had been since
the mark landed. The reasoning was simply wrong about what masking does: the file is
not modified, it is read as a shape and tinted, which is how xAI renders it
themselves. Writing a tradeoff down does not make it correct, and neither this unit
nor the pass that followed it measured the thing it was excusing.

**Half a surface is not a surface.** 080 specified the overwrite escape hatch for the
GUI and stopped there, which left `ocx integration client enable` dead-ending on the
exact state the feature exists to escape. The user with no browser -- an SSH session,
or an agent driving the proxy -- was the one still stuck. Fixed in #3088; the docs had
meanwhile been asserting that a conflict simply locks.

## Verification as merged

CI green on each PR head, including the unsharded macOS job, before every admin
squash merge. Two flakes surfaced and were diagnosed rather than absorbed:
`tests/install-scripts.test.ts` restart-helper on #3082, and
`tests/shutdown-launcher.test.ts` SIGHUP health-wait on #3083 -- the latter's
SIGINT and SIGTERM siblings passed in the same run, and PR #3061 is already open
for it. Neither file is touched by this unit.
