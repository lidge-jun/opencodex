# Provider rail A-gate synthesis

## Independent inputs

- The roadmap-phase Sol explorer independently inspected the current rail DOM/CSS and reproduced the historical vertical `Ready` leakage plus the remaining six-peer row pressure. It recommended icon + two-line copy + fixed trail, empty `aria-hidden` status dots, original-color `<img>` assets, and a shell-local collapse threshold.
- A fresh Sol-high reviewer was dispatched for this work phase but failed immediately at the provider usage limit.
- A high-effort frontier fallback reviewer remained running through three bounded waits (20s, 30s, 30s) without returning an audit and was retired. The main agent reclaimed the gate under the plan escalation rule; the delivery failures are recorded rather than represented as review approval.

## Current-source audit

1. The page header already owns the page title and Add Provider action. `ProviderWorkspaceShell` repeats both in `.pws-rail-header`; deleting that block is behavior-preserving because the empty workspace keeps its own `onAddProvider` actions.
2. The listbox has `tabIndex=0` while every `role=option` is a native button. Removing the listbox tab stop preserves bubbled Arrow/Home/End handling and removes the duplicate keyboard stop.
3. Each row currently exposes six horizontal peers: icon, name stack, badge, model count, trail, chevron. The name alone can shrink; every later peer is fixed. A copy wrapper with primary and secondary lines reduces this to icon/copy/trail and makes one owner responsible for ellipsis.
4. Status text is already absent from the visual row and belongs in the group heading/accessible name. The dot remains reinforcing, empty, and `aria-hidden`; no reintroduction of `Ready` inside the dot is permitted.
5. Duplicate config ids are rare and already computed in the shell. Moving the id and model count into the secondary line retains disambiguation without exposing internal fragments as a primary column.
6. `providerIconSrc` currently renders original assets through `<img>`; the fallback mask only applies when no provider asset exists. The patch must not apply workspace `color` or a mask to provider SVG files.
7. The global `.main-inner` max-width of 980px leaves the wide workspace at 908px after padding, while `.pws-root` then hard-caps its desktop tracks at 280px + 800px. This produces large unused margins on wide screens and lets viewport breakpoints disagree with the actual workspace width.
8. A scoped `.main-inner:has(.pws-shell-container)` expansion plus a named container wrapper is feasible in the bundled Chromium target. It keeps other pages at 980px, lets the workspace consume the available desktop surface, and makes split/stack decisions from actual workspace width.
9. The detail panel already has `min-width:0`; the overview has a fixed 280px side column. The container query must collapse the overview before the whole rail/detail split stacks, then stack the split at the measured rail + 320px-detail floor.
10. Three separate row declarations and undefined `--fg`/`--fg-muted` tokens are reachable style drift. Consolidating them and using `--text`/`--muted` is required, not cosmetic.

## Plan amendments

- Add a `.pws-shell-container` wrapper and scope wide-page max-width with `:has`; this is the minimum fix for the user's explicit wide-layout complaint and stays in the planned shell/CSS owners.
- Use two container thresholds: constrained split for one-column overview, then stacked rail/detail near 680px actual workspace width. Retain the existing viewport mobile fallback.
- The chevron is removed rather than conditionally hidden because the selected detail is persistently adjacent on split layouts and the full row is already a button.
- Add `title` on the row and both copy lines so truncated names/config metadata remain discoverable without adding visible raw text.

## Risks and controls

- `:has`/container-query support: bundled Vite/Chromium target supports both; viewport media fallback remains.
- Over-expansion: wide scope applies only while `.pws-shell-container` is present; classic Providers and all other pages retain 980px.
- Keyboard regression: source test pins no listbox tab stop; browser checks Tab + Arrow/Home/End at split and stacked widths.
- Korean long labels: no-wrap/ellipsis on both lines, sentence-case group heading, and 44px stacked targets.
- Horizontal overflow: root/main/detail use `min-width:0` and `max-width:100%`; browser metrics require `scrollWidth === clientWidth` at document and shell levels.

## A judgment

The change is feasible within the existing shell/rail/CSS owners. No catalog, provider asset, auth, or server contract change is needed. The completed roadmap Sol findings plus fresh current-source/browser evidence cover the failed reviewer delivery.

VERDICT: GO-WITH-FIXES (blockers=0)
