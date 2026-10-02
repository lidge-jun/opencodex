# 030 Claude page (wp3)

## IA

Sidebar: Dashboard, Codex, **Claude** (new, directly under Codex), Providers, … Integrations keeps its other clients; the Claude
tab inside Integrations is removed and its hashes redirect: `#integrations/claude` → `#claude/code`,
`#integrations/claude/desktop` → `#claude/desktop`.

Page shaped like Codex Set (page-tabs, hash-routed, panels mounted on first visit and kept mounted while inactive, keyboard arrows):

| Tab | Hash | Content |
| --- | --- | --- |
| Account | `#claude` / `#claude/account` | Anthropic accounts: the existing provider auth + AnthropicAccountPoolSettings (pool on/off, auto-switch threshold), reset grants |
| Code | `#claude/code` | existing ClaudeCode page (CLI first-party, models, sidecars) |
| Desktop | `#claude/desktop` | existing ClaudeDesktop page (mode, picker, bindings) |
| Settings | `#claude/settings` | Claude routing on/off, intercept status/port and start action (from wp2 when merged), compatibility mode, inject agents, auto-context — only settings that exist today, no new behaviour |

## Design read

Dashboard tool surface (D4, variance 3, motion 1): reuse existing page-tabs, panels and tokens; no new visual language.
One primary action per tab. Empty/disabled states explain why and link to the action.

## Checks

lint:gui, build:gui, GUI tests for tab routing/redirects, i18n completeness (all locales), screenshots of each tab in light/dark
for the PR and a UI review by an inherited-model subagent.
