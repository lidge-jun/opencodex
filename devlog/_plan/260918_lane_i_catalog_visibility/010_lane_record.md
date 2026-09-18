# Lane I — catalog and model visibility

Six assigned issues, worked against `dev` at `a0f611d4aceb9476d44268e43722273b7b211846`.
Hosted CI was the only executable verification; no local suite, typecheck, build, install or
`ocx` invocation was run in this lane.

## Disposition

| Issue | Outcome | PR |
| --- | --- | --- |
| #4811 | Sync-log suppression diagnostic plus the two missing config keys | #4958 |
| #4940 | Proxy-side refusal of a Reserve turn the opt-in cannot serve | #4968 |
| #4944 | Generated-registry data refresh for `opencode-go` | #4962 |
| #4646 | Doctor check for an unexposed pinned default model; two asks answered, not implemented | #4963 |
| #4590 | Base prompt reported by the prompt probe | #4964 |
| #4662 | Client-role discriminator so a missing management route is legible | #4959 |

Filed from this lane: #4961 (the `codexDesktopAuthless` coupling defect), #4971 (the latent
`seen`-skip), #4972 (the shared default loopback port).

## Findings worth keeping

**#4811 and #4940 are not one defect.** They fail at two different clauses of the same guard.
`createReserveCatalogProjection` refuses on
`!isEffectiveCodexDesktopAuthless(config) || mainSelectors.length === 0`. #4811 has the opt-in on
and trips the second clause; #4940 has it off and trips the first, never reaching the selector map
at all. The working hypothesis going in was that both were the selector map, and two patches would
have been written against it.

**#4944's operative cause was not the mechanism its title leads with.** The title names three, and
the `seen` skip in `routed-gather.ts` is the one that reads like the culprit. It is not: the
serialized entry gets its window from `applyCatalogMetadata`
(`src/codex/catalog/parsing.ts:828-836`) straight from the generated table, with no reference to
the `CatalogModel` list, so a stale registry is the cause and a merge fix would have changed no
row. Recorded as #4971 so the ruling-out survives the closure. The issue's model list is also
partially wrong: `muse-spark-1.3-contributor` was already declared at 1048576 in the provider
registry preset, and `deepseek-flash` is not published by models.dev for this provider.

**#4646 ask 1 was already correct behaviour.** Sync byte-compares the regenerated catalog against
disk rather than testing for file existence; the guard landed 2026-08-11 in
`c7eec01ca4`/`642805c11e`, a month before the report. Implementing the requested drift trigger
would have rewritten the catalog on every sync forever, because `visibleNativeSlugs` omits
disabled slugs from `/v1/models` while the catalog deliberately retains them as `hide` rows — two
sets that are unequal by design — and that rewrite would re-break the #857/#1407 mtime staleness
contract.

**#4662's reported cause was a red herring.** There is no second management port; management rides
the same listener. The ambiguous 404 came from the client machine listener, which publishes a
`role` discriminator that the CLI liveness parser was discarding.

## Pattern: the file-size ratchet makes large files append-only

Two lanes hit this independently, so it is worth naming rather than rediscovering.

`tests/fixtures/file-size-baseline.json` caps named files, and `scripts/file-size-ratchet.ts`
treats any growth past the cap as `GREW`. The baseline only moves downward — `updateBaseline`
uses `Math.min` — so a file sitting exactly at its cap cannot be extended at all, and raising the
cap is not an available move. That is deliberate: a lane that reaches for the cap has already
decided to mask something.

The consequences in practice:

- `tests/codex-integration/codex-catalog.test.ts` sits exactly at 7985. The #4944 regression could
  not be added to it. The sanctioned escape is a new sibling file plus its two registrations, in
  `scripts/test-layout/layout.json` `explicit` and `tests/fixtures/test-layout-expected.json` —
  the shape `d3ca5522db` established, and what `catalog-hub-context-window.test.ts` already is.
- `src/codex/catalog/sync.ts` is capped at 52 and was at 52. A six-line facade re-export added in
  #4958 pushed it to 58 and failed a Linux shard. The fix was to delete the re-export, which was
  never load-bearing, rather than to look for a way to move the cap.

Check the baseline before planning where a change lands, not after CI says no. A one-line node
read of `tests/fixtures/file-size-baseline.json` against the current line counts catches it in
seconds, and it is worth doing across every file a lane intends to touch.

## Correction made during implementation

The #4646 brief asserted that a disabled-but-hidden native slug "will fail at request time". It
does not. `src/router.ts:922` states that routing never consults `disabledModels`, and
`docs-site` `model-routing.md:80` already documented that disabling does not reject a direct
request. The slug is routed by the ordinary rules as though it were enabled. The shipped docs and
the issue's closing comment state the accurate behaviour; the brief was wrong and the
implementation caught it.
