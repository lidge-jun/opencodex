# ADR-0100 — decision recorded under "Stable service launcher (launchd and systemd)"

- Contract owner: [ops/service-and-sidecars.md](../ops/service-and-sidecars.md#stable-service-launcher-launchd-and-systemd)

## Decision record

- 목적과 의도: Stop launchd from handing the service API token and proxy environment to a PATH-discovered `ocx` launcher: a mutable version-manager shim could be replaced after installation and would then run with those secrets. Keep systemd services upgrade-stable without losing an explicitly trusted Bun override or accepting a non-executable PATH placeholder.
- 기존 구현 및 제약 조건: Version managers replace package trees but retain lexical shims; Bun dotenv makes ambient override values untrustworthy unless the Node launcher already stamped matching runtime provenance. The launchd plist carries credential-bearing service state, which a replaceable launcher inherits on every start.
- 검토한 주요 대안: Keep sharing the launcher between launchd and systemd; bake the package Bun and CLI on both platforms; resolve the shim target; or pin launchd to the package pair while systemd keeps the launcher.
- 선택한 방식: Require a regular executable lexical launcher for systemd, resolve it once during installation, preserve only `durableBunRuntime().source === "override"`, and keep token loading in the existing file-backed shell preamble. Keep launchd pinned to the package runtime selected by the trusted install or repair invocation: `buildPlist` accepts but ignores `deps.launcher`, `installLaunchd` performs no PATH discovery and records no `launcherPath`, and a `launcherPath` recorded by an older install reports stale so `ocx service repair` re-bakes the package paths.
- 다른 대안 대신 이 방식을 선택한 이유: Sharing the launcher leaves the credential-handing flaw open; baking package paths on systemd recreates the upgrade restart loops the launcher removed; resolving the shim target only renames the trust problem.
- 장점, 단점 및 영향: Mise/asdf-style systemd upgrades keep working and explicit Bun selection survives; source installs still use the direct pair, while a removed or non-executable launcher requires `ocx service repair`. Launchd users must repair after an upgrade changes package paths, in exchange for not trusting a replaceable shim with service credentials.
