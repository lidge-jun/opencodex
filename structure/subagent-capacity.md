# Subagent Surface And Capacity

Surface and limit settings are independent of [subagent roster ordering](subagents.md).

## Multi-agent surface selection

`OcxConfig.multiAgentMode` controls the `multi_agent_version` field stamped on catalog entries:

| Mode | Behavior |
| --- | --- |
| `"v1"` | Force ALL entries to `multi_agent_version = "v1"` ??overrides upstream pins (sol/terra included). |
| `"default"` | Respect upstream model pins (sol/terra=v2, luna=v1, others=null ??codex feature flag decides). On sync, stale forced values are cleared and upstream pins restored. |
| `"v2"` | Force ALL entries to `multi_agent_version = "v2"` ??overrides upstream pins (luna included). |
| `"v2-plaintext"` | Select V2 catalog pins for every model, enable the experimental plaintext task compiler, and disable the global override. Explicit opt-in; existing history is not rewritten. |

The override is applied as a final pass in both `buildCatalogEntries` (live `/v1/models` path) and
`mergeCatalogEntriesForSync` (on-disk sync), AFTER all normalization and visibility processing. This
ensures `normalizeRoutedCatalogEntry` (which deletes `multi_agent_version` from routed entries) does
not clobber the forced value.

`src/server/codex-model-list.ts` uses the shared mode resolver before building live rows, including
`v2-plaintext`; retained native priority evidence and read-only catalog discovery remain intact.

`"v2-plaintext"` is a separate explicit opt-in: all catalog rows receive `multi_agent_version = "v2"`, the global feature is disabled, and the existing [plaintext V2 compiler](subagents.md#plaintext-v2-agent-messages) is enabled. The OpenCodex mode literal is never sent as a Codex model pin. Stored `keepNativeChatGptOnV1` and `plaintextV2AgentMessages` preferences are preserved; the former is inactive in this mode. Existing configurations never migrate into it automatically. Existing chats retain native history/session selection: catalog pins affect new chats, but the compiler follows the current setting on subsequent eligible canonical ChatGPT requests, including existing V2 sessions. No stored-history rewrite, ciphertext decryption or deletion of retained copies occurs when the setting changes.

Entering this mode through `PUT /api/v2` requires `plaintextAgentMessagesAcknowledged: true`; re-saving the same mode is idempotent. The CLI requires `--acknowledge-plaintext-agent-messages` for the same transition. The dashboard advertises it only when `supportsPlaintextV2Mode` is true and asks for explicit confirmation of task-text retention before one mode write. GET/PUT expose the derived `plaintextAgentMessagesEnabled` state. Enabling the global V2 override while the mode is selected is rejected before writes. Selecting another mode restores its ordinary policy, without clearing an independently enabled legacy plaintext field. No automatic fallback or provider retry is added.

A forced pass records each row's pre-override value once, in `opencodex_multi_agent_version_origin`
(a string pin, or null for none); repeated forced passes never replace it. Returning to `"default"`
consumes the record. Pristine baseline and native pins still win; the record only decides a native
row the baseline predates, which previously kept the forced stamp because an absent baseline entry
cannot tell a stale forced value from a genuine pin (issue 5636). Rows written before the record
existed keep that non-destructive read.

`getDefaultConfig()` (`src/config/proxy-env.ts`) writes `multiAgentMode: "v1"` explicitly, using the version
constant from `src/config/multi-agent-surface.ts`, so v1 is the install default while a v2
native-to-routed child task is undeliverable ciphertext. The repair and salvage merges in
`src/config/diagnostics.ts` pin `multiAgentMode` and `multiAgentSurfaceAdvisoryVersion` to the stored
document, because spreading the defaults underneath would repair an unrelated missing field
into a surface change its operator never made.
An absent key still means `"default"`, because selecting base deletes the key ??absence cannot be
read as "never configured". An install that predates that change is therefore not rewritten; it is
asked once. `multiAgentSurfaceAdvisoryRequired()` is true while the resolved mode is base or v2 and
the stored `multiAgentSurfaceAdvisoryVersion` is below `MULTI_AGENT_SURFACE_ADVISORY_VERSION`, and
only the operator answering the dashboard notice writes that version.

CLI: `ocx v2 mode v1|default|v2|v2-plaintext` (plaintext entry requires the acknowledgement above). GUI: segmented control on the Models page. API: `GET/PUT /api/v2`
with `multiAgentMode` field.

The `multi_agent_v2` feature flag and the logical maximum thread count are separate from
`multiAgentMode` (`src/codex/features.ts`): the mode decides which surface Codex advertises, while
the flag and thread count decide what the native runtime allows.
Because the global feature has precedence over catalog pins, Codex config injection reconciles it
to disabled whenever persisted OpenCodex mode explicitly selects v1 or v2-plaintext. This includes a fresh install
on a Codex home that had previously enabled v2; external-provider ownership and read-only injection
preflight still prohibit that write. The transition runs inside the same write lock and preimage as
the rest of injection, so a later refusal rolls the flag back with the files.

`keepNativeChatGptOnV1` makes mode `v2` a catalog-driven hybrid: OpenCodex disables the global
`multi_agent_v2` override because codex-rs resolves that override before a model row's explicit
`multi_agent_version`. Native ChatGPT rows then select v1 from the catalog and routed rows select
v2. An explicit attempt to enable the global flag while the hybrid pin is active is rejected.

### Concurrent child limit

The Models page's Model settings panel exposes one subagent limit control in v1, base, v2 and v2-plaintext,
including hybrid mode with the global `multi_agent_v2` flag disabled. Its displayed value counts
children only. Surface selection and capacity are independent; raising the cap neither spawns
children automatically nor guarantees faster execution.

`GET/PUT /api/v2` retains its existing `maxConcurrentThreadsPerSession` units: with `enabled: false`, N means N
children; with `enabled: true`, N+1 includes the primary thread. The GUI subtracts one for display
and adds one on save only when that global flag is enabled. Catalog-selected v2 in hybrid mode
does not change those API units. A stored V2 total of 1 displays zero children in both the
selector and folded summary; new child-limit edits still require at least 1. Both the child
input and converted API value must be safe integers. PUT rejects unsafe API limits with 400
before toggles or configuration writes. An unset limit leaves the default to the native runtime.
New sessions consume limit changes; a long-running App host may need a normal restart.

`src/codex/features.ts` reads and writes the canonical `[agents].max_concurrent_threads_per_session`
child limit, falling back to the legacy `max_threads` alias. Equal-valued aliases normalize to
the canonical key on write; conflicting aliases refuse a write unless an explicit replacement
limit resolves them. Unsupported or unsafe writes refuse before mutation. With the global v2
flag disabled, a limit edit updates the canonical child count and removes a stale feature-level
v2 limit without enabling that flag. These rules establish configuration consistency; they do
not attest the effective capacity of a running native or routed session.
CLI and dashboard global-v2 conflict warnings name both supported agents keys.
