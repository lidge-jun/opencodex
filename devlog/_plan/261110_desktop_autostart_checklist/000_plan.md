# Desktop startup checklist

The Home and SetupHub checklists currently describe CLI startup even when Desktop supervises the proxy. This unit will give both surfaces the same Desktop-specific step and retain the existing browser-service step. The login control remains in the app's existing tray menu; the Startup page describes its state and directs the user there.

- Archetype: satisfy specification. Trigger: owner report of a perpetually incomplete desktop checklist.
- Goal: show correct login-at-startup copy, completion and destination in both screens; preserve non-Desktop behavior.
- Non-goals: change runtime startup, registration, authentication, dependencies or CI policy; no lane=all dispatch.
- Stop: merged PR with exact-head independent review and the user's requested evidence; report unmet gates without calling them passed.
- Artifact: this unit and focused test receipts. Outcome: DONE only after merge, otherwise report actual blocker or unfinished work.
- Escalation: unexpected security or compatibility changes, missing authorization or unavailable required independent review.
- Scope: this checkout, repository PR and explicitly requested screenshot assets; user specified no time or token limit.

## Evidence and candidate decisions (pending architect consultation)

- `gui/src/pages/Home.tsx` and `gui/src/pages/SetupHub.tsx` both call `startupChecklistDone`, but each uses browser-only copy and Startup navigation.
- `src/service/desktop-startup.ts` derives `viable` only from desktop ownership/supervision, enabled login, and running supervision; a login registration alone does not establish proxy supervision.
- `gui/src/pages/startup-sections.tsx` shows desktop status and existing guidance directs the user to the OpenCodex menu. The GUI itself has no established equivalent toggle in that section.
- `gui/tests/startup-checklist-refresh.test.tsx` exercises both consumers and stale refresh, including synthetic desktop data that needs careful reconciliation with the new contract.

## Candidate file map and proof

- MODIFY `gui/src/startup-health-ui.ts` or a small sibling: one shared derived checklist definition for desktop detection, tri-state completion, copy keys and destination. Treat stale or unconfirmed diagnostics as unknown; do not allow service/shim evidence to certify Desktop login. Preserve existing browser path exactly.
- MODIFY Home and SetupHub to use that shared definition and navigate to the existing Startup desktop guidance. Determine how to reach the relevant section from the real routing implementation before finalizing.
- MODIFY `gui/src/i18n/shell-v2-copy.ts`: two Desktop strings for all 11 locales, consistent with existing Start at Login terminology.
- MODIFY `gui/tests/startup-checklist-refresh.test.tsx` or add a GUI test alongside it: both pages, desktop viable, disabled, unverified and stale, browser service/shim states, labels and click destination. Run failing tests against unchanged dev before implementation and preserve output.
- Assess `docs-site` and `structure` ownership, updating the applicable source of truth if behavior documentation needs it.
- Run focused tests, GUI suite, `bun run lint:gui`, `bun run typecheck`, `bun run build:gui`, GUI i18n lint, locale parity, file-size ratchet and test-layout guards. Capture real rendered desktop on/off and browser views and attach as PR assets outside the change branch.
- Create templated PR to dev, record maintainer judgment, obtain fresh independent final-head review and inspect actual CI failures at final head; merge per owner instruction without waiting for pending CI or CodeQL. If dev conflicts, merge dev and repeat review.

Verifier baseline and detailed boundary cases, architect decisions and audit dispositions are pending.

## Baseline evidence

On the unchanged source at `05d517e96038cb84fa63e2b2aa4f236385d01261`, after `cd gui && bun install --frozen-lockfile`, `bun test tests/startup-checklist-refresh.test.tsx tests/locale-parity.test.ts` exited 0: 10 pass, 0 fail, 140 assertions. This establishes the existing refresh and locale checks only; it is not the requested red-first regression. The first attempt failed to load React because GUI dependencies were absent; the lockfile install resolved that environment issue.

`deriveDesktopStartup` computes `viable` from ownership or supervisor, `loginEnabled`, and `running`, so enabled login alone is insufficient when supervision is known to have failed. `diagnosticStale`, unknown login and unknown supervision require distinct tests; a stale service/shim reading must not silently count as Desktop login. The Startup page's current desktop card has no toggle; tray menu guidance is the existing action path. Confirm the route and visible guidance in rendered tests.

