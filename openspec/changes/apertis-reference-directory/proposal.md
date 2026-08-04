## Why

Apertis publishes an OpenAI-compatible API at `https://api.apertis.ai/v1`, uses Bearer API keys,
and exposes a key-scoped live `/v1/models` catalog. The current PR intentionally removed the
canonical entry and therefore no longer meets the requested outcome of adding Apertis as a model
provider.

## What Changes

- Restore Apertis as a canonical API-key provider in the registry-derived CLI, dashboard, key-login,
  routing, and model-discovery surfaces.
- Use the documented fixed base URL and authenticated live model discovery without freezing a
  mutable model list or claiming a default model.
- Preserve same-named custom providers' adapter, destination, and key boundary.
- Add focused coverage for derivation, Bearer validation, live discovery, chat routing, and custom
  provider preservation.
- Sync the provider catalog documentation and translated tables/counts.
- Retain the existing Bun-based GUI lint runtime fix and make React Doctor's TypeScript peer
  resolution explicit for Bun-launched validation.
- Keep the maintainer-required routing/resale authorization and security review as an explicit
  pre-merge gate; public endpoint/terms/legal-entity evidence must not be presented as proof of
  private authorization.

## Capabilities

### New Capabilities

- `provider-canonical-integration`: expose Apertis as a canonical key provider with authenticated
  live model discovery and fixed-host routing.
- `gui-lint-runtime`: execute GUI lint and React Doctor validation with runtimes that preserve
  the repository's local TypeScript tooling.

### Modified Capabilities

<!-- None. The previous reference-only contract is replaced by the canonical integration capability
in this still-unmerged change. -->

## Impact

- `src/providers/registry.ts`, registry derivation, key validation, GUI provider classification,
  and provider parity gain the `apertis` canonical entry.
- `tests/apertis-provider.test.ts`, the discovery fixture, and registry parity tests prove the
  provider contract without contacting the live service.
- English and translated `docs-site` provider guides list the new endpoint and updated counts.
- `gui/package.json` lint commands continue to use Bun's runtime bridge, while React Doctor
  commands use npm's explicit package resolution instead of a Bun-translated `npx` launch.
