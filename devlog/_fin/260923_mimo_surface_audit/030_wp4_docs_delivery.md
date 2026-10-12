# wp4 — docs and delivery (diff-level)

1. English `docs-site/src/content/docs/guides/providers.md`:
   - C-DOC-01: the Anthropic-compatible example names the `xiaomi` preset and points to `xiaomi-mimo` for Chat.
   - Command Code paragraph: MiMo markup handling covers the whole MiMo family.
   - Xiaomi preset text states the V2.6 defaults and the 2026-10-21 V2.5 deprecation.
2. `reference/adapters.md` (C-DOC-03): restoration only after a clean stop/tool-call finish; abnormal finishes leave text.
3. Seven locales (fr, ja, ko, ru, tr, zh-cn, zh-tw) `guides/providers.md`: C-DOC-01 sentence and the current Command Code
   paragraph (C-DOC-02) translated from the English source; one locale per worker, token parity checked by main
   (`commandcode`, `command-code`, `claude-*`, `/provider/v1/messages`, `/alpha/generate`, preset ids).
4. `structure/providers-and-adapters.md`: MiMo gate wording; `structure/` owners reviewed by `bun run structure:check`.
5. Delivery: gates (focused suites of wp2-wp4, typecheck, layout, file-size ratchet, structure:check, privacy:scan,
   `git diff --check`), PR to `dev` with the template, exact-head CI, squash merge, verify on `origin/dev`.
