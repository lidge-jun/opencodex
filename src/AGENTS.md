# Source runtime instructions

This file applies to `src/` and inherits the repository-wide rules in `/AGENTS.md`.

## Runtime and module rules

- `src/` is Bun-native TypeScript in strict mode and uses ES modules only.
- Do not assume a separate server compilation step.
- Prefer Bun and Web-platform APIs. Introduce a Node-only runtime dependency only when the task explicitly requires compatibility code and the owning module already has that role.
- Preserve existing public exports and configuration compatibility unless the task explicitly changes them.
- Read the applicable documents in `structure/` before changing shared routing, adapters, transports, sidecars, authentication, configuration, or server architecture.

## Implementation rules

- Follow the existing subsystem boundaries and naming patterns.
- Do not combine unrelated responsibilities to avoid creating another large shared module.
- Handle asynchronous failures at request, transport, and sidecar boundaries. Optional integrations must degrade through the existing failure representation rather than crash the request path.
- Provider catalog metadata belongs in the canonical provider registry and derivation flow. Do not duplicate provider facts across independent pickers or seeds.
- Adapter changes must preserve the internal event contract, streaming behavior, tool calls, cancellation, error mapping, and image handling relevant to that adapter.
- Authentication, OAuth, token, credential, management API, and CORS changes are security-boundary changes.

## Tests and validation

- Place focused regression coverage near the existing tests for the affected subsystem.
- For focused behavior, run the relevant `bun test tests/<name>.test.ts` and `bun run typecheck`.
- If the change set is broader than one file, run `bun run test:changed` instead of the full suite.
- Run `bun run test` only before marking a PR review-ready, or when the user explicitly asks for the full suite.
- For logging, requests, credentials, account data, or fixtures, also run `bun run privacy:scan`.
- Update `docs-site/` when the change affects user-visible behavior or configuration.
