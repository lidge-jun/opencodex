# OpenCodex GUI — agent rules

## Text and i18n

- **No hardcoded visible UI text** in `src/pages`, `src/components`, `src/App.tsx`, or `src/ui.tsx`.
- Every new user-facing string goes into **all** locale files:
  - `src/i18n/en.ts` — source of truth / `TKey`
  - plus every other `src/i18n/{locale}.ts` module (discovered automatically by `bun run lint:i18n`; when adding a language, add `{locale}.ts` and wire it in `src/i18n/shared.ts`)
- Render copy with `useT()` / `t("key")` or `<Trans k="key" cmd="..." />` for `{cmd}` chips.
- **Allowed literals without i18n keys** (see `.eslint/i18n-allowlist.ts`):
  - **Company / product names** (e.g. OpenAI, Anthropic, GitHub, Codex).
  - **Model identifiers** from APIs/catalogs (e.g. `gpt-4o`, `deepseek-v4-flash-free`) when displaying provider data, not labels like "Default model".
  - **Technical / machine text** — do **not** put these in locale files:
    - CLI/shell samples (`curl …`, `export VAR=…`, `ocx claude`)
    - Content inside `<pre>` / `<code>`
    - HTTP headers, env var names, protocol field dumps (`model=…`, `thinking`)
    - Units/abbreviations next to numbers (`ms`, `k`, `1M`, cache `c`/`w`)
    - URLs / localhost endpoints, adapter ids (`oauth`, `passthrough`, npm channels)
  - Keep **code comments** (including shell `# …` comments in samples). Never strip them to “satisfy” i18n.
- Run `bun run lint:i18n` after UI copy changes; fix real violations before committing. If a hit is technical, extend the allowlist or put the string in `<pre>`/`<code>` — do not invent nonsense translation keys.


## Failure mode

Hardcoding English (or German) in JSX to “fix” a bad translation is **not** allowed. Add or fix the key in all locale files instead.
