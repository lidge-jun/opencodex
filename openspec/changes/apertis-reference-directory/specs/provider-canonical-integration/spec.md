## ADDED Requirements

### Requirement: Apertis is a canonical API-key provider
The provider registry SHALL expose Apertis as a canonical key provider with label `Apertis`, the
`openai-chat` adapter, base URL `https://api.apertis.ai/v1`, the documented dashboard URL, and live
model discovery enabled. The registry SHALL NOT freeze a static model list or default model for
the mutable key-scoped catalog.

#### Scenario: Canonical setup surfaces derive Apertis
- **WHEN** CLI init, key-login, dashboard preset, and provider catalog surfaces are derived
- **THEN** each surface contains `apertis` with key authentication, the fixed base URL, and live discovery

#### Scenario: Live catalog remains the source of available models
- **WHEN** a fresh Apertis provider is created without an explicit model list
- **THEN** the saved provider enables live discovery and does not claim a static model list or default model

### Requirement: Apertis key validation and discovery use the authenticated models endpoint
The key-login flow SHALL call `GET https://api.apertis.ai/v1/models` with `Authorization: Bearer <key>`
and SHALL treat an OpenAI-shaped model list as the live catalog. A 401 or 403 response SHALL reject
the key; other non-success or transport failures SHALL remain unknown rather than becoming a false
positive. Discovery SHALL use the repository's bounded response, row, and model-id guards.

#### Scenario: Valid key returns an OpenAI-shaped catalog
- **WHEN** the models endpoint returns a bounded `{ "object": "list", "data": [{ "id": "..." }] }` response
- **THEN** key validation succeeds and discovery exposes the returned model ids under `apertis/<model>`

#### Scenario: Unauthorized key is rejected
- **WHEN** the models endpoint returns HTTP 401 or 403
- **THEN** key validation returns false and does not persist the key as valid

#### Scenario: Uncertain upstream failure is not a false positive
- **WHEN** the models endpoint times out, returns a transport error, or returns another non-success status
- **THEN** key validation returns unknown and discovery does not cache an untrusted catalog

### Requirement: Apertis routing preserves the configured custom boundary
Requests for canonical Apertis models SHALL use the `openai-chat` adapter, Bearer authentication,
and the canonical `/chat/completions` destination. A manually configured provider named `apertis`
whose adapter or destination differs from the canonical preset SHALL retain its own adapter, base URL,
model id, and key boundary.

#### Scenario: Canonical chat request uses the Apertis host
- **WHEN** a request selects `apertis/<model>` from a canonical provider config
- **THEN** the request targets `https://api.apertis.ai/v1/chat/completions` with the configured Bearer key and model id

#### Scenario: Same-named custom provider is not retargeted
- **WHEN** a saved `apertis` provider has a custom adapter or base URL
- **THEN** routing and model discovery use that saved adapter/destination instead of the canonical Apertis host

### Requirement: Canonical-provider evidence remains explicit and review-gated
The change record and PR SHALL distinguish public endpoint, API, terms, and legal-entity evidence from
the maintainer-required private routing/resale authorization. The change SHALL NOT claim verified,
merge-ready, merged, or deployed status until a maintainer records the required authorization,
maintenance owner, verification date, security review, and required CI approval.

#### Scenario: Public evidence does not silently satisfy private authorization
- **WHEN** public Apertis documentation is present but maintainer routing/resale authorization is not recorded
- **THEN** the implementation may remain locally verified, but the PR remains explicitly not merge-ready
