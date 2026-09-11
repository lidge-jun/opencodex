# ADR-0030 — Stable service launcher (launchd and systemd)

- Contract owner: [ops/service-and-sidecars.md](../ops/service-and-sidecars.md#stable-service-launcher-launchd-and-systemd)

## Decision record

- 목적과 의도: Keep systemd services upgrade-stable without losing an explicitly trusted Bun override or accepting a non-executable PATH placeholder.
- 기존 구현 및 제약 조건: Version managers replace package trees but retain lexical shims; Bun dotenv makes ambient override values untrustworthy unless the Node launcher already stamped matching runtime provenance.
- 검토한 주요 대안: Bake the package Bun and CLI forever; resolve the shim target; accept the first existing PATH entry; drop every runtime override in launcher mode; or preserve only a proof-bound override.
- 선택한 방식: Require a regular executable lexical launcher, resolve it once during installation, preserve only `durableBunRuntime().source === "override"`, and keep token loading in the existing file-backed shell preamble.
- 다른 대안 대신 이 방식을 선택한 이유: Resolving or pinning package paths recreates upgrade restart loops, existence-only selection can name a directory or non-executable file, and dropping a trusted override silently changes an operator's runtime.
- 장점, 단점 및 영향: Mise/asdf-style upgrades keep working and explicit Bun selection survives; source installs still use the direct pair, while a removed or non-executable launcher requires `ocx service repair`.
