# Script and release-tooling instructions

This file applies to `scripts/` and inherits the repository-wide rules in `/AGENTS.md`.

## Safety boundary

- `scripts/release.ts` is the release authority.
- Release, publish, version-bump, deployment, and package-signing behavior is maintainer-controlled.
- Never run `bun run release`, a publish command, or a deployment command unless the task explicitly requires the action and `MAINTAINERS.md` permits it.
- Changes to release, packaging, dependency-installation, credential, or repository-automation scripts require explicit security review.

## Implementation rules

- Preserve Linux, macOS, and Windows behavior. Do not add shell-specific assumptions to cross-platform scripts.
- Use explicit paths, deterministic inputs, bounded resource use, and actionable failures.
- Use atomic replacement for files whose partial write would corrupt configuration, package metadata, release state, or recovery data.
- Do not log secrets, tokens, request bodies, account identifiers, private paths, or personal data.
- Do not weaken dry-run, exact-commit, CI-success, or explicit-confirmation gates.
- Generated package assets must be produced by the owning preparation command, not edited manually.

## Required validation

- Run focused tests or probes for the changed script.
- Run `bun run typecheck`.
- Run `bun run privacy:scan` when the script handles configuration, credentials, requests, logs, or account data.
- Run `bun run prepush` for release, packaging, dependency, or cross-platform tooling changes.
- Report any platform-specific validation that was not executed.
