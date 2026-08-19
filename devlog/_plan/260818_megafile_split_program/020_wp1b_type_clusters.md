# WP1b — types.ts type-cluster split (stacked PR 2, layer 2 of the stack)

Stack (DEV-STACK-01/03): layer 1 = #2019 (codex/split-wp1-types, value leaves).
This layer: codex/split-wp1b-type-clusters, base = codex/split-wp1-types.
Thesis: src/types.ts becomes a pure barrel; all type clusters move to leaves.
Class: C2 pure-move, type-only (zero runtime code moves in this layer).

## Loop spec

- Archetype: pure-move refactor, zero behavior change (type-only).
- Verifier: bun run typecheck + full bun run test on lidge (remote contract).
- Stop: green + PR opened with base codex/split-wp1-types + stack map in body.

## Measured dependency structure (one-way, no cycles)

- request cluster (lines 6-368): needs KiroOAuthMetadata (oauth/types),
  OcxTool + OcxToolChoice (types/tools). Nothing else external.
- config cluster (370-1180): needs OcxProviderConfig only (provider cluster).
- provider cluster (1183-1698): needs UpstreamHttpVersion x2,
  ReasoningSummaryDelivery x3, CodexAccountMode x2 (types/wire).
- accounts cluster (1700-1729): self-contained.

## File change map

- ADD src/types/request.ts  <- lines 6-368 + import type {KiroOAuthMetadata}
  from ../oauth/types, import type {OcxTool, OcxToolChoice} from ./tools
- ADD src/types/config.ts   <- lines 370-1180 + import type
  {OcxProviderConfig} from ./provider
- ADD src/types/provider.ts <- lines 1183-1698 + import type {...} from ./wire
- ADD src/types/accounts.ts <- lines 1700-1729, no imports
- EDIT src/types.ts -> pure barrel (~30 lines): export type blocks for the 4
  new leaves + existing tools/wire re-exports (values stay `export {}`,
  types stay `export type {}`). KiroOAuthMetadata import dropped from barrel.

## Accept criteria

1. typecheck exit 0. 2. lidge full suite 0 fail (>= 13201 pass baseline).
3. core-lab-boundary green (barrel value re-exports still walked; type-only
   leaves are erased so runtime graph SHRINKS, never grows).
4. Source diff: exactly 5 files under src/ (4 adds + barrel).
5. Public surface byte-compatible: src/index.ts exports (OcxConfig, OcxContext,
   OcxMessage, OcxParsedRequest, OcxProviderConfig, OcxRequestOptions, OcxTool,
   AdapterEvent) all still resolve from ./types.

## Risks

- `export type ... from` binds nothing locally (WP1 lesson) — but the new
  barrel needs NO local bindings once all interfaces leave; only the 4
  import-type lines vanish too. Residual: none expected.
- interface merging/declaration duplication: each name must exist in exactly
  one leaf; grep-verify no name appears in two files.
- Tests importing `import * as types from ../src/types` (namespace): type-only
  namespaces erased; runtime namespace keeps the same value exports via
  tools/wire re-exports. No test currently reads a VALUE that moves (nothing
  moves at runtime this layer).


## Audit amendments round 2 (grok-4.6 NEAR-PASS / sol FAIL -> both fixed)

CORRECTED extract ranges (file is 1727 lines):

- request.ts:  lines 5-211 (incl. leading JSDoc) + 224-364
  + import type { KiroOAuthMetadata } from ../oauth/types
  + import type { OcxTool, OcxToolChoice } from ./tools
  + import type { TierDecision, TierObservationContext } from ./provider
    (OcxRequestOptions.tierDecision:235 / tierObservation:237 — missed edge)
- config.ts:   lines 366-1181 (incl. closing brace 1181) MINUS the
  RefreshPolicy block (1074-1080, moves to provider — see below)
  + import type { OcxProviderConfig, RefreshPolicy } is WRONG — instead:
  + import type { OcxProviderConfig } from ./provider (604)
  + import type { CodexAccount } from ./accounts (874 — missed edge)
- provider.ts: lines 1183-1687 + RefreshPolicy block (1074-1080; sole
  consumer is OcxProviderConfig.refreshPolicy:1484 — relocation keeps the
  graph one-way, avoids the config<->provider cycle)
  + import type { UpstreamHttpVersion, ReasoningSummaryDelivery,
    CodexAccountMode } from ./wire
  + REWRITE 2 inline type-query paths (1659, 1665):
    import("./adapters/cursor/...") -> import("../adapters/cursor/...")
- accounts.ts: lines 1700-1727, no imports
- BARREL KEEPS lines 213-222 (tools value re-exports) and 1689-1698 (wire
  value re-exports): RUNTIME blocks, must NOT enter type-only leaves.
  Final barrel = 2 value blocks + 4 export type blocks, named re-exports
  only, NO export * (would duplicate runtime names).
- The 3 import type lines at 1-3 vanish with their consumers.
- Barrel needs RefreshPolicy re-exported from ./provider (was ./config).

Corrected one-way graph: request -> {oauth, tools, provider};
config -> {provider, accounts}; provider -> wire; accounts -> none.

Both auditors confirmed: no namespace imports, no runtime dynamic import of
types.ts (all import("...types").X hits are erased type queries), no textual
test pins, lab walker unaffected while value blocks stay in barrel,
src/index.ts keeps resolving. AC4 corrected: 5 files under src.

