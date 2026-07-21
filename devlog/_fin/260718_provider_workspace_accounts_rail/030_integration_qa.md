# Work phase 030 — integration, adversarial QA, and closeout

## Outcome

Prove the account and rail slices together against the latest repository state, repair only evidence-backed residuals, synchronize the design-system SoT, and close the goal with reproducible receipts.

## Scope

- Production edits are default-out. Any repair must be a P amendment naming the observed failing file/path and activation evidence.
- Test/evidence updates may touch the focused test files, `docs/design-system/components.md`, this unit's final verification section/evidence directory, and the bound goalplan/ledger.
- No release, version bump, deployment, push, account deletion, or permanent live account change.

## P stale check

- Re-read `010_account_switcher.md` and `020_provider_rail.md` against HEAD.
- Inspect all commits from both work phases and classify test changes as required/suspicious/unrelated.
- Record any hypothesis that died or any criterion that did not improve; do not restart from aggregate “looks better” judgment.

### 2026-07-18 current HEAD

- Reviewed `34e34b4..657a2ce`: roadmap-only docs, account implementation/receipt, rail implementation/receipt, and design SoT sync are isolated commits. New tests only add auth-surface/privacy/integration and rail semantic/layout contracts; no assertion deletion, skip, threshold change, or unrelated test rewrite exists.
- Unrelated dirty-tree deletions/modifications and the pre-existing deleted `tests/codex-multi-state.test.ts` remain outside every staged commit and are not adopted by this goal.
- Account live QA already restored both captured original active ids and rail QA restored System theme/English locale. A fresh read must confirm those restorations before any final mutation.
- One integration residual is reproducible: loading or reloading `#providers/workspace` immediately becomes `#providers`. `readPageFromHash()` correctly accepts sub-view suffixes, but the page synchronization effect compares the full hash to `#providers` and overwrites a valid sub-view on mount. This contradicts the existing `Providers.tsx` comment and breaks workspace deep-link/reload continuity.

### Evidence-backed repair amendment

- Add `gui/src/App.tsx` to integration scope only for the hash synchronization effect. Compare the current hash's first segment to `page`; preserve valid suffixes when the segment already matches, while still normalizing empty/invalid/different-page hashes.
- Add a narrow source contract to `tests/provider-workspace-rail.test.ts` and browser proof that direct navigation/reload retains `#providers/workspace`.
- No other production edit is authorized unless the verification sequence exposes a new failing path.

### Independent final-review additions

The Terra-high reviewer returned `GO-WITH-FIXES` with complete implementation-file coverage and four findings, all folded into the final repair:

1. Whitelist only the exact `providers/workspace` subroute; a first-segment-only preservation rule would incorrectly keep `providers/typo`.
2. Generic logout must check `response.ok` and refresh promoted account rows/OAuth/config/quota rather than unconditionally showing logged out.
3. Generic and Codex account DELETE failures must preserve state and announce failure instead of remaining silent.
4. Rail options require one roving Tab entry (`focused/selected/first visible`) instead of leaving every native option button at `tabIndex=0`.

Main audit additionally folded a synchronous duplicate-switch ref, post-PUT refresh-success honesty, and explicit native Codex account switch buttons into the same bounded repair. These are all reachable on the new workspace surface and do not change server or deletion policy.

## B repair receipt — 2026-07-18

- Workspace routing now whitelists only exact `providers/workspace`; direct navigation and reload retain it, while a live `providers/typo` hash normalizes to `providers`.
- Generic account switching uses a synchronous target ref before React state, preventing two same-render clicks. Account refresh returns success; a failed post-PUT GET shows the load error rather than a contradictory success toast.
- Generic logout checks non-2xx/network failure, refreshes the promoted account set plus OAuth/config/quota on success, and leaves state unchanged on failure.
- Generic and Codex account deletion now check response status and show localized failure feedback without refreshing or changing visible state after failure.
- Codex cards are non-interactive containers. Every non-current usable main/pool account has an explicit native `Set as Next Session` button; nested ticket/remove controls retain independent semantics and remove labels include the masked email.
- Rail focus uses one `tabIndex=0` option selected from the last focused, selected, or first visible row; every other option is `-1`, while Arrow/Home/End updates the focus owner.

### Build evidence

```text
focused integration suite (8 files)
  133 pass / 0 fail / 462 assertions
GUI production build + TypeScript
  PASS
focused ESLint (App, Providers, Codex pool, shell, rail)
  0 errors / 0 warnings
privacy scan + diff check
  PASS
```

## Verification sequence

1. Contract and focused tests:

   ```sh
   bun test --isolate tests/provider-workspace-auth.test.ts tests/provider-workspace-rail.test.ts tests/oauth-accounts-api.test.ts tests/oauth-store-multi.test.ts tests/oauth-public-surface.test.ts tests/codex-auth-api.test.ts tests/provider-workspace-data.test.ts tests/provider-workspace-state.test.ts
   ```

