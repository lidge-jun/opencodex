# 050 — Docs and privacy statements (wp6)

| File | Change |
| --- | --- |
| `docs-site/src/content/docs/guides/telemetry.md` | New section "Public profile and rank (opt-in)": what is public, what is sent, how to connect/disconnect (card + CLI), no linkage to the install id, deletion, rate limits, hidden flag, GitHub login as a follow-up. |
| `README.md` + 7 `readme/README.*.md` | Privacy line: amend "Project-wide aggregates are public." to "Only project-wide aggregates of this anonymous data are public." and add: "A separate public leaderboard profile is off unless you connect one yourself; it shares only a chosen handle, display name and daily totals, and disconnecting deletes it." (translated). Update `readme/i18n-manifest.json` in the same commit. |
| `docs-site/src/content/docs/reference/code-signing.md` + Turkish page | Same sentence. |
| `SPONSORS.md` | Check the telemetry clause; add that public profiles are opt-in if it lists telemetry data. |
| `AGENTS_INSTALL.md` | Connecting a public profile is a user-consent action an agent must never perform or answer. |
| `structure/telemetry.md` | New "Public profiles" section: modules, consent boundary, sync rules, collector endpoints and tables. |
| `services/telemetry-collector/README.md` | Endpoints, tables, limits, hide command. |

Privacy review of this wording is separate (wp7). Installer unchanged: the profile is opt-in.

