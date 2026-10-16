# Codex settings and Reserve consequences

Depends on wp1 (`codexMainAccountHardLock` and main hard-lock status contract).

## Design Read

```yaml
name: OpenCodex main-account quota protection
colors:
  primary: '#0d0d0d'
  accent: '#9a4a08'
  background: '#ffffff'
typography:
  heading: { fontFamily: var(--font-ui), fontSize: var(--text-body) }
  body: { fontFamily: var(--font-ui), fontSize: var(--text-body) }
iconography:
  system: existing gui/src/icons.tsx
  weight: existing
  domain: library-subset
```

Reading this as an existing developer-console settings surface, not a redesign. Reuse the current monochrome light/dark tokens, compact cards, switches and native dialogs. Amber describes a current policy block, not the mere existence of the opt-in.
Do: keep toggle peer-level with Ultra Fast, short primary label, consequence text before save, persistent main-card status.
Do not: add illustrations, a new theme, a threshold editor, a wizard, quota promises, or emoji.
DESIGN_VARIANCE 2; MOTION_INTENSITY 1; density D8. Repeated expert use needs stable controls, not expressive composition. Utility dashboard is exempt from image concept generation.

## File delta

NEW `gui/src/components/MainAccountHardLockSetting.tsx`: reuse bounded fetch and visible polling. Server state is boolean plus policy status; local state is dialog/saving/error. Load disables interaction until known. Clicking an off toggle opens confirmation WITHOUT mutation. Confirm PUTs `{codexMainAccountHardLock:true}` and accepts only `ok:true` plus explicit boolean acknowledgment. Disable saves false without an enable warning. Invalidate old GET generations on every mutation; stale GETs cannot revert success. Native dialog traps focus, Escape/cancel closes without write, and closing restores focus to switch. Save failure remains visible and retryable.

MODIFY `gui/src/pages/codex-set-multiauth.tsx`:
```diff
 <UltraFastTierSetting apiBase={apiBase} />
+<MainAccountHardLockSetting apiBase={apiBase} />
```

MODIFY `gui/src/hooks/useCodexAccountPool.ts`: extend `CodexAccountEntry` with the optional server-owned `mainAccountHardLock` status from wp1. Do not derive policy from rounded QuotaBars.
MODIFY `gui/src/components/codex-account-pool-main-card.tsx`: when enabled show blocked/unknown/monitoring text, with a named recovery action. Suppress a misleading main activation offer when blocked. Keep usage refresh and disable-setting path available.
MODIFY all discovered `gui/src/i18n/{locale}.ts`: identical key sets for title, description, confirmation title/body, enable, saved, disabled, load/save failure, blocked and unknown/monitoring status. English is source; Korean is native concise prose.
NEW scoped CSS only if current card/dialog classes cannot fit 390px, 768px, 1280px viewports. No global token changes.
NEW `gui/tests/main-account-hard-lock-setting.test.tsx`: load, explicit acknowledgment, cancel, Escape, failed save, disable and stale GET/mutation ordering. CI execution only.
MODIFY `docs-site/src/content/docs/reference/cli/providers-accounts.md` and its `ko/` counterpart. Document 99 observation gate, no inflight reservation guarantee, reserve tradeoff and separately scoped external-provider alternative. Audit other translations for contradictions; do not claim same-picker compatibility without client evidence.

## Interaction copy contract

Title: Block main account at 99% usage.
Body: Stop new main-account requests at 99% of the 5h window, or weekly usage when no 5h window exists. Monthly-only accounts use monthly usage. Added accounts and other providers remain available.
Confirmation: While blocked, this account cannot use Luna reserve either. Keeping ordinary usage below exhaustion may prevent Reserve activation. Requests already running or outside this proxy may still consume the remainder. Disable this setting to resume normal handling; upstream limits still apply.
No claim that Reserve grants other native models or that the Desktop picker has been unlocked.

## Verification

Use existing GUI scripts `bun run lint:i18n`, `bun run lint`, `bun run build`; read package definitions at P. Do not run local tests. Browser: real component against isolated fixture API; exercise off -> dialog -> cancel, confirm -> enabled, load/save failures, blocked state, disable; observe screenshots at desktop/mobile in English and Korean. Capture no real account data. CI owns component regressions. C requires clean observed render and independently reviewed state transitions.
