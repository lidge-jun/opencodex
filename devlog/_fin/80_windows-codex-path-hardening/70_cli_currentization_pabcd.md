# 80.70 — CLI Currentization and Diagnostics PABCD

## Purpose

Clean up the CLI surface so users can quickly diagnose version, runtime, service, provider, and stale config problems. This explicitly covers the current missing `-v`/version path and the emergency stale Cursor OAuth config issue.

## Source Evidence

- User feedback: CLI is currently messy and `-v` is missing.
- Emergency finding on 2026-06-27: local `~/.opencodex/config.json` and `auth.json` can retain a removed `cursor` OAuth provider, producing repeated `Unknown OAuth provider: cursor` failures until config/auth cleanup.
- Hotfix commit: `c560b54 fix(oauth): classify stale provider config`.

## PABCD Work Unit

This is one full PABCD cycle after Windows service/data-plane hotfixes. It is allowed to be docs-first, then implementation. It should not be mixed with Cursor provider resurrection work.

### P — Plan

Scope:

- MODIFY `src/cli.ts`
- MODIFY `bin/ocx.mjs` only if launcher-level `-v` should bypass Bun startup or show launcher diagnostics
- MODIFY `src/update.ts` or extract shared package-version helper if needed
- MODIFY `src/config.ts` only for safe config diagnostics helpers
- MODIFY `tests/cli-help.test.ts` or ADD `tests/cli-version.test.ts`
- Possibly ADD `src/diagnostics.ts` if status/version logic gets too large

Non-goals:

- Do not re-add Cursor OAuth provider support here.
- Do not mutate config during `ocx -v`, `ocx --version`, `ocx version`, or `ocx help`.
- Do not print tokens, API keys, Authorization headers, or raw OAuth credentials.
- Do not turn `status` into an interactive repair flow.

### A — Audit

Ask a read-only auditor to verify:

- `package.json` is the authoritative version source or a generated constant is explicitly justified.
- `ocx -v`, `ocx --version`, and `ocx version` can exit 0 without loading or mutating user config.
- `ocx status` can detect unsupported `authMode: "oauth"` provider ids and stale auth entries without printing secrets.
- Existing commands still support subcommand help without side effects.

### B — Build

Implementation checklist:

Version and help:

- Add global `-v`, `--version`, and `version` support.
- Print a stable single-line version by default, for example `opencodex 2.5.x`.
- Keep `ocx help`, `ocx --help`, and `ocx -h` side-effect free.
- Add subcommand help coverage for important commands that mutate state.

Status diagnostics:

- Extend `ocx status` with:
  - opencodex version;
  - Node launcher path when relevant;
  - Bun path/version if safely available;
  - platform and arch;
  - config path;
  - service status and service log path when available;
  - provider count and default provider;
  - warnings for unsupported OAuth provider config entries;
  - warnings for stale auth entries with no supported provider.
- For the Cursor cleanup class, print exact safe guidance:

```text
Unsupported OAuth provider in config: cursor
Fix: remove or reconfigure provider 'cursor' in ~/.opencodex/config.json, then remove stale auth entry from ~/.opencodex/auth.json.
```

Optional cleanup command:

- Consider `ocx config doctor` as read-only first.
- Consider `ocx config cleanup --stale-oauth` only if it backs up files and prints exactly what changed.
- If implemented, require tests for backup creation and token-safe output.

Suggested commits:

```bash
git add src/cli.ts tests/cli-help.test.ts && git commit -m "feat(cli): add version flags"
git add src/cli.ts src/config.ts tests && git commit -m "feat(cli): diagnose stale oauth providers"
```

### C — Check

Required commands:

```bash
bun test tests/cli-help.test.ts tests/oauth-status-privacy.test.ts tests/config.test.ts
bun x tsc --noEmit
```

Manual smoke:

```bash
ocx -v
ocx --version
ocx version
ocx help
ocx restore --help
ocx status
```

Stale provider smoke:

```bash
# In a temp OPENCODEX_HOME, create config/auth entries for cursor with authMode oauth.
ocx status
# Confirm status warns, exits 0, and prints no token material.
```

### D — Done Criteria

- `ocx -v`, `ocx --version`, and `ocx version` work and do not mutate config.
- `ocx status` gives enough information for Windows reports: version, runtime, service/log path, config path, provider/default summary.
- Stale unsupported OAuth providers are diagnosed with safe cleanup guidance.
- Tests cover version flags, no-mutation help/version behavior, and stale provider diagnostics.
