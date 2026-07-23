# 060 — Cycle 6: PR #337 takeover (`codex/gui-auto-switch-threshold`)

> **DIFFLEVEL-ROADMAP-01 / loop spec — spec-satisfaction repair.** Take over
> contributor PR #337 at head `5f84301252865dc6f792d3272c2fe0db6d09eb0e`
> (`maintainerCanModify=true`) and repair the missing executable interaction
> specification without changing the feature contract. Completion means the
> controller is extracted from `CodexAccountPool`, the four async interaction
> regressions below execute through a mounted React DOM, the independent
> root-suite research artifact `061_root_suite_investigation.md` records a
> repeatable classification/disposition, and all verifiers exit 0: `bun run lint:gui`, `bun run build:gui`,
> `bun run test`, `bun run typecheck`, and `bun run privacy:scan` (plus the
> focused GUI suite). Escalate rather than broaden scope if the failures require
> release/security-boundary changes, dependencies, API/schema behavior, or files
> unrelated to the observed failures. Push repair commits to the contributor
> branch only after verification. Stop at **branch updated + green**: because
> this is a `gui/` PR, merge requires explicit owner approval and is not part of
> this cycle.

## Ground truth and constraints

- PR: `#337`, base `dev`, head `codex/gui-auto-switch-threshold`.
- Current PR footprint: 15 files, including `+343/-38` in
  `gui/src/components/CodexAccountPool.tsx`; the base file is 535 lines, so the
  PR version is approximately 840 lines.
- Existing behavior is retained: persisted threshold `0..100`, enabled input
  `1..100`, initial loading/failure/retry states, inclusive threshold copy,
  Enter/blur commit, Escape cancel, failed-write rollback, toggle restore,
  stale-refresh protection, localized feedback, and responsive styling.
- The endpoint remains `PUT /api/codex-auth/auto-switch` with
  `{ threshold: number }`; no server, config, routing, locale-copy, docs, or CSS
  semantics are redesigned in this repair.
- GUI tests are not Vitest and do not use Testing Library. `gui/package.json`
  runs `bun test tests`; `happy-dom` is already a dev dependency. Existing
  interactive tests install a `happy-dom` `Window`, set DOM globals and
  `IS_REACT_ACT_ENVIRONMENT`, mount with React 19 `createRoot`, dispatch native
  DOM events inside `act`, and unmount/restore globals in `afterEach`.
- The root `bun run test` invokes `scripts/test.ts`, which isolates HOME and runs
  only `./tests/`; therefore `bun test ./gui/tests` is an additional mandatory
  verifier and cannot be inferred from a green root suite.

## Scope

### IN

1. Mechanical extraction of the auto-switch presentation and controller from
   `CodexAccountPool` with behavior-preserving interfaces.
2. Mounted component tests for the four missing async/race scenarios.
3. Existing helper/endpoint/SSR test import updates caused by extraction.
4. English PR update describing the repair and evidence; maintainer push to the
   contributor branch.

### OUT

- New threshold behavior, API/schema/config changes, locale/docs/CSS copy or
  design changes, general `CodexAccountPool` cleanup, dependency additions, and
  unrelated test modernization.
- Release automation or security-boundary edits without explicit expansion and
  security review.
- Merge, squash, close, release, promotion to `main`, or changes to
  `claudedesktop`.

## Exact file change map

Line anchors below refer to PR head `5f843012`; re-anchor after checking out the
contributor branch, but preserve the named ownership boundaries.

### NEW `gui/src/components/CodexAutoSwitchSetting.tsx`

Move the exported `AutoSwitchSetting` JSX currently added at
`CodexAccountPool.tsx:25-156` without markup, accessibility, class-name, or copy
changes. Export these public view types beside the component:

```ts
export type AutoSwitchFeedback = { tone: "ok" | "err"; message: string } | null;

export interface CodexAutoSwitchSettingProps {
  threshold: number | null;
  draft: string;
  saving: boolean;
  loadError: boolean;
  feedback: AutoSwitchFeedback;
  onDraftChange(value: string): void;
  onEditingChange(editing: boolean): void;
  onCommit(): Promise<boolean>;
  onCancel(): void;
  onToggle(): Promise<boolean>;
  onRetry(): void;
}
```