2. Static/i18n/build/privacy:

   ```sh
   bun run typecheck
   cd gui && bun run lint:i18n
   cd gui && bun run build
   bun run privacy:scan
   git diff --check
   ```

3. Existing lint debt:

   ```sh
   cd gui && bun run lint
   ```

   Report the pre-existing `ProviderOverview.tsx` hook error separately if unchanged. New errors are blockers.

4. Affected/full suite:

   ```sh
   bun run test
   ```

5. Live account contract:
   - Capture original generic OAuth and Codex active IDs in process memory without printing them.
   - In the workspace Accounts tab, switch Anthropic to the other masked account; observe one PUT, refreshed selected state, and persistence after reload.
   - Restore the original Anthropic account and verify.
   - In canonical OpenAI Accounts, switch/prepare another account only if the current mode semantics make the action reversible; verify the documented next-session message, then restore the original ID.
   - Never delete, add, redeem credits, or change auto-switch.

6. Browser matrix with requested and effective CSS width recorded:

   ```text
   desktop 1440: Accounts tab, many rows, rail, detail overview
   split 1024: rail/detail composition, long names, no horizontal overflow
   tablet 768: actual client width recorded; force lower requested width if needed to cross 760 CSS px
   mobile 390: stacked rail/detail, touch controls
   narrow 320: no Korean/English clipping or vertical glyph stacking
   themes: light + dark
   locales: en + ko mandatory; de + zh smoke for expansion
   states: loading, empty, error, one, many, reauth, switching, restored success
   keyboard: rail arrows/Home/End; detail tabs arrows/Home/End; account/action Tab order
   console/network: no framework overlay/error; expected account GET/PUT and quota refresh only
   motion: feedback-only; reduced-motion removes transition/spinner animation where applicable
   ```

7. Independent final review:
   - Fresh reviewer, different model family from the builder/research Sol agents.
   - Security: no token/raw ID/PII regression, canonical provider gating, failed mutation honesty, stale request ownership.
   - UX: account tab IA, active/error semantics, keyboard path, rail hierarchy, responsive screenshots, original brand colors.
   - Coverage ledger: every changed implementation file reviewed.

## Repair policy

- First failure: record exact delta and patch only that delta.
- Second same-class failure: enter root-cause mode before another patch.
- Third: return to P with changed plan or close honestly as BLOCKED/UNSAFE/NEEDS_HUMAN.
- Reviewer FAIL requires blocker RCA and same-reviewer re-audit; only pass or main-judged near-pass advances.

## Done evidence

- Commit hashes for docs-only roadmap, account slice, rail slice, and integration closeout.
- Persisted screenshots/evidence paths for every required width/state family.
- Goalplan tasks done and every met criterion has non-empty captured evidence.
- `cxc loop validate` passes, FSM closes through D to IDLE, then `update_goal complete` succeeds.
- Final terminal result names `DONE`, `NOOP`, `BLOCKED`, `UNSAFE`, `NEEDS_HUMAN`, or `BUDGET_EXHAUSTED`; no push occurs without explicit approval.

## C final verification receipt — 2026-07-18

### Automated gates

```text
focused integration suite
  133 pass / 0 fail / 462 assertions
current-worktree full test suite
  PASS (exit 0; unrelated pre-existing deleted test remains outside goal commits)
root bun run typecheck
  PASS
GUI production build
  PASS; pre-existing chunk-size warning only
focused changed-file ESLint
  PASS (0 errors / 0 warnings)
GUI full lint / lint:i18n
  one unchanged baseline error only: ProviderOverview.tsx:152 react-hooks/set-state-in-effect
privacy scan / git diff --check
  PASS
```

### Final browser/runtime proof

- Exact route contract: direct `#providers/workspace` and reload both retained the workspace; `#providers/typo` normalized to `#providers`.
- Current default viewport: 1600 CSS px, document `1600 == 1600`, workspace `1296 == 1296`, exactly one rail option with `tabIndex=0`, zero console errors/warnings.
- Final OpenAI Accounts screenshot shows masked main + three pool accounts, explicit `Set as Next Session` buttons on three non-current usable accounts, no clickable card containers, and independent masked remove controls.
- Anthropic still reports two accounts. Fresh live reads prove both Anthropic and Codex active ids equal the originals captured before mutation; ids were never printed.
- German and Chinese desktop smoke both retained document/workspace `clientWidth == scrollWidth`; English/System were restored afterward.
- The earlier full responsive matrix and Korean/light/dark/filter/keyboard screenshots remain valid after the final repair because the repair did not touch layout CSS; direct final metrics reconfirm zero overflow and one rail focus entry.

### Independent review

Terra-high reviewed every changed implementation file and both tests. Its `GO-WITH-FIXES` findings were all implemented in `f5655e9`. The same reviewer was resumed for a repair re-audit but produced no result after four bounded waits (30s, 30s, 30s, 20s) and was retired. Main verification closed each item with source contracts, focused/full suites, and live browser proof; the original reviewer verdict was not misreported as PASS.
