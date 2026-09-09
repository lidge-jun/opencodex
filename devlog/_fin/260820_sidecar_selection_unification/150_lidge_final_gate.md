# 150 — lidge final aggregate/release gate

The final AGGREGATE gate before release. It does not replace per-merge gating: docs
110/120 keep approval + required CI blocking for every individual merge; 'lagging
indicator' covers only repair iterations between pushes. At the final dev head:

- lidge: OCX_TEST_NO_QUEUE=1 bun run test — full suite green (baseline 13808+/0 at L9).
- Local: bun run typecheck, bun run privacy:scan, bun run lint:gui, lint:i18n, GUI
  tests, bun run build:gui, and the docs-site build (doc 130 touches GUI and
  localized copy, so the full GUI/i18n/docs chain is in the gate).
- GitHub Actions: final dev head green on Linux/Windows/macOS (Windows gate is a
  standing release requirement).
- Live probes through the running proxy: OAuth chat default turn, opt-in Responses
  turn (no caller service_tier upstream), x_search opt-in turn, exa sidecar turn,
  reasoning-streaming E2E (doc 100 matrix).
- Release staged on lidge per release-train conventions; promotion remains
  maintainer-controlled.
