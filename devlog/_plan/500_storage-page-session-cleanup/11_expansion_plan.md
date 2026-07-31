# Expansion plan — jawdev-style decade sub-docs

The first cycle scaffolded 00/10/20/30/40/50. They are too thin for jawdev
convention (cf. 143_kiro-gateway-parity: 20 files, each phase = Problem → target
shape → source shape → diff-level Plan with file:line anchors → verification).
This cycle expands each phase into granular sub-numbered docs. Still doc-only.

## New file set (decade sub-numbering)

| File | Expands | Content |
|---|---|---|
| `21_storage-scanner-module.md` | 20 structure | New scanner module spec: bucket model, fs.stat walk, sqlite ro-count, output type |
| `31_phase1_api-endpoint.md` | 30 phase1 | `GET /api/storage` diff-level against src/server.ts (beside /api/usage L1671) |
| `32_phase1_gui-page.md` | 30 phase1 | `Storage.tsx` + App.tsx nav wiring (Page union, VALID_PAGES, NAV, i18n TKey) |
| `33_phase1_tests-fixtures.md` | 30 phase1 | fixture CODEX_HOME builder + unit tests + read-only assertion |
| `41_phase2_deletion-data-model.md` | 40 phase2 | full delete reconciliation: jsonl + threads row + manifest + lock |
| `42_phase2_quarantine-restore.md` | 40 phase2 | quarantine dir layout, move semantics, restore round-trip |
| `51_phase3_policy-engine.md` | 50 phase3 | policy schema, evaluation loop, scheduler hook, freed-bytes report |
| `90_open-questions.md` | epic-wide | consolidated decisions/open-questions log |
| `95_verification-matrix.md` | epic-wide | per-phase verification matrix + risk tiers |

## Anchors confirmed (for diff-level accuracy)

- `src/codex-paths.ts:25` exports `CODEX_HOME`; only config-path consts today
  (no sessions/state/log path helpers) → scanner adds its own path derivations.
- `src/server.ts:1671` `/api/usage` GET is the closest sibling pattern
  (parseRange → jsonResponse(summarize…) with a try/catch fallback envelope).
- `gui/src/App.tsx`: `Page` union (L15), `VALID_PAGES` (L18), `NAV` array (L28),
  page imports (L2-8), i18n `TKey` nav labels → all need a `storage` entry.
- `state_5.sqlite` `threads.rollout_path` + `archived` is the JOIN key (20 doc).

## Scope / discipline

- Doc-only. Zero src/gui code. Atomic commit.
- Each new doc carries: Problem, target shape, source shape (file:line),
  diff-level plan, verification, open questions — matching 143's granularity.
