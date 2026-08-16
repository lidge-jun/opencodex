# OpenCodex anti-slop profile

This directory contains an OpenCodex-local adaptation of selected rules from `dmmulroy/anti-slop`, snapshot `446268e5d15baa968eaec669ff65358d36ae6259`.

The upstream project explicitly recommends vendoring and customising its rules. OpenCodex therefore owns this copy and its policy instead of taking a moving package dependency.

## Enabled rules

The repository enables these rules across runtime source, scripts, and dashboard TypeScript:

- `no-chained-type-assertions` - warning during migration.
- `no-known-value-widening` - warning during migration.
- `no-object-parameters` - warning during migration.
- `no-reflect-apply` - error.
- `no-reflect-get` - error.
- `no-widen-then-assert` - warning during migration.
- `require-safety-comment-for-type-assertion` - warning during migration.

Warnings keep the existing codebase lintable while making new low-evidence patterns visible. The two Reflect rules are errors because the repository has no legitimate production use of those dynamic escape hatches.

## Intentionally excluded upstream rules

OpenCodex accepts untrusted provider, protocol, process, and JSON input at explicit boundaries. `unknown`, narrow `typeof` checks, and dictionary-shaped boundary data can therefore be correct rather than slop. We do not enable upstream policies that broadly reject those patterns.

The local profile intentionally omits:

- `no-conditional-empty-object-spread`
- `no-module-mocking`
- `no-runtime-typeof`
- `no-shape-in-symbol-names`
- `no-unknown-parameters`
- `no-unknown-returns`
- `no-unknown-type-aliases`
- `no-unsafe-dictionary-type`

## Implementation note

The plugin uses Oxlint's ESLint-compatible JavaScript plugin shape directly. It has no runtime npm dependency, so the same vendored file can be loaded by both repository lint configurations without coupling one package install tree to another.

Upstream is MIT licensed. See `LICENSE` in this directory.
