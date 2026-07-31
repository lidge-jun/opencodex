# WP10 - Narrow-screen question-mark cleanup

## Loop spec

- Archetype: spec-satisfaction repair.
- Trigger: the supplied narrow landing-header capture exposes a literal `?` help glyph from the embedded GUI dashboard image.
- Goal: replace text question-mark help controls with the existing Lucide-style icon grammar and refresh the landing product capture so the glyph cannot leak behind the floating header.
- Non-goals: no header redesign, breakpoint rewrite, new menu behavior, new fallback, provider changes, or unrelated screenshot refresh.
- Verifier: GUI build, docs build, source assertion for hardcoded `?` help buttons, and observed narrow viewport screenshots.
- Stop: both GUI help controls use a semantic info icon; the landing capture no longer contains the question mark; builds pass; the rendered 640px-or-narrower header is clean.
- Memory artifact: this file plus `.codexclaw/evidence/260710_wp10_*`.
- Terminal outcomes: DONE, NOOP, BLOCKED, UNSAFE, NEEDS_HUMAN, BUDGET_EXHAUSTED.
- Escalation: if a clean capture requires exposing user secrets or rewriting unrelated landing assets, stop and use a sanitized local render instead.
- HOTL bounds: local repository/browser only; no credentials or external writes; write scope listed below; 45-minute wall-clock bound.

## Design read

Reading this as a dense developer-tool control embedded in an expressive docs landing page. Preserve the existing monochrome Lucide-style UI and floating header; remove the stray textual glyph rather than adding decoration.

- Do: use one semantic SVG icon, stable dimensions, accessible names, and verify the actual narrow render.
- Do not: restyle the header, add a new control, use emoji, or hide the issue with a responsive-only fallback.
- DESIGN_VARIANCE: 2
- MOTION_INTENSITY: 1
- Product density: D7

## Diff-level plan

1. MODIFY `gui/src/icons.tsx`
   - Add `IconInfo`, matching the existing shared Lucide-style SVG owner.
2. MODIFY `gui/src/pages/Dashboard.tsx`
   - Import `IconInfo` and replace the literal `?` child in the multi-agent help button.
   - Preserve click behavior, use `dash.multiAgent` as the contextual accessible name, add `aria-haspopup="dialog"`, mark the decorative SVG `aria-hidden`, and use a stable target of at least 24x24px so the control cannot reflow.
3. MODIFY `gui/src/pages/Models.tsx`
   - Apply the same icon replacement to the multi-agent help control, using `models.v2Label` as its accessible name and `aria-haspopup="dialog"`.
4. MODIFY `docs-site/src/assets/dashboard.png`
   - Refresh from a sanitized rendered GUI after the source change; no unrelated visual edits.
   - Deterministic capture fixture: run the GUI against an ephemeral loopback Bun mock API that returns only fixed synthetic health/provider/settings/sidecar/usage/v2/injection/models/diagnostics payloads. Do not contact the running user proxy or read `~/.opencodex`.
   - Capture at the existing 3200x1574 pixel dimensions in light mode after data settles. Verify dimensions/profile metadata and inspect the captured pixels; OCR/text inspection must show no standalone help `?` while preserving the expected synthetic dashboard labels.
5. CHECK
   - `rg` proves no `>?</button>` / Help-labeled literal question-mark buttons remain.
   - `bun run build:gui` and `bun run build` in `docs-site/` exit 0.
   - Browser interaction checks activate the Dashboard and Models help controls with Enter and Space respectively, observe each existing dialog, close it, and confirm focus-visible styling remains available.
   - Docs browser screenshots at 640/390/320 CSS px show no question-mark leak, overlap, or clipped title/search/menu controls.

## Activation scenario

Load the docs landing page at a CSS viewport at or below 640px where the header collapses to title + icon-only search + hamburger. Observe the header and the embedded dashboard image. The old literal question-mark glyph must be absent; both help buttons must still open their existing dialogs when invoked in the GUI.
