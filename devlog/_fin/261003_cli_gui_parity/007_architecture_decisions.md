# Architecture decisions

The reader is a maintainer reviewing named terminal workflows. Existing domain handlers and the existing management client remain the execution authority; the capability index becomes an accurate, scalable discovery layer.

| Decision | Main disposition | Consequence |
| --- | --- | --- |
| CP-ARCH-01 | Accept fixed named metadata with handwritten domain handlers | No arbitrary method/URL API client, no generic config fallback counted as parity. |
| CP-ARCH-02 | Amend: reuse Capability, without NamedCommandMeta/DomainCommand interfaces | Split type/data files only for size and pure-import boundaries. Handler signatures remain compatible. |
| CP-ARCH-03 | Accept existing server validation/persistence/ownership | CLI parses grammar and bounded input; no second persistence engine or live-to-local fallback. |
| CP-ARCH-04 | Accept additive optional Capability.usage | Exact operand grammar is available for verified leaves; old metadata output stays compatible when absent. |
| CP-UX-01/02 | Accept fixed grammar, explicit JSON sources and scoped confirmation | Ordinary reversible changes do not gain gratuitous confirmation. Destructive actions preserve --yes and identity checks. |
| CP-UX-03 | Amend: preserve legacy stderr prose and exit codes | No global JSON error-envelope migration. New diagnostics are safe and retain reason/hint/status. Partial receipts remain observable. |
| CP-UX-04 | Scope observational claims | Help remains offline/write-free. Do not promise all legacy reads bypass shim preflight; new strict observational paths need their own proof. |
| CP-AUDIT-01/02 | Accept task ledger plus separate API debt | Counts are not endpoint-prefix coverage. Local/native equivalence, duplicate GUI entry points and consent exclusions are explicit. |
| CP-SIZE-01 | Accept capacity work before metadata expansion | Split generated reference into flat domain chapters; add a CLI structure owner by moving existing contracts, never raising line caps. |
| CP-TEST-01 | Accept handler-wire, real route, CLI and negative evidence | No live user state/upstream traffic. Source declarations are not runtime proof. |
| CP-DATA-01/02 | Accept bounded credentialless malformed-body observation before a chosen-key model probe | Fail unavailable on unproved enforcement, preserve existing server policy, and state the cross-request identity/policy limits; exact mechanism and real-route tests are in 070. |
| CP-DELIVERY-01 | Accept dependency slices with sequential branch ownership | Main alone switches branches; implementation leaves have disjoint file scopes. Six manual PR layers, each with its own CI. |

## Local and live are explicit targets

Preserve offline/local commands. Add --live to provider add/remove/set-default, custom models add/remove, v2 and logout where the source comparison proves different retained runtime state or receipts. Decide the target before touching local config. A multi-request workflow resolves its management base once and reuses it. A refusal never falls back to local writes. --json is output selection, never target selection.

For Desktop, use the existing namespace with profile show/import for the live desired profile; existing show/move/default/import remain local and apply remains separate. Management commands run on the serving runtime host, including a Hub; a connected-client management refusal remains a refusal. No remote admin credential scheme is introduced.

## Capability usage field chain

Creation: optional usage literals in pure capability domain files; type in src/cli/capability-types.ts. Serialization: capabilities-command.ts uses an explicit field projection; it must add usage conditionally while retaining the exact legacy shape for declarations without it. A real runCapabilities --json fixture verifies the field is not silently dropped. Deserialization: N/A, no persisted/external capability ingestion is introduced. Consumers: declared help renderer and generated reference use usage beneath canonical headings; command matching/recovery and capabilityInvocation remain based on command tokens. Tests cover absent-field compatibility, exact grammar, alias resolution and pure import closure.

## Input and result boundaries

New JSON file/stdin input is explicit, bounded to the management JSON contract (4 MiB), rejects interactive waiting, invalid UTF-8/JSON and wrong top-level shapes, and never echoes payloads. Domain files validate keys/shapes and reuse pure existing validators where appropriate. Composite requests are checked against the whole serialized body limit. Never read stdin twice in one invocation.

Server errors retain their normal exit classification. A new safe nested-error projection in runtime-api preserves an existing nested code/message without dumping the raw body. Domain writers distinguish saved, applied, deferred, conflict and unknown completion; no blind write retry. Human text uses terminal escaping. JSON success remains the safe existing DTO, not a universal new envelope.

## Explicit scope for data-plane tools

The API Keys page's selected-key test, audio transcription and connection-only live probe are included as terminal tasks. They use a dedicated fixed data-plane transport with an explicit stdin key, never management auth or arbitrary URLs. Browser microphone capture/playback and waveform controls are presentation exclusions. No secret-returning creation/pairing operation is executed by the development agents.

## Consultation provenance

Architect: Epicurus, returned handle 01a1021d-2d94-7d20-95c1-a18da31958a8. Proposal and decision amendment are retained in task scratch. The architect accepted optional usage with exact legacy fallbacks and accepted retaining existing v2 roots after main corrected an inventory false-negative. Whole-plan reflection by the same architect is ALIGNED for SHA256 a095a4e514d6d8e5a37dbf05a66b2c9156ebaeeb28a8e0fb878bc76f931c27b1: all 178 IDs, unit assignments and acyclic aliases were checked, with no essential mismatch. This is separate from the earlier concept agreement. Reflection artifact is retained in task scratch; its decision mapping covers every accepted CP decision. Independent A remains a separate gate.
