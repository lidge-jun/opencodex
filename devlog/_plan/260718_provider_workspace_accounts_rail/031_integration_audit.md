# Workspace integration A-gate synthesis

## Scope and test integrity

- `34e34b4..657a2ce` contains 21 expected roadmap/account/rail/design/test files. Production changes are limited to the planned workspace page, account components, rail/shell components, pure classifier, locale dictionaries, and workspace styles.
- Both new test files are additive. There are no deleted assertions, skips, todos, timeout inflation, fixture weakening, or unrelated test edits.
- The user's unrelated dirty tree and deleted `tests/codex-multi-state.test.ts` are absent from every goal commit.

## Security and state ownership audit

1. Canonical Codex ownership is gated by `isAccountProvider`; custom forward providers do not inherit the account pool.
2. Visible generic/Codex labels use masked email or localized ordinal/main copy. No token or opaque account id is rendered in rows, title, aria label, confirm, or toast.
3. Generic list reads are generation-bound and merged per provider. Codex reads are generation-bound across list + active responses.
4. Non-2xx mutations preserve the previous selection and announce failure. Live switches were restored to the captured originals without printing ids.
5. Residual: generic duplicate blocking currently checks React state only. Two clicks in one render turn can both observe `null`. Fold a synchronous ref guard into the final repair.
6. Residual: a successful generic PUT followed by a failed authoritative GET still emits a success toast while the old row remains selected. Make `fetchAccountSets` return success and surface the load failure instead of announcing refreshed success.

## UX and accessibility audit

1. Generic OAuth rows are native buttons; active rows remain focusable, reauth/pending mutation is blocked, and loading/error/empty/many states have text semantics.
2. Detail tabs have linked ids/panels and roving Arrow/Home/End focus. Rail options own focus without a duplicate listbox stop.
3. Rail rows expose the intended icon/two-line-copy/trail hierarchy, no visible Ready fragment, original `<img>` colors, and container-derived responsive states.
4. Residual: Codex pool cards are pointer-clickable `<div>` elements with no keyboard switch control. Remove the hidden whole-card click affordance and add explicit native `Set as Next Session` buttons for non-current, usable main/pool accounts. Nested ticket/remove buttons remain independent.
5. Reduced-motion is already global: all transitions and spinner animation are disabled under `prefers-reduced-motion: reduce`.

## Routing audit

- `readPageFromHash` accepts `providers/workspace`, but the page-sync effect compares the full hash to `#providers` and overwrites the suffix. The live browser reproduced this on every reload. The P amendment's first-segment comparison is required and must still normalize invalid/empty/different-page hashes.

## Independent final review

Fresh Terra-high review returned `GO-WITH-FIXES` after reviewing every changed implementation file and both tests. It confirmed canonical gating, no new raw-id/token surface, original SVG paths, account/Codex generation guards, and tab/rail keyboard structure. It added four reachable findings:

1. exact subroute whitelist rather than first-segment-only preservation;
2. honest multi-account logout refresh/failure handling;
3. visible generic/Codex DELETE failure handling;
4. one roving rail Tab entry rather than every option being tabbable.

All are folded into B. The reviewer reported no unreviewed implementation file and separately excluded the unrelated dirty tree.

## A judgment

Eight reachable integration residuals are folded into a narrow final repair: exact hash continuity, synchronous duplicate guard, post-PUT refresh honesty, explicit Codex keyboard switch actions, honest logout refresh, visible DELETE failures, and a true single-entry rail focus model. No server, credential, quota policy, deletion policy, or provider-asset change is required.

VERDICT: GO-WITH-FIXES (blockers=0 after folded repair)
