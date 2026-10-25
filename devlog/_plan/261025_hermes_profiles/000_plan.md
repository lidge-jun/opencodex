# 000 — hermes_profiles: Plan

## Objective

Issue #7674: the Hermes integration writes only the default profile. Hermes keeps one
home per profile: the default home is `HERMES_HOME` or the platform default
(`%LOCALAPPDATA%\hermes` on Windows, `~/.hermes` elsewhere), and each named profile is
`<root>/profiles/<name>/` with its own `config.yaml`. OpenCodex resolves exactly one home
(`src/clients/config-export.ts:266,276`, registry `src/integrations/registry.ts:320`), so
named profiles get no provider block and no catalog.

Evidence base (Hermes upstream, NousResearch/hermes-agent@4dcef215):

- `hermes_constants.py` `PROFILE_ID_RE = ^[a-z0-9][a-z0-9_-]{0,63}$`,
  `_PROFILE_IDENTITY_MARKERS = (config.yaml, .env, SOUL.md, profile.yaml, auth.json, state.db)`,
  tombstone `profiles/.deleted/<name>`, `_hermes_root_of` (HERMES_HOME under the native home
  -> native home; `<root>/profiles/<name>` -> `<root>`; otherwise HERMES_HOME itself),
  `_platform_default_hermes_home` (Windows `%LOCALAPPDATA%\hermes`).
- `hermes_cli/profiles.py` `_get_profiles_root` = root/profiles, `_iter_named_profile_dirs`.
- Docs: https://hermes-agent.nousresearch.com/docs/user-guide/profiles ,
  https://hermes-agent.nousresearch.com/docs/getting-started/installation (Windows home).

## Loop-spec

- Loop archetype: verifier-defined (route/uninstall regression tests, gates).
- Write scope: new `src/integrations/hermes-profiles.ts`, new
  `src/server/management/hermes-profile-routes.ts`, scoped store/path plumbing in
  `src/server/management/integration-routes.ts`, `src/cli/uninstall-integrations.ts`,
  GUI Hermes profile list + scope plumbing, docs-site integrations guide (EN),
  `structure/clients/hermes.md` (new leaf; integrations.md net <= +1 line), tests.
- Out of scope: CLI `ocx integrations` profile flags, Hermes catalog auto-refresh (Hermes is
  not in any refresh list today, default included), "apply to all" batch, translated docs,
  `structure/runtime.md`.
- Budget: one work-phase; one PR.

## Work-phase map

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| wp1 | 010_phase1.md | discovery + scoped API + uninstall + GUI + docs + delivery | — |

## Accept criteria

- Named Hermes profiles are discovered and selectable; with no selection (or `profile=default`)
  behavior is identical to dev.
- Each named profile has its own ownership store `integrations/hermes-profiles/<name>/`
  (records, journal, snapshots); apply/disable/overwrite/restore/delete-history are scoped.
- Uninstall disables every owned Hermes profile before removing state.
- Regression test fails on dev, passes after the fix; acceptance commands green.
- PR to dev, exact-head CI dispatched, independent review PASS.
