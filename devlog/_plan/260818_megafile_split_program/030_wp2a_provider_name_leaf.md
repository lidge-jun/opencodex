# WP2a-1 — config provider-name leaf (cycle breaker; parallel PR off dev)

Branch codex/split-wp2a-config-names on dev@aaf04690e. NOT stacked on the
types stack (disjoint files, DEV-STACK-01 'independent parts -> parallel PRs').
Class C2 pure move + 2 consumer retargets. Risk basis 000_risk_assessment.md
WP2a; highest-leverage low-risk config extraction: breaks the existing
config <-> routing/profile import cycle.

## Loop spec

- Goal: isValidProviderName/hasOwnProvider live in a leaf with no heavy deps;
  routing/profile.ts and router.ts stop importing them through the 3900-line
  config barrel (which loads Zod + bun:sqlite + registry transitively).
- Non-goals: no other config extraction this PR; management write-path
  callers keep importing from ./config (barrel re-export).
- Verifier: typecheck + lidge full suite + core-lab-boundary.

## File change map

- ADD src/config/provider-name.ts: RESERVED_PROVIDER_NAMES,
  PROVIDER_NAME_PATTERN (both module-private consts, config.ts 738-750),
  isValidProviderName (762), hasOwnProvider (769). Zero imports.
- EDIT src/config.ts: delete moved bodies; add
  `export { isValidProviderName, hasOwnProvider } from "./config/provider-name"`;
  internal call sites (1150, 1390, 1597 + others) need a local
  `import { ... } from "./config/provider-name"` since re-export binds nothing
  (WP1 lesson).
- EDIT src/routing/profile.ts:16: import hasOwnProvider from
  ../config/provider-name (cycle edge profile->config removed).
- EDIT src/router.ts:11: split import — hasOwnProvider from
  ./config/provider-name, resolveEnvValue stays from ./config.

## Accept criteria

1. typecheck exit 0. 2. lidge full suite 0 fail (baseline 13201 pass).
3. core-lab-boundary green (router edge now reaches a leaf with no imports —
   protected graph shrinks).
4. rg 'from "../config"' src/routing/profile.ts -> no hasOwnProvider import
   through the barrel (cycle gone; remaining profile imports from config: none
   expected — verify, else keep others intact).
5. Source diff: exactly 4 files under src/.

## Risks

- config.ts superRefine calls isValidProviderName internally — the local
  import must land before schema evaluation (top of file, hoisted; ESM fine).
- routing/profile.ts may import more than hasOwnProvider from ../config —
  verify and leave other names on the barrel.


## Audit amendments (grok PASS / sol NEAR-PASS)

- Internal call sites are EXACTLY 3 (1150, 1390 isValidProviderName; 1597
  hasOwnProvider), all inside superRefine callbacks — no TDZ risk.
- AC3 claim corrected: the protected graph does NOT shrink (router keeps the
  barrel edge for resolveEnvValue; the leaf adds one dead-end module). The
  real win is the config<->profile cycle break. core-lab-boundary stays
  green either way.
- profile.ts imports nothing else from ../config — cycle fully gone.
- Tests importing isValidProviderName via barrel: config.test.ts:13,
  policy-execution.test.ts:6 — barrel re-export preserves both.

