# Azure OpenAI DefaultAzureCredential

## Goal

Add an explicit Azure identity configuration using the native Azure SDK while
preserving API-key behavior, preventing header confusion, and documenting the
Node 22 runtime baseline.

## Global Constraints

- Work test-first and retain RED/GREEN evidence in the SDD report.
- This is an authentication and dependency security boundary: never log,
  persist, fixture, or return tokens or raw SDK credential-chain diagnostics.
- Absent identity configuration preserves API-key behavior.
- Reject simultaneous API key and identity configuration.
- Strip conflicting auth headers case-insensitively before applying the chosen
  credential.
- Rely on the Azure SDK token cache; do not add another cache.
- Keep the optional-Lab boundary and adapter-registry authority intact.

## Task 1: Add strict Azure credential configuration and keyless admission

Add `azureCredential?: { type: "default-azure-credential";
managedIdentityClientId?: string }` to provider config. Validate it in the
shared provider-validation owner: Azure-only, nonempty trimmed client id,
mutually exclusive with `apiKey`. Update routing/key admission so this exact
Azure mode can route without an API key while all other key providers retain
their current fail-closed behavior.

Focused verification:

- Provider-validation, config, routing, and key-failover tests.

## Task 2: Implement redacted DefaultAzureCredential authentication

Add one Azure-specific helper that dynamically imports `@azure/identity`,
reuses a credential per configuration, passes the optional managed-identity
client id, and requests
`https://cognitiveservices.azure.com/.default`. Provide the narrow existing-
pattern test injection/reset seam. Identity mode emits exactly one Bearer
header and no api-key; API-key mode emits exactly one api-key and no
Authorization. Empty token and SDK failure return one stable redacted error.

Focused verification:

- Azure adapter and end-to-end routed-server tests, including mixed-case
  hostile static headers and no live Azure calls.
- `bun run privacy:scan`

## Task 3: Add the SDK and raise the runtime baseline

Add `@azure/identity@^4.13.2`, update the lockfile, raise
`engines.node` to `>=22.0.0`, and update only the Node 20 CI smoke job to
Node 22. Preserve newer jobs. Document the breaking runtime baseline and the
full DefaultAzureCredential environment/workload/managed-identity/developer
tool chain.

Focused verification:

- `bun run audit:high`
- `bun run privacy:scan`
- `bun run prepush`

## Task 4: Documentation and branch verification

Document configuration examples, mutual exclusivity, managed identity client
selection, scope, redacted failures, and API-key compatibility. Run focused
suites, audit/privacy checks, `bun run typecheck`, `bun run test`,
`bun run prepush`, and `bun --cwd docs-site run build`. Commit the plan and
implementation on `codex/provider-azure-identity`.
