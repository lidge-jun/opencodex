# Design Read — provider accounts and rail

```yaml
---
name: opencodex-provider-workspace
colors:
  primary: "var(--text)"
  accent: "var(--accent)"
  background: "var(--bg)"
typography:
  heading: { fontFamily: "var(--font-ui)", fontSize: "var(--text-title)" }
  body: { fontFamily: "var(--font-ui)", fontSize: "var(--text-body)" }
iconography:
  system: "existing gui/src/icons.tsx outline layer"
  weight: "existing 2px currentColor"
  domain: "existing provider brand SVG/image layer"
---
```

Reading this as: a desktop-first developer operations console for repeated provider and account management, using OpenCodex's existing monochrome OpenAI-like product grammar. The defining behavior is not decoration: account identity becomes a first-class tab, and each rail row reads as one coherent status object.

- Do: preserve brand assets, semantic colors, 4px spacing, compact controls, obvious active/pending/error state, and short Korean labels.
- Do not: add card stacks, gradients, glass panels, new icon packages, raw IDs, horizontal account-pill overflow, or motion beyond feedback.

## Dials

- `DESIGN_VARIANCE: 2`
- `MOTION_INTENSITY: 1`
- `Product density profile: D6`
- Reasoning: this is an authentication-adjacent repeated-work console; stable hierarchy and low-motion scanning are more valuable than novelty.

## Concept-generation decision

Skipped under `UX-CONCEPT-GEN-01`: the repository already has a governing design system and this is a utility dashboard repair. No brand-visible composition remains unresolved enough to justify generated mockups.

## Information architecture

### Detail tabs

- Existing: Overview / Models / Usage / Settings.
- After: Overview / Models / Usage / Accounts (or API keys for key-auth providers) / Settings.
- The tab appears only when the provider has an actual auth-management surface.
- Canonical OpenAI forward provider owns Codex App/pool accounts. Other forward-shaped custom providers must not embed the Codex account pool.
- Settings keeps configuration only; auth management is removed from the Settings panel to avoid duplication.

### Account panel

- 0 accounts: no empty selector chrome; explain the state and show Login/Add account.
- 1 account: one static/selectable row with visible Active or Re-auth state; no fake disclosure chevron.
- 2+ accounts: vertically scannable single-select rows. The active row remains focusable and announced as selected; it is not removed from keyboard navigation by `disabled`.
- Switching: preserve the old active row, mark only the target pending, block duplicate mutations, and announce status.
- Failure: keep old active selection, show a local retryable error, and restore controls.
- Overflow: the account panel scrolls within its content boundary only when the list exceeds the practical panel height; no nested account tabs.
- Management: Add, Remove, and Re-auth remain separate actions; remove is never nested inside a select option button.

## Tab accessibility contract

- `role=tablist`; each tab has stable `id`, `aria-controls`, `aria-selected`, and roving `tabIndex`.
- Arrow Left/Right move and activate; Home/End jump; Tab enters the selected panel.
- Each visible body is `role=tabpanel`, has matching `id`/`aria-labelledby`, and receives focus only when programmatically needed.
- Success uses `role=status`; failures use `role=alert`; status is not color-only.

## Provider rail contract

```text
[brand icon] [provider name ................] [default star] [status dot]
             [N models] · [rare config id] [Free/Local exception]
```

- Remove the rail-local duplicate page title and Add button; the page header already owns both.
- Group headings use sentence-case label plus separately styled count, not an uppercase raw string such as `READY (8)`.
- Name owns `minmax(0, 1fr)` and ellipsis. Secondary metadata is one line with controlled truncation.
- Readiness text stays in the status-group heading and localized button name/title; the 8px dot is empty and `aria-hidden`, avoiding the original raw-text leak. Model count moves out of its own fixed right column.
- Desktop split-pane navigation does not require a decorative chevron; retain it only when the layout acts as drill-in navigation.
- Fix undefined `--fg`/`--fg-muted` workspace values to the existing `--text`/`--muted` tokens and replace raw visual values touched by the patch with semantic tokens.

## Responsive composition

- Wide desktop: rail 280px, detail `minmax(0,1fr)` and max 800px.
- Constrained desktop/split view: a shell-local container query collapses rail/detail below the measured usable split threshold; detail overview becomes one column before text wraps into machine-like fragments.
- At the existing app mobile boundary, rail becomes a bounded top list and detail becomes the next block; touch controls use the existing 44px contract.
- Test effective CSS widths around 1440, 1024, 768, 390, and 320; the browser capability's actual `documentElement.clientWidth` is recorded with screenshots.

## Korean copy decisions

- `계정`, `계정 추가`, `다시 시도`, `전환 중…`, `계정을 불러오지 못했어요` use short B2B/ops wording.
- No account label falls back to a raw ID. Use a localized ordinal such as `계정 2` / `Account 2`.
- Long masked emails and provider names ellipsize visually while retaining an accessible/title full label.