The Startup route currently mounts `<Startup ... />` from `gui/src/App.tsx` without a subpath prop. The desktop option is rendered by `gui/src/pages/startup-sections.tsx` as an `OptionCard` with `data-option="desktop"`; its surrounding Startup status supplies the menu guidance when appropriate. A plan that claims a direct section destination must implement and test actual focus/scroll or equivalent navigation, including asynchronous health loading, rather than merely pass an ignored subpath. If using the existing Startup page as the destination, verify that the correct desktop status and menu guidance are visible in the targeted scenario.

Platform constraint: `docs-site/src/content/docs/guides/desktop-app.md:173-177` says Windows can identify supervision but cannot verify Start at Login, so it earns no startup-protection credit. A Windows Desktop fixture must remain unknown and must not infer login success from running supervision; the PR's Windows/macOS judgment must name that limitation.

Baseline guard: after root `bun install --frozen-lockfile`, `bun test tests/ci-workflows/file-size-ratchet.test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts` exited 0 with 38 pass, 0 fail. These guards read the repository and test inventory; rerun them against the completed change if affected.

## Required regression matrix

| Environment and evidence | Completion | Expected copy and route |
| --- | --- | --- |
| Desktop owned/supervised, fresh, viable | true | Desktop login copy; Startup desktop guidance |
| Desktop owned/supervised, fresh, login disabled | false | Desktop login copy; Startup desktop guidance |
| Desktop, login unknown or supervision uncertain | undefined | Desktop login copy; Startup desktop guidance |
| Desktop, stale diagnostics | undefined | Desktop login copy; Startup desktop guidance |
| macOS Desktop, login enabled but supervision fails (any routing kind) | false | Desktop login copy; Startup desktop card with reopen guidance |
| Linux Desktop, login enabled or missing, app closed | undefined | Desktop login copy and hint; Startup desktop guidance |
| Windows Desktop with login unverified | undefined | Desktop login copy; Startup desktop guidance |
| Non-Desktop, installed service/shim or protection | unchanged existing boolean | Existing autostart copy and Startup route |
| Non-Desktop without protection | false | Existing autostart copy and Startup route |
| No payload | undefined | Do not fabricate a completed state |

Exercise both Home and SetupHub independently, including click destination. Keep existing stale-refresh and target-change tests valid with realistic payloads; only change their assertions to reflect intentional copy/state contract changes, not to hide failures.

Rendered Home hides the entire checklist when all three steps are complete (`Home.tsx` allDone branch); tests and screenshots asserting the third step in the enabled case must leave another step incomplete, or separately assert the all-done summary. SetupHub retains its rows and uses absent badges for unknown. Verify both without changing this existing behavior.

Verified architect observation: `gui/src/app-routing.ts:177-191` does not allow a Startup subpath in `hashBelongsToPage`; `gui/src/use-app-route-state.ts:55-63` documents that such a path is normalized away unless explicitly accepted. A deep link therefore also needs a routing contract test, refresh/back-forward behavior, and a Startup-side scroll/focus test after diagnostics render.

## Executable plan (diff level, reconciled after architect reflection)

Decisions:

