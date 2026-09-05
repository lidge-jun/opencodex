# Guardrails rule asset modifications

`guardrails_regex_rules.yaml` and
`guardrails_regex_rules.gitleaks.generated.yaml` were copied byte-for-byte from
`cloud-ru-tech/guardrails-llm-filter@bbd6f27467a53ff3869b59449edf4209f85ae675`.
They have not been modified by OpenCodex contributors. Their source paths and
SHA-256 hashes are recorded in `provenance.json`.

`guardrails_regex_rules.opencodex.yaml` is original MIT-licensed OpenCodex work.
It supplements the pinned donor registry and is intentionally not represented
as a donor asset. Its distributed-file SHA-256 is recorded separately in
`provenance.json`. Its infrastructure-URI rule accepts a bounded angle-bracket
host placeholder so a repeated scan can mask userinfo credentials left beside
an already masked host. Its email rule covers ASCII addresses whose final
domain label uses the standard `xn--` punycode form.

Native TypeScript code that loads and evaluates these assets is original
OpenCodex code and is not a modification of donor Go source files.
