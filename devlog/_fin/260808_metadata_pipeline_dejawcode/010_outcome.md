# 010 — outcome (D record)

Terminal outcome: DONE.

Single PABCD cycle, HITL. A-gate: independent reviewer (Cicero) returned
GO-WITH-FIXES with one High blocker — the generator's default output was
`process.cwd()`-relative, defeating the from-any-cwd scenario. Folded into the
plan (output anchored at `import.meta.dir`) and implemented. One observation
folded: `src/usage/cost.ts` keeps the serialized `jawcodeProvider` key via
explicit `jawcodeProvider: metadataProvider` assignments, never shorthand.

Commits:
- 40d831e4e — vendored snapshot + generator/test default switch (pre-loop).
- 1be8e67e3 — renames, symbol updates, env removal, regeneration.

C evidence (all fresh, post-commit tree):
- `bun run typecheck` — exit 0.
- Affected suites (8 files) — 254 pass, 0 fail.
- `bun run test` (full) — 9,845 pass, 0 fail, 7 platform skips; the sync
  guard now runs instead of skipping (snapshot vendored) and passes.
- `bun run privacy:scan` — passed.
- Old-name sweep (`rg` over the 16 old identifiers, excluding devlog
  history) — zero hits.
- Activation: sync guard regenerated into a temp dir via `MODEL_METADATA_OUT`
  and byte-compared (pass); generator run from `/tmp` produced a
  byte-identical module (cwd independence, the A blocker, verified).

Deliberately unchanged (contract surface, separate decision if ever desired):
`source: "jawcode"` price-source literal, `jawcodeProvider` payload key
(read by `gui/src/pages/Logs.tsx`), `jawcodeBundle` registry field,
`deriveJawcodeAliases`, the jawcode provider itself, devlog history names.

What did not improve / killed hypotheses (LOOP-PESSIMIST-01): none — the
rename was mechanical and the only substantive fix came from the A gate
(cwd-anchored output). Evidence that would show this direction is wrong: a
consumer surfacing the old module path as a string at runtime (none found by
the reviewer sweep), or downstream tooling keying on the old package.json
script name (none in-repo; external muscle memory only).
