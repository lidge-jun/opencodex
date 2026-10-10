# Done — catalog presentation and effort projection (cycle 1)

2026-09-11, session `01a08e7d-be48-72f0-9063-fb3f26ea2eb8`. Reader: someone who was
not in the loop.

## Conclusion

Phases 1, 2 and 4 landed on `codex/260911-clamp-expiry` and every gate that observes
them is green. Phase 3 (account-roster presentation fields) stays withdrawn: whether
`backend-api/codex/models` carries card copy the pin lacks is still unverified, and
the probe needs a live ChatGPT token, which is the user's call.

## What changed

- `fddbb7fad` — the code. `src/codex/runtime.ts` exports the single
  `UNCLAMPABLE_REASONING_EFFORTS` set (`max`/`ultra`); `effortClampAppliesToRuntime` is
  version-aware on the same-path branch (in-place Windows upgrades no longer keep a
  stale diagnostic alive) and inert when only exempt rungs are named;
  `src/codex/catalog/effort.ts:357` keeps those rungs in the observed-runtime
  intersection and `:378` stops repairing an exempt default; the Reserve keep falls
  out of the filter with no splice special-case; `ocx status`, `ocx doctor` and
  `/api/settings` read one shared predicate.
- `docs(devlog)` commit — this unit (000-060).

## Evidence

- Focused gate: `bun test` on the 8 affected files — 503 pass / 0 fail, exit 0.
- `bun run typecheck` — exit 0.
- `bun run test:changed` — 14080 pass; the 4 unique failures (cursor `apiKeyMode`,
  pnpm ×3, one 5s bearer timeout) were reproduced on a pristine worktree at merge
  base `babb76449`, so they pre-date this diff.
- Activation observed live on the reporting machine: repo build prints `Catalog
  clamp: inactive` and no doctor warning against the real leftover 0.135.0
  diagnostic at the unchanged binary path (now 0.154.0).
- Audit: three rounds with the same independent reviewer (`xai/grok-4.6`),
  FAIL → FAIL → PASS; synthesis in `050_revalidation.md`.

## What did not improve (LOOP-PESSIMIST-01)

- The installed proxy (2.50.0) still ships the old behaviour; this machine's warning
  clears only for a build that includes this branch.
- The four environmental test failures are untouched — they are not this unit's,
  but they are also nobody's right now.
- The Astra card question is narrowed, not answered: bundled and pin both carry
  `availability_nux: null` for `gpt-6-astra`, so if upstream ships copy at all it
  lives on the account roster endpoint. If the probe shows nothing there either,
  the honest answer to #4213 is that upstream has not shipped the copy.

## Next

- Push + PR to `dev` — needs explicit user approval (DEV-GIT-PUSH-01). PR text must
  fill the template; no GUI surface changed, so no screenshot obligation.
- The account-roster probe (Phase 3 re-plan trigger) — user-authorized token only.
- A summary comment on #4213 with the catalog-field evidence — offered, not requested.
