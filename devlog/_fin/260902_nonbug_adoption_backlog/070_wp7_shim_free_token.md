# wp7 — #2713 shim-free Codex token injection

State at entry: the narrow `ocx doctor` diagnostic requested by the issue ("env_key set + variable
absent + shim missing → actionable repair line") landed on `dev` in PR #2844 (`5734a1caf`,
`collectCodexEnvKeyReadiness` in `src/cli/doctor.ts`, tests in
`tests/doctor-codex-envkey-readiness.test.ts`). The maintainer review (score 58) and the reviewer
follow-up (2026-08-29) both settled the remaining design questions:

- A `systemd --user` drop-in is rejected as the default: it does not fit a root-owned server and
  only reaches services launched by the user manager, not interactive shells, cron, or Desktop.
- `EnvironmentFile=` on `opencodex-proxy.service` lands only in the proxy process; it cannot
  inject `OPENCODEX_API_AUTH_TOKEN` into an independently launched `codex exec`. Validated by the
  reporter on a root VPS.
- Codex has no credential-file directive for `env_key`; the value must exist in the Codex process
  environment. Do not invent one.
- No new token file; the existing `service-api-token` is the source. Do not add another launcher
  interception at the Codex binary path (that is the hole the issue reports).
- Verdict: no `ocx codex-env` command yet; a narrow documentation update is what remains.

## Scope (docs only)

`docs-site/src/content/docs/reference/cli/lifecycle.md`, in the `ocx codex-shim` section: a
subsection "Token injection without the shim" that states the process boundary, lists what does and
does not carry `OPENCODEX_API_AUTH_TOKEN` to Codex (shim; exporting the variable in the launching
process — shell profile, cron line, service unit that launches Codex itself; `EnvironmentFile=` on
the proxy unit does not), points to `ocx doctor`'s "Codex env_key launch readiness" line, and
reminds that the token value is never printed and must not be copied into `config.toml`.

## Acceptance

- Section present; no new commands or config keys claimed (`skill:surface:check` unaffected).
- `bun run privacy:scan` clean.
- PR to dev; close #2713 with English rationale: doctor slice landed (#2844), documentation landed,
  first-class `ocx codex-env` declined for now with the reasons above; reopen path stated.

