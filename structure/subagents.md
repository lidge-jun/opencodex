# Subagents And Multi-Agent Surface

Subagent quota priming remains separate from automatic activation scheduling. See the [quota activation contract](providers/openai-tiers.md#public-provider-contract).

Native result continuations and function-result injection follow [the mode-specific result and control contract](transports/streaming-health.md#experimental-native-function-result-injection); this surface does not infer upstream support or alter its defaults.
Explicit Codex CLI installation observation does not attest the runtime used by a subagent or change agent selection. See the [read-only observation contract](runtime.md#explicit-codex-cli-installation-observation).

Native steering follows [the shared WebSocket contract](transports/streaming-health.md#experimental-native-mid-turn-steering); this surface's defaults remain unchanged.

Encrypted-task and fallback request handling follow the Responses
[core module ownership](transports/responses.md#core-module-ownership). This surface retains its existing behavior.
For policy-selected turns, both subagent selection and the post-recovery selection retain the
[original policy authorization](transports/policy-fallback.md);
ordinary subagent fallback configuration does not authorize a destination outside that evaluation.

Catalog HTTP acquisition follows the [proxy-routing contract](catalog.md#remote-catalog-http-proxy-routing).

Concurrent refreshes triggered by independent agent work share the [credential refresh-lock contract](catalog.md#accounts-namespaces-and-pool-rotation); unknown lock identity remains available for stale recovery rather than immediate removal, and a failed path probe cannot mask the callback outcome. Cooperating lock metadata changes serialize through the existing SQLite mutation transaction; release keeps the descriptor open through identity comparison and any unlink, then closes it. Failed metadata writes remove only a matching owned path after successful coordination; unknown identity, failed probes or unavailable coordination retain the path for stale recovery. Async refresh work holds no metadata transaction.

CLI installation inspection reason codes, including Windows deferral, follow the [runtime inspection contract](runtime.md#lifecycle).

## Plaintext V2 agent messages

`src/responses/plaintext-v2-agent-messages.ts` owns the experimental, configuration-only
`plaintextV2AgentMessages` request compiler and response restoration. The default is unset;
only explicit true on Responses ingress to the final canonical ChatGPT forward route activates it.
A default collaboration catalog is required: top-level `tools`, or, when that field is absent,
the first input item's developer `additional_tools` catalog used by Responses Lite. Explicit
top-level catalogs take precedence; user-role and later historical catalogs do not opt in.
The compiler preserves caller objects,
aliases the namespace and three message functions, and removes only their true encryption marker.
Declaration/reference collisions refuse the whole rewrite without changing the request.

`src/adapters/openai-responses.ts` returns request-local alias capabilities. The Responses core
refreshes them after every request rebuild and restores JSON, SSE and WebSocket identities after
snapshot repair. Malformed, conflicting, unsupported or over-limit responses fail closed without
retrying the model. Raw stream inspection cannot publish plaintext continuation state: only
restored client blocks reach its dedicated bounded collector. Foreign namespaces and opaque
argument/metadata values remain unchanged; the empty encrypted-function-args marker is preserved.
For a streamed response whose content type is missing or is neither `application/json` nor a
recognizable event stream, the native passthrough reads at most the first 4 KiB to confirm a
Responses SSE event before restoring aliases; an `application/json` body takes the bounded JSON
path instead. That probe is bounded by the request's `stallTimeoutSec`: one total budget for the
prefix, plus a per-read inactivity window the arrival of a chunk restarts, so a drip-fed or silent
upstream fails closed instead of holding the turn open. A body that does not match still fails
closed, and its bytes never reach Codex as a successful response.

Startup warns that task text can remain in Codex history, selected-provider requests and local
response/debug state. This is application-level plaintext over HTTPS, depends on undocumented
upstream behavior, and does not decrypt existing tasks or replace authenticated recovery.

Restored calls and selectors carry an explicit collaboration namespace and unqualified child name.
Codex treats qualified names literally and defaults absent namespaces to functions. Only child
declarations inherit their restored namespace container; the compiler never invents an empty
encryption marker when the upstream omitted it or returned a nonempty marker.

Shared parsing and streaming follow the [request-copy](transports/byte-accounting.md#request-copy-accounting) and [stream-buffer accounting](transports/byte-accounting.md#stream-buffer-accounting) contracts. Response-attached WebSocket telemetry follows the [stage record identity contract](transports/responses-wire-shapes.md#passthrough-sse-stream-shapes-314).

Pool credentials used by subagent routes can be
[linked to Orca-managed homes](codex-home.md#orca-source-owned-account-import). The account-store
resolver enforces source identity and expiry before those credentials reach routing.

## Multi-agent surface mode (3-state)

See [surface selection and capacity](subagent-capacity.md#multi-agent-surface-mode-3-state) for the mode, global flag and hybrid configuration contract.

### Concurrent child limit

See [concurrent child limit](subagent-capacity.md#concurrent-child-limit) for GUI/API units and canonical Codex setting ownership.

### What the five-model `spawn_agent` window is, and how V1 differs from V2

`MAX_SPAWN_AGENT_MODEL_OVERRIDES = 5` (mirrored in `src/codex/catalog/subagent-roster.ts`) is **not** a
subagent concurrency limit and **not** an eligibility limit. Upstream uses it in exactly two
places: the model list rendered into the `spawn_agent` tool description
(`multi_agents_spec.rs:789`) and the "Available models:" suggestions in an unknown-model error
(`multi_agents_common.rs:448`, inside the `ok_or_else` closure that runs only *after* the lookup
already failed). The success path `find_spawn_agent_model_name` (`:431-442`) scans the whole
catalog with neither the cap nor a `show_in_picker` filter, so a model outside the advertised
five is still accepted when named exactly.

Three different numbers, often conflated:

| Quantity | Value | Source |
| --- | --- | --- |
| Models **advertised** as overrides | `min(5, picker-visible eligible rows)` | `multi_agents_spec.rs:785-790` |
| Models **eligible** as targets | no numeric cap (only `"disabled"` is excluded, and only on V2) | `multi_agents_common.rs:36-42` |
| **Concurrent** subagents | Configurable child limit, independent of the five-model window | [Concurrent child limit](#concurrent-child-limit) |

**The cap is the same 5 on both surfaces, but the window's contents are not.** The eligibility
filter runs *before* `.take(5)`, and it behaves differently per surface: on a V1 call
`model_supports_multi_agent_backend` short-circuits true for every row (including `disabled`
ones), while a V2 call drops `Some(Disabled)` first ??which lets a later row move into the five.
Same catalog, different advertised list:

| # | Model | pin | V1 advertises | V2 advertises |
| ---: | --- | --- | :---: | :---: |
| 1 | `v2-a` | `v2` | ??| ??|
| 2 | `disabled-a` | `disabled` | ??| ??|
| 3 | `v1-a` | `v1` | ??| ??|
| 4 | `null-a` | absent | ??| ??|
| 5 | `v2-b` | `v2` | ??| ??|
| 6 | `disabled-b` | `disabled` | ??| ??|
| 7 | `null-b` | absent | ??| ??|

opencodex already matches this: `effectiveSubagentRoster` filters with
`surface !== "v2" || isEligibleV2SubagentEntry(entry)`, so the V1 path skips the eligibility
filter exactly as upstream does. opencodex also injects no roster on V1
(`src/server/responses/collaboration.ts` emits only proactive text at the top effort tier), so
the upstream tool description remains the authority there.

Two further V1/V2 differences worth knowing: the list gate is
`hide_agent_type_model_reasoning` on V1 (hard-coded `false` at registration, so V1 always
advertises) but `expose_spawn_agent_model_overrides` on V2 (default `true`; when false the list
is omitted *and* the `model`/`reasoning_effort` schema fields are removed). And V2's
`hide_spawn_agent_metadata` defaults true, which removes `service_tier`.

`modelPickerOrder` (#1649) separates **OpenCodex guidance** from native advertisement.
`SPAWN_PRIORITY_FIELD` preserves the natural priority used by `effectiveSubagentRoster`, so
OpenCodex's preferred/guidance candidate calculation stays independent of display order.
Native Codex ignores that private field: its advertised five on V1 and exposed V2 follow the
native `priority` and may change when the picker is reordered. Exact-name override lookup is
not restricted to those five advertised rows. V1 receives no OpenCodex preferred-roster
injection; V2 can additionally receive natural-priority guidance when its catalog state permits.
The helper tests pin guidance behavior, not native tool-description equivalence.

A nonblank bare id in `modelPickerOrder` opts into complete-picker display ordering. Exact
ids take precedence over raw/encoded equivalents; routed-only and empty lists keep the legacy
ordering behavior. This does not change the separate `opencodex_spawn_priority` contract.
Retained rows recompute their natural ranks from the current featured roster and account-selector
stride before display order is applied, so a discovery outage cannot preserve an obsolete
featured or picker rank. Canonical `opencode-go` rows retain their configured reasoning ladder
and provider-scoped context metadata both when generated and when merged from retained catalog
state; `deepseek-v4.1-flash` therefore keeps its 1,048,576-token window, while synthetic max/ultra
choices are not added to that provider's declared ladder.
`meta-muse` declares `max` for both seeded models under the [Muse provider contract](providers-and-adapters.md), so routed-client catalogs can expose it without extending OpenCode Go's ladder.
The first-party DeepSeek `deepseek-flash` row declares native `text` and `image` input and therefore
does not require the vision sidecar by default; explicit `noVisionModels` or text-only declarations
remain authoritative. First-party `deepseek-chat`, `deepseek-reasoner`, and `deepseek-v4-flash`
remain sidecar-backed by default. OpenCode Go's `deepseek-v4.1-flash` was reclassified as native
vision on 2026-09-19 (probed on that gateway); its sibling `deepseek-v4-flash` stays sidecar-backed,
and the Zen tiers keep their classification because they could not be measured.

Full derivation with per-line citations: `devlog/_plan/260816_codexrs_multiagent_v2_and_history_perf/013_five_cap_v1_vs_v2.md`.

## Multipart encrypted task recovery

`src/server/responses/agent-task-recovery.ts` admits at most 32 consecutive, individually complete
Fernet-shaped parts with a combined 2 MiB ciphertext limit. Every encrypted slot must belong to
that run. The existing credential admission precedes cache access; the cache key is a JSON-encoded
fixed-order tuple of every addressing field (scope, parent thread, message type, task name,
recipient, sender, ciphertexts) rather than a delimiter-joined string, so no field content can shift
a boundary. One fixed-endpoint request forwards separate parts, and assignment
replacement compares the complete original item snapshot before splicing the run. Recovery output
is model-transcribed plaintext, not cryptographic fidelity proof. An opt-in `retries` bound — off
by default and capped at two extra sends — re-issues the same admitted request only on a transient
upstream status or a transport failure, inside the same deadline and shared flight; terminal
statuses, invalid output, and budget exhaustion keep the bounded refusal reasons unchanged.
Recovery recognises all four codex-rs message types (NEW_TASK, MESSAGE, FOLLOWUP_TASK,
FINAL_ANSWER); a FINAL_ANSWER envelope may omit the Task name line, in which case the
structured recipient is not cross-checked because the envelope names no recipient, and
admission remains the trust boundary.

`src/server/responses/encrypted-payload.ts` uses bounded concatenation only to recognize otherwise
unreadable split-token shapes. The sanitizer preserves just those fragment objects and continues
normalizing independent plaintext slots. Detection never authorizes reconstruction or recovery;
other fragment layouts and mixed readable content retain their documented residual boundaries.

## Routed agent-message ciphertext egress

Two questions about an `agent_message` were asked in two places, and the gap between them was
open. `hasUnreadableEncryptedAgentTask` asks whether the CURRENT worker task can be read and
inspects only the tail item; `normalizeRoutedAgentMessages` asks whether EVERY part can be lowered
onto a public message and forwards the private item verbatim when one cannot. An item mixing
`input_text` with `encrypted_content` is readable by the first measure and unlowerable by the
second, so it passed the guard, kept its private type through the raw Responses passthrough, and
left the process as backend ciphertext plus an item type only the Codex backend declares. The
destination answered `422 unknown item type "agent_message"` after the bytes were already sent.
Position was incidental: a replayed child result sits mid-history, where a tail-only scan cannot
see it, and the tail is exposed the same way once it is mixed.

The repair already existed reactively. `prepareOpaqueBlobRecovery` replaces an undecryptable part
with `[encrypted content omitted]`, which leaves the item lowerable, and it ran after an upstream
rejection. A destination that cannot accept the private item under any circumstances was never
going to answer that request, so the round trip only served to send the ciphertext.
`stripAgentMessageCiphertextInPlace` in `src/server/responses/encrypted-payload.ts` applies the
same repair before dispatch, and `src/server/responses/core.ts` runs it against the final route,
after `expandPreviousResponseInput`, after the sanitizer has rewritten plaintext parked in
encrypted slots, and after encrypted-task recovery has had its chance to produce real plaintext
instead of a marker.

The two kinds of slot are judged differently, because they carry different guarantees. An
`encrypted_content` slot holds ciphertext by definition, so it is stripped whatever it holds:
demanding a well-formed token there would reopen the same defect one payload later, since a
truncated token, a standard-base64 blob carrying `+` or `/`, an unexpected version byte, or a run
past the recovery size limits would each keep the item and forward the bytes. A text part carries
no such guarantee, so it is matched strictly -- embedded runs that validate as Fernet, or a whole
slot with the Fernet wire shape, which is the version prefix, the base64url alphabet and a
canonical length of at least 100 divisible by four. Adjacent text fragments are joined before that
test, so a token split across slots is still caught. `looksLikeBackendCiphertext` is deliberately
NOT used on text: it is length >= 64 over a character class that a SHA-256 digest matches exactly
at 64 characters, and replacing a digest a child deliberately printed would delete readable content
to protect bytes that were never secret. Other item types are untouched: reasoning and
function-output blobs keep the reactive opaque-blob recovery, which still rescues a destination
that merely failed to decrypt something it was entitled to read, and which stays reachable for the
canonical backend and for explicitly trusted routes.

The repair resolves the same wire override the adapter is built from rather than restating routing
policy, and runs for `openai-responses` whenever the destination is not the canonical Codex
backend. `authMode: "forward"` is deliberately not that test: it describes how this proxy treats
credentials, not who answers, and a forward-configured gateway at another origin receives the
ciphertext like any third party. Only `isCanonicalOpenAiForwardProvider` is exempt, because it
alone minted these bytes and can read them. The wire override matters for the reported destination,
where the provider row names the Chat wire and a registry model default moves the model onto
Responses. Translated wires are untouched because `inputContentParts` drops an encrypted part
instead of forwarding it, and `canPassThroughEncryptedV2AgentTask` keeps an explicitly trusted
route exempt. Combo children run the repair themselves: `concreteComboRequestBody` gives each
target its own `structuredClone` and its own concrete route, so a sibling's repair is invisible to
them and a target resolving to a routed Responses wire would otherwise send what the parent's own
dispatch no longer does.

Nothing here decrypts, and the tail agent_message envelope (any of the four codex-rs
message types) keeps `unreadable_encrypted_agent_task` and
its opt-in recovery unchanged: an unreadable current task still fails closed rather than reaching a
child with a marker where its assignment should be. An `agent_message` carrying unknown parts but
no ciphertext still reaches the wire unchanged and still draws the destination's own 422, which is
a compatibility gap rather than an egress one. Covered by
`tests/server/v2-agent-message-failfast.test.ts`.

## Subagents

New non-OAuth provider registrations carry `initialModelSelection` with a unique
registration identity. Until reliable live/static discovery completes, public
catalogs and model candidates withhold those providers' models; the provider itself
stays active. At 20 or more canonical Models switch rows, initialization appends
all corresponding disabled selectors once. Existing registrations and later manual
choices are not reinitialized. OAuth/ChatGPT forwarding is exempt using the same
key-mode override predicate as routing: a persisted `authMode: "key"` on an
opted-in OAuth preset is honored even while its credential cannot be resolved
(paused last key, missing env reference, disabled pool), so that row registers
as pending rather than as an OAuth login. Display aliases do not add switch rows.

`src/providers/initial-model-selection-runtime.ts` commits the decision against a
matching registration/inventory snapshot before catalog authority is captured.
Ordinary management discovery also completes it with Codex integration OFF. The
final catalog merge fences pending retained rows, including delete/re-add recovery.
Raw management rows remain visible as pending/OFF. Config listener bindings are
excluded from inventory identity because live and persisted bindings may differ.

Codex `spawn_agent` advertises only the highest-priority first five picker-visible catalog rows.
Use at most five configured `subagentModels` ids; they may contain bare catalog ids, routed
`provider/model` ids, or exact account-qualified `<selector>/<native-openai-model>` ids. The
dashboard offers bare native and routed choices; exact account-qualified choices are configured
through `ocx agent subagents set` or the opencodex configuration. Retired native rows are
excluded by the [shared catalog](catalog.md#shared-catalog); saved user choices are not rewritten
by that retirement. Quota fallback retains independent shared/Reserve evidence.

### Native source priority

`src/codex/catalog/native-priority.ts` owns native priority provenance for the builder and merge.
It accepts only safe integers in `0..1000`, trying the current discovered descriptor, pristine
catalog-backup baseline, the exact slug's retained `opencodex_native_source_priority`, then the
upstream snapshot, finally `9`. Invalid candidates are skipped. Published `priority` and
`opencodex_spawn_priority` never supply source provenance. Every ordinary emitted native row
carries its unbanded source value; `src/codex/catalog/derive-entry.ts` strips it from template clones.
Featured bare rows retain their rank. With a nonempty featured list, unfeatured bare natives use
`featured.length + 100 + sourcePriority`; otherwise they use `sourcePriority`. Account-selector
stride priorities and routed priority `5` (or their existing selector band) keep their own rules;
the source bound does not promise disjointness from account-selector priorities. Complete picker
ordering remains the final display override, independently of private guidance priority.

`src/server/codex-model-list.ts` resolves the active catalog path once per live Codex-shaped list,
reads its pristine baseline and exact-slug retained fields directly from that file, and supplies
both to the same builder. Missing, null or corrupt catalogs contribute empty inputs. This path
never creates a backup or publishes a catalog. For equal inputs, live `/v1/models?client_version`,
the published catalog and its `models_cache.json` copy carry equal priorities. Concurrent reads may
observe the complete previous or next publication. Coverage: `tests/codex-integration/native-source-priority.test.ts`
and `tests/server/server-native-catalog-priority.test.ts`.

When account selectors are active, one featured bare native id expands into a complete selector row
group. Catalog priorities use the selector count as a stride so each group stays together without
widening Codex's five-row advertisement window. Fresh defaults are Astra, GPT-6.1 Sol and Luna
(`DEFAULT_SUBAGENT_MODELS`). Startup upgrades unmarked rosters once: prepend `gpt-6-astra`, retain the first four unique
non-Astra choices, then move retained bare `gpt-5.5` last. The old fifth choice is dropped;
an unmarked empty list becomes Astra only, and an unset list receives the fresh defaults.
A second one-time step rewrites bare `gpt-5.6-sol`/`gpt-5.6-luna` to their GPT-6 rows in place
and drops every other bare `gpt-5.5`/`gpt-5.6` id; ids with a `/` are untouched, and a list left
empty by the cleanup receives the defaults.
A third one-time step (version 3) rewrites bare `gpt-6-sol` to `gpt-6.1-sol` in place without
duplicating it; routed and account-qualified ids keep their spelling, and GPT-6 Sol re-added later
stays. `subagentModelsVersion: 3` records completion, so later user edits (including an empty list or
removing Astra) persist. The migration rebases on the latest disk config under the existing
mutation lock; failed persistence degrades to an in-memory roster for that run without a stale
whole-config overwrite. Existing disabled-model visibility rules remain unchanged.

Quota-aware fallback walks a configured chain when the featured model is exhausted, probing
availability on a bounded interval (default 60 s, `src/codex/subagent-model-fallback.ts`). It rewrites
the requested model id only; effort remains owned by the caps described under
[Ultra reasoning level](catalog.md#ultra-reasoning-level).

### Per-role model pins

Codex overrides a child's spawn-time model with the root `model` key of
`$CODEX_HOME/agents/<role>.toml`, so that pin decides which model a role runs on.
`src/codex/agent-role-models.ts` is opencodex's only writer into those files, and it writes only
the root `model` and `model_reasoning_effort` keys, each only when the request carries it, only when a user saves a role in the dashboard's omo (Codex / LazyCodex)
section on the omo tab (`PUT /api/codex-agent-roles/{role}`) or with `ocx agent roles set`,
and only while LazyCodex is detected. No sync, startup, or
catalog path calls it, and opencodex never creates, repairs, or removes a role file.

- The key is located by the same TOML-aware scan the pin reader uses
  (`locateTomlModelKey` in `src/codex/subagent-model-fallback.ts`), so a `model =` line inside
  the instructions multiline string is never read or edited. A key under a table header is not
  the root pin.
- An existing one-line string value is replaced inside its span; every other byte, including
  quote style when the new value allows it, trailing comments, line endings, and a leading BOM,
  is kept. A missing key is inserted after the leading comment block. A non-string value is
  refused rather than duplicated.
- The original file and the edited result must both parse as TOML; otherwise the write is
  refused with `invalid_role_file` and the file keeps its bytes, so an edit can never turn a
  role Codex rejects into one it loads. Other write failures answer a fixed `write_failed`
  message without the filesystem path or owner details.
- The role name must equal a listed `*.toml` stem, which is also the path-traversal check. The
  target must be a regular file owned by the running user; the replacement is atomic and does
  not follow a symbolic link.
- Every PUT that writes the role TOML appends one row to `codex-agent-roles.jsonl` under `integrationsDir()` (`src/codex/role-model-history.ts`): time, `batch`, role, model and effort before and after, and the canonical Codex home (`getCodexHome()`) it wrote. An unchanged save appends nothing, and a failed append is logged without failing the write. Before appending, the writer separates an unterminated suffix with a newline: torn JSON remains skippable and a complete final row remains valid, so a restart does not swallow a newly issued batch's first row. The server hands out batch ids: a write without the optional body field `batch` starts a new batch, and a recorded write's response names it as `batch`; a later write that sends that id (1 to 64 letters, digits or dashes, else 400 `invalid_batch`) joins it, so auto-assign's Apply all and a Restore send the id from their first write's response with every later one. A write joins a batch only while the current home's retained history holds it whole, else 409 `batch_closed`, so an id compaction dropped, or one the server never issued, cannot start over and pass for the beginning of a batch; a batch holds at most 50 rows, else 409 `batch_full`; both are refused before the role file is touched. Each row stores its number in its batch, which keeps that cap durable and lets every read drop a batch missing any of its rows, so a cut batch is never listed or restored. `GET /api/codex-agent-roles` returns the current Codex home's newest whole batches as `history`, never more than 50 rows, when LazyCodex is detected (a batch over 50 rows from an older file is skipped); rows another Codex home wrote are never listed, so a proxy restarted against a different home starts with an empty list. The file is bounded: before appending, the writer captures the last 256 KiB and 1000 rows. An append that crosses either limit compacts that snapshot plus the new row to the newest whole batches, targeting 128 KiB. A kept Restore and its complete source batches are budgeted together, displacing unrelated older batches and using up to 256 KiB and 1000 rows in total when needed. If that group cannot fit both limits, it expires rather than exceeding the bounded read window. A history file it cannot read sets `historyUnavailable: true` with an empty list, and the role list and saves keep working. The dashboard restores a batch by writing each role's earliest `before` through this same PUT under a new batch, naming the restored batch in `restores`; the server refuses such a write with 409 `restore_not_in_history` unless the current home's retained history (every whole batch the file holds, not only the 50 listed rows) holds that batch for that role with exactly those earlier values, so leaving the 50-row listing alone does not invalidate a Restore. Compaction preserves a retained Restore's source from the pre-append snapshot while their combined rows fit both retention limits; this is bounded history, not an indefinite reservation against later writes.
- On `PUT /api/codex-agent-roles/{role}`, `effort` is optional: omitted keeps the role's
  `model_reasoning_effort`, a level inserts or replaces it, and JSON `null` removes its root line
  and trailing comment. Only a one-line string value can be removed; a multiline or non-string
  value is refused with 409 `unsupported_model_value`, leaving both TOML and omo.jsonc unchanged.
  Removal preserves the BOM, line endings, and all other bytes; an absent key is a no-op.
  Clearing the role-level override lets Codex resolve effort normally (spawn value, `[agents]`
  default, parent). The dashboard offers **Inherit effort** on every row and sends `null` to clear.
- `model` is optional too: omitted leaves the root pin, or its absence, untouched, so a role that
  inherits its model can set or clear its effort alone; the dashboard sends `{ "effort": ... }` for a
  row without a pin. A `null` model is refused with 400 `invalid_model` (a save never removes a pin),
  and a body with neither key is refused with 400 `empty_update` before any role file is read.
- The same pick is mirrored into LazyCodex's `[codex].agents.<role>` as `model` and, for an effort LazyCodex can express, `reasoning`; that half belongs to
  [client integrations](clients/integrations.md#omo-codex-lazycodex-role-models). The role file is written first
  and stands even when the mirror is skipped.

Sibling instances refuse the write, because it reaches the shared `CODEX_HOME`.

### Role model auto-assign

`POST /api/codex-agent-roles/auto-assign` (dashboard Auto-assign, `ocx agent roles suggest`) proposes a
model for every role and writes nothing. It belongs to omo (Codex / LazyCodex): without
`detectLazyCodex()` it answers 409 `lazycodex_not_detected` before reading the body or calling a model,
the same refusal as the PUT. Applying a proposal is the ordinary
`PUT /api/codex-agent-roles/{role}`, now with an optional `effort`. The work splits in two on purpose:

- **Sizing is one model call.** `src/codex/role-sizing.ts` holds the rubric (ported from the MIT-licensed
  modelchk skill, cited in the file) as the system prompt, the neutral vocabulary
  (`fast|standard|frontier`, `glance|measured|thorough|exhaustive`), and the validator. Each role sends its
  name and the first 1500 characters of `description` plus `developer_instructions`; a role with neither
  is not sent. The call goes through the proxy's own `/v1/chat/completions` via
  `postLocalChatCompletion` (`src/lib/local-chat-completion.ts`, shared with the routed vision describer), on
  the root `model` of Codex `config.toml` unless the caller names one. An answer that is not the strict JSON
  shape, a missing role, or a field outside the vocabulary leaves that role **unsized** with the reason;
  nothing is guessed. Keys beyond the five answer fields are ignored, and all five stay required. The
  sizing model never names a model.
- **Mapping is deterministic code.** `src/codex/role-auto-assign.ts` draws candidates from
  `subagentSelectableModels` (the same list the role picker renders) and tiers them: `codexRoleTiers` in the
  opencodex config first, then price rank (input plus output per 1M tokens). Three or more priced models
  split evenly across the three tiers. Fewer are anchored at the top, the dearest frontier and each cheaper
  one a tier lower, so one is frontier and two are standard and frontier; fast is the tier left empty,
  which keeps a standard role on the cheaper model. Unpriced, unmapped models are never proposed. A role
  gets the lowest sufficient tier, then the lowest price, then the model it already uses when that model is
  in the tie, then picker order. Effort binds to ladder positions of the chosen
  model (floor, default or middle, the rung above, ceiling), collapsing inside the range; it is proposed
  for every sized role whose chosen model has a non-empty ladder. Apply and `--apply` insert or
  replace `model_reasoning_effort` through the same span-preserving editor as `model`, located by
  the same TOML-aware scan. An empty ladder gives `proposedEffort: null`, meaning no proposal;
  Apply omits `effort` and preserves the existing pin. A null proposal never means a null PUT. A routed
  model's ladder is its row's
  `reasoningEfforts`; a row that declares none takes the ladder the written Codex catalog shows for it, an
  explicit empty list stays empty, and a row without its own default takes the catalog's default when that
  rung is on the ladder.

The sizing call is injectable (`completeCodexRoleSizing` on the management deps), so route tests answer it
without a provider. Sibling instances refuse the preview too: it sits under the refused
`/api/codex-agent-roles` prefix, and its proposals could not be applied there anyway.

### Delegation model suggest

`POST /api/injection-model/suggest` (Subagents page **Suggest**, `ocx agent injection suggest`) applies the
same sizing to the delegation default. The caller describes the work Codex usually hands off (nonblank, at
most 1500 characters, the role excerpt limit); `proposeDelegationModel` in
`src/server/management/codex-role-auto-assign.ts` sends it as one role named `delegated-work` with the same
parser and the role rubric followed by a short addendum (`DELEGATED_WORK_SIZING_SYSTEM_PROMPT`) that has the
sizer size the described one-shot work rather than a standing role; the role rubric's own text is unchanged.
It maps the answer with the same `buildRoleProposals`. Candidates are the `available` list
`GET /api/injection-model` offers (one helper builds both), with effort ladders cut to the Codex
levels `PUT /api/injection-model` accepts. As with roles, a non-empty ladder gives an effort
proposal even when no effort is set; an empty ladder gives none. The route writes nothing; the page shows tier, effort, rationale and move triggers,
and **Use this** goes through the page's ordinary `PUT /api/injection-model` save. It is not
sibling-refused, like the `PUT` it feeds, since both touch only this instance's config.

`injectionModel` and `injectionEffort` are shared selections with two independent consumers.
`multiAgentGuidanceEnabled` controls only OpenCodex-authored delegation guidance.
`syncCodexSubagentDefaults` is a separate, default-off opt-in that applies the selected values to
Codex's native `[agents]` defaults on sync/restart for newly created Codex tasks when OpenCodex owns
the active Codex routing; external user-managed provider configs remain untouched. It does not itself
cause delegation. The TOML edit owns only marker-tagged values, preserves existing unmarked
user-owned `[agents]` defaults rather than overwriting them, and rejects ambiguous table shapes
without changing the file.

An explicit desktop restart to load those defaults follows the [runtime membership checks](runtime.md#codex-desktop-process-membership); selecting a delegation model does not authorize additional restart targets.

V2 proxy guidance uses `<opencodex_subagent_guidance>` for both built-in metadata and
custom `injectionPrompt` bodies. The built-in text reports the resolved preferred model,
effort, roster and fallback chain without prescribing delegation, spawn overrides or
`fork_turns`. Custom bodies retain their placeholder behavior. The guidance switch and
catalog-state gates still apply; stale or unknown catalog state suppresses proxy guidance.
V1 uses the shared `MULTI_AGENT_MODE_HINT_RECOMMENDATION.text` inside `<multi_agent_mode>`
at `max` or `ultra`. Only the separate explicit delegation-request trigger changes; user,
authority, task-scope and collaboration-tool rules remain applicable. This is guidance,
not an enforcement mechanism or a change to native settings or tool access.

Both guidance paths start from `collabSurface()`, which reads only what the request declares. A
directly declared `spawn_agent` and its companions decide the surface as before. Codex
code-mode-only turns declare no collaboration tool on the wire, so
`src/server/responses/code-mode-collab-surface.ts` also reads the nested listing that codex-rs
renders inside the custom `exec` description: a tool heading, its description, and a final
`exec tool declaration:` fence naming the same tool. It accepts only a freeform, un-namespaced
`exec` that starts with the codex-rs template line, ignores headings inside fences or without their
own declaration, and counts only `multi_agent_v1__spawn_agent` as V1 evidence. Any other
`spawn_agent` or V2 companion beside it, or a different direct surface, makes the turn
contradictory (`null`), which also withdraws a direct V2 surface's designation and effort cap.
Collaboration-named tools in an `mcp__` namespace, direct or nested, are MCP server tools and
neither prove nor contradict a native surface.
The two checks are asymmetric on purpose: evidence needs a rendered section, while the
contradiction check reads every heading and declaration line, quoted or not, so text copied into
the listing can push a turn toward `null` but cannot hide another surface.
The parse uses bounded linear scans: descriptions over `1 << 20` string code units carry no nested evidence, declarations over `64 * 1024` code units are not recognized, and quoted text and comments are skipped while matching delimiters; return generics must close fully.
Nested evidence never produces `v2`. When the model supports tool search (every OpenCodex catalog
row), codex-rs defers the V1 tools and leaves them out of the description. Its own
`<multi_agent_mode>` item exists only on V2 and it pins the version per session, so neither the saved
mode nor the catalog stamp proves a conversation's surface. The one request-visible signal is the
developer `<tools>` world-state fragment codex-rs sends when its default-off
`deferred_tool_world_state` feature is on (Codex Desktop sessions receive it): a
`Deferred tool namespaces:` snapshot, then `Added`/`Removed` diffs. `src/server/responses/deferred-collab-surface.ts`
replays those fragments in input order from developer messages only, each text part standing alone,
and treats a current `multi_agent_v1` row as V1 evidence. It counts only beside a host that can load
deferred tools (the genuine code-mode `exec` above, or a structured `tool_search` tool), and it is
conservative under the 4 KiB budget: omitted rows never establish a namespace, omitted removals and
malformed fragments clear what was carried. The evidence combines exactly like the rendered listing:
it never yields `v2`, a different direct surface or a rendered foreign collaboration claim makes the
turn `null`, and a removal withdraws only deferred evidence. The row proves that some V1 tool is
deferred, not that `spawn_agent` is; only an embedder's own tool allowlist can split them (codex-rs's
guardian allowlist drops the whole namespace), and such a host gets advisory text it cannot act on.
Feature-off clients still carry no V1 evidence and stay `null` (#6844). A tool description that
copies a complete V1 section verbatim, or a forged developer item, cannot be told apart from the
host's own rendering.

Replay deduplication compares the latest exact generated developer text separately for
each tag family, preserving built-in ??custom ??built-in transitions without duplicating
unchanged proxy metadata after a native policy change. Native and legacy-tagged history
remain intact: tags do not establish historical authorship or revoke old instructions,
and mixed-version transition detection is not guaranteed.

The native mode hint is separate from proxy guidance and native `[agents]` defaults.
`src/codex/multi-agent-mode-policy.ts` owns the proactive recommendation; the dashboard
obtains it from `/api/v2` rather than maintaining its own preset. An explicit dashboard,
API or CLI hint write passes through `setMultiAgentModeHintText`, which replaces only
the two byte-exact released OpenCodex presets with the current recommendation. Other
valid custom text, including whitespace variants, is preserved. Reads, unrelated writes
and upgrades do not migrate stored hints. The writer retains its native capability check
and stores only `features.multi_agent_v2.multi_agent_mode_hint_text` in Codex TOML;
`null` removes that key. The hint affects new native Codex sessions when their v2 surface
is active, without changing reasoning effort or the proxy guidance switch.

Claude Code `ocx-*` agent definitions consume the same effective `claudeCode.blockedSkills` policy
as inbound bundle elision. When the list is non-empty (default: `claude-api`), generated definitions
whose marker-stripped model resolves to a routed id receive a preventive instruction not to invoke
those skills. Direct `provider/model` selectors are routed even when their inbound resolution is
identity. The only unguarded `ocx-self` case is an identity-resolved `claude|anthropic` model while
native passthrough is enabled; `modelMap` claims and `nativePassthrough:false` restore the guard. The
guard avoids creating oversized skill messages before the proxy can intervene; inbound elision remains
the fallback if a client still sends a blocked bundle. An explicit empty list disables both routed-model
behaviors.

> Decision record: [ADR-0027](decisions/ADR-0027-subagents.md)

### Saved picker presets

The Models page saves routed snapshots in `modelPickerOrder` and records their origin in
`modelPickerOrderMode` (`alphabetical`, `provider`, `most-used`). Mode is UI provenance, not a
catalog sorting policy: catalog writers consume the saved array. Routed-only featured/native
bands and complete-picker natural-rank preservation remain as described above. Public
`buildCatalogEntries` accepts the order before optional native-source inputs and applies the complete-order
pass after building. On-disk convergence retains its existing post-merge final pass.

Claude ModelInfo ordering receives optional `{ modelPickerOrder, featured }` after `fastRows`.
It orders routed output groups after alias deduplication, preserving the collision winner and
base/1M/Fast siblings. Native groups and explicit Desktop profile ownership are unchanged.
Native Codex advertisements still follow display priority; private guidance ranks do not freeze them.

Codex display-cache expiry, retained blocking main-policy evidence, and reset history follow the
[quota cache contract](providers/openai-tiers.md#quota-cache-and-short-window-history).

Usage consumers preserve positive incomplete-history metadata as specified in [usage accounting](dashboard-and-usage.md#usage-accounting); readable totals are not represented as a complete ledger. Upstream API-key usage follows the [physical-attempt account attribution contract](dashboard-and-usage.md#upstream-key-account-attribution), independently of subscription quota observations.

Connected CLI usage follows the [client-scoped hub usage contract](dashboard-and-usage.md#usage-accounting); local management and account data remain separate.

Remote Workspace uses a separate, explicitly enabled server surface with structural WebSocket callbacks and awaited per-server cleanup; [its contract](remote-workspace.md) owns that integration.

Listener startup diagnostics follow [the runtime lifecycle contract](runtime.md#lifecycle); malformed optional listener blocks follow [config loading](config.md#config-surface).
Chat helper admission in `src/server/responses/core.ts` follows the
[deferred stored-main contract](providers/openai-tiers.md): only a needed Direct OpenAI helper
claims stored main, after terminal vision, routed vision and search exclusions.

Subagent automatic pool preview returns no candidate when all pool plans are excluded; explicit account-qualified models retain the [selection-policy distinction](providers/openai-accounts.md#automatic-pool-plan-exclusions).

Provider-level Combo eligibility uses explicit inference evidence for the current single credential; account-specific admission remains separate. See [scoped provider quota](runtime.md#scoped-provider-quota-for-combo-selection).

The management quota DTO keeps Combo editing aligned with scoped inference evidence;
see [Combo editor routing quota](dashboard-and-usage.md#combo-editor-routing-quota).

Optional Codex transport-hint suppression is scoped to canonical Responses client output;
its defaults and exclusions are owned by [Responses transport](transports/responses.md).

Final-route summary visibility is recomputed after fallback from the original Responses preference; an earlier provider opt-in does not carry into a later provider. See [reasoning presentation](providers/chat-compat.md).

Paginated and migration-capable history follows the [authoritative writer contract](codex-home.md#paginated-history-writer-boundary); this document adds no independent writer guarantee.

Codex pool settings and their consumers follow the [reset-first ordering contract](providers/openai-accounts.md#reset-first-account-ordering), including independent-quota fallback, preserved affinity, strategy-specific threshold summaries, and shared short-observation freshness for switch warnings.

Claude replay carries [Go conversation affinity](data-planes/inbound-compat.md#claude-affinity-at-final-go-dispatch)
privately to final dispatch; preliminary route selection does not inject Go-only headers.

Native Chat applies qualifying effort ceilings independently of model pins; pin selection precedes the cap and only pins or cap rewrites enter wire mapping. The [catalog effort contract](catalog.md#ultra-reasoning-level) records the V1/compaction exemptions and caller-preservation boundary.

Private pool credential metadata follows the [quota-history publication identity contract](providers/openai-accounts.md#quota-history-publication-identity); credential-only and account DTO projections omit it.

Pool quota producers and account commands follow the [bounded raw-observation contract](providers/openai-accounts.md#bounded-pool-quota-observations), separate from the latest display snapshot and capacity estimates.

The account history response can include a [low-confidence effective capacity estimate](providers/openai-accounts.md#observed-effective-token-capacity); usage normalization retains local-answer provenance so local responses cannot supply samples.

Account quota surfaces use [safe probe diagnostics](transports/inventory.md#account-quota-failure-diagnostics) separately from quota validity, credential health and routing authority.

Combo child requests normalize effort and thinking controls against the selected target while retaining reasoning summaries; strict unknown targets preserve caller controls. The [Responses transport owner](transports/responses.md) documents this boundary, and native Chat also honors explicit per-axis capability declarations; an initial JEV null choice separately strips caller effort.

Live sideband admission and its bounded upstream handshake follow the [runtime contract](runtime.md#live-sideband-handshake); the ordinary Responses WebSocket exchange remains separate.

The [explicit model-capability contract](config.md#explicit-per-model-capability-declarations) preserves operator declarations through provider storage and catalog capture; it does not infer upstream capability or change this surface's routing behavior.

Exact [model input declarations](config.md#explicit-per-model-capability-declarations) now feed text-only eligibility and catalog hints; existing image-description/omission handling consumes them before the main upstream send.

That shared rule includes the Crusoe registry entry's five explicit text-and-image model ids;
subagent eligibility consumes the same derived metadata as the main catalog and does not infer
vision support from a provider-wide multimodal label.

[Anthropic seed image metadata](runtime.md#capability-aware-image-admission) supplies missing capability evidence; subagent selection and eligibility rules remain unchanged.

Opper's fallback pool seeds carry provider-scoped text/image declarations from
`src/providers/registry/model-seeds.ts`. They feed the same capability-aware image admission and
do not change subagent selection, roster order, or eligibility.

Provider-scoped approval reviewer settings are projected by the [catalog owner](catalog.md#provider-scoped-approval-reviewer); this surface retains its existing routing, transport and account-selection behavior.

Renamed fixed-key providers receive [missing reasoning metadata](catalog.md#renamed-destination-reasoning-metadata) during derivation; explicit per-model entries and provider defaults retain precedence.

Shared response-log retention and native SSE inspection pacing follow the [bounded inspection contract](transports/byte-accounting.md#response-log-inspection); other subsystem behavior remains unchanged.

Native steering retains fixed phase deadlines and reconciled replay output; see the [steering stability contract](transports/streaming-health.md#steering-deadlines-and-replay-completeness).

Native steering generation overrides, explicit public-API eligibility and the consent-gated wire probe follow the [shared control contract](transports/streaming-health.md#steering-settings-public-api-and-diagnostic-probe); this owner does not change routing or execute diagnostic tools.

Startup provider-id migration preserves the account binding between configuration and OAuth credentials; see the [runtime contract](runtime.md).

Dashboard Fast-row persistence and client refresh follow the [Fast selector rows setting contract](gui-and-management-api.md#fast-selector-rows-setting).

The [compaction routing override](transports/responses-failover.md#compaction-routing-overrides) uses explicit request-kind and trigger metadata, independently of spawned-child markers.

Ongoing priority failback keeps model-detour and independent-quota affinity isolated; preview remains read-only and no child changes an unrelated shared cursor. The routing details live in [OpenAI account operations](providers/openai-accounts.md#ongoing-priority-failback).

Automatic account exhaustion and recovery use the [spendable Codex credit evidence contract](providers/openai-tiers.md#spendable-codex-credits), including independent freshness, upstream refusal, and reset-ticket separation.

### Forced Claude Code subagent model

`src/claude/subagent-model.ts` shares the roster alias and authoritative context-marker resolver with routed launch force. `claudeCode.subagentModelForce` is opt-in and default-off. Force availability excludes retained unavailable roster entries. Caller-added `[1m]` suffixes require a finite authoritative long window (`src/claude/long-context.ts`: 1M, or at least the 829,800 default compact window; a genuine 1M for Claude models on either Anthropic pool or a bare `claude-*` id) or an exact advertised marked identity; generated markers follow the same rule; exact upstream ids remain literal, while legacy roster marker handling is unchanged. `claudeCode.contextAccounting` `"200k"` stops automatic marking on generated and forced selectors; an explicit `[1m]` still follows the window rule above ([Claude Desktop picker mode](clients/claude-desktop.md#picker-mode-the-desktop-egress-proxy)). The generated-agent legacy directive cannot replace a wire selector matching the configured forced alias. `src/claude/subagent-force-status.ts` performs bounded, read-only server-local version and settings-key inspection; unknown is not supported.

Explicit gateway selectors outrank generated-agent `ocx-route` fallback independently of saved force state. `src/claude/inbound-model-options.ts` shares this precedence across Messages and count-tokens; bare Claude fallback and requests without directives retain their existing behavior. Native Claude force targets use reversible native aliases, restored before existing credential/model-map checks. Connected launch exposure comes from fresh authenticated gateway rows, not cached context-window keys; acquisition is independent of cache-write success.
