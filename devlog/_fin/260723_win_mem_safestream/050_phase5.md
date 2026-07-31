# 050 — WP5: docs-site troubleshooting page + invariant sweep + full gates

Depends: WP1-WP4 landed.

WP5-P stale-check (tree 6a670bce): docs-site has NO troubleshooting collection
yet — content root docs-site/src/content/docs/{getting-started,guides,
benchmarks,reference,contributing} + ko/zh-cn/ru/ja locales; sidebar defined in
docs-site/astro.config.mjs:103-152 (English labels + per-locale translations
per item). Plan: NEW docs-site/src/content/docs/troubleshooting/windows-memory.md
with sibling frontmatter (title/description), NEW "Troubleshooting" sidebar
group (with ko/zh-CN/ru/ja label translations; single item) inserted before
Contributing. Translated locale content NOT added (English source of truth);
locales fall back to English automatically in Starlight. The runtime warn line
(memory-watchdog.ts DOCS_URL) and doctor guidance already reference
troubleshooting/windows-memory — the page must land at exactly that slug.
package.json has no docs build script wired into CI here; verification =
astro check via docs-site build if a script exists, else structural review.

## NEW docs-site page

Path: docs-site/src/content/docs/troubleshooting/windows-memory.md (verify the
actual troubleshooting collection path at WP5's P; follow existing frontmatter
conventions of sibling pages; English source of truth — translated locales NOT
updated here, only checked for non-contradiction).

Content contract (honesty labels from 001 §6 — MUST appear verbatim in spirit):
1. Symptom: growing RSS of the `bun` process on Windows (#314 shape).
2. Root cause: upstream Bun runtime issues — fetch backpressure (#28035, fixed
   via #29831, release inclusion unverified), async-pull cancel crash (#32111,
   fix merged, release inclusion unverified), node:net handle leak (PR #31654
   still open). Bundled runtime is 1.3.14.
3. What opencodex does today: bounded mitigation only — RSS watchdog warnings,
   `ocx doctor` memory section, `/api/system/memory`; the leak itself is NOT
   fixed on the bundled runtime. Real-world RSS relief: awaiting Windows user
   verification.
4. Options (audit round dispositions): (a) wait for a bundled runtime bump;
   (b) OPENCODEX_BUN_PATH override with a runtime you trust (unvalidated,
   own-risk label) — MUST state the service re-bake step (audit B1): the env
   is read at artifact-generation time (durableBunRuntime → baked OCX_BUN,
   service.ts:358), so service users set the env THEN re-run
   `ocx service install`; setting the env alone does nothing for an installed
   service; (c) `streamMode: "eager-relay"` opt-in via config.json OR
   streamMode-only `PUT /api/settings` (both paths named — audit Low) —
   explicitly labeled with the #32111 crash risk on 1.3.14, noting the crash
   is NOT Windows-specific (repro on macOS/Linux ARM64 too; audit Low).
5. Threshold auto-restart: NOT shipped (deferred; F4). Service-manager respawn
   (WinSW/launchd/systemd) already restarts on crash-exit.
6. Link from an existing troubleshooting index/sidebar if one exists.

## Invariant sweep

- Re-verify tests/passthrough-abort.test.ts + index.ts mirror comment coherence
  after all phases (H4/F5) — audit pre-verified coherent at 6a670bce.
- Re-verify crash-guard comment rationale (A6) — audit pre-verified updated.
- rg for stale references: "no-tee", dead flags, TODOs left by WP1-WP4 —
  audit pre-verified clean; only devlog historical line refs drifted (leave).
- structure/ SoT patches (audit B2 — DEFINITE list, SOT-SYNC-01):
  * structure/04_transports-and-sidecars.md — add the two-shape passthrough
    contract (default tee vs gated eager relay).
  * structure/05_gui-and-management-api.md:13 endpoint table — add
    GET /api/system/memory row; note streamMode in PUT /api/settings.
  * structure/01_runtime.md:26 module inventory — add memory-watchdog.ts,
    relay-eager.ts, management/system-routes.ts, lib/bun-stream-caps.ts.

## Final gates (goalplan c-gates)

- bun run typecheck; bun run test; bun run privacy:scan; bun run lint:gui only
  if gui touched (should be NO).
- docs-site build is a MANDATORY gate (audit B3): `cd docs-site && bun install
  && bun run build` — docs-site/package.json:8 has the script and NO PR-time
  CI builds docs (deploy-docs.yml fires only on main push), so a bad slug or
  sidebar entry would otherwise first fail at release promotion.
- Goalplan: all criteria capturedEvidence filled; ledger updated; final commit.
