# 020 — GUI consent popup, post-update popup and Advanced toggle

Stack layer 3. Depends on 010 (`GET /api/telemetry`, `PUT /api/telemetry`). There is no notice-only
endpoint (060 D13).

## Behaviour

- `TelemetryConsentCard` is a native `<dialog className="modal-overlay">` mounted beside
  `<DesktopStarOnboarding />` in `gui/src/App.tsx`. It is enabled only when
  `targetsSettled && !targets.connected && sharedSessionReady && starOnboardingSettled`.
  `DesktopStarOnboarding` gains an `onSettled` callback (fired when it closes or decides it will not
  show), so the two dialogs never open together.
- It opens when the status reports an undecided install with no env override and the proxy says
  `reason === "awaiting-notice"` or `"default-on"` without a decision. That covers first run and
  installs that update into this version (they have no decision yet): the post-update popup.
- The checkbox is **pre-checked**. Continue sends `PUT /api/telemetry { decision: checked ? "accepted" :
  "declined" }` (this also records the notice server-side). Escape and the backdrop record nothing,
  and the install stays undecided for the next start (060 D13). Opening the dialog alone records
  nothing, so an unread or automated page load never enables sending. Focus is moved to the heading
  right after `showModal()`, so a stray Enter cannot press Continue.
- The card lists what is sent and what is never sent and has a "What is sent" disclosure with the
  exact preview JSON from the status endpoint.
- `TelemetrySettingsPanel` renders in Proxy details (`SettingsSection id="proxy-telemetry"` in
  `dashboard-overview-panels.tsx`, id appended to `PROXY_SECTION_IDS`) with `Switch` from `ui.tsx`,
  `readOnly` honoured for Remote Link children, and the preview dialog. With `OCX_TELEMETRY=0` or
  `DO_NOT_TRACK=1` the switch is disabled and a `Notice tone="warn"` names the variable.
  `AdvancedHub.tsx` gets `telemetry`/`privacy` search words on the proxy entry.
- The panel and card fetch on their own with `createBoundedFetch(15_000)`, outside
  `useDashboardData` (dashboard-contracts poll-wave rule).

## Files

| File | Change |
| --- | --- |
| `gui/src/telemetry-api.ts` | DTO types and fetch helpers (non-component, oxlint `only-export-components`). |
| `gui/src/components/telemetry-consent-card.tsx` | First-run / post-update dialog. |
| `gui/src/components/TelemetrySettingsPanel.tsx` | Toggle row and preview dialog. |
| `gui/src/components/desktop-star-onboarding.tsx` | `onSettled` prop. |
| `gui/src/App.tsx` | Mount the card, track `starOnboardingSettled`. |
| `gui/src/pages/dashboard-section-ids.ts`, `dashboard-overview-panels.tsx`, `AdvancedHub.tsx` | Section, panel, search words. |
| `gui/src/i18n/v2-pages/proxy-copy.ts` | All `proxyV2.telemetry*` rows in the 11-column table (en, ko, de, fr, zh, zh-TW, ru, ja, tr, vi, pt). |

No CSS is added to `gui/src/styles.css` (ratchet cap); reuse `.modal-overlay`/`.modal-card` and v2
utilities.

## Verification

- `gui/tests/telemetry-consent-card.test.tsx`: waits for star onboarding; shows only when undecided
  and no env override; checkbox pre-checked; nothing recorded on open; Continue sends accepted /
  declined; Escape records nothing; hidden once decided.
- `gui/tests/telemetry-settings-panel.test.tsx`: switch mirrors effective state, toggles via PUT,
  disabled with env notice and in read-only mode, preview dialog shows the JSON.
- `gui/tests/desktop-star-onboarding.test.tsx` extended for `onSettled`.
- `cd gui && bun test tests && bun run lint && bun run lint:i18n && bun run build`; root
  `bun run typecheck`.
- Screenshot of the card and panel for the PR description (uploaded via `pr-assets`, never committed).

