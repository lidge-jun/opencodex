# OpenCodex GUI — agent rules

## Text and i18n

- **No hardcoded visible UI text** in `src/pages`, `src/components`, `src/App.tsx`, or `src/ui.tsx`.
- Every new user-facing string goes into **all** locale files:
  - `src/i18n/en.ts` (source of truth / `TKey`)
  - `src/i18n/de.ts`
  - `src/i18n/ko.ts`
  - `src/i18n/zh.ts`
- Render copy with `useT()` / `t("key")` or `<Trans k="key" cmd="..." />` for `{cmd}` chips.
- **Allowed literals without i18n keys:**
  - **Company / product names** (e.g. OpenAI, Anthropic, GitHub, Codex) — prefer identical entries in locale files when the string is shown as UI copy.
  - **Model identifiers** from APIs/catalogs (e.g. `gpt-4o`, `deepseek-v4-flash-free`) when displaying provider data, not when writing labels like "Default model".
- Run `bun run lint:i18n` after UI copy changes; fix violations before committing.

## Failure mode

Hardcoding English (or German) in JSX to “fix” a bad translation is **not** allowed. Add or fix the key in all locale files instead.

