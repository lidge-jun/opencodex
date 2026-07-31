# Issue #43 — Diagnose stale Codex bundled plugin marketplace after app updates

- **Reporter:** 0disoft (ZeroDi)
- **URL:** https://github.com/<repo>/issues/43
- **Type:** Feature request (read-only diagnostics, optional repair) — Windows
- **Severity:** Low-Medium — usability/diagnostics; no proxy malfunction.
- **Status:** Scoping recommendation below (NOT implemented — documentation phase).
- **Next:** see `10_plan.md` for the audited implementation plan (Phase 1
  read-only diagnostic + deferred opt-in Phase 2 repair), with codex-rs and
  opencodex file:line evidence.

## Report summary

After a Codex app update on Windows, Codex-bundled plugins (`computer-use`,
`browser`, `chrome`) can become unavailable even though the files still exist in
the new app package. The active Codex plugin marketplace list no longer includes
the current `openai-bundled` marketplace path because Windows app-package paths
embed the Codex app version; an update leaves a stale/missing registered path.
Reporter proposes: Phase 1 read-only diagnostics in `ocx status`/`ocx doctor`/a
new command; Phase 2 an optional explicit `ocx repair codex-plugins`. Explicitly
wants to AVOID `ocx ensure` silently mutating Codex plugin marketplaces.

## Current state in the repo (investigation)

- There is **no `ocx doctor` command** today. `src/codex-shim.ts` lists `doctor`
  and `plugin` only as Codex subcommands the shim passes through (L17, L25) — not
  an opencodex diagnostic.
- opencodex already owns adjacent Codex-integration surfaces, which makes a
  read-only diagnostic a natural fit:
  - config injection/restore: `src/codex-inject.ts` (already reasons about
    `[plugins."chrome@openai-bundled"]` table state — see comment L25)
  - paths: `src/codex-paths.ts` (`CODEX_HOME`, `CODEX_CONFIG_PATH`)
  - shim: `src/codex-shim.ts` (`ocx codex-shim`)
  - status: `src/cli-status.ts`, `src/service.ts`
- No existing reader for `codex plugin marketplace list`.

## Scoping recommendation

In scope as **read-only diagnostics**; the explicit repair command is acceptable
only as an opt-in, never automatic. Agree with the reporter's "do not let
`ocx ensure` mutate plugin marketplaces" stance.

### Phase 1 — diagnostics (recommended first PR)
Add a read-only report (extend `ocx status --json` or add `ocx doctor`) that, on
Windows, reports:
- whether a Codex app package is installed and its detected version/path
- the detected current `openai-bundled` marketplace path
- whether `codex plugin marketplace list` includes that current path
- install/enable state of common bundled plugins:
  `computer-use@openai-bundled`, `browser@openai-bundled`, `chrome@openai-bundled`
- whether any registered bundled marketplace path is stale (points at an old
  app-version path)
Output should be **path-focused and secret-safe** (reuse `src/redact.ts`
conventions) and only *suggest* a manual repair command — never mutate.

### Phase 2 — explicit repair (optional, opt-in only)
`ocx repair codex-plugins`:
- detect the current bundled marketplace dir
- `codex plugin marketplace add <current-openai-bundled-path>`
- install/refresh known bundled plugins only when present
- never run for internal Codex plugin commands unless explicitly invoked
- keep output secret-safe

## Cross-platform note

Behavior is Windows-specific (versioned app-package paths). The diagnostic should
no-op or clearly report "not applicable" on macOS/Linux rather than guessing.

## Verification approach

- Unit-test the detection/stale-path logic with fixture path layouts (old vs new
  app version) and a mocked `codex plugin marketplace list` output.
- Manual: on a Windows box, simulate an app update (path version bump) and confirm
  the diagnostic flags the stale marketplace path.

## Effort & risk

- Phase 1: small-medium, low risk (read-only).
- Phase 2: medium; touches Codex plugin config → must be explicit/opt-in and
  secret-safe. Treat as separate PR after Phase 1 lands.
- Suggested reply: yes to Phase 1 read-only diagnostics; accept a small reporter
  PR scoped to diagnostics only; defer/decide Phase 2 separately.
