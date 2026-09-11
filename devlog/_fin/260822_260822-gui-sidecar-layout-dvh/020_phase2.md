# 020 — Phase 2: container-query conversion

Slice: make narrow-card stacking depend on the CARD, not the window.

## Why the current queries cannot work

`.dash-sidecar-grid` is auto-fit, so a 336px card exists inside a 992px viewport. Every
`@media` targeting these cards is measuring the wrong box.

## MODIFY gui/src/styles-dashboard-workspace.css

### 1. Declare the container on the card (line ~142)

```css
.dash-sidecar-row-card {
  min-width: 0;
  flex-wrap: wrap;
  row-gap: 12px;
  container-type: inline-size;
  container-name: sidecar-card;
}
```

Hazard note to embed as a comment: `container-type: inline-size` implies layout
containment, which makes the element a containing block for fixed/sticky descendants.
Safe here because both in-card overlays portal to `document.body`
(`ui.tsx` Select `portal = true`, `VisionAdvancedPopover` `createPortal`), and the sticky
`thead` lives on `.dashboard-workspace-main`, outside the card. Do NOT lift the container
to the shell — that would trap the sticky header.

### 2. A container cannot style itself

`@container sidecar-card (...)` rules must target DESCENDANTS. `.dash-sidecar-row-card`
and `.dash-vision-sidecar-card` ARE the container node, so `flex-direction: column` on
them inside the query is a no-op. Stack via `flex-basis: 100%` on the two children
instead — which is why 010 made the row wrappable.

### 3. Replace @media (max-width: 36rem) (line ~275-293)

DELETE the media block. ADD:
```css
@container sidecar-card (max-width: 30rem) {
  .dash-sidecar-copy,
  .dash-delegation-controls {
    flex-basis: 100%;
    min-width: 0;
  }
  .dash-vision-sidecar-card .dash-delegation-controls {
    align-items: stretch;
  }
  .dash-vision-select-row {
    justify-content: flex-start;
  }
}
```
30rem = 480px card, the width at which copy floor (14rem/224px) + control floor
(10.5rem+gaps) can no longer coexist on one line.

### 4. Delete @media (max-width: 30rem) (line ~296-300)

Dead rule. `.dash-vision-number` only renders inside the portaled popover now, and
`.dash-vision-advanced-popover .dash-vision-number .codex-auto-switch-input-wrap`
already sets `width: 100%` at line 267.

### 5. Replace @media (max-width: 22rem) (line ~301-317)

DELETE. The 30rem container query above subsumes it: once both children are
`flex-basis: 100%`, the card is already stacked, and 010's `flex-wrap: wrap` on the
controls handles the sub-320px case without a second breakpoint.

## Verification

- Set viewport WIDE (1400px) but force a narrow card (two-column at ~430px each) and
  confirm the stacked layout fires — impossible under the old media queries
- Confirm the Select menu still opens outside the card bounds (portal escape intact)
- Confirm dashboard table sticky headers still stick

