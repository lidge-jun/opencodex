# 040 wp4: dashboard control for context accounting

## Why

wp3 adds `contextAccounting` to config, API and CLI. The Claude Code settings page needs the same
switch so the 200k opt-in is reachable without a terminal.

## Diff

### MODIFY `gui/src/pages/claude-code-types.ts:57-59`

Add `contextAccounting: "1m" | "200k";` after `autoCompactWindow`.

### MODIFY `gui/src/pages/ClaudeCode.tsx:37` (`normalizeFirstPartyState`)

Both entry points pass through this normalizer: the session cache (`:115`) and the GET read
(`:153`). Normalize there so an older cached state (no field) and an older server agree:

```ts
function normalizeFirstPartyState(state: ClaudeCodeState): ClaudeCodeState {
  const contextAccounting = state.contextAccounting === "200k" ? "200k" : "1m";
  ...existing body, returning { ...result, contextAccounting }
}
```

Test: an older cached state object without `contextAccounting` normalizes to `"1m"` before any
network read (the normalizer is exported for the test if it is not already).

### MODIFY `gui/src/pages/claude-code-save.ts`

- `EDITABLE_KEYS` (`:10-20`): add `"contextAccounting"`.
- Save body (`:45-46`): `contextAccounting: state.contextAccounting,`.

### MODIFY `gui/src/pages/claude-code-sections.tsx` (before the auto-context row, `:117`)

```tsx
      <div className="setting-row">
        <div className="setting-label">
          <span className="title">{t("claude.contextAccounting")}</span>
          <span className="desc">{t("claude.contextAccountingDesc")}</span>
        </div>
        <div className="setting-controls">
          <Select
            value={state.contextAccounting}
            options={[
              { value: "1m", label: t("claude.contextAccounting1m") },
              { value: "200k", label: t("claude.contextAccounting200k") },
            ]}
            onChange={v => onStateChange({ ...state, contextAccounting: v === "200k" ? "200k" : "1m" })}
            label={t("claude.contextAccounting")}
            style={{ minWidth: 140 }}
            align="right"
            portal
          />
        </div>
      </div>
```

The auto-context row and compact-window row render only when `state.contextAccounting === "1m"`
(they have no effect under 200k).

### MODIFY `gui/src/pages/claude-manual-env.ts:52`

`const autoCompactActive = state.contextAccounting !== "200k" && state.autoContext && state.maxContextTokens === null;`
(state type gains `contextAccounting`).

### MODIFY 11 locale catalogs `gui/src/i18n/{en,ko,ja,zh,zh-TW,de,fr,pt,ru,tr,vi}.ts`

Four keys after `claude.autoContextInert`:

- `claude.contextAccounting`: "Context accounting"
- `claude.contextAccountingDesc`: "1M (default): models whose window can host the summarize point are offered at 1M on every Claude surface. 200k: Claude Code counts every model at 200k unless you pick a 1M row yourself."
- `claude.contextAccounting1m`: "1M (default)"
- `claude.contextAccounting200k`: "200k"

Each locale gets a translation (ko written natively; others translated, no English left in
non-English catalogs). The i18n parity test enforces identical key sets.

## Tests

- Extend `gui/tests/claude-code-save.test.ts` and `gui/tests/claude-code-types.test.ts` with: save body carries `contextAccounting`; DTO normalization maps unknown to `"1m"`; manual env omits `CLAUDE_CODE_AUTO_COMPACT_WINDOW` under 200k.
- `bun run lint:gui`, `bun run build:gui`, i18n parity (`gui/tests/i18n-locales.test.ts:44`, `gui/tests/locale-parity.test.ts:242`).

## PR evidence

`enforce-target` requires a screenshot for `gui/` changes: capture the Claude Code settings page
from an isolated dev server (`HOME`/`CODEX_HOME`/`OPENCODEX_HOME` all under a temp dir, never the
user's real homes) and upload it through the `pr-assets` branch or the description editor; never
commit it to the PR branch.