Before: presentation, keyboard handling, blur handling, and controller state all
share the account-pool module. After: this file owns only rendering and DOM event
translation. Keep the control-group blur guard (`contains(relatedTarget)`),
composition guard, `aria-busy`, `aria-describedby`, status/alert roles,
read-only-on-save behavior, retry button, and toggle semantics byte-for-byte
equivalent. The default export is `CodexAutoSwitchSetting`; no barrel export.

### NEW `gui/src/hooks/useCodexAutoSwitch.ts`

Move all auto-switch state, refs, effects, and callbacks currently added around
`CodexAccountPool.tsx:171-279` and `:388-487` into one controller hook. It owns:

- state: confirmed threshold, draft, initial-load error, saving, feedback;
- refs: confirmed threshold, last enabled value, editing/saving flags, revision,
  deferred server value, feedback timer;
- operations: apply, queue/apply, reconcile deferred value, clear/show feedback,
  save, reject, cancel, commit, toggle, and timeout cleanup;
- read reconciliation used by the account pool's `/active` request.

Exact interface:

```ts
export interface CodexAutoSwitchController {
  threshold: number | null;
  draft: string;
  saving: boolean;
  loadError: boolean;
  feedback: AutoSwitchFeedback;
  beginServerRead(): number;
  acceptServerRead(value: unknown, startedRevision: number): void;
  rejectServerRead(): void;
  setDraft(value: string): void;
  setEditing(editing: boolean): void;
  commit(): Promise<boolean>;
  cancel(): void;
  toggle(): Promise<boolean>;
}

export function useCodexAutoSwitch(
  apiBase: string,
  messages: {
    updated: string;
    updateFailed: string;
    invalid: string;
  },
): CodexAutoSwitchController;
```

`beginServerRead()` returns the current revision before `/active` starts.
`acceptServerRead()` runs the existing `autoSwitchThresholdReadDisposition`
against that captured revision; an edit/save defers the value and a revision
mismatch ignores it. `rejectServerRead()` sets the load error only while no
confirmed threshold exists. These methods make the read/write race an explicit
controller contract while leaving the parent responsible for fetching active
account data.

Preserve these invariants exactly:

1. A write increments revision before and after the request.
2. A successful write clears deferred reads and installs its value.
3. A failed write first applies a valid deferred confirmed value, otherwise
   restores the pre-write confirmed value.
4. Enter followed by blur observes the synchronous saving ref and cannot start
   a second PUT.
5. Escape clears feedback, restores the last confirmed/deferred draft, and does
   not write.
6. Toggle-off remembers a valid dirty draft as the page-lifetime restore value;
   toggle-on writes that remembered value.
7. The 5-second feedback timer is replaced/cleared and is cleared on unmount.

Keep pure validation/planning and transport in
`gui/src/codex-auto-switch.ts`; do not duplicate or move
`normalizeAutoSwitchThreshold`, `parseEnabledAutoSwitchThreshold`,
`planAutoSwitchToggleWrite`, `autoSwitchThresholdReadDisposition`, or
`putAutoSwitchThreshold`.

### MODIFY `gui/src/components/CodexAccountPool.tsx`

Before: the approximately 840-line PR component owns account loading plus the
entire auto-switch view/controller. After: it imports
`CodexAutoSwitchSetting` and `useCodexAutoSwitch`, leaving account-pool fetching
and composition in place.

Concrete edits:

- Remove the six auto-switch imports from `../codex-auto-switch`, the
  `AutoSwitchSetting` declaration, five auto-switch `useState` calls, seven
  auto-switch refs, auto-switch feedback cleanup effect, and all controller
  callbacks.
- Construct the controller once with `apiBase` and translated messages.
- At the beginning of each `load`, call `const autoSwitchReadRevision =
  autoSwitch.beginServerRead()`.
- On a successful `/active` response, continue setting `activeId`, then call
  `autoSwitch.acceptServerRead(active.autoSwitchThreshold,
  autoSwitchReadRevision)`.
- On `/active` failure call `autoSwitch.rejectServerRead()`; preserve existing
  account and overall load-state handling.
- Pass `autoSwitch.threshold ?? 0` to both `QuotaBars` sites.
- Render `<CodexAutoSwitchSetting>` with controller fields and handlers; Retry
  remains `void load()` because it reloads the shared `/active` payload.
- Keep `load` callback dependencies stable by destructuring stable hook methods
  or memoizing the hook callbacks. The initial 50 ms load and 30-second interval
  must not be recreated on each state update.

