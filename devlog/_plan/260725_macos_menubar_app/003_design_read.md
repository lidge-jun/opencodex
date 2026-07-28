# 003 — Design Read + dial lock

Design authority delegated by the user ("그냥 브랜치 너의 미감대로"). Produced under
`cxc-dev-uiux-design` before any UI code, per UX-CONCEPT-GEN-01. Implementation rules
are enforced from `cxc-dev-frontend`.

## 1. Existing design system detection (MANDATORY, ran first)

The repository already has a governing token system: `gui/src/styles.css`. It is not a
starter theme — it is deliberate, and the companion inherits it rather than inventing a
parallel aesthetic.

```css
--bg:      light-dark(#ffffff, #212121);
--surface: light-dark(#ffffff, #262626);
--raised:  light-dark(#f4f4f4, #303030);
--border:  light-dark(#e6e6e6, #3d3d3d);
--text:    light-dark(#0d0d0d, #ececec);
--muted:   light-dark(#6e6e6e, #a6a6a6);
--accent:  light-dark(#0d0d0d, #ececec);   /* ink, not a hue */
--green:   light-dark(#0a7d5c, #4ecb9d);
--amber:   light-dark(#9a4a08, #fbbf24);
--red:     light-dark(#b91c1c, #f87171);
--radius: 12px; --radius-sm: 8px; --radius-pill: 999px;
--text-micro: 10px; --text-caption: 11px; --text-label: 12px; --text-control: 13px;
```

Three properties of this system are load-bearing and are carried over verbatim:

1. **The accent is ink, not a hue.** `--accent` is near-black in light mode and near-white
   in dark. Colour is reserved for *state* (green/amber/red), never for decoration. This
   is already the correct answer for a developer tool and it sidesteps the
   purple-gradient tell without any further thought.
2. **`light-dark()` rather than a class toggle.** The OS decides. A menu bar app that
   fought the system appearance would be immediately wrong on macOS.
3. **Small type ladder (10-13px).** Confirms the intended density is high.

**Consequence:** this is a *derivation*, not a redesign. A separate palette would make
the companion look like a third-party utility rather than part of OpenCodex.

## 2. Design Read

```yaml
---
name: opencodex-menubar
colors:
  primary: "#0d0d0d"      # ink accent, inverts to #ececec in dark
  accent: "#0a7d5c"       # state green only; amber #9a4a08, red #b91c1c
  background: "#ffffff"   # inverts to #212121 in dark
typography:
  heading: { fontFamily: "SF Pro Text", fontSize: 12, weight: 600 }
  body: { fontFamily: "SF Pro Text", fontSize: 11 }
  numeric: { fontFamily: "SF Pro Text", feature: "tabular-nums", fontSize: 13 }
iconography:
  system: "SF Symbols"
  weight: "regular"
  domain: "library-subset"
---
```

Reading this as: **a glanceable operations readout for a local proxy the user already
runs**, in the visual language of the existing OpenCodex dashboard, compressed to a
340pt popover.

The reference is not another menu bar app — it is an **instrument panel**: Activity
Monitor's CPU popover and Little Snitch's network monitor, where the whole point is that
one glance answers "is it fine?" and a second glance answers "what specifically".

**Do's:** inherit the dashboard's ink-accent restraint; state colour only for state;
tabular numerals everywhere a number can change; one row = one fact; dense but not
cramped.

**Don'ts:** no hero anything; no marketing copy; no gradients; no emoji; no segmented
tab bar that hides the answer behind a click; no colour that means nothing.

### Font choice

**SF Pro (via `NSFont.systemFont`), not the dashboard's OpenAI Sans.** The dashboard is a
web surface where a brand font is appropriate. A menu bar popover sits 4pt from macOS
chrome, and a non-system font there reads as a foreign object. SF Symbols are used for
iconography for the same reason — this is the one place where "use the platform default"
is the sophisticated choice rather than the lazy one, because the platform *is* the
context.

## 3. Dial lock

```text
DESIGN_VARIANCE: 2
MOTION_INTENSITY: 1
Product density profile: D7 (finance/ops class — high information density, restrained)
```

Reasoning: this is a repeated-glance operations surface for a developer tool. Per the
`cxc-dev-uiux-design` preset table, "Finance / ops" is `2 / 1 / D6-D7` and that is exactly
the right shape here — the user opens this to read numbers, not to be delighted.
MOTION_INTENSITY 1 means feedback-only: the popover's own open/close animation is
AppKit's, and the only in-app motion is a state-change crossfade on the status dot.
Scroll-driven motion is zero. Per FE-MOTION-HONESTY-01, declaring 1 obliges me to ship no
decorative motion, which is the intent.

