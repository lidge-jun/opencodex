# Audit round 6 — synthesis

Verdict: **FAIL**, 4 High + 1 Medium. Fourth of five round-5 blockers confirmed
closed in substance; the failures are one genuine new defect and four places
where my amendment landed beside the stale text instead of on top of it.

## Confirmed closed

- `non_loopback_removed` matches the code in both branches: `changed: true` with
  an existing fence, `changed: false` without, `absent` either way.
- Dropping the cross-family coordinator is safe. The reviewer checked
  `records.json` and `journal.ts` directly: native toggles write neither, so no
  shared bookkeeping overlap remains.
- Claude Code needs no route guard — mutation and synchronous save cannot
  interleave on Bun's event loop, and `withConfigMutationLockSync` holds a
  SQLite `BEGIN IMMEDIATE` across processes (verified independently at
  `src/config.ts:1768-1786`).
- `NativeStatus` is defined once; route ownership is consistent; `040` is two
  switches and one dialog; the `002` appendix is clearly marked.

## The one real finding: orphan beats non-loopback

**#4.** Enable Grok on a non-loopback bind while `config.toml` holds a begin
marker with no end marker. `injectGrokConfig` calls `stripGrokConfig`, which
returns `ok: false, skippedReason: "orphaned-marker"` and changes nothing
(`src/grok/inject.ts:474`) — but the caller reads only `removed.changed` and
discards the rest (`inject.ts:357-363`). So it reports non-loopback success with
`changed: false`, and my spec then lands the card on `absent`.

The fence is still there. `absent` is wrong; the honest state is `unsafe`.

This is the same failure shape as round 5 #1 — a policy skip that quietly
swallows what actually happened underneath — one branch deeper. I fixed the
outer case and did not check whether the inner call could fail.

**Fix without touching the writer:** run `inspectGrokConfig` as an authoritative
preflight for BOTH directions. An orphaned marker refuses `orphaned_marker`
before `injectGrokConfig` is ever called, so the ambiguous case never reaches
the branch that would misreport it. The inspector already exists for
`disableBlocked`; this makes it the gate rather than an advisory extra.

## The four residues

#1, #2, #5 are the same mistake as round 5 #4/#5, repeated after I had written a
process rule about exactly this:

- `030`'s refusal TABLE still lists `non_loopback` as 409 while the prose two
  sections later specifies 200 `non_loopback_removed`. I added the outcome and
  left the row.
- `011` still says the coordinator serializes its writes, in a doc whose sibling
  removed the coordinator.
- `002`'s live refusal section still names three sibling-unit refusals, and says
  "Two more" while naming three.

#3 is a specification gap rather than a residue: `findManagedRegion` is private
to `inject.ts` and ES modules cannot share an unexported symbol, so
"shares `findManagedRegion` with the writer" named an arrangement that does not
exist. `inject.ts` must be in WP2's scope and export it as an internal API.

## Why the sweep keeps missing these

Round 3 gave me "grep the claims, not the headings". Round 5 gave me "grep the
other phases' client names, type names, and cardinality words". Both times I
ran the sweep I had just written, against the terms I already knew about, and
both times the residue was somewhere I had not thought to look — a table row
while I was checking prose, a cross-doc dependency while I was checking
cardinality.

The generalisable rule, finally: **after amending a doc, re-read every section
that MENTIONS the thing I changed, not just the section I changed.** A grep
finds terms; only reading finds a table that contradicts the paragraph below it.

For this round that means: `non_loopback` appears in `012` and `030` — read both
in full. The coordinator appeared in `011`, `030`, `000` — read all three.

## Disposition

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | High | `non_loopback` still 409 in the refusal table | **Accept** — row removed, outcome documented once |
| 2 | High | `011` still depends on the dropped coordinator | **Accept** — replaced with the real lock contract |
| 3 | High | Parser sharing has no module boundary | **Accept** — `inject.ts` joins WP2 scope, exports it internally |
| 4 | High | Orphan-vs-non-loopback precedence unresolved | **Accept** — inspector becomes the authoritative preflight for both directions |
| 5 | Medium | Sibling refusals in the live section | **Accept** — moved into the appendix |

Nothing rebutted.
