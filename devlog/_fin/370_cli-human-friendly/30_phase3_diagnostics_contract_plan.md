# Phase 3 - Agent-Friendly Diagnostics Contract Plan

Status: public contract plan only, no implementation in this cycle.

## Objective

Design the first machine-readable diagnostics contract for agents and scripts so they do not need to scrape human text from `ocx status`.

This phase should start only after Phase 2 has made help/version routing predictable.

## Source Findings From Phase 1

Authoritative matrix:

```path
/Users/jun/Developer/new/700_projects/opencodex/devlog/370_cli-human-friendly/11_help_surface_matrix.md
```

Relevant findings:

- `ocx status --json` currently exits 0 but prints human text, because extra args are ignored by `status`.
- `ocx doctor` and `ocx doctor --json` are unknown commands.
- `ocx logs` and `ocx service logs` are unknown/unsupported, but service diagnostics already expose a log path.
- README/docs-site do not promise any JSON status contract.

## Contract Boundary

### Included

- `ocx status --json` as the first stable JSON surface.
- Additive-only schema policy for future fields.
- Token/secret redaction requirements.
- Tests that JSON output is valid, read-only, and secret-safe.
- Documentation for agents/scripts.

### Excluded

- No `doctor` command in the first diagnostics contract slice unless Phase 2 explicitly re-plans it.
- No `logs` or `service logs` implementation.
- No remote provider quota/account usage output.
- No dashboard API changes unless implementation discovers a reusable read-only status helper is required.

## Planned Files

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/src/cli.ts`

Planned changes:

1. Parse `status --json` before human status output.
2. Refactor status collection into a data object that both human and JSON output can use.
3. Keep `ocx status` human output stable unless tests require a minimal adaptation.
4. Reject unknown status flags explicitly once `--json` is supported.

Candidate type:

```ts
type CliStatusJson = {
  schemaVersion: 1;
  proxy: {
    running: boolean;
    pid: number | null;
    health: {
      ok: boolean;
      url: string;
      message: string;
    };
  };
  dashboard: {
    url: string;
  };
  paths: {
    config: string;
    pid: string;
    runtime: string;
  };
  codexAutostart: boolean;
  defaultProvider: string | null;
  service: {
    summary: string;
  };
  codexShim: {
    summary: string;
  };
};
```

Do not include:

- API keys;
- OAuth tokens or refresh tokens;
- Authorization headers;
- raw request/response bodies;
- emails or account names unless a later auth-specific contract explicitly permits redacted labels.

### ADD `/Users/jun/Developer/new/700_projects/opencodex/tests/cli-status-json.test.ts`

Planned tests:

- `ocx status --json` exits 0 and parses as JSON.
- `schemaVersion` is present.
- proxy health/url/path fields are present.
- no known secret-like keys appear in JSON:
  - `apiKey`
  - `token`
  - `refreshToken`
  - `authorization`
  - `email`
- command does not start the proxy or write PID/config files in a temp home unless those files already exist.

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/docs-site/src/content/docs/reference/cli.md`

Planned documentation:

- Add `ocx status --json`.
- Include an example output with placeholder paths.
- State additive-only schema policy.
- State that JSON is intended for agents/scripts and excludes secrets.

### OPTIONAL MODIFY `/Users/jun/Developer/new/700_projects/opencodex/structure/01_runtime.md`

Only if implementation refactors status collection enough to alter runtime ownership docs. If added, document that `src/cli.ts` owns both human and JSON status formatting.

## Acceptance Criteria

- `ocx status --json` exits 0 with valid JSON.
- `ocx status` human output remains usable.
- JSON status does not start/stop proxy, service, or shim.
- JSON status does not include secrets or raw account identity.
- Unknown `status` flags do not silently produce human output once JSON support exists.
- docs-site matches the implemented schema.

## Verification

```bash
bun test tests/cli-status-json.test.ts tests/cli-help.test.ts
bun run typecheck
node bin/ocx.mjs status --json
```

Optional manual verification after implementation:

```bash
node bin/ocx.mjs status --json | jq .
```

## Risk Notes

- `serviceStatusSummary()` may inspect platform service managers; keep JSON status read-only and tolerant of unsupported platforms.
- Paths can be absolute local paths and are acceptable diagnostics, but secrets must not be embedded in path-like strings.
- `defaultProvider` is a config value and may be user-defined. If future privacy requirements tighten, expose only whether a default provider exists.

## Suggested Commit

```text
feat(cli): add json status diagnostics
```