- D1 Desktop detection comes from the health payload: `desktopManagesStartup(data)` (`gui/src/startup-health-ui.ts:11`). Neither `startupDesktopContext` (it requires opencodex-local routing) nor the user agent decides it, because a Desktop window can show a connected target whose proxy the app does not manage; that target keeps the browser step.
- D2 Desktop completion, composed from existing predicates, in order: no payload or `diagnosticStale === true` gives undefined; `desktop.viable === true` gives true; `desktop.loginState === "disabled"`, or a confirmed supervision failure on `platform === "darwin"` (the only platform whose login evidence is verified), gives false. The failure test is routing independent: `desktop.running === false && desktop.viable === false && desktop.supervisionUnknown !== true`, because `desktopSupervisionFailed` also requires opencodex-local routing and would leave a Desktop proxy with native routing undefined forever (audit blocker 1); only proven-absent macOS shapes reach it (no LaunchAgent with a matching install id, `src/service/desktop-startup.ts:207-212`, or a confirmed missing supervisor); unreadable evidence carries `supervisionUnknown: true` and stays undefined, so the arm must never be simplified to `!viable`. The ownership-only placeholder (`src/server/startup-health-cache.ts:104-123`) is marked `diagnosticStale: true` and is caught first. A missing `platform` counts as not darwin; anything else gives undefined. On Windows an owned claim with a mismatched install id or unreadable evidence reports `running: false` without `supervisionUnknown` (`src/service/desktop-startup.ts:388-405`), so the failure arm must not run there. Linux never reports `loginState: "disabled"` for a missing autostart entry (`src/service/desktop-startup.ts:289-291`), so Linux Desktop stays undefined unless viable; making it countable needs a backend change outside this lane. `viable` already folds login and supervision (`src/service/desktop-startup.ts:30-33`), so there is no separate enabled-and-running arm. Windows never verifies login (`src/service/desktop-startup.ts:377-405`), so it stays undefined as the owner asked; this matches today's unverified result. Service or shim evidence never completes the Desktop step, including a Desktop proxy with native or custom routing.
- D3 Browser completion delegates to `startupChecklistDone` unchanged; copy and `navigate("startup")` unchanged. The checklist body type gains `platform?: string` and the hook derives its body type from `startupChecklistStep`.
- D4 No in-place toggle. Start at Login is changed only from the app's tray menu (`desktop/src-tauri/src/tray_login.rs`); the loopback dashboard has no Tauri permission to change it (`desktop/src-tauri/capabilities/dashboard-titlebar.json`), and a dashboard toggle would duplicate `login_registration::judge` on a remote origin. The destination is the Startup page's Desktop card.
- D5 Copy: two new rows authored per locale as action phrases built from that locale's existing Start at Login term (the bare term appears in `startup.desktopRecovery`/`startup.loginUnverifiedAction` prose; badge keys are not reused). Title, e.g. en "Turn on Start at Login", ko "로그인 시 시작 켜기". Hint names the OpenCodex app menu, says "make sure it is checked", and says the app then opens at login and keeps the proxy running; it is machine neutral and promises no startup-safety credit.
- D6 Unknown Desktop presentation: completion stays undefined, but Home shows the Desktop hint when `startup.data` is loaded, `step.desktop === true` and `step.done === undefined` (Home otherwise shows hints only for `false`), so a Windows row explains where to look. SetupHub already shows every hint. The denominator is unchanged.
- D8 Destination content: when the Desktop card is neither viable nor running and the reading is fresh, the card body renders the existing `startup.desktopReopenRecovery` ("Reopen OpenCodex and check Start at Login.") instead of nothing (`gui/src/pages/startup-sections.tsx:162-164`), so the focused card carries its action. It never renders while `failed` is true. Both pages mark the step row with `data-step="autostart"` so tests select it without depending on copy.
- D7 Deep link `#startup/desktop`: `hashBelongsToPage` accepts it. A Startup-side hook listens to `hashchange` and to the Desktop card's render; on each arrival at that hash it scrolls the card into view (smooth unless reduced motion) and focuses it with `preventScroll`, setting `tabIndex = -1` imperatively. It fires once per arrival, ignores polls and stale refreshes, does nothing without a Desktop card, and never rewrites history. This is the v2 router only; the classic dashboard has no Home or SetupHub checklist.

Files:

- MODIFY `gui/src/startup-health-ui.ts`: add `startupChecklistStep(data)` returning `{ desktop, done, titleKey, hintKey, subPath }` beside `startupChecklistDone`.
- MODIFY `gui/src/pages/Home.tsx`, `gui/src/pages/SetupHub.tsx`: consume it; `navigate("startup", step.subPath)`; Home D6 hint.
- MODIFY `gui/src/app-routing.ts`: accept `startup/desktop`.
- ADD `gui/src/pages/startup-desktop-focus.ts`; wire from `gui/src/pages/Startup.tsx`.
- MODIFY `gui/src/i18n/shell-v2-copy.ts`: two rows, 11 columns.
- MODIFY `gui/src/pages/startup-sections.tsx`: D8.
- ADD `gui/tests/startup-checklist-desktop.test.tsx`: predicate table, both pages with realistic Desktop payloads (viable, disabled, unknown, stale, macOS supervision failed with opencodex-local routing gives false, the same evidence with native routing gives undefined, Windows supervisor-only and Windows owned with running false give undefined, Linux without autostart gives undefined, Desktop plus shim/service is never true), browser payloads, click destinations, routing acceptance, Startup focus (cold load after data, hashchange while on Startup, no card no-op, poll does not refocus). No layout registration: `gui/tests` is outside the root inventory.
- MODIFY `gui/tests/startup-checklist-refresh.test.tsx`: split fixtures into browser and Desktop sets; change assertions only where the contract changed.
- MODIFY `structure/gui-and-management-api.md` Startup safety paragraph and `docs-site/src/content/docs/guides/desktop-app.md` (one English sentence).

