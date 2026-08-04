## Context

Canonical registry entries seed provider configuration, expose API-key setup, enrich saved
providers, and feed routing and the shared Codex catalog. Apertis's official API documentation
currently describes the OpenAI-compatible base URL `https://api.apertis.ai/v1`, Bearer
authentication, and an authenticated `/v1/models` endpoint whose result depends on the API key
type/plan. Apertis's public website identifies STIMA AI LLC as the operator and describes
multi-provider routing.

The upstream repository requires additional private routing/resale authorization and maintainer
security review before a credential-destination preset can merge. This change therefore implements
the requested canonical behavior and records that external gate honestly; it does not infer private
authorization from public product or API documentation.

## Goals / Non-Goals

**Goals:**

- Register Apertis as a canonical `authKind: "key"`, `adapter: "openai-chat"` provider.
- Seed the documented fixed base URL and dashboard URL into CLI/key-login/dashboard flows.
- Validate keys and discover model ids through the authenticated OpenAI-shaped `/models` path.
- Route chat-completion requests to the canonical host while preserving same-named custom
  providers' own adapter, destination, and credentials.
- Keep model availability live and key-scoped rather than encoding a speculative static catalog.
- Keep public evidence links and the private maintainer authorization gate separate.

**Non-Goals:**

- Add a new adapter, Responses wire, image/audio integration, or provider-specific request
  semantics beyond the existing OpenAI Chat adapter.
- Freeze model ids, context windows, prices, or a default model from the mutable live catalog.
- Claim that public endpoint/terms/legal-entity evidence proves private routing/resale authorization.
- Send credentials, post maintainer messages, push the branch, merge, or deploy as part of local
  implementation.

## Decisions

- **Extend the existing registry-derived provider flow.** This keeps CLI init, key-login,
  dashboard presets, routing, and catalog derivation on one source of truth instead of adding an
  Apertis-specific path.
- **Use live discovery with the default `/models` resolution.** The configured base URL already
  ends in `/v1`, so the existing discovery and key-validation flow produces `/v1/models`, sends a
  Bearer key, and applies the repository's bounded response/row guards. A registry-specific
  discovery policy is unnecessary for the documented endpoint.
- **Set `preserveCustomDestination: true`.** A saved provider named `apertis` with a custom
  adapter/base URL must not be silently retargeted when the canonical preset is introduced.
- **Do not add static models or a default model.** Official documentation says availability varies
  by key type and plan; live discovery is the faithful contract and avoids stale claims.
- **Use the existing GUI display-name classification without inventing an icon asset.** The provider
  remains discoverable and correctly labeled while the default unknown-provider icon fallback stays
  intact.
- **Keep the evidence gate outside runtime behavior.** Public API/terms/legal-entity links are
  recorded in source/docs; private routing/resale authorization remains a maintainer review input.
- **Keep GUI validation runtimes explicit.** ESLint continues to use Bun's runtime bridge, while
  React Doctor uses npm exec with pinned TypeScript and React Doctor packages so Bun cannot omit
  React Doctor's TypeScript peer.

## Risks / Trade-offs

- [A user key and traffic reach a multi-provider gateway] → fixed-host routing, explicit public
  provenance, `preserveCustomDestination`, and maintainer/security review are required before merge.
- [The live catalog changes by key/plan] → no static model list/default is claimed; discovery is
  bounded and fixture-tested.
- [A same-named custom provider could be disabled in GUI classification] → the canonical entry's
  destination-preservation contract and regression test keep custom adapter/base URL controls intact.
- [Public docs may be mistaken for private authorization] → the change records public evidence and
  the unresolved routing/resale gate separately.
- [A GUI validation command could lose its local TypeScript peer under Bun] → ESLint scripts use
  Bun's runtime bridge and React Doctor scripts use npm exec with explicit TypeScript and React
  Doctor packages; direct external invocations remain outside this repository contract.

## Migration Plan

Fresh Apertis setup derives the canonical fixed destination. Existing saved `apertis` providers
retain their configured adapter, base URL, and key when they do not match the canonical transport.
Rolling back removes the preset surfaces but does not rewrite or delete existing provider config;
explicit custom routes remain user-owned.

## Open Questions

- Which maintainer-designated private channel will record the routing/resale authorization, named
  maintenance owner, and verification date required for merge?
- After the current head is reviewed, does the maintainer require any provider-specific capability
  exclusions beyond the existing `openai-chat` contract?
