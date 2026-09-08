# wp3: V2 guidance carry

Depends on wp2 in the owner-requested manual chain. Carry PR #3944 at 6fb0fc6f1d34c77b98a74fe817e5bd90063a7d1a with both original commits and contributor trailer. Local product verification is NOT RUN.

 separate proxy routing metadata from native policy

Source: [pinned collaboration implementation](https://github.com/lidge-jun/opencodex/blob/6fb0fc6f1d34c77b98a74fe817e5bd90063a7d1a/src/server/responses/collaboration.ts#L244), [pinned regression changes](https://github.com/lidge-jun/opencodex/blob/6fb0fc6f1d34c77b98a74fe817e5bd90063a7d1a/tests/codex-integration/multi-agent-compat.test.ts#L1188). C3 source change, with C4 care for developer-instruction and public-contract semantics; this lane does not run orchestration.

### Concrete before -> after hunks

| Exact path / baseline anchor | Before | After to carry |
| --- | --- | --- |
| `src/server/responses/collaboration.ts:242` | Only the native proactive constant exists. | Add private `OPENCODEX_SUBAGENT_GUIDANCE_OPEN_TAG` / `CLOSE_TAG` constants after it. Leave `PROACTIVE_MULTI_AGENT_MODE_TEXT` unchanged. |
| `src/server/responses/collaboration.ts:466-490` | Custom and built-in v2 bodies use native tags; built-in prescribes overrides, `fork_turns`, and preferred-model use. | Wrap both v2 paths in the proxy tag; replace only built-in preamble with routing-metadata wording; preferred clause ends with a period. Preserve placeholder substitution, effective preferred model, account namespace filtering, roster/fallback text, stale/unknown suppression and roster-drop budget. |
| `src/server/responses/collaboration.ts:543-545` | Exact generated-item predicate only. | Add `generatedGuidanceFamily(text)` recognizing exactly the two outer tag families. This is a dedup classification, not an authorship assertion. |
| `src/server/responses/collaboration.ts:583-594` | Latest-match handling only for native tag; other text dedups against any earlier exact match. | For either known family, compare incoming text to the latest exact generated developer text within that family in the replay prefix. For untagged text retain existing exact-item behavior. |
| `src/types/config.ts:472-475,515-516` | Effort JSDoc prescribes spawn overrides; custom-body wrapper is native tag. | Describe effort as advisory v2 metadata; update wrapper name. Preserve type declarations, injectionModel dependency and reasoning-level validation documentation. |
| `tests/codex-integration/multi-agent-compat.test.ts:270,387,615,741,781,847,1185` | Old v2 wrapper and imperative expectations; native-family A-B-A only. | Carry all changed expectations and new proxy/native replay matrices from the head; preserve existing v1, catalog, placement, sanitization and shape-negative tests. |
| `docs-site/src/content/docs/reference/configuration/agents.md:77-93` | Excludes v1 leaf workers and describes model/fork overrides. | Correct already-shipped leaf eligibility; describe proxy wrapper, advisory metadata, preserved custom body and per-family latest-text dedup. State mixed-version limitations. |
| `docs-site/src/content/docs/ja/reference/configuration/agents.md:31-37` | Old roster/guidance contract. | Carry corresponding roster correction and proxy/native/replay qualification. |
| `docs-site/src/content/docs/ko/reference/configuration/agents.md:31-37` | Same old contract. | Same localized contract. |
| `docs-site/src/content/docs/ru/reference/configuration/agents.md:38-57` | Same old contract, longer prose. | Carry full localized explanation including historical-message limitation. |
| `docs-site/src/content/docs/zh-cn/reference/configuration/agents.md:31-37` | Same old contract. | Same localized contract. |

Do not mass-replace `<multi_agent_mode>`: `collaboration.ts:493-497` remains the v1 max/ultra parity path, and native/legacy history must remain byte-identical. Do not add a settings migration or infer the author of an old tagged message. No revocation of already injected instructions is claimed.

### Data creation and consumers

Existing config fields, not new fields: `/api/injection-model` maps `model`, `effort`, `prompt`, `multiAgentGuidanceEnabled` to `OcxConfig.injectionModel`, `injectionEffort`, `injectionPrompt`, `multiAgentGuidanceEnabled` (`agent-settings-routes.ts:501-508,529-589`). `saveConfigPreservingClaudeCode` persists the existing JSON config. No changes to that input/storage contract are needed.

`src/server/responses/core.ts:2421-2429` passes those fields, route account namespace, featured models and fallback to `multiAgentGuidanceText`. `collaboration.ts:366-405` retains feature/tool/catalog admission; `:409-464` retains request-scoped roster and preferred/fallback derivation. Only the final rendered text changes. `applyInjectionPlaceholders` at `:504-509` still substitutes the four placeholders and preserves unknown placeholders.

`core.ts:2430-2433` calls `injectDeveloperMessage`. `collaboration.ts:583` creates raw `{type:"message",role:"developer",content:[{type:"input_text",text}]}`; `:597-613` creates the parsed `{role:"developer",content:text,timestamp}` and places it; `:616-621` splices raw input at the matching conversation position. Both representations must retain the same ordered text across stateful replay. `src/server/responses.ts:6` reexports the same public helpers unchanged. `src/codex/subagent-model-fallback.ts:688-692` continues owning fallback prose. Native default sync is an independent consumer per `structure/03_catalog-and-subagents.md:459-465`; do not merge it with guidance.

### Regression activation

Carry the existing hermetic `CODEX_HOME` / catalog fixture builders (`multi-agent-compat.test.ts:23-103`), including the fresh catalog override and its cleanup. Test the actual helpers through `parseRequest`, raw input, `_replayPrefixLen`, and `_continuationConversationMessageIndex`.

1. V2 built-in has proxy tags and model/effort/roster/fallback metadata, and lacks native tag, `fork_turns`, and preferred-model imperative. V1 max/ultra retains native tag and below-top silence. Disabled guidance and stale/unknown catalog produce null.
2. Built-in A -> custom B -> built-in A appends last A; unknown placeholders/newlines in custom B remain unchanged.
3. Native A -> proxy P -> native B -> same proxy P adds nothing; native text dedup ignores later proxy P.
4. Old built-in/native-tagged custom text + native policy + new proxy text preserves the original prefix and appends new proxy metadata. Never assert historical authorship or automatic cleanup.
5. Keep exact-shape negatives, 700-character fixture, external-task input, leading tool-result, compaction marker and raw/parsed alignment cases.
6. Small additional hunk recommended in `tests/server/server-combo-failover-e2e.test.ts:2285` beside the existing generated-guidance replay case: configure a synthetic v2 tool/catalog route, change built-in -> custom -> built-in across actual response continuations, capture adapter input, assert latest proxy guidance and native policy survive once and precede the current task. Use the existing server harness. Preserve current-dev compaction/recall fixtures in this file. This activates the caller/replay integration rather than only manually assigning parsed indices.

Remote-only focused activation: `bun test tests/codex-integration/multi-agent-compat.test.ts`; additionally `bun test tests/server/server-combo-failover-e2e.test.ts` if adding the caller fixture. **NOT RUN here.** Negative controls for the remote verification owner: reverting the custom wrapper, collapsing the two families, or changing latest-family comparison to any-ever comparison must fail the corresponding transition tests. No local mutation/control execution.


Main decision: preserve the complete original diff. The optional extra server caller fixture is deferred unless source audit reveals an untested change; do not duplicate the existing replay matrix merely for volume. Sync structure/03_catalog-and-subagents.md to the new tag and policy boundary.

## wp3 P refresh

Previous wp2 D: PR3991 head00eb47886 passed run34180674115, source audit and remote docs425pages; proceed guidance carry. Prepared layer3 consists of24977adf2,21757b71a,8000e2482, based on d1f61e933. Intervening wp2 changes affect xAI adapter/tests, provider/adapters docs and structure04; none overlap the9layer3 files. Original #3944 remains open at6fb0fc6f. Independent prepared-source/security audit PASS in isolated v2GuidanceReviewer.md; actual adoption requires unchanged-delta/interdiff verification and own hostedCI.