Acceptance:

- A1 New tests fail on unchanged source and pass after the change; red output recorded below.
- A2 Browser payloads keep the same title, hint, completion and destination.
- A3 `cd gui && bun ../scripts/test-with-pinned-bun.ts --isolate tests/startup-checklist-desktop.test.tsx tests/startup-checklist-refresh.test.tsx tests/startup-minimal.test.tsx tests/startup-revisit-cache.test.tsx tests/startup-install-result-reconciliation.test.tsx tests/i18n-locales.test.ts tests/locale-parity.test.ts tests/dashboard-tabs.test.ts tests/providers-hash-history.test.tsx tests/codex-set-shell.test.tsx`; `bun run test -- tests/gui/startup-health-ui.test.ts tests/gui/routing-intelligence-ui.test.ts tests/ci-workflows/file-size-ratchet.test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts`; `bun run lint:gui`; `bun run typecheck` (root; GUI types ride on `bun run build:gui`'s `tsc -b`); `bun run build:gui`; `bun run structure:check`; `bun run privacy:scan`; `cd docs-site && bun install --frozen-lockfile && bun run build`. All exit 0. Localized desktop-app guides stay untouched; the English sentence adds guidance without contradicting them.
- A4 Screenshots of Desktop on, Desktop off and browser states attached through `pr-assets`.

## Architect consultation (hyds/deepseek-v4.1-flash-free)

Proposal (task desktop-checklist-architect-hyds-2): approve-with-changes. Accepted: compose from existing predicates, keep `desktopManagesStartup`, hashchange-driven one-shot focus, menu-named machine-neutral copy, fixture split, structure/docs updates, no toggle. Windows: completion stays undefined per owner; presentation fixed by D6.

Reflection (same thread, run 2): not-ready because D2 and the file list contradicted the dispositions, D5 pointed at badge keys, and the Windows row had no explanation. All three are reconciled above, plus `--isolate` and the GUI typecheck note in A3.

Reflection (run 3): not-ready because the supervision-failure arm would return false on Windows and Linux could never return false. Adopted as proposed: failure arm gated on darwin, Windows and Linux stay undefined with the limitation stated in the PR, matrix rows carry the routing kind, and D8 gives the focused card its action. No other objections remained on D1, D3-D7, files or acceptance.

## Audit (A)

Reviewer hyds/deepseek-v4.1-flash-free (task desktop-checklist-audit-a1): GO-WITH-FIXES (blockers=2). Folded: (1) routing-independent supervision-failure arm in D2; (2) A3 uses the pinned runner. Also folded: platform in the body type, named consumer and routing tests, `data-step` selector, matrix rows for macOS and Linux, docs-site build, v2-only note, D6 guard, browser arm delegates to `startupChecklistDone`, D8 hidden while failed. A mistral fallback audit was cancelled after the primary finished. The D2 change goes to the architect for reflection.

Architect recheck (run 4): ALIGNED with the routing-independent arm; its guard notes are folded into D2. Main judgment: near-pass. Both High blockers folded, no residual blockers.

## Evidence

- Red on unchanged source `05d517e960`: `cd gui && bun ../scripts/test-with-pinned-bun.ts --isolate tests/startup-checklist-desktop.test.tsx` exited 1 with 17 fail and 3 pass. The three passes are the do-nothing cases (no reading yet, no Desktop card, plain `#startup`). The browser cases fail only on the new `data-step` selector; their copy, completion and destination already matched.
- Green after the change: the same file 20 pass; the A3 GUI set 100 pass across 10 files; root set 70 pass across 5 files; `bun run test:changed` 322 pass; lint, typecheck, `build:gui` (`tsc -b`), `structure:check`, `privacy:scan` and the docs-site build exit 0. After rebasing onto `fdcf20b74c` the core GUI set (60 pass) and typecheck were rerun.
- The refresh test's fixtures were split: browser readings keep the original assertions; Desktop readings run the same refresh cases with Desktop copy, and their stale stage expects the hint (D6).
- Rendered with headless Chrome against a mocked API serving `gui/dist`: Desktop on, Desktop off, browser, Set up hub and the focused Desktop card on `#startup/desktop`. Uploaded to `pr-assets` under `desktop-autostart-checklist-261110/`.
