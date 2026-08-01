# Bare `ocx service` Build Record

## Changes

- `src/service.ts`: added `normalizeServiceSubcommand()` so omitted service subcommands default to `install`; invalid explicit subcommands still fail closed.
- `src/cli-help.ts`: changed service usage to optional subcommand form and documented the no-subcommand install/update/start default.
- `tests/service.test.ts`: locked the no-subcommand normalization contract without invoking real OS service managers.
- `tests/cli-help.test.ts`: updated invalid usage expectation to the optional-subcommand syntax.
- `README.md`, `README.ko.md`, `README.zh-CN.md`: documented bare `ocx service` as the service install/update/start path.
- `docs-site/src/content/docs/**/reference/cli.md`: documented `ocx service [subcommand]`, added the no-subcommand row, and aligned `remove` alias tables.

## Audit Adjustments

- Kept `ocx service start` installed-only, including the Linux systemd unit-file preflight.
- Used `??` normalization so only an omitted subcommand defaults to `install`.
- Covered localized docs in README and docs-site.
