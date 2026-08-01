# 030 — Phase 3: verification (local gates + CI)

## Local gates (repo root)

```sh
bun install
bun run typecheck            # bun x tsc --noEmit
bun test --isolate ./tests/  # full suite
bun run privacy:scan         # release.ts preflight parity
cd gui && bun install --frozen-lockfile && bun run lint && bun run build
```

## CI

```sh
gh run list --branch dev --limit 3
gh run watch <run-id> --exit-status   # ci.yml for integrated dev HEAD
```

service-lifecycle.yml also fires if the WP2 push touched package.json/bun.lock
(PR 137 touches gui/package.json only — root package.json untouched until WP4 bumps).
Record every run URL + conclusion in this doc's evidence section at C.

## Accept criteria

- All local commands exit 0 (fresh output captured).
- ci.yml conclusion=success for dev HEAD SHA.
- Any failure → LOOP-REPAIR-01: fix-forward commits on dev, max 2 repair rounds
  before root-cause mode; upstream-PR-intent failures escalate NEEDS_HUMAN.

## Evidence (filled at C)

- (pending)
