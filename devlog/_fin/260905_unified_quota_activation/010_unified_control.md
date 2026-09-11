# Unified quota-window activation

## Loop specification

C2, one spec-satisfaction PABCD work-phase (`wp1`). Trigger: owner requested removing
the quota activation row from every account card, one all-account/both-window toggle
inside Advanced settings, and a PR with admin merge. DONE is verified UI and merged
dev ancestry. No backend/API contract, credential, worker, real account settings,
release, or service changes. Use existing GitHub credentials only for this repository;
isolated synthetic browser fixture; no paid probes or purchased credits; no token
budget specified; three-hour wall-clock reassessment. Upward escalation: main reclaims
after two distinct failed audit dispatches; downward delegation is read-only audit
and verification only. Memory: this document and the session-bound goalplan.

## Design read and necessity

Existing quiet React/Vite developer dashboard with translated copy and native `.toggle`
buttons. Preserve fonts, colors, cards and collapse mechanism; variance 2, motion 1,
density D5. No generated concepts/assets: this is an existing utility settings screen.
Do nothing leaves repetition; deleting the feature loses requested control; configuring
alone cannot change the UI. Reuse `CodexAuthAdvancedSettings`, settings API, quota
availability, existing toggle/card/feedback CSS. New API or global policy is unnecessary.
The action covers currently listed main/added accounts, not future-account inheritance.

## Concrete changes

- MODIFY `gui/src/components/CodexAccountPool.tsx`: remove card toggle props and
  display-only per-account quota settings merge. Replace per-account write handler
  with one all-account operation using the existing `{id, window, enabled}` PUT
  shape. Keep shared settings GET for Spark and quota state; block unknown state,
  provide retry after read failure, synchronous duplicate-click guard, serialize
  per-window writes and reconcile settings with GET after success or failure.
  Retain failed batch target (ON or OFF) and expose explicit Retry that recomputes
  remaining granular changes toward that same target; a partial OFF retry must never
  send ON. Failed/uncertain writes never show success; failed reconciliation leaves disabled
  unknown state with retry. Keep busy state until reconciliation finishes. Ignore
  stale reads using the mutation revision; abort on unmount/apiBase change and stop
  the remaining batch. Reuse `createBoundedFetch` for deadlines.
- NEW `gui/src/components/CodexQuotaAutoRefreshSetting.tsx`: small stateless setting
  card inside Advanced. One button, `aria-pressed` false/true/mixed, description that
  names all current accounts and both supported windows, actual warmup spending and
  pool-mode scope. Disabled while accounts/settings unknown, saving, or no eligible
  window and no enabled stale setting; show loading/error/empty/mixed feedback.
  Derived window descriptors reuse `quotaAutoRefreshAvailability` (legacy fallback)
  and authoritative account availability. Aggregate on iff all available windows
  enabled (or only stale enabled settings remain, so OFF stays reachable); mixed
  resolves toward ON. OFF clears enabled fiveHour/weekly settings even unavailable.
  Preserve server completion markers by issuing only existing granular mutations.
- MODIFY `gui/src/components/codex-account-pool-cards.tsx` and
  `gui/src/components/codex-account-pool-main-card.tsx`: remove rendered activation
  rows, their now-unused props/import, and the unreferenced controls function after
  checking all callers. Account data contract stays intact.
- MODIFY `gui/src/styles.css`: replace dead per-account row styles with minimal
  unified setting layout reusing adjacent settings conventions, with mobile wrapping.
- MODIFY all `gui/src/i18n/{locale}.ts`: new unified description, mixed, empty,
  loading-failure/partial-failure labels; retain keys still in use.
- MODIFY `gui/tests/codex-account-pool-toast-tone.test.tsx`: integration regressions
  using injected controller and mocked API: hidden advanced/no card rows; main +
  weekly-only + 5h/weekly + unsupported account coverage; on/off payloads; mixed;
  settings load failure/retry; blocked busy double-click; partial PUT failure and
  reconciliation failure/retry; stale initial response; legacy data compatibility.
  Update `gui/tests/main-account-hard-lock-setting.test.tsx` props only where removed.
- MODIFY `docs-site/src/content/docs/getting-started/how-it-works.mdx`,
  `docs-site/src/content/docs/reference/configuration/providers.md`, and
  `structure/08_openai-provider-tiers.md`: replace per-card UI instructions with the
  advanced bulk control, current supported windows, non-atomic batch/failure behavior.
  No new serialized fields/enums: creation/serialization/deserialization unchanged;
  existing PUT and GET consumers verified in `config-routes.ts:118,461,551`.

## Verification and boundaries

Baseline attempts `bun test tests/gui/quota-bars-rows.test.ts` and GUI focused tests
found missing dependencies in the fresh worktree; install frozen lockfiles before
rerunning. Direct file arguments prove target coverage. Run existing focused files
before and after; add one failing regression before production changes. Runtime quota
tests cover existing settings behavior; no changed runtime code.