## 4. Information architecture

PR #421 used four segmented tabs (Usage / Health / Status / Activity). **Rejected**, for a
specific reason: a menu bar popover is a glance surface, and tabs mean the answer to "is
it fine?" is one click away three times out of four. UX-LAZY-01 step 1 — can a correct
default remove this decision? Yes: show everything, ordered by urgency, in one scroll-free
column.

```text
┌──────────────────────────────────────┐
│ ● Running          127.0.0.1:10100   │  status line — the answer
│   protected · service                │  qualifier, muted, 11px
├──────────────────────────────────────┤
│ LAST 7 DAYS                          │  range echoed from the response
│ REQUESTS      TOKENS         COST    │  micro labels, 10px, letterspaced
│ 1,746         12.4M         $8.21    │  tabular-nums, 13px
│ ▁▂▃▅▂▁▃                              │  7d usage trend from usage.days[]
├──────────────────────────────────────┤
│ OpenAI          ▓▓▓▓▓░░░░░  44%      │  quota rows, one per provider
│ Anthropic       ▓▓▓▓▓▓░░░░  58%      │
│ xAI             ▓▓▓▓▓▓▓▓▓░  87%      │  amber >80, red >95
├──────────────────────────────────────┤
│ Dashboard        Stop proxy     ···  │  actions
└──────────────────────────────────────┘
```

Vertical order is urgency order: liveness first (the reason the app exists), then
throughput, then quota pressure, then actions. Providers move to a disclosure row rather
than occupying primary space, since toggling one is rare compared to reading status.

Target width 340pt. Height is content-driven, capped at 480pt with the provider list
scrolling if a user runs many providers.

## 5. The one signature moment

**The menu bar icon itself.** It is a template image so macOS inverts it correctly, and it
carries state without colour:

| State | Glyph treatment |
| --- | --- |
| Running, protected | Solid mark |
| Running, at-risk | Solid mark + a single-pixel notch |
| Stopped | Outlined mark |
| Unreachable | Outlined mark at 40% opacity |

Colour is deliberately not used in the menu bar. macOS menu bar template images are
monochrome by convention, and a coloured dot up there is the tell of an app that does not
respect the platform. The coloured status dot lives *inside* the popover, where it has a
label next to it and does not encode meaning by colour alone (WCAG 1.4.1).

## 6. Anti-slop pre-registration

Committed to before implementation, so Phase 2's audit can check them:

- No emoji anywhere in the UI (STRICT). SF Symbols only.
- No gradients. Zero, not "one per viewport" — a 340pt utility popover has no room for
  ambient decoration.
- No one-note theme: neutral surfaces, state colour only.
- No oversized display type: the largest text in the app is 13px numeric.
- No self-describing meta copy: no "Your proxy at a glance" style header. The window is
  the product; it does not narrate itself.
- No fake data. If a value is unknown, the row shows an em dash, never a plausible zero.
  `/api/usage` distinguishes `measuredRequests` from `estimatedRequests`, so an estimate
  is marked as one.
- No colour-only meaning: every state colour is paired with a word or a glyph.

## 7. Numeric formatting (hard requirement from `002`)

Live data reaches `requests: 232507`, `totalTokens: 36536664705`,
`estimatedCostUsd: 34018.25`. Rules:

- Counts: `1,746` → `12.4K` → `1.2M` (3 significant figures, SI suffix at 10 000).
- Tokens: always suffixed (`12.4M`, `36.5B`).
- Cost: `$8.21` below 1 000, `$34.0K` above.
- All numerics use `tabular-nums` so digits do not reflow while polling.
- Timestamps normalize by magnitude: values below `1e12` are seconds, at or above are
  milliseconds (`002` §3 documents `openai` sending seconds and `anthropic` milliseconds
  in the same array).

## 8. Accessibility gates

- Every icon-only control carries an `accessibilityLabel`.
- The popover is fully keyboard operable; Escape closes it.
- Quota bars expose their percentage as accessible text, not only as a filled width.
- `NSWorkspace.shared.accessibilityDisplayShouldReduceMotion` disables the status-dot
  crossfade.
- Contrast is verified against both light and dark rendering, not assumed from tokens.