Target after extraction: `CodexAccountPool.tsx` below 650 lines and with no
auto-switch revision/deferred-write refs. This is a containment target, not an
invitation to refactor unrelated account behavior.

### MODIFY `gui/tests/codex-account-auto-switch.test.tsx`

- Import `CodexAutoSwitchSetting` from its new component path rather than from
  `CodexAccountPool`.
- Retain all 16 pure helper, transport, validation, and static SSR cases.
- Rename the local renderer only if needed for clarity; do not rewrite these
  tests into the mounted suite.

### NEW `gui/tests/codex-auto-switch-controller.test.tsx`

Use `bun:test`, `happy-dom`, React `createRoot`, and `act`; no new package or
runner. Follow `combo-workspace-empty.test.tsx` and
`error-boundary.test.tsx` for global installation and cleanup. Mount the real
`CodexAccountPool` under `LanguageProvider`, not a reimplementation of the
hook. Provide a route-aware `globalThis.fetch` fake and deferred `Response`
promises for:

- `GET /api/codex-auth/accounts` → a minimal successful account payload;
- `GET /api/codex-auth/active` → controlled threshold payloads;
- `PUT /api/codex-auth/auto-switch` → controlled success/failure and a write
  log parsed from `RequestInit.body`.

Capture the callback registered by the component's 30-second `setInterval`
and invoke it inside `act`; this deterministically activates the production
refresh path without waiting 30 seconds. Prefer this narrow interval shim over
global fake timers because the component also has a 50 ms initial-load timeout
and a 5-second feedback timeout. If Bun fake timers are used instead, advance
only the initial 50 ms and one 30,000 ms tick, flush microtasks after every
advance, and restore real timers in `afterEach`.

Shared activation setup for every case:

1. Install `happy-dom` globals, English locale, fetch router, and interval
   capture; mount with `apiBase="http://localhost"`.
2. Complete initial account + active reads with threshold `80`; await React
   updates and assert the number input is enabled with value `80`.
3. Drive value changes with the native `HTMLInputElement.value` setter plus a
   bubbling `input` event, and drive keyboard/focus transitions with native
   `KeyboardEvent`, `focus()`, and focus on an outside button.
4. Flush the controlled promises in `act`, then assert both PUT count/body and
   rendered confirmed state. Always unmount and restore fetch/timers/globals.

Concrete executable cases:

1. **`Enter then blur issues exactly one write`.** Focus input, change `80` to
   `95`, dispatch Enter, immediately move focus outside while the PUT promise is
   unresolved, and assert one PUT `{threshold:95}`. Resolve 204; assert value
   `95`, success status, and still one PUT after microtask flush.
2. **`stale 30-second refresh cannot overwrite a successful edit`.** Invoke the
   captured interval callback and leave its `/active` response pending. Edit to
   `95`, Enter, resolve PUT 204, then resolve the older refresh with threshold
   `80`. Assert input/copy remain `95` and exactly one PUT occurred. This order
   proves revision-based ignore, rather than merely testing an editing defer.
3. **`failed write restores the last confirmed value`.** Starting from confirmed
   `80`, edit to `95`, Enter, return HTTP 500 (or reject transport), flush, and
   assert input/copy return to `80`, an alert contains the update-failed copy,
   and exactly one PUT `{threshold:95}` was attempted.
4. **`Escape cancels without writing`.** Focus input, change to `95`, dispatch
   Escape, then move focus outside to activate the real blur path. Assert draft
   returns to `80`, no PUT exists after microtask flush, and no success status
   is shown.

The test file may include small `deferred<T>()`, `flush()`, `setInputValue()`,
and fetch-router helpers local to the file. Do not export production internals
solely for testing.

### CONDITIONAL scope: root-suite findings

Root-suite reproduction, classification, and disposition live exclusively in
`061_root_suite_investigation.md`; execute that research artifact before claiming
the root gate. No root-suite fix file is pre-authorized in this document.

If 061 demonstrates a required fix that touches any path not already named in
this Cycle 6 change map, stop before build and perform a P-phase amendment to
this file. The amendment must name the exact `MODIFY` path and include the exact
before/after diff; only then may implementation begin. `scripts/release.ts`,
workflow, dependency, auth, credential, or other security/release-surface changes
remain escalation boundaries even if 061 reproduces a failure there.

