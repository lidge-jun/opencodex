# Done: wp1

The Models tab no longer opens with a three-row card of fixed sentences. Under the subtitle there is now one line, "How changes reach Codex", folded closed, that names the real steps for the current mode: two on a standalone install (saved here -> Codex loads it on restart) and three for an `ocx connect` client (saved on hub -> synced <time> -> Codex loads it on restart). Expanded, each step explains what it means, how OpenCodex knows it or why it cannot, and the hint names the page's own Reload Codex models button. The subtitle lost the two sentences this now covers, and the save toast no longer says "hub" on installs that have none.

## Evidence

- gui `bun x tsc --noEmit -p tsconfig.app.json`: exit 0.
- gui tests: models-catalog-delivery (new, 3), models-status-toast, codex-stale-banner, i18n-locales, i18n-language-switch: 54 pass.
- root `bun test tests/ci-workflows/file-size-ratchet.test.ts tests/gui`: 439 pass. Models.tsx 2785/2792; styles.css untouched.
- `bun run lint:gui` exit 0; `bun run privacy:scan` passed.
- Render: Vite dev server proxied to :10100. Collapsed height 27px; expanded shows 2 steps + hint in en and ko; Combos tab renders no disclosure. Screenshots: evidence/ko-collapsed.png, evidence/ko-expanded.png.
- Audit: grok-4.7 reviewer PASS (no blockers); architect ALIGNED (010_architect.md).

## What did not improve

- The client-mode (3-step) branch was not observed live; this machine is standalone. It is covered by the render test only.
- Codex activation is still unverifiable from OpenCodex; the step says so instead of claiming it. Using CodexStaleBanner's app-server age to colour that step is a possible follow-up, not done here.
- Eight locales were translated by subagents and checked for key/placeholder parity and type errors, not by native readers.
