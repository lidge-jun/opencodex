# wp5 — make the local gates agree with CI

`bun run doctor:gui` exits 1 on `dev`. It is part of `prepush`
(`package.json` `"prepush"`), so every gui-touching push needs `--no-verify` to get
through. A gate everyone routinely bypasses is not a gate.

## The finding

Both reported issues are the same line:

```
2 issues
Bugs: 2 warnings
  Missing effect dependencies  react-hooks/exhaustive-deps      src/pages/Models.tsx:498
  Missing effect dependencies  react-doctor/exhaustive-deps     src/pages/Models.tsx:498
```

The omission is deliberate. `gui/src/pages/Models.tsx:509-513` explains it: the effect
calls `loadPresets` and `loadModelDiscovery`, which are plain async loaders rather than
`useCallback`s, a `useCallback` wrapper trips PreserveManualMemo, and the effect only
ever needs the current closure.

The suppression comments name `react/react-compiler` and eslint's
`react-hooks/exhaustive-deps`. Neither silences oxlint's own
`react-hooks(exhaustive-deps)` nor react-doctor's `react-doctor/exhaustive-deps`,
which is why the same intentional exception is reported twice and fails the gate.

## Options, in order of preference

1. **Add the matching suppressions.** Extend the existing comment block with the two
   rule ids actually being reported. Smallest change, preserves the documented
   reasoning, and makes `prepush` pass without `--no-verify`.
2. **Satisfy the rule.** Wrap both loaders in `useCallback` and add them to the dep
   array. Rejected by the in-file note as tripping PreserveManualMemo — verify that
   claim before choosing this, since it was written for the eslint rule and may not
   hold for oxlint.
3. **Change `doctor.config.json` blocking from `warning` to `error`.** Rejected: that
   silences every future warning, not this one, and `scripts/doctor-gui-if-changed.ts`
   documents `blocking: "warning"` as the intended contract.

Take option 1 unless option 2 proves clean.

## Why CI passes while local fails

`gui/package.json` runs doctor with `--scope changed --base origin/main`. In CI the
changed set is the PR's diff; locally on `dev` it is the whole 254-commit,
551-file range, so the local run inspects far more than CI ever does. That asymmetry is
worth recording even after the warning is fixed: a green `react-doctor` check on a PR
does not mean `bun run doctor:gui` is clean on `dev`.

## Verification

- `bun run lint:gui` — exit 0, and confirm the warning count drops to 0
- `bun run doctor:gui` — exit 0
- `cd gui && bun run build` — success