PR-ready commands: root `bun run typecheck`, `bun run test`, `bun run privacy:scan`;
GUI `bun test tests`, `bun run lint`, `bun run lint:i18n`, `bun run build`; docs
`bun install --frozen-lockfile && bun run build`. Script definitions inspected in
package manifests; new commands are pending execution, not claimed as passed.
Do not rerun passing checks against unchanged code. Native browser screenshot and
keyboard click-through use synthetic data on a separate localhost port (not 10100).
Independent read-only A and C audits. One cohesive PR (not a stack); screenshot is
privacy-safe and committed under `.github/pr-assets/`. Fill the repository PR template,
record the owner-authorized admin bypass, verify exact head CI and findings, then
merge with head-match guard and prove `merge-base --is-ancestor` on fetched dev.
No enforcement is introduced; all existing auth/worker gates remain authoritative.

## Acceptance activation matrix

| Trigger | Observable result |
| --- | --- |
| Default collapsed Advanced | No per-account activation row; no visible bulk toggle |
| Expand with all off | One accessible control; click enables supported windows for all current accounts |
| All enabled | Click clears fiveHour and weekly flags, including stale unavailable ones |
| Partial existing state | `aria-pressed=mixed`; click enables remaining supported windows |
| No windows/empty account set | Disabled control with explanation, no PUT |
| Delayed/failed GET | No guessed pressed state; retry reloads confirmed settings |
| Double click during delayed PUT | One batch only; busy holds through reconciliation |
| One PUT fails | No success claim; GET reveals actual partial state; explicit Retry retains original ON/OFF intent |
| Reconciliation fails | Unknown disabled state, explicit error and retry |
| Old apiBase GET resolves after switching proxy | Scope/revision guard prevents old state or old remaining writes |
| Legacy account payload | Availability fallback works; unrelated selection-order control still works |

## Evidence

Baseline after frozen installs: 13 root quota-row tests and 30 GUI tests passed.

A1 synthesis: accepted reviewer blocker: mixed defaults ON, so partial OFF must not
use the normal toggle as retry. Root cause was conflating aggregate display with
operation intent. No conflicting requirements; add retained failed target and an
explicit retry path (including a no-ON-writes partial-OFF regression). Initial GET
cannot race a mutation while the control is unknown/disabled, so replace that
unreachable row with old-apiBase GET / in-flight batch cancellation scenarios.

B verification: failing regression first proved per-card row remained, then passed
with the unified setting. Nine new integration cases plus eight original tests pass.
Lint required extracting shared pure data functions to `gui/src/codex-quota-activation.ts`
(component-only fast refresh) and keying settings snapshots by proxy/read revision
instead of resetting React state inside an effect. No runtime/API shape changes.
The existing large pool component remains the lifecycle owner; no unrelated split.
The single PR keeps the tightly coupled UI, regressions, all locales, and docs together.

C1 synthesis: accepted reviewer stale-proxy-incarnation blocker. An A/B/A return
could match an old A snapshot before the fresh read, and failed reads lacked the
mutation revision guard. Invalidate the snapshot at the API prop boundary (guarded
React state adjustment), advance its read revision, and guard errors like successes.
Add A/B/A pending+failed GET followed by OFF-batch coverage. Existing auto-switch
controller tests also need accurate settings GET fixtures and selectors scoped to
their own `.codex-auto-switch-card`; no assertions or behavior coverage removed.

Hosted React Doctor reported only `async-await-in-loop` on the intentional settings
write sequence. Classified false positive: unlike independent reads, writes must not
dispatch the rest of a billable opt-in batch before cancellation. The deferred-write
test proves that switching proxy prevents all unsent writes. Use the existing narrow
documented suppression convention from `IntegrationsOverview.tsx:398`, not a global
rule/config change or a parallel rewrite. No runtime behavior changes in this repair.

Verified implementation: GUI full suite 1453 pass / 0 fail; focused 49 pass; import-
connected root selection 110 pass / 0 fail; root typecheck, GUI lint/i18n/build,
privacy scan and 425-page docs build passed. Root full suite was interrupted with
exit 143 and is not claimed green; exact-head hosted runtime CI is the landing gate.
Independent reviewer closed partial-OFF and A/B/A findings with PASS. Browser drove
the actual pool component with synthetic data (no live credentials/upstream), including
ON, keyboard OFF, partial failure/retry, mixed and empty states. CSS widths 320,
390, 768, approximately 1024 and 1440 show no horizontal overflow or clipped setting
copy. Light/dark screenshots checked; port 10191 and temporary browser tab torn down.
Delivery PR: #3662; administrative approval bypass explicitly authorized by the owner
and recorded on the PR. No service restart or release belongs to this unit.

C2 synthesis (hosted Codex review): accepted P2 on transiently unavailable windows.
ON must skip unavailable windows entirely, preserving previously opted-in flags;
only explicit OFF clears those flags. The final readback verifies only the targeted
available windows for ON, but every window for OFF. Updated the mixed-state regression
to preserve the unavailable opt-in and then prove explicit OFF clears it. This corrects
the earlier stale-cleanup interpretation without changing the API or worker.

C3 copy-only review closure: French now names each account's supported windows and
uses the existing Mode Groupe label; traditional and simplified Chinese explicitly
say each account's own supported windows. This avoids an intersection-of-all-accounts
reading. No behavior or Korean layout changes; validate locale lint and GUI build.
