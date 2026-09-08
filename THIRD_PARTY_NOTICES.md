# Third-Party Notices

This distribution contains the following third-party materials. These notices
describe origin and attribution only; they do not imply endorsement by any
named project or organization.

## guardrails-llm-filter rule assets

- Disposition: copied unchanged.
- Source: `cloud-ru-tech/guardrails-llm-filter@bbd6f27467a53ff3869b59449edf4209f85ae675`.
- Source paths: `configs/guardrails_regex_rules.yaml` and
  `configs/guardrails_regex_rules.gitleaks.generated.yaml`.
- Distributed paths: `src/guardrails/rules/guardrails_regex_rules.yaml` and
  `src/guardrails/rules/guardrails_regex_rules.gitleaks.generated.yaml`.
- License source path: `LICENSE`; distributed full text:
  `LICENSES/Apache-2.0.txt`.
- NOTICE source path: `NOTICE`; the complete notice text relevant to these
  assets is reproduced below.

Original NOTICE attribution:

> guardrails-llm-filter
> Copyright 2026 Cloud.ru
>
> This product includes detection rules derived from the gitleaks project
> (https://github.com/gitleaks/gitleaks), licensed under the MIT License.
> See configs/gitleaks.toml and the generated
> configs/guardrails_regex_rules.gitleaks.generated.yaml.

### Donor rule parity fixture

- Disposition: mechanically transformed.
- Source:
  `cloud-ru-tech/guardrails-llm-filter@bbd6f27467a53ff3869b59449edf4209f85ae675`.
- Source path: `tests/rules/rules_cases_test.go`; SHA-256
  `b7eae600c5a1658a69f948ab355cbc25f2b48bdc9f64d3ad3793115711d91214`.
- Distributed test path: `tests/fixtures/guardrails-donor-rule-cases.json`;
  the Go table fields were converted to versioned JSON without changing case values.
- License: Apache-2.0; the full text is distributed at
  `LICENSES/Apache-2.0.txt`.

## Gitleaks rule configuration

- Disposition: upstream-derived configuration represented in the copied
  generated rule asset; the source configuration itself is not distributed.
- Source: `gitleaks/gitleaks@09242ce9c8a60d9b051fc2d166f9e849b88c7ac0`.
- Source configuration path: `config/gitleaks.toml`.
- Generated distributed path:
  `src/guardrails/rules/guardrails_regex_rules.gitleaks.generated.yaml`.
- License source path: `LICENSE`; MIT, Copyright (c) 2019 Zachary Rice.
  Distributed full text: `LICENSES/Gitleaks-MIT.txt`.

## re2-wasm runtime dependency

- Disposition: direct runtime dependency, not bundled in the OpenCodex tarball;
  OpenCodex loads the exact dependency-owned artifacts described below.
- npm package: `re2-wasm@1.0.2`.
- Source commit: `63796eaa20e1eea74466c0c56e2785a64f7ae372`.
- npm integrity:
  `sha512-VXUdgSiUrE/WZXn6gUIVVIsg0+Hp6VPZPOaHCay+OuFKy6u/8ktmeNEf+U5qSA8jzGGFsg8jrDNu1BeHpz2pJA==`.
- npm tarball SHA-1: `78c09dc651b8962aa814b55ae7fe5e472ec15bbb`.
- Installed path: dependency-owned `node_modules/re2-wasm`; no file from that
  directory is copied into the OpenCodex package tarball.
- OpenCodex modification: `src/guardrails/re2-runtime.ts` verifies the stock
  `build/wasm/re2.js` SHA-256, then modifies that loader only in process memory
  before evaluation. It raises the fixed initial WebAssembly heap from 16 MiB
  to 64 MiB and raises the validated imported-memory maximum from 256 to 1024
  pages. This prevents exhaustion while retaining all 266 reviewed rules. The
  installed dependency files and npm tarball remain unchanged.
- Adapted source path at the pinned commit: `src/re2.ts`
  (`escapeRegExp` and `translateRegExp`); Copyright 2021 Google LLC.
- Distributed adaptation path: `src/guardrails/registry.ts`
  (`escapeRe2Pattern` and `translateRe2Pattern`).
- License source path at tag `v1.0.2`: `LICENSE`; Apache License 2.0.
  Distributed exact full text: `LICENSES/re2-wasm-Apache-2.0.txt`.
- The package's `build/wasm/re2.js` is pinned by SHA-256
  `4bfa5d6a8dd0052da8d06baf171078a392dc9c70592d5dca90c9aefa9006336e`.
- The package's `build/wasm/re2.wasm` is pinned by SHA-256
  `79e025a30d20157807add5e7d01acefe700f06721f4a56669b0bad5d00995e72`.

## yaml runtime dependency

- Disposition: direct runtime dependency, not bundled in the OpenCodex tarball.
- npm package: `yaml@2.8.3`.
- Source repository and tag: `eemeli/yaml@v2.8.3`.
- npm integrity:
  `sha512-AvbaCLOO2Otw/lW5bmh9d/WEdcDFdQp2Z2ZUH3pX9U2ihyUY0nvLv7J6TrWowklRGPYbB/IuIMfYgxaCPg5Bpg==`.
- Installed path: dependency-owned `node_modules/yaml`; not copied into the
  OpenCodex package tarball.
- License source path at tag `v2.8.3`: `LICENSE`; ISC, Copyright Eemeli Aro.
  Distributed full text: `LICENSES/yaml-ISC.txt`.

## RE2 and node-re2 attribution

- RE2 source: `google/re2@166dbbeb3b0ab7e733b278e8f42a84f6882b8a25`,
  embedded by `re2-wasm` under `third_party/re2`; standalone license source
  path `LICENSE`, BSD-3-Clause; distributed exact full text:
  `LICENSES/Google-RE2-BSD-3-Clause.txt`.
- node-re2 attribution: `google/re2-wasm@63796eaa20e1eea74466c0c56e2785a64f7ae372`,
  adapted source under `third_party/node-re2`; license source path
  `third_party/node-re2/LICENSE`, BSD-3-Clause,
  Copyright (c) 2005-2020 Eugene Lazutkin; distributed full text:
  `LICENSES/node-re2-BSD-3-Clause.txt`.
