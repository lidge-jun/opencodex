# Delivery procedure

Not a work-phase — delivery is not independently implementable, and modelling it as one
was audit blocker 8. This is the checklist each phase runs at its own C/D.

## Shape: one PR, no stack

```
codex/meta-model-api-provider   -> PR 1 (base: dev)   wp1
```

The first draft stacked two layers, then briefly claimed two independent PRs. Both were
wrong. wp2 closed as a `NOOP` negative (`020`) and ships no code, so there is one PR —
and with it, no cascade, no merge order, and no shared-constant coupling to reason
about. Branch from the current `origin/dev` tip; `dev` moved during the audit rounds.

## Per-layer gate

1. `git push --no-verify` (standing user instruction).
2. PR body fills every `.github/PULL_REQUEST_TEMPLATE.md` section. No GUI change, so
   no screenshot is required.
3. Wait for the workflow runs on the **exact head SHA** — not the branch, the SHA.
   `Cross-platform CI` plus `React Doctor`, and CodeRabbit's status.
4. Read CodeRabbit's findings. Fix anything materially wrong; record and rebut
   anything that is not. A cosmetic nit does not block the merge.
5. Admin-merge (squash), pre-authorized by the user.
6. **No cascade.** One branch on `dev`. If `dev` moves under the open PR, rebase and
   `git push --force-with-lease` — never a bare `--force`.

## Verification budget

The canonical gate for this unit, in order:

```bash
bun test tests/meta-model-api-provider.test.ts tests/provider-registry-parity.test.ts tests/usage-cost.test.ts
bun run test:changed
bun x tsc --noEmit
bun run privacy:scan
cd docs-site && bun install --frozen-lockfile && bun run build
```

The last line applies because the touch set includes `docs-site/`;
`docs-site/AGENTS.md` treats that build as the documentation gate. `privacy:scan` runs
because the change ships credential guidance.

`test:changed` is required rather than optional: `src/AGENTS.md:26` calls for it once a
touch set is broader than one file, and this one spans the registry, the price overlays,
and two test files. It follows Bun's import graph, so it is **not** the forbidden
repository-wide run.

CI remains the full gate. If a focused run cannot cover an indirect dependency (a
subprocess, a golden file), name it in the PR's Verification section and let CI carry it
rather than reaching for the full suite.

## Terminal outcomes

- wp1 `DONE` when PR 1 is green at its head SHA and merged, and the registry serves
  `meta-model/muse-spark-1.3` and `meta-model/muse-spark-1.3-contributor` without
  capturing the existing `meta/…` Command Code selectors.
- wp2 `NOOP` — closed by a licence finding, with no code to deliver (`020`).
