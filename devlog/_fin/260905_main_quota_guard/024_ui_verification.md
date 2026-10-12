# UI verification checkpoint

Actual React CodexSet/CodexAccountPool components were served by the existing Vite stack against an isolated fixture API on loopback15141/15142. Settings GET/PUT used the real management handler with in-memory persistence and fixture-only quota provenance. No live account, credit, installed app or port10100 was changed.

## Observed interaction matrix

| Scenario | Observed result |
| --- | --- |
| Enable attempt, Escape | Dialog closed; focus returned to toggle; fixture PUT count remained0. |
| Confirm enable | One PUT; acknowledged enabled state; owner reloaded status. |
| Short98 / weekly100 | Monitoring, not a99% block. |
| Short99 | Main card showed blocked status; use-main action disappeared; status remained outside collapsed Advanced. |
| Manage protection on same page | Advanced opened and setting section received focus/scroll. |
| Short0 / weekly100 | Monitoring returned; configuration remained enabled. |
| Failed disable PUT | Existing enabled value retained after authoritative reload; actionable save-confirmation error. |
| Retry disable after failure | Confirmed off with other limits explicitly unchanged. |
| Settings GET failure | New toggle disabled; scoped Retry restored interaction after a valid response. |
| Successful PUT, failed account reload | Enabled stayed true; separate saved-but-status-unconfirmed notice. |
| Retry account reload | Main status updated with no additional PUT (count remained4). |
| Unknown selected usage | Main card showed usage-confirmation-needed, not a fabricated0 or a claim of availability. |
| Keyboard bounds | Cancel Shift-Tab -> Confirm; Confirm Tab -> Cancel; Escape restored toggle. |
| Responsive copy | Korean390/768/1280 CSS widths and English390/1280 inspected. Dialog remained within viewport; no horizontal overflow. |

Screenshots in022_ui_evidence contain only fixture identities. Initial80% embedded-browser zoom caused capture cropping; final captures use matched viewport/device metrics atDPR1. Temporary emulation/viewport overrides were reset and the agent-created tab was closed. Ordinary pointer interactions were checked before emulation; keyboard navigation was used for exact emulated viewports.

Teardown: verified the fixture Bun process and workspace Vite process before stopping them. No listener remains on15141 or15142. The running proxy on10100 was never targeted.

## Source and build checks

- Independent Descartes review PASS after the old-proxy completion fix; follow-up two-button focus wrap and scoped CSS also PASS.
- GUI `bun run build`, `bun run lint:i18n`, `bun run lint`: exit0 after final source/CSS changes. Existing large-bundle advisory remains.
- Docs `bun install --frozen-lockfile && bun run build`: exit0,425 pages. Existing bundle/404-entry advisory unchanged.
- No local test suite executed. New component regressions are authored for exact-head CI; all CI checks remain mandatory before merge.
- React Doctor0.9.11, run from the actual gui project against the parent branch, found no issues after expressing fallback navigation with navigateHash. No scanner rule was suppressed. Native screenshot suffixes were corrected to.jpg; the bytes are unchanged JPEGs.
- Runtime parent PR3552 atfe2e10e15: complete Cross-platform CI33930796875 succeeded, including macOS. Parent marked ready for review; no merge yet.

## Changed surfaces

MainAccountHardLockSetting: strict read/acknowledgment, bounded requests, confirmation/focus/error/retry states.
CodexSetMultiauth: one proxy-scoped controller and completion lifetime.
CodexAccountPool: local Manage action opens Advanced.
Main-card component and account hook: safe server-owned status contract and activation suppression while blocked.
styles-codex-set.css: scoped card alignment, wrapping and touch targets.
All9locale modules: matching14keys with window/zero/Reserve consequences.
English/Korean account reference: opt-in behavior, scope and recovery guidance.
New component test: state/lifecycle/cancel/focus and real-parent identity-race regression; CI execution pending.
