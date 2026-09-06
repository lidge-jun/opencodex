# Proven custom native capability projection

Depends on roadmap; independent from Chat semantics. Class C3. Issue #3775 remains partial because an arbitrary gateway model name does not prove native capability, and current official source is not a binary proof for Desktop 0.153.4.

## File delta

- MODIFY src/codex/catalog/provider-fetch.ts: in current custom-row producer, retain existing canonical openai forward destination and capability-backed model ID proof. AFTER custom/inherited metadata merge, intersect explicit reasoningEfforts with nativeReasoningEfforts for that proved model. If explicit [] preserve [] and remove default; if nonempty declared list has no supported entry, use proved native default as singleton. Otherwise choose declared default only if present, then proved default if present, then first surviving effort. Do not clamp arbitrary provider/model names, destination overrides, or ordinary routed custom models.
- MODIFY src/codex/catalog/sync.ts: in retained sync merge, current invocation's live custom rows must not have max re-added. Use current config/producer provenance rather than a disk marker. Keep ordinary provider/combo/Reserve rules.
- MODIFY existing catalog-custom-models, sync-hardening, convergence and Claude model-discovery tests after reading actual filenames: canonical Astra with none/minimal + valid ladder; explicit []; all-invalid nonempty; valid default preserved; same-name noncanonical gateway unchanged; destination override unchanged; second sync no max resurrection; both gather entry points and /models client-version projection.
- MODIFY relevant English catalog/reasoning reference plus structure/03_catalog-and-subagents.md to state the narrow capability proof and explicit empty-list behavior. Translations must not claim broader gateway/client repair.

## Official evidence and deferrals

Local official source corpus 121_openai-codex: protocol/src/openai_models.rs allows nonempty custom effort strings; models-manager/src/manager.rs qualified lookup is consumer lookup, not gateway provenance; multi_agents_common.rs validates chosen-row membership. Codex source supports ultra and translates it on wire. API model docs lacking ultra do not justify deleting Codex ultra.

Field chain is existing custom config -> fetch custom row -> deriveEntry/retained merge -> catalog file/direct /models consumers. No new schema field or request-time effort override. Existing threads and version-specific stale runtime state are outside this repair.

Source/code inspection is completed; proposed regression commands are NOT RUN locally. Final remote CI must exercise modified tests and typecheck. #3775 must remain open for gateway destination and exact Desktop/version evidence; this fix addresses only proven canonical rows.
