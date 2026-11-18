# 001 Research: developer-role rejection, prior art (#8864)

Research only. Implementation designs live in the 010-030 docs.

## Evidence in this repository

| Fact | Where |
|---|---|
| Pi's builder writes `compat.supportsDeveloperRole: false` only when `foldDeveloperRole` is passed | `src/clients/config-export.ts:1138` |
| `PI_EXPORT_OPTIONS = { sendSessionAffinityHeaders: true, foldDeveloperRole: true }`, used by pi, omo, gentle-shell | `src/clients/config-export.ts:1158`, `:1533`, `:1727`, `:1786` |
| Prime and Aside call the builder with no options on both paths | `src/clients/config-export.ts:1416`, `:1439`, `:1671`, `:1689` |
| Session affinity was deliberately limited to Pi | commit `eb8cc9ab73` "fix(pi): scope generated session affinity to the Pi client" |
| The Prime test removes Pi's whole `compat` before comparing, which also hid the developer-role flag | `tests/clients/prime-client.test.ts:41` |
| Native Chat folds `developer` only on an explicit record; absent means forward verbatim | `src/adapters/openai-chat/developer-role.ts:24`, `src/adapters/openai-chat/passthrough.ts:86` |
| moonshot and mistral record the fold (#7583/#7584) | `src/providers/registry/entries-extended.ts:503`, `:1081` |
| Saved configs inherit a registry record without re-adding the provider | `src/providers/derive.ts:618`, `src/providers/routed-config.ts:356` |
| Upstream text never reaches a log row or a client body; client text is proxy-owned | `structure/data-planes/error-detail.md`, `src/usage/error-detail.ts:1-7` |
| Closed validation pairs already include `messages.role` / `enum`, and the dashboard renders them | `src/lib/upstream-validation-detail.ts:2-10` |
| A recognized upstream token may map to a fixed proxy sentence (`MODEL_NOT_IN_PLAN`) | `src/lib/client-error-body.ts` `ACTIONABLE_REFUSALS`, `structure/data-planes/error-detail.md:292` |

## How earlier fixes solved the same class

- #5664 / #5674 (Pi): the export states `supportsDeveloperRole: false` so the client sends `system`. The export rewrites the whole provider block on every refresh, so a hand edit cannot persist; the export must carry the flag.
- #7583 / #7584 (moonshot): the registry records `foldDeveloperRoleToSystem: true`; the native passthrough then rewrites `developer` to `system` for that preset, and saved configs inherit the record through `routedProviderConfig`. Test: `tests/providers/moonshot-developer-role.test.ts`.
- #6409 (hive): the same rejection on another gateway, surfaced only as "Bad Request". Shows the generic 400 hides the cause.

## Upstream rejection wording (keyword evidence)

| Gateway | Wording | Source |
|---|---|---|
| Alibaba DashScope compatible-mode | `developer is not one of ['system','assistant','user','tool','function']` | #5664 body; #8864 body; [openclaw#13633](https://github.com/openclaw/openclaw/issues/13633) |
| Moonshot | `400 Invalid request: role 'developer' is not allowed` | registry comment `entries-extended.ts:500`; docs-site providers reference |

## External prior art

- Pi documents `compat.supportsDeveloperRole` for `openai-completions` providers, per provider or per model; `false` makes it send the system prompt as `system` ([pi models.md](https://github.com/davidondrej/pi-agent/blob/main/packages/coding-agent/docs/models.md), [models-configuration.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models-configuration.md)). Aside and Prime ship the same runtime and read the same `models.json` contract.
- LiteLLM converts each `developer` message into a `system` message in place for OpenAI-compatible providers that reject the role, with `supports_mid_conversation_system: false` for models that need a single leading system message ([LiteLLM: Developer Role](https://docs.litellm.ai/docs/completion/developer_role)). This matches `foldDeveloperRoleToSystem` plus `singleLeadingSystemMessage`.
- Alibaba Model Studio's OpenAI-compatible examples use `system` and publish no accepted-role list; the 400 itself is the spec ([DashScope API reference](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-dashscope), [OpenAI compatibility](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope)).

## Conclusions used by the plan

1. Fix the export (covers every destination behind the one `opencodex` block) and the registry (covers non-Pi Chat clients). Both precedents exist in this repository.
2. Give Prime/Aside only the developer-role flag; session affinity stays Pi-only (eb8cc9ab73).
3. Diagnostics must stay inside the closed-vocabulary invariant: recognize the rejection from fixed keywords, emit a proxy-owned sentence, record the closed pair `messages.role`/`enum`. No upstream text is stored or relayed.

