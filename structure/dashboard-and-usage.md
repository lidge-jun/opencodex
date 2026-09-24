# Dashboard Surfaces And Usage

Dashboard page contracts, usage accounting and request metrics, and the management settings that
back individual dashboard surfaces. Serving, authentication boundaries, and `/api/*` ownership are
in [GUI and management API](gui-and-management-api.md).

## UX boundary

The dashboard is a local control surface, not a separate service. It should reflect the same config
and catalog invariants documented in this folder rather than inventing parallel state.

Codex quota cards consume the display cache from `src/codex/quota.ts`. A partial refresh
removes an omitted short tuple whose reset deadline has elapsed, so a stale model-derived
5h row does not persist on a weekly-only account. This is independent of the main-account
blocking hard-lock evidence and reset-notification history; their retention rules are documented in
[OpenAI account modes](providers/openai-tiers.md#quota-cache-and-short-window-history).
Codex account panels expose no Spark quota toggle or setting and retain quota refresh, pause/resume, selection order, reset-credit confirmation and Advanced settings; account/provider quota DTOs suppress retired windows upstream of the generic quota renderer, under [OpenAI quota scopes](providers/openai-tiers.md#public-provider-contract).

## Dashboard surfaces

Dashboard localization uses the English `gui/src/i18n/en.ts` catalog as the complete key and
placeholder contract. Every registered locale, including Vietnamese, supplies the same keys;
locale-specific Compatibility Lab, log-guard, routing, vision, status-code, and quota-formatting
maps remain total rather than silently falling back to English.

The Models catalog names three distinct delivery states. A successful management mutation confirms
only that the catalog is saved on the hub. `gui/src/api-targets.ts` carries the local machine's
`catalogSyncedAt` into `gui/src/pages/Models.tsx` as the time this client last fetched a catalog; the
timestamp does not prove that fetch contains a later hub save. Runtime activation remains explicitly
unverified because process age and catalog-file age are not client acknowledgement.

`src/server/management/api-access.ts` publishes an `audio` projection through the
existing `/api/keys` response in `src/server/management/oauth-account-routes.ts`.
URLs derive from the same advertised inference base as text APIs, with HTTP(S)
mapped to WS(S). Configuration flags inspect enabled canonical providers only;
they do not read credentials, inspect account health or prove entitlement.
`gui/src/pages/api-keys-utils.ts` validates the same projection on network and
cache reads. Missing or malformed audio metadata disables only audio controls.

Connections/API keys has separate Dictation and Live Voice sections in
`gui/src/components/apikeys-workspace/AudioApiPanel.tsx`. Transient data keys never
enter caches or generated samples. `gui/src/audio-api-client.ts` owns bounded
uploads and a connection-only native voice probe; `gui/src/api.ts` sends uploads
without management auth injection or 401 recovery. Voice readiness requires a
nonterminal session acknowledgment with `session.id`, not merely socket open.
Changing keys, inference metadata, API origin or leaving the active panel releases
requests/sockets. Only allowlisted event types and localized error categories are
displayed. Tests live in `gui/tests/audio-api-client.test.ts`,
`gui/tests/audio-api-panel.test.tsx`, `gui/tests/api-auth-memory.test.ts` and
`tests/server/api-access-endpoints.test.ts`.
The API workspace gives `gui/src/components/section-tabs.tsx` its mobile reading
line so scroll-spy and the top-bar offset agree; other consumers keep their
existing reading line. The section strip stays one row at every width.

Provider Overview consumes the existing shared `add-provider-presets` resource for sponsor
presentation. `matchingWorkspacePreset` requires the configured id, adapter and normalized
endpoint to match; a custom endpoint or absent sponsor metadata suppresses the introduction.
`ProviderSponsor` keeps localized promotional copy and outbound HTTP(S) links separate from
operator notes. Notes remain complete and editable once in the main column; stats and current
account quota remain in the side column. This presentation does not write provider configuration
or participate in routing.

Provider marks remain a name-to-asset projection in `gui/src/provider-icons.ts`. The Crusoe preset
maps to the self-hosted multicolor `gui/public/provider-icons/crusoe.svg`; the gradient is rendered
as an image rather than flattened through the monochrome mask path.

The sidebar exposes eleven pages (`gui/src/App.tsx` `NAV`). Several are workspace shells rather than
single forms, and the shell pattern is the part worth keeping stable:

| Surface | Shape |
| --- | --- |
| Providers | Rail of configured providers plus a detail pane whose tabs are Overview, Models, Usage, then Accounts or API Keys when the provider has an auth surface, then Settings (`gui/src/components/provider-workspace/ProviderDetails.tsx`). |
| API keys | Rail plus per-key detail; masked values only (`gui/src/components/apikeys-workspace/`). |
| Storage | Rail plus cleanup and trash detail (`gui/src/components/storage-workspace/`). |
| Subagents | Featured-roster selection workspace (`gui/src/components/subagents-workspace/`). |
| Combos | Rail, detail panel, and an add flow (`gui/src/components/ComboWorkspace.tsx`). |
| Add provider | Catalog browser plus form and OAuth panes (`gui/src/components/provider-catalog/`, `gui/src/components/AddProviderModal.tsx`). The catalog browses four tabs — Accounts, Free, Local, Paid — where Local is a catalog-only bucket peeled out of `bucketPresets` after `presetTier` has classified; the workspace `providerTier` stays three-way, so the rail, the free-paid sort and the Free count still treat a local runtime as free. Search sits above the tabs and reaches every tab at once: while a query is live the list renders all four groups with headings and the strip becomes jump chips with counts rather than a tablist, because moving the selected tab would change the row kind under the user (a preset-select button becomes a login row). ArrowDown from the search input focuses the first enabled result action; if none is available, focus stays in the input. The tab strip wraps within narrow modals. Every nonempty note has a full-text button so narrow rows never hide content permanently; the native note dialog closes during teardown and restores focus to its trigger. Provider notes clamp to two lines and open in full in a stacked native `<dialog>` owned by `AddProviderModal`, which also owns the search text so its `window` Escape handler can unwind popup, then query, then dialog. |
| Codex accounts | Account pool cards, add-account flow, switch and reset modals (`gui/src/components/CodexAccountPool.tsx`, `gui/src/components/AddCodexAccountModal.tsx`), plus the generic account-targeting picker opt-in on `gui/src/pages/codex-set-multiauth.tsx`. Add/delete/login completion is projected to one boolean before presentation; pending catalog work is a warning, not a failed account mutation. The main card's native-main device reauth (#3898) is owned by `gui/src/components/use-main-device-reauth.ts`: the dedicated `/api/codex-auth/main/reauth-device` namespace only — never the pool login route — with flowId-owned polling, an allowlisted verification URL, and no token fields accepted from payloads. The main-device reauth hook retains flow ownership from the Cancel click, while DELETE is unresolved and after retryable failure; polling normally continues. A concurrent GET HTTP error cannot expose a replacement login POST before DELETE settles. If a retryable DELETE failure races with a non-2xx GET while the flow is pending or committing, either response order preserves same-flow Cancel retry, restores the last server-provided device code, verification URL, and phase when needed, and keeps the existing poll cadence so a later terminal result remains observable. Outside same-flow cancellation ownership, a GET HTTP failure still stops polling without starting a second login POST. The cancellation-failure indication survives pending status updates until a trusted terminal result releases ownership. A successful DELETE with a terminal `failed` DTO releases it and uses the same closed failure-code mapping as polling; only `succeeded` notifies login completion. Unrecognized or nonterminal DTO status values remain retryable. A DELETE response with HTTP 404 and code `unknown_flow` releases the expired flow and shows the existing generic failure state so device re-login is available again; it claims neither login success nor confirmed cancellation. Confirmed cancellation also makes device re-login available. Start, polling and cancellation completions verify their controller or flow ownership after asynchronous response reads; replaced flows and unmounted hooks cannot update a newer flow or notify completion. Effect setup restores mounted state after the StrictMode development cleanup cycle. |
| Dashboard overview | Overview, Providers, and Models tabs at the page level (`gui/src/pages/Dashboard.tsx`), the 30-day token and coverage stats in the overview head (`gui/src/pages/dashboard-overview-head.tsx`), and the effort-cap, injection, maintenance, sidecar, and memory panels below it (`gui/src/pages/dashboard-overview-panels.tsx`). |

The native-main reauth poller captures an immutable accepted flow id for queued callbacks.
Its POST, GET and DELETE JSON reads retain API error codes, but non-2xx responses never
become successful flow DTOs. The three local React Doctor response-body exceptions preserve
that tested contract without disabling the rule for other calls.

Rail selection is component-local state today, so a reload returns to the workspace's default
selection rather than the previously selected row. An OAuth ToS warning is shown before a login that
requires acceptance (`gui/src/components/OAuthTosWarningModal.tsx`).

The `/#codex-auth` add-account modal has a three-step manual-code UX contract on top of the existing
OAuth polling API: submit request, waiting-for-login completion, and terminal success/failure. Once
`POST /api/codex-auth/login/code` succeeds, the GUI must keep the input disabled, expose an
`aria-live` status message that the code was accepted, and surface repeated `login-status` polling
network failures as a visible warning instead of silently looking idle again.

Fixed provider redirect URIs keep their registered port. If that port is already in use, a login
controller with `onManualCodeInput` enters manual-only mode: it must still publish the authorization
URL and accept the final redirect URL or code through the same state/PKCE session. A controller
without manual input must fail closed; it must not silently move a fixed redirect URI to another port.

The account-targeting control reads the effective flag from `GET /api/settings`; it must not infer
state from the redacted config DTO or expose selector mappings. It renders no actionable off switch
before hydration, serializes rapid clicks, rejects stale poll results that started before a mutation,
and accepts the server-confirmed state after PUT. Product copy describes arbitrary public selectors
and exact account binding only—there are no built-in Personal/Work roles. A pending catalog refresh
keeps the saved state and renders fixed `ocx sync` guidance without server/account detail.

## Usage accounting

### Upstream key account attribution

API-key attempts in `src/usage/log.ts` carry `accountLogLabel` as `k` plus 32 lowercase
hex digits. `src/codex/account-label.ts` derives it from the first 128 bits of SHA-256 over
`JSON.stringify(["ocx-key-account-v1", providerName, entryId ?? null, reference])`.
`reference` is the configured value captured for the physical send, before environment or
keychain resolution. The log contains the digest, not raw keys, references, or pool IDs.
Existing Codex and OAuth label formats remain valid. Replacing a literal or reference changes
identity; rotating the secret behind the same reference preserves the logical account.

`src/providers/label.ts` stamps only key authentication, including implicit custom-provider
keys. `src/server/request-log.ts` commits identity at dispatch after queued selection changes,
retains separate flat records when retries change keys, and isolates each record's raw usage
from parent combo totals and adapter-loop aggregation. Reported failure usage is retained;
missing usage and historical identities remain unknown. Native wire snapshots replace only the
current physical response contribution, preserving prior sends on the same key without counting
repeated inspections twice. Consumers sum the flat attempts once and keep subscription quota
observations separate from token or API-equivalent cost totals.


`src/server/hub-usage.ts` serves `GET /v1/usage` on hubs for an explicit configured data key. The authenticated key selects the aggregate; query parameters cannot select an API-key identity. Unscoped environment/admin credentials and loopback bypass are not admitted. The response projects only this client's numeric totals, provider/model/day rows and incomplete-history metadata through `src/remote/hub-usage.ts`; accounts, raw records and key IDs are omitted. Unknown fields are stripped at every object boundary and the serialized body is capped at 1 MiB.

Custom usage windows are immutable bounds on the streaming accumulator, applied before attribution and daily
aggregation. The filtered cache includes both inclusive millisecond bounds in its identity and retains the existing ledger revision, overlay-version and timezone checks.
At most four distinct filtered scans may run concurrently; identical requests share one scan and excess distinct
work fails closed. Preset warming never consumes custom summaries.
The response retains its preset range discriminator for compatibility and explicitly marks
`customWindow`, `since`, and `until`; the chart uses the window's local calendar days with
the existing 366-day cap. GUI custom reports bypass the held preset/session cache.
Both dashboard and CLI reject a custom report unless the server echoes `customWindow: true`
and the exact requested numeric `since` and `until`. An older daemon that silently returns a
preset report cannot supply totals labelled with the requested custom interval.

Resetting a manual model price keeps the map, even when temporarily empty, through persistence
reconciliation. This removes only the requested entry and preserves sibling rates independently
written to disk. The Desktop sign-in preference likewise distinguishes saved from applied state:
its pending flag survives cache refresh/remount until a successful sync confirms application.

Subagent fallback settings load independently of the main roster. Their failure disables only
fallback controls and provides a retry; available fallback options come from that endpoint's
availability list while already-configured stale values remain editable.

Subagents → Advanced uses the current API server's recommendation for **Always proactive
delegation** (formerly Ultra mode). Enabling requires the native v2 flag, explicit v2 mode
and a recommendation with nonblank string text and revision. Missing or malformed
recommendations disable preset installation and restoration while existing custom hints
remain editable and clearable. Restore changes only the editor draft; Save writes it.
Recommendation-only refreshes preserve unsaved drafts. Switching API servers hides the
previous hint and blocks mode writes until the new server's settings arrive.

An explicit `multiAgentModeHintText` write canonicalizes only the two byte-exact legacy
OpenCodex presets; other valid custom text keeps its bytes. GET, unrelated PUTs and upgrades
leave stored hints unchanged. `null` clears the hint, blank strings are rejected, and the
existing native capability check still precedes writes. The text and revision recommendation
is supplied independently of stored TOML and is not evidence of native runtime support.

Account quota discovery is capability-based. Cheap OAuth and provider-key lists include
`quotaMode` (`probe`, `passive`, or `unsupported`) without contacting upstream quota APIs.
`GET /api/oauth/accounts?provider=...&quota=1` and
`GET /api/providers/keys?name=...&quota=1` enrich each supported credential separately;
`refresh=1` bypasses settled quota cache while joining a current same-identity read.
OAuth readers use the named stored account; key readers use isolated per-key configuration,
never active-key mutation or the provider-wide cache. Response projection rechecks key identity
and exposes only quota/availability fields, not its internal identity guard. Passive observations
retain their original timestamp and never trigger inference or token renewal. Unsupported,
unobserved, failed and measured-zero readings remain distinct; multiple keys are not summed
because they may share one upstream balance.

Provider details use one account-quota reading renderer for Overview, Usage and Accounts/API
keys. Current-account usage sits below usage statistics; a known-mode active row is authoritative
even when empty, so a newly selected passive account cannot inherit a previous account's cached
report. Pool reports project only `aggregation.currentAccount.quota` with its own timestamp;
missing or malformed aggregation stays unknown rather than using total capacity. Shared states
include credits-only and measured-zero readings, unsupported, unobserved, explicit pending and
unavailable-with-last-good. Forced account/key enrichment settles before its control reports a
completed check, and provider-report waiters are bound to the exact refresh epoch.

Main-account WHAM refresh diagnostics are an ephemeral `quotaRefresh` outcome carried
from `fetchMainAccountInfoWhileOwned` to the generation-checked account DTO and the
opt-in CLI quota JSON. They are not persisted or consumed by admission/rotation.
A private per-dispatch identity generation fences the diagnostic independently of ordinary
quota metadata. Both snapshot and account DTO publication omit externally invalidated
attempts; the generation itself is never serialized or stored in the quota cache.
The CLI reconstructs the object using a fixed vocabulary and bounded numeric HTTP
status, so an unexpected management response cannot add raw upstream material.

> Decision record: [ADR-0078](decisions/ADR-0078-usage-accounting.md)

`src/usage/log.ts` writes append-only JSONL to `~/.opencodex/usage.jsonl` with file mode `0o600`
inside an owner-only `0o700` directory. Consecutive appends reuse the directory and permission
check for at most one second; the first append at or after that boundary attempts to reapply both
modes, and an `ENOENT` append invalidates the cache and recreates the path immediately. This is a
bounded, write-triggered repair of externally widened POSIX modes, not continuous filesystem
monitoring or protection against another process changing the path again after the check.
An opt-in shadow-call rewrite persists the bounded, redacted original helper model as
`shadowCallRewrittenFrom`, so helper traffic remains identifiable after restart without storing
request content or inferring a helper subtype from timing.
A failed request persists closed `failureStage` and `failureCause` members on the attempt that ended
it and on the logical row, derived once at `addFinalRequestLog` from facts that are themselves
closed; `errorCode` and `upstreamError` carry upstream text and are deliberately not read there. The
resend verdict they imply is never stored — `/api/logs` computes `resendPermission` at read time, so
a row written by an older build cannot assert a permission the current tables refuse. An attempt also
carries `deliverySummary`: adapter events, relayed frames, semantic bytes, side effects and terminal
frames, counted where each event is delivered rather than where it is read, so the gap between the
first two is the loss signal. Provider debug formats one ring line per finalized attempt from those
counts and writes no second record. `GET /api/usage?failures=1` groups failed rows by a versioned
fingerprint over closed vocabularies only, rebuilt through the same cooperative scanner and
inheriting its bounds, so deleting a ledger row removes it from the grouping.
`usageLedgerMaxBytes` is unset by default; when set, an append that crosses it publishes the newest
whole rows byte for byte through the shared atomic writer, refuses the rename unless the source is
the exact revision that was copied, and then discards the Logs ring, the retained aggregates and the
request-history index so no surface serves rows the ledger no longer has.
`src/usage/summary.ts` turns that file into the `/api/usage` shape — totals, daily zero-filled
grid, model and provider breakdowns, and `measured / reported / unreported / unsupported / estimated` counts.
The management route scans the ledger from its beginning in fixed 1 MiB chunks on a
cold rebuild, then retains compact numeric aggregate state and resumes at the last verified LF for
ordinary appends. It does not retain the full input or a normalized object for every request, and
neither the old byte window nor the parsed-entry cap can discard an earlier prefix before range and
surface filtering. `managementUsageMaxReadBytes` remains a recognized compatibility setting for
bounded legacy readers, but it is not an accuracy limit or tuning knob for `GET /api/usage`.
A Codex-surface response also includes an `accounts` breakdown keyed by the stable non-PII
`accountLogLabel`; current cards join those rows to the management account DTO and show the 30-day
token total, API-equivalent cost estimate, and measurement coverage. New main-pool rows use `main`,
while legacy bare `openai` rows stay ambiguous rather than being reassigned from current config.
A missing `usage.jsonl` returns a zeroed summary with 200, not an error: a fresh install has no
usage and must not render as a failure. What the shape must never do is present an unmeasured
request as a measured zero — that is what the `measured / reported / unreported / unsupported /
estimated` split exists for, and why coverage is reported alongside totals. The dashboard Usage tab renders the same shape, and the
main Dashboard surfaces a 30d token / coverage summary. The in-memory `requestLog` is capped at
200 entries and is **not** the source of truth for aggregation — the JSONL on disk is.

A row also records the upstream cost of its logical request. `logicalRequestId` names the turn
that a retry leg, a repair refetch and a combo child all belong to, and `spend` aggregates their
physical sends: `sends` totals every attempt on the row, `settled` counts the sends whose attempt
reached a terminal status, and `unresolved` holds the rest — an attempt abandoned in flight, or a
budget charge no attempt row accounted for. Unresolved spend is never folded into settled, because
an unexplained send is the quantity the record exists to expose. `reserved` and `policyVersion`
report the request execution budget's final state, and `moveReasons` names every pool-binding move
that discarded a warmed prompt-cache prefix. `/api/usage` totals these as `sends`,
`settledSends`, `unresolvedSends` and `spendRequests`; per-attempt `sendCount` remains the
accounting source, and `attemptCount` is the smaller number because retry layers re-send inside
one attempt.

Cache detail is qualified by provenance rather than read as a measurement. `cacheProvenance` is
`observed`, `synthesized` or `unknown`: strict-client normalization emits zero-default
token-detail objects on every bridged wire, so a `cached_tokens: 0` recovered from a parsed wire
is a wire-compatibility artifact, and a row with no cache fields measured nothing at all. Only
observed input tokens reach the `cacheHitRate` denominator, reported alongside it as
`cacheObservedInputTokens`, and the summary counts the three provenances separately. A row
written before the field existed is reconstructed from its own shape, so historical rows keep
their previous reading. `/api/logs` marks a non-observed detail with `cache_detail_missing` on
the cost estimate rather than pricing the turn as a measured uncached send.

A pool selection that produced no account reaches no auth context, so its cause is recorded on
the request that failed for it: reasons are held per (thread, model lane) and consumed by that
lane alone, because a thread holds one binding per lane and a thread-keyed reason lets one lane
report a cause that fired on another. The failing row carries `affinity: "cleared"`, its reason
and `errorCode: "codex_no_account"`; no synthetic row is emitted, since `/api/usage` counts one
row as one request. Affinity now reaches disk with the rest of the row — the field-by-field
projection in `addRequestLog` did not name it, so a move survived only until the next restart.

Usage aggregation does not infer confirmed model identity merely from a requested selector.
Model rows with saved unchanged
default-provider route evidence carry `hasUnresolvedRequestedModel`: their tokens stay under
the recorded serving provider, with an unresolved-request annotation. For those slash-containing
selectors, a vendor-only inferred price is unavailable; exact provider and user prices remain
eligible. Missing trace evidence is not reconstructed from today's configuration. Provider-detail
model shares use that provider's token total, not the global total. Unknown reserved `policy/`
selectors are rejected before upstream dispatch; historical rows remain unchanged.
Expected-price overlays are estimates, not billing reproductions: the Z.AI GLM rows (`zai`, `zhipu-bigmodel`, `zhipu-bigmodel-coding`, `zhipu-bigmodel-responses`) display the published z.ai USD list price on surfaces that actually bill by Coding Plan subscription or CNY-tiered domestic PAYG, and every such row is marked `verified-derived` so the estimate flag reaches the UI.

The management API retains the compact accumulator plus bounded query summaries; it never retains
normalized per-request rows after a response. File identity changes, shrinkage, same-size metadata
changes, pricing-overlay changes, and local-time-zone changes force a cold rebuild. Ordinary growth
is treated as an append: the scanner verifies the previous LF and its trailing 64 KiB digest, then
folds only the suffix into a cloned accumulator and publishes it after validation. Concurrent callers
share that work. Cold rebuilds scan the whole ledger in fixed-size chunks and yield between bounded
batches, so memory stays bounded and unrelated management requests remain serviceable even for a
large existing log. The first read is proportional to ledger size; steady-state refresh work is
proportional to newly appended bytes. The Dashboard polls its 30-day usage summary independently once
per minute, so usage work cannot delay health/provider/settings state or run every five seconds.

An oversized row is skipped inside the scanner bound without shortening identities. Accumulators keep normal rows plus `usageIncomplete` / `usageIncompleteReason: "oversized_rows"` on caches and rollups; append ORs the flag and a rebuild recalculates it. Invalid-row counts are not sticky, and absence of the flag is not completeness. GUI caches warn on Usage, Dashboard, provider and key views; CLI warns in human output only; most-used order save refuses an incomplete snapshot. Quota surfaces stay separate. Legacy truncation fields keep their meaning; read/mutation failures still fail closed.

`usage.jsonl` is an append-only runtime ledger. A manual in-place edit earlier than the trailing
64 KiB checkpoint followed by file growth is intentionally outside the incremental detector's
contract: validating arbitrary historical rewrites on every refresh would require rereading the
whole prefix. Replace or truncate the file, or restart the proxy, after manually changing historical
rows so the next request performs a cold rebuild.

The wire fields `historyTruncated`, `truncatedPrefixBytes`, `entriesTruncated`, and `entriesDropped`
remain in the response for compatibility with older GUI and CLI clients. A successful whole-ledger
scan reports `false`, `0`, `false`, and `0`; clients must not interpret those fields as evidence that
`managementUsageMaxReadBytes` was raised or that a bounded tail was selected.

> Decision record: [ADR-0079](decisions/ADR-0079-usage-accounting.md)

## Opt-in aggregate request metrics

`metricsExport.enabled` is default-off and fixed for one process lifetime. When enabled,
`src/server/index/serve-options.ts` creates one `src/server/request-metrics.ts` owner before the
shared fetch closure, so every listener spread records into the same bounded cells. Request logging
calls the injected recorder once from `addFinalRequestLog`; the management route receives only a
snapshot capability. There is no module-global active registry, timer, outbound connection, scrape-time
log scan, or persistence. Restart creates a fresh owner, resets every counter/histogram, and changes
`opencodex_metrics_process_start_time_seconds`.

The label vocabularies are closed: protocol is `responses`, `chat`, `messages`, or `unknown`; result
is `completed`, `failed`, `incomplete`, or `aborted`; recovery is one of the coarse classes listed in
`REQUEST_METRICS_RECOVERY_CLASSES`, and cause is one of the shared failure causes in
`REQUEST_METRICS_FAILURE_CAUSES`, which aliases the dictionary rather than copying it. Each is the
roster the exporter itself iterates. The count is
deliberately not restated here: it was written as eight, a bounded label value was added, and the
documentation then contradicted the output it describes. A
logical request increments once, physical sends sum the finalized attempt counts, and each distinct
recovery kind already retained on an attempt contributes once to its coarse class.
`opencodex_request_failures_total` counts the cause the recorder derived and never re-derives one,
and it labels a counter only: no histogram carries a cause. HTTP 200 never
overrides a failed terminal event. Duration observes every valid finalized duration; TTFT observes
only finite nonnegative first-output values, while `opencodex_ttft_missing_total` is the complementary
denominator. No request, credential, account, provider, model, conversation, raw error, prompt, tool,
body, header, or URL value enters a label or sample.

For diagnosing upstream-shape / usage-extraction issues run `ocx debug usage on` (or set
`OPENCODEX_USAGE_DEBUG=1` before start). The proxy then writes a rolling debug record per finalized
request to `~/.opencodex/usage-debug.jsonl` (mode `0o600`, auto-trimmed to the most-recent 100 lines
once it exceeds 200) with the upstream content-type, body kind (`sse / json / other / none`), a 2KB
body sample, and the extracted usage. Off by default; the hot path is guarded so production stays
untouched.

For diagnosing cache-read instability without capturing content, set `OPENCODEX_CACHE_DEBUG=1`
before start. `src/usage/cache-diagnostic.ts` then writes one record per finalized request to
`~/.opencodex/cache-debug.jsonl` (same `0o600` file, same 200-to-100 rolling bound) holding only
presence booleans, counts, closed enums, the raw upstream cache counter before defaulting, and
process-local HMAC equality tags for the prompt-cache key, allowlisted session headers, the account
log label, and ordered instruction/tool/message blocks (capped at 128 per section, first divergent
section/index only). The signing key is created at process start and never persisted, so tags
compare values within one proxy process and never become a durable correlation key; no prompt
text, tool name, raw identifier, or header value is recorded. Off by default.

## Z.ai quota destination ownership

`src/providers/quota/vendor-probes-key.ts` uses one exact normalized-base mapping for both Z.ai quota
eligibility and monitor selection. International root, coding Chat, Anthropic and
Responses bases use `api.z.ai` with Bearer authentication. Existing BigModel CN root,
coding Chat and Responses bases use `open.bigmodel.cn` with the raw key. Unsupported
bases produce no probe; redirect refusal and quota parsing/cache semantics are unchanged.

> Decision record: [ADR-0096](decisions/ADR-0096-z-ai-quota-destination-ownership.md)

## Provider debug logging

Provider transport diagnostics (dropped SSE frames, adapter dial/stream events, etc.) are opt-in:
`ocx debug provider on` / `ocx debug provider off` on the running proxy, the Debug-page toggle, or `OCX_DEBUG=1` on
the next start (legacy `OCX_DEBUG_FRAMES` still enables the same path). Lines
use the `[ocx:<adapter>:<event>]` prefix, go to the proxy terminal, and are buffered for
`ocx debug provider logs` / `ocx debug provider logs -f`. Usage JSONL tails with
`ocx debug usage logs [-f]`. Separate from provider buffered logs above.

The shared Responses path follows the [bounded multipart recovery contract](subagents.md#multipart-encrypted-task-recovery); credential admission and retry policy remain unchanged.

## Remote credentials and bounded sessions

Data keys authorize only the data matrix and authenticated catalog. Admin credentials authorize ordinary management and key rotation but cannot mint, exchange, or refresh a `gui-session`. Pairing grants are digest-only, origin-bound, one-use, capped at 128 live grants, burned after five grant failures, and source-limited after ten failures in ten minutes with at most 1,024 source buckets. `POST /api/session/logout` invalidates only the current origin/CSRF-authorized browser session.

### Model picker ordering settings

`GET /api/subagent-models` retains `chosen`, `available`, and `catalogState`, and adds routed-only
`pickerAvailable`, saved `pickerOrder`, and nullable `pickerOrderMode`. `available` still includes
saved disabled/missing roster choices; it is not the eligible-picker set. Bare aliases are excluded
from the routed preset surface because a bare id activates complete Codex-picker ordering.

PUT accepts `models` and/or `pickerOrder`; `pickerOrderMode` requires `pickerOrder` and accepts
`alphabetical`, `provider`, `most-used`, or null. Roster arrays keep their existing exact string
values and five-slot cap. Picker arrays reject blank, duplicate or ineligible ids. Null/empty
order clears order and mode; a nonempty order without a mode clears only the mode. Validation
finishes before a synchronous live mutation/save. An unsupported future deletion-provenance format
returns 409 for picker writes instead of losing clear intent. Deletion intent is staged separately and
materialized as existing config rebase provenance, so failed persistence restores the touched
fields without contaminating the live object's pending-deletion state. Absent fields are not
copied back from a snapshot taken before discovery, preserving concurrent roster changes.

Only roster writes sync Claude agent definitions/auto-apply Desktop profiles. Picker writes
converge the Codex catalog once and return its disposition. The Models UI owns a separate bounded
picker data resource so failure cannot erase the ordinary model inventory; Apply publishes through
the resource's generation fence, and Most used reads usage only on explicit Apply. Stored mode
survives availability drift, while complete/native custom orders await explicit replacement.

The shared atomic replacement publisher also identifies explicit Remote Workspace file writes as `remote-workspace`. Remote Workspace uses a separate, explicitly enabled server surface with structural WebSocket callbacks and awaited per-server cleanup; [its contract](remote-workspace.md) owns that integration and records its isolated owner and support limits.

Listener startup diagnostics follow [the runtime lifecycle contract](runtime.md#lifecycle); malformed optional listener blocks follow [config loading](config.md#config-surface).

Chat helper admission in `src/server/responses/core.ts` follows the [deferred stored-main contract](providers/openai-tiers.md): only a needed Direct OpenAI helper claims stored main, after terminal vision, routed vision and search exclusions.

## Combo editor routing quota

`src/server/management/provider-routes.ts` projects `routingQuota` after each quota read using the
current provider configuration and [scoped inference evidence](runtime.md#scoped-provider-quota-for-combo-selection).
The DTO carries only state, observation time and an exclusive `validUntil`; cached display reports
and private credential bindings are unchanged. Known states expire within 30 minutes; exhaustion
may expire earlier when the runtime predicate clears at a reset boundary, accounting for other
windows and persistent USD blockers.

`gui/src/combo-workspace-data.ts` accepts only this projection for quota-based Save/Create blocking.
Missing, invalid or expired evidence is unknown. `gui/src/pages/Combos.tsx` wakes at the rendered
expiry, including a deadline crossed before effects run, rechecks activation and visibility, and
refreshes quota with Combo data while preserving drafts. Each successful quota snapshot also
advances the observation clock, so a retained older row cannot defer evaluation of a fresh row.

Optional Codex transport-hint suppression is scoped to canonical Responses client output;
its defaults and exclusions are owned by [Responses transport](transports/responses.md).

The provider editor field policy exposes `showThinkingSummary` as a boolean provider option; it controls Responses summary defaults without a dashboard rendering change. See [Google provider](providers/google.md).

The same editor policy accepts the per-model `inlineThinkTagModels` string list. Its opt-in
format contract is owned by [Chat compatibility](providers/chat-compat.md#inline-think-tag-recovery).

Paginated and migration-capable history follows the [authoritative writer contract](codex-home.md#paginated-history-writer-boundary); this document adds no independent writer guarantee.

Codex pool settings and their consumers follow the [reset-first ordering contract](providers/openai-accounts.md#reset-first-account-ordering), including independent-quota fallback, preserved affinity, strategy-specific threshold summaries, and shared short-observation freshness for switch warnings. Codex account DTOs and cards expose the routing-plan exclusion separately from credential health; the [plan exclusion contract](providers/openai-accounts.md#automatic-pool-plan-exclusions) also governs CLI projection. Private pool credential metadata follows the [quota-history publication identity contract](providers/openai-accounts.md#quota-history-publication-identity); credential-only and account DTO projections omit it.

Claude replay carries [Go conversation affinity](data-planes/inbound-compat.md#claude-affinity-at-final-go-dispatch) privately to final dispatch; preliminary route selection does not inject Go-only headers.

The connected browser shell reuses `SESSION_UNAVAILABLE_EVENT` and its shared-session readiness state. Terminal 401 recovery failure exposes pairing without a restart instruction; a newer session or aborted request cannot publish an unavailable notice. Successful pairing changes dashboard resource revalidation dependencies, so retained failed stores are explicitly refreshed. Dashboard reads distinguish authentication, permission denial, request failure, invalid payload and transport failure; protected data is hidden for authentication/denial, while other failed refreshes label retained data as stale.

Cline journal Undo eligibility reads both native configuration files through the paired integration IO adapter; [the integration contract](clients/integrations.md#cline-paired-files) defines recovery.

The existing dashboard file-client maps include Cline CLI and reuse its committed color mark. The export panel labels its download as a settings/catalog bundle; all locales explain that Undo restores both original files.

Native Chat applies qualifying effort ceilings independently of model pins; pin selection precedes the cap and only pins or cap rewrites enter wire mapping. The [catalog effort contract](catalog.md#ultra-reasoning-level) records the V1/compaction exemptions and caller-preservation boundary.
Pool quota producers and account commands follow the [bounded raw-observation contract](providers/openai-accounts.md#bounded-pool-quota-observations), separate from the latest display snapshot and capacity estimates. The account history response can include a [low-confidence effective capacity estimate](providers/openai-accounts.md#observed-effective-token-capacity); usage normalization retains local-answer provenance so local responses cannot supply samples. Account quota surfaces use [safe probe diagnostics](transports/inventory.md#account-quota-failure-diagnostics) separately from quota validity, credential health and routing authority.

Combo child requests normalize effort and thinking controls against the selected target while retaining reasoning summaries; strict unknown targets preserve caller controls. The [Responses transport owner](transports/responses.md) documents this boundary, and native Chat removes effort only for an explicit empty declaration or no-reasoning model.

Live sideband admission and its bounded upstream handshake follow the [runtime contract](runtime.md#live-sideband-handshake); the ordinary Responses WebSocket exchange remains separate.
Dashboard overview polling observes authorization failures independently of stalled or rejected peer requests, cancels remaining child requests after a decisive result, and exposes resource-level deadline failures without rewriting them as authentication failures.

The [explicit model-capability contract](config.md#explicit-per-model-capability-declarations) preserves operator declarations through provider storage and catalog capture; it does not infer upstream capability or change this surface's routing behavior.

Exact [model input declarations](config.md#explicit-per-model-capability-declarations) now feed text-only eligibility and catalog hints; existing image-description/omission handling consumes them before the main upstream send.

The raw provider editor round-trips `autoReviewModel` and `autoReviewModelOverrides` through editor-owned DTO fields. POST/PATCH/PUT share validation; PUT copies schema-normalized values into the persisted and live candidate before adoption. Canonical `openai` rejects these fields, including clear forms. Field-masked writes (PATCH, editor PUT, reload) pin every registry-seed key and ignore operator overlays the seed never defines, most commonly `selectedModels`; POST keeps the exact-key comparison. Canonical `openai` still rejects `allowPrivateNetwork`, which must not short-circuit destination DNS checks on the ChatGPT forward row. Existing authentication, origin checks and stale-baseline protection still govern the writes. See [reviewer projection](catalog.md#provider-scoped-approval-reviewer). Stored Direct substitution follows the [credential identity contract](providers/openai-accounts.md#sidecars-management-and-ui): both synchronous and asynchronous materializers discard the caller account header before applying the stored credential; ordinary native Direct passthrough is unchanged.

Shared response-log retention and native SSE inspection pacing follow the [bounded inspection contract](transports/byte-accounting.md#response-log-inspection); other subsystem behavior remains unchanged.

Native steering retains fixed phase deadlines and reconciled replay output; see the [steering stability contract](transports/streaming-health.md#steering-deadlines-and-replay-completeness).

Native steering generation overrides, explicit public-API eligibility and the consent-gated wire probe follow the [shared control contract](transports/streaming-health.md#steering-settings-public-api-and-diagnostic-probe); this owner does not change routing or execute diagnostic tools.

`compactionRouting` is a persisted configuration setting. Its model and optional effort follow the
[Responses trigger contract](transports/responses-failover.md#compaction-routing-overrides). Dashboard Overview
provides model and effort selectors with an explicit Save action, a standing note that the selected
model's provider receives the entire conversation, and a warning naming that provider once a model
is chosen; for a combo selector the warning lists the combo's target providers from `GET /api/combos`
and states that failover targets receive the conversation too. `GET /api/settings` returns
the override or null; `PUT /api/settings` accepts a complete validated object or null to clear it.
Save failure restores live settings and deletion provenance; the dashboard retains the draft for retry.

`src/server/gui-static.ts` serves the dashboard from `gui/dist`, with `OPENCODEX_GUI_DIST` taking
priority and standalone binaries resolving the copied directory beside `ocx`. Runtime package
metadata comes from the bundled `src/lib/package-version.ts` manifest import so compiled binaries
do not read a source-tree `package.json`.

## Quota-reset notifications

`src/quota/` implements the opt-in `quotaResetNotify` section. With the section absent, or enabled
without a sink, no reset is detected or delivered and no new baseline is created. Cleanup can still
write when an existing baseline is forgotten: `src/quota/reset-observer.ts` runs
`forgetQuotaBaseline` without a sink. Startup still arms one unref'd poller interval
(`src/server/background-lifecycle.ts`) whose tick is a no-op until the section is enabled, so
enabling it takes effect without a restart.

- `src/quota/window-mapping.ts` maps provider and Codex quota snapshots to one neutral window list,
  and `src/quota/reset-detector.ts` compares two consecutive observations of a window and emits at
  most one reset event, classified as scheduled or surprise.
- `src/quota/reset-observer.ts` is the only place a snapshot becomes a delivered notification. It
  never throws into the quota write that triggered it. `src/codex/quota.ts` and
  `src/providers/quota.ts` reach it only through a lazy import, because both are statically
  reachable from `src/server/responses/core.ts` and a static edge would load the subsystem into
  every install.
- `src/quota/reset-seen-store.ts` keeps a durable already-notified ledger. The observer claims a
  reset there before dispatch, so a reset is attempted at most once, across restarts and racing
  observers; a failed delivery is not retried. `src/quota/reset-sinks.ts` delivers to a webhook or
  a local command; each sink is best-effort and isolated from the other.
- `src/quota/reset-poller.ts` is an opt-in idle refresh (default 15 minutes, floor 10). Without it,
  quota reports are fetched only when the dashboard or CLI asks, and an overnight reset goes
  unobserved. `src/quota/reset-activation.ts` installs the sink independently of the poller, so
  `pollSeconds: 0` observes live traffic only.


## Usage history and model identity

`src/server/request-log.ts` preserves upstream `servedModel` independently of route-derived
`resolvedModel`; `src/usage/log.ts` persists it with `wireModel`. The Logs model column and detail view
compare `servedModel` with `wireModel ?? model`. `recordObservedServedModel` in `src/usage/log.ts` refuses
the client's own selector echoed in `response.model` (Anthropic routes keep `anthropic/<model>` there), and
`modelIdentityLogFields` drops the same echo from older rows on read, so neither draws a false reroute.
An absent upstream model stays absent; the tooltip
retains all available model identities. Historical Codex `openai`, `chatgpt` and `openai-multi` main
labels collapse for reporting; configured provider names ending in `-main` remain separate.

Request-history selectors longer than 130 characters persist as a prefix plus a digest of the complete
selector; exact-match filtering uses the same idempotent encoding. The derived index rebuilds when its
projection version changes and encodes older raw-selector rows from canonical JSONL so exact filters
still find them. CLI access-key usage is unavailable without an ISO-8601 UTC attribution timestamp,
rather than a measured zero or never-used key.

Kimi Coding K3 price rows use API-reference estimates with the default five-minute cache-write rate,
not Code Plan billing or quota. The three Coding presets have explicit price namespaces. The
retargeted `kimi-for-coding` alias stays unpriced until a verified K2.8 price or a user `modelCosts`
override exists; the retired K2.7 mapping is not reused. Request, attempt and combo estimates remain
unknown rather than zero or partial totals. User prices take precedence and existing unknown-price
and unknown-cap policies still govern cost evidence and routing.

The Models app-server status read is owned by its API-base/restart effect, not the picker tab; switching
to Combos preserves a pending read and its existing stale-state banner.

Anthropic Fast pricing applies a 2x list-price multiplier only when the response confirms
`usage.speed: "fast"`; an absent echo or standard-speed downgrade retains standard pricing.
`tests/usage/usage-anthropic-fast-pricing.test.ts` pins that distinction. The request-metrics recovery
label `anthropic-fast-downgrade` projects to `fast_downgrade`, separate from reasoning-effort
`effort_downgrade`.

Cursor Claude Fast pricing applies the published Fast tuples to Opus 4.8, Opus 5 and Opus 5.5.
Explicit `-fast` model IDs use the Fast tuple directly; a Cursor variant tier outcome applies
the same 2x multiplier to a base model estimate. Opus 4.7 remains standard-priced because its
upstream Fast mode is unavailable. Configured model prices retain precedence over compiled rows.
