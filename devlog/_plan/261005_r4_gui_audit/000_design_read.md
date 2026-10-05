# 000 — Design Read and audit scope (lane R4)

Lane R4 of the release-readiness train audits the dashboard GUI changes merged since
v2.77.0 and fixes what it finds. This document records the design frame the audit
judges against, so a finding can be traced to a rule instead of a taste.

## Design Read

```yaml
---
name: opencodex dashboard (governed by gui/design-system/)
colors:
  primary: "var(--text) #0d0d0d / #ececec"
  accent: "var(--accent) — primary action and focus only"
  background: "var(--bg) #ffffff / #212121, rail var(--rail) #f9f9f9 / #171717"
typography:
  heading: { fontFamily: var(--font-ui), fontSize: 20px (text-title) }
  body: { fontFamily: var(--font-ui), fontSize: 14px (text-body), controls 13px }
iconography:
  system: "in-repo icons.tsx (stroke set)"
  weight: "regular; filled/pressed state for the current choice"
  domain: "provider brand marks (provider-icons.ts)"
---
```

Reading this as: a dense, repeated-work admin console for developers who run a local
proxy, in the quiet neutral language of the ChatGPT/Codex desktop apps it sits beside.
The governing design system (`gui/design-system/`, tokens in `gui/src/styles.css`)
overrides any taste call; the audit checks conformance and objective UX, not style.

Do's: one obvious row per destination, the active row always lit, every control
reachable by keyboard with a visible focus ring, copy that fits in all eleven locales.
Don'ts: emoji as UI, clipped labels, a control whose state is only conveyed by color,
dead ends on empty/error states, new visual vocabulary that the design system lacks.

```
DESIGN_VARIANCE: 3
MOTION_INTENSITY: 2
Product density profile: D5 (dense SaaS/admin, developer audience)
Reasoning: an operator console used repeatedly; clarity and density beat expression.
```

Concept generation (UX-CONCEPT-GEN-01) is skipped: this is an audit of an existing
utility surface governed by a design system, which the rule exempts.

## Scope

| PR | Surface | Stated intent to verify |
|---|---|---|
| #6579 | sidebar foot | three-icon theme switch (aria-pressed, tooltip/name); shares a row with the zoom stepper on macOS/Linux desktop; "Theme" label row in browser/Windows; alignment with language icon and orbs |
| #6593 | sidebar, Connect, Claude, Usage & Logs, Remote Link | eight rows; row lights for every owned page; section switcher (named nav, aria-current, arrow/Home/End); Connect tab order; Claude without sub-tabs; #claude/account and #claude/settings redirects; Codex Set labelled Codex |
| #6596 | Connect → Claude, Connect → Claude Desktop | one-page Claude Code settings with sticky Save bar (dirty state, Revert/Save); Desktop Models card (default and quick task model), folded Advanced lanes. Claude Desktop is owned by lane R3: findings are reported, not fixed here |
| #6522 | Connect → DSH | plan-path allowlist and semantics text in all locales |
| #6597 | Connect → file clients | missing-store remedy; audited only after it lands |

Checks per surface: intent coverage; IA and reachability (every route, active state,
collapsed and expanded sidebar, drawer at narrow widths, keyboard order, aria names);
all eleven locales (missing keys, untranslated English, truncation in de/pt/ru/fr);
light, dark and system themes; zoom 80–150% and widths 1440/1024/768/390; empty,
loading and error states on changed pages; no emoji as UI; pages that moved still work.

## Method

The built dashboard (`bun run build:gui`) is served by an isolated proxy whose HOME,
OPENCODEX_HOME, CODEX_HOME, CODEX_SQLITE_HOME and XDG_* roots live under one
`mktemp -d` directory, on a random port, after verifying the resolved state roots.
Screenshots come from headless Chrome driven by a scratch Playwright script outside the
repository. No test runner is used (owner instruction for this train).