## Verification and rendered observation (C-RENDER-GROUNDING-01)

Run from repository root at the final contributor-branch head:

```bash
bun test ./gui/tests/codex-account-auto-switch.test.tsx \
  ./gui/tests/codex-auto-switch-controller.test.tsx
bun test ./gui/tests
bun run lint:gui
bun run build:gui
bun run typecheck
bun run privacy:scan
bun run test
bun run test
git diff --check
```

Every command must exit 0. Record focused case counts, full GUI/root counts, and
the final SHA. `bun run build:gui` may retain the already-known large-chunk
advisory, but no new warning/error is accepted.

Rendered observation plan:

1. Build and serve the PR GUI against a local proxy with at least one Codex
   account; open the Codex account pool at 1280×720 and 390×844.
2. Read back screenshots (do not treat capture success as observation). Confirm
   the card remains aligned, 80/custom threshold text matches the input, `%` is
   visible, toggle state is truthful, no clipping/overflow occurs, and mobile
   controls stack as intended.
3. Observe initial loading and simulated load failure/retry. With the input
   focused, verify Enter saves once, Escape restores, pending save is read-only,
   success uses a status, and failure uses an alert with confirmed-value
   restoration.
4. Trigger quota refresh while editing and after a successful save; verify quota
   content can refresh but an old threshold response never replaces the saved
   value. Inspect console and network: no React warnings, duplicate PUTs, or
   failed requests except the intentionally simulated failure.
5. Store screenshot paths and concise observations in the cycle evidence; avoid
   real account identifiers in screenshots/logs.

## Commit, push, and owner gate

- Rebase/fetch-check the contributor head before editing and before push; do not
  rewrite contributor commits unnecessarily.
- Use one focused repair commit for extraction/tests. A separate root-suite fix
  commit is allowed only after 061 evidence and the required P-phase amendment
  to this file authorize its exact path/diff.
- Push to `codex/gui-auto-switch-threshold` using maintainer modification rights.
- Verify the remote head equals the local verified SHA and required Linux,
  macOS, Windows, target-enforcement, and GUI checks are green.
- Do **not** merge. Hand back for explicit owner approval because `gui/` is
  touched.

## English PR comment draft

> Maintainer takeover update: I preserved the threshold feature and API contract
> while extracting the auto-switch view/controller from `CodexAccountPool` so
> its async reconciliation rules have a focused ownership boundary. I also added
> mounted `happy-dom` interaction coverage for the four previously untested
> cases: Enter followed by blur emits one PUT, an older 30-second refresh cannot
> overwrite a successful edit, a failed PUT restores the last confirmed value,
> and Escape cancels without writing.
>
> Root-suite follow-up: `[insert the four original test names and classification]`.
> `[insert exact fix or baseline/flake evidence; do not claim fixed if it only
> passed standalone]`.
>
> Final verification at `[SHA]`: focused GUI `[counts]`; full GUI `[counts]`;
> `bun run lint:gui`, `bun run build:gui`, `bun run typecheck`,
> `bun run privacy:scan`, and two consecutive `bun run test` runs all passed.
> Render checks at 1280×720 and 390×844 confirmed loading, edit/save/cancel,
> rollback, refresh reconciliation, accessibility feedback, and responsive
> layout with no duplicate PUTs or console errors.
>
> The contributor branch is updated and green. This PR still requires explicit
> owner approval before merge because it changes `gui/`; no merge was performed.

## Acceptance checklist

- [ ] PR head revalidated and no unrelated contributor changes folded in.
- [ ] View and controller extracted; `CodexAccountPool.tsx` is below 650 lines.
- [ ] All four mounted interaction cases fail before/ pass after the repair.
- [ ] Existing 16 helper/SSR/transport tests remain green.
- [ ] `061_root_suite_investigation.md` contains the four root failure names,
      logs, classification, and evidence-backed disposition; any fix outside
      this change map was authorized by an exact-path/before-after P amendment;
      final root suite is green twice.
- [ ] Static, privacy, build, focused/full GUI, and render-grounding evidence is
      recorded at the pushed SHA.
- [ ] Contributor branch remote head and required CI are green.
- [ ] English PR comment posted with exact evidence and no unsupported claims.
- [ ] No merge performed; explicit owner approval remains pending.
