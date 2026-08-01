# 006 — jawcode import decision matrix

> Snapshot: 2026-07-17 local jawcode working tree. It is uncommitted and fingerprinted in `devlog/_fin/260717_jawcode_model_import_audit/001_research_snapshot.md`.

이 표는 “jawcode에 있으니 복사한다”가 아니라, 같은 문제를 OCX가 실제로 갖는지와 어느 owner가 책임져야 하는지를 결정한다. `IMPORT`/`ADAPT`도 코드 작업 승인이 아니라 표의 gate를 통과했을 때의 방향이다.

## 판정표

| 후보 | 근거 | OCX 현재 상태 | 결정 | 구현 전 gate |
|---|---|---|---|---|
| Cursor client-version 공용 owner | `local-source` | discovery `cli-2026.02.13-41ac335`, run `cli-2026.07.08-0c04a8a`로 drift | `ADAPT` | 두 경로가 같은 owner를 import하는 focused test |
| Cursor에 사용할 정확한 version | `live-unverified` | 두 값 중 어느 것이 양 endpoint의 현재 계약인지 미확인 | `RESEARCH` | 인증된 discovery와 run이 같은 값으로 성공하는 probe. jawcode의 02 값을 그대로 채택하지 않음 |
| OpenAI/Azure bounded 429 wrapper | `local-source` | OCX generic retry는 429를 재시도하지 않으며, key pool만 429에서 회전 | `NOOP` / direct port `REJECT` | 향후 SDK retry를 도입하거나 429 지연이 재현될 때만 provider-scoped fixture로 재검토 |
| GPT-5.6 Luna/Sol/Terra model IDs | `local-source` | 세 ID 모두 native, OpenAI API-key, OpenRouter에 이미 존재 | `NOOP` | 없음. 신규 모델 추가 대상이 아님 |
| GPT-5.6 context window | `local-source`, OCX contract implemented | jawcode 최종 373K와 달리 OCX Pool/Direct는 같은 bare 372K 그룹, API-key는 1.05M context / 922K max input, OpenRouter는 1.05M | `ADAPT` implemented | 없음. account-mode/API ownership과 compact cap이 테스트로 고정됨 |
| GPT-5.6 cost rows | `local-source` | OCX model catalog/runtime에 jawcode cost consumer가 없음 | `REJECT` current scope | billing/가격 UI owner가 생기기 전에는 생성물에 필드를 더하지 않음 |
| Antigravity picker에서 `gemini-3.1-pro-high` retire | `local-source`, `live-unverified` | OCX는 아직 picker seed에 노출 | `RESEARCH` | 인증된 available-models 또는 inference 실패 증거 |
| Antigravity inbound/wire alias 보존 | `local-source` | `gemini-3.1-pro-high -> gemini-pro-agent`를 테스트로 고정 | `NOOP` now | picker를 retire하더라도 기존 config 호환 alias는 별도 deprecation 없이 삭제하지 않음 |
| OpenCode Go `kimi-k2.7-code` effort map | `local-source`, `live-unverified` | OCX는 reasoning을 완전히 숨김; jawcode는 `xhigh|max -> high` 보정 | `RESEARCH`, then `ADAPT` | low/medium/high와 tool-choice 조합 live matrix |
| OpenCode Go `kimi-k2.7-code-highspeed` effort map | `live-unverified` | OCX는 기본 모델과 같이 reasoning을 숨기지만 jawcode 근거는 없음 | `RESEARCH` | highspeed 자체 probe. 기본 모델 결과를 전이하지 않음 |
| Anthropic 일반 요청의 disabled-thinking omission | `local-source` | OCX는 reasoning이 non-`none`일 때만 thinking을 보냄 | `NOOP` | 기존 `anthropic-reasoning` test 유지 |
| Anthropic web-search sidecar explicit disabled | OCX local source | 별도 sidecar가 의도적으로 `{type:"disabled"}` 전송 | `REJECT` coupled change | 해당 endpoint 계약의 독립 증거 없이는 일반 adapter 변경과 묶지 않음 |
| Anthropic OAuth organization identity | `chase-only` | OCX token parser는 account UUID/email만 저장 | `RESEARCH` | 실제 token response schema와 multi-org collision 재현 |
| Anthropic tool argument/stream index hardening | `local-source` | OCX adapter/parser 구조가 jawcode SDK event loop와 다름 | `RESEARCH`, then `ADAPT` | malformed tool JSON 및 interleaved block fixture를 OCX parser에서 먼저 재현 |
| Google tool-argument JSON sanitization | `local-source` | provider shape가 다르고 같은 malformed payload 재현 없음 | `RESEARCH` | OCX Google adapter의 failing fixture |
| Gemini CLI version header bump | `local-source` | OCX는 jawcode Gemini CLI transport와 같은 owner가 아님 | `REJECT` direct port | 동일 endpoint/header를 소유하는 경로가 확인될 때만 재검토 |
| LiteLLM rich metadata | `chase-only` + OCX local source | OCX는 context, reasoning boolean, vision boolean만 소비 | `ADAPT` consumer-first | Codex catalog가 실제 소비할 필드와 fixture를 먼저 추가. 임의 metadata passthrough 금지 |
| jawcode generated `maxTokens`, `reasoning`, `wireModelId` | `local-source` | 생성물에는 있으나 OCX catalog application은 소비하지 않음 | `RESEARCH` | 각 필드의 runtime consumer와 precedence contract 정의 |
| OpenRouter source-only 17 IDs | `local-source` | metadata regeneration만으로 OpenRouter row를 append하지 않음 | `NOOP` refresh-only / `RESEARCH` exposure | live `/models` 결과 또는 의도적 static seed 결정. [007](./007_model_id_delta.md) 참조 |
| xAI `grok-4.5` | `local-source` | OCX xAI registry에 이미 모델·reasoning·context가 있음 | `NOOP` | OpenRouter namespaced row와 direct xAI row를 혼동하지 않음 |
| Z.AI weekly-limit classifier | `chase-only`, `live-unverified` | 정확한 body classifier 없음 | `RESEARCH` | 실제 provider error body와 현재 key/failover 결과 fixture |
| invalid-prompt/refusal circuit breaker | `chase-only` | 400은 generic transient retry 대상이 아니며 refusal parsing도 존재 | `NOOP` for retry / `RESEARCH` normalization | 반복 retry가 실제 재현되거나 provider별 safety stop 통합 요구가 생길 때 |
| model hub, floating selection, custom role models | `chase-only` | jawcode agent UI semantics; OCX는 proxy catalog/management API 제품 | `REJECT` direct port | OCX GUI에 같은 사용자 요구가 정의될 때 별도 제품 계획 |
| prompt cap / agent dispatch guard | `chase-only` | jawcode agent prompt assembly와 OCX proxy context contract가 다름 | `REJECT` direct port | OCX-owned overflow 재현이 있을 때 catalog/context owner에서 설계 |
| Fugu/Sakana standalone provider/login | `official-source` + user direction | Sakana가 direct endpoint, Bearer auth, Responses/Chat, 두 모델을 공개했고 사용자가 first-class provider를 요청함 | `ADAPT` | registry/Responses fixture + authenticated smoke; [`010`](../../_plan/260717_non_openai_provider_chase/010_fugu_sakana_direct.md) |
| OpenRouter `sakana/fugu-ultra` | `local-source` | jawcode metadata row는 있으나 OCX는 OpenRouter row를 metadata로 append하지 않음 | `NOOP` static import / `RESEARCH` visibility | OpenRouter live discovery 결과를 권위로 사용 |

## 다음 코드 작업 후보

첫 구현 후보는 공식 direct 계약이 확인된 **Sakana Fugu provider**다. 그다음 명확한 hardening 후보는 **Cursor version owner 통합**이며, 값 자체는 여전히 `RESEARCH`다.

1. discovery와 run을 같은 version parameter로 probe한다.
2. 성공한 값을 공용 owner로 추출한다.
3. 두 caller와 override behavior를 focused test로 고정한다.
4. 실패 시 version을 추측해 통일하지 않고 현재 분리를 유지한 채 증거를 기록한다.

나머지는 [`260717_non_openai_provider_chase`](../../_plan/260717_non_openai_provider_chase/000_plan.md)의 decade 문서와 live-fixture gate 없이 코드 phase로 승격하지 않는다.
