## ADDED Requirements

### Requirement: Unverified providers remain inert reference entries
The provider directory SHALL represent a provider lacking integration authorization in the
`reference-only` access group. Such an entry MUST use the reference support level and unverified
verification state, MUST NOT claim an access entitlement or verification date, and MUST NOT define
a usable upstream endpoint or live-model discovery.

#### Scenario: Apertis is listed without an integration claim
- **WHEN** consumers inspect the Apertis directory row
- **THEN** it is `reference-only`, unverified, endpoint-free, and has unsupported discovery

### Requirement: Reference entries do not become canonical providers
A `reference-only` directory entry SHALL NOT appear in the canonical provider registry or any
derived key-login, initialization, or dashboard preset list. It SHALL NOT be classified as a GUI
catalog provider.

#### Scenario: Apertis is absent from canonical provider surfaces
- **WHEN** canonical provider surfaces are derived
- **THEN** no Apertis runtime preset, key validator, or catalog-provider classification exists

### Requirement: Same-named custom providers retain their destination
Routing a manually configured provider whose id matches a `reference-only` directory row SHALL use
the configuration's own adapter and base URL without registry enrichment or redirection.

#### Scenario: Custom Apertis configuration routes unchanged
- **WHEN** a user configures `apertis` with a custom adapter and base URL
- **THEN** a request for `apertis/<model>` retains that adapter, base URL, and model id
