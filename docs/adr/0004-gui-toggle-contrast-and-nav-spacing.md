# ADR 0004: GUI toggle contrast and sidebar item spacing

## Status

Accepted

## Context

In dark mode, enabled switches used the monochrome accent for the track. The bright track could
visually merge with the switch knob, making the enabled state and knob position difficult to read.
Sidebar navigation items also had no vertical separation, so adjacent hover and active backgrounds
appeared as one continuous block.

## Decision

Keep the existing shared switch components and CSS tokens. Use the existing dark-theme success
green for enabled switch tracks while retaining a dark knob, and make `.switch` consume the same
toggle tokens as the label-based `.toggle` control.

Lay out the sidebar `nav` as a vertical flex container with a 4px gap. This preserves each item's
full click target while separating adjacent hover and active surfaces.

## Consequences

- Enabled switches have distinct track and knob silhouettes in dark mode.
- Both switch implementations share one enabled-state color rule.
- Sidebar hover and active states remain visually separate without adding divider noise.
- No component API or dependency changes are required.
