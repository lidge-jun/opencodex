# chase — 실행 인덱스

> current through: OpenCodex source and model chase re-audit on 2026-07-17
> durable roadmap: [`devlog/_plan/260717_non_openai_provider_chase/000_plan.md`](../_plan/260717_non_openai_provider_chase/000_plan.md)

오래된 7월 1일 분류의 “Cursor 어댑터 미포팅”, “xAI 전용 경로 없음”은 현재 소스와 맞지 않는다. 아래 표는 OpenAI와 xAI를 제외한 다음 실행 순서다. 한 행은 한 PABCD work-phase이며, 정확한 diff와 검증 기준은 연결된 decade 문서가 정본이다.

## 실행 순서

| WP | 항목 | 결정 | 계획 |
|---|---|---|---|
| 1 | Sakana Fugu/Fugu Ultra direct | `ADAPT` | [`010`](../_plan/260717_non_openai_provider_chase/010_fugu_sakana_direct.md) |
| 2 | Cursor client-version owner | `ADAPT` after live probe | [`020`](../_plan/260717_non_openai_provider_chase/020_cursor_client_version_owner.md) |
| 3 | Antigravity indexed replay + picker/alias split | `RESEARCH` → `ADAPT/NOOP` | [`030`](../_plan/260717_non_openai_provider_chase/030_antigravity_replay_alias.md) |
| 4 | OpenCode Go Kimi effort | `RESEARCH` → `ADAPT/NOOP` | [`040`](../_plan/260717_non_openai_provider_chase/040_kimi_effort_matrix.md) |
| 5 | Z.AI weekly-limit classifier | fixture-gated | [`050`](../_plan/260717_non_openai_provider_chase/050_zai_weekly_limit.md) |
| 6 | Anthropic indexed stream/tool replay | fixture-gated | [`060`](../_plan/260717_non_openai_provider_chase/060_anthropic_stream_replay.md) |
| 7 | consumer-backed metadata | `ADAPT/NOOP` | [`070`](../_plan/260717_non_openai_provider_chase/070_metadata_consumers.md) |
| 8 | DeepInfra | `ADAPT` | [`080`](../_plan/260717_non_openai_provider_chase/080_deepinfra_provider.md) |
| 9 | Cohere compatibility API | `ADAPT` | [`090`](../_plan/260717_non_openai_provider_chase/090_cohere_provider.md) |
| 10 | AI21 Jamba | `ADAPT` | [`100`](../_plan/260717_non_openai_provider_chase/100_ai21_provider.md) |
| 11 | Databricks workspace serving | `ADAPT`, workspace-bound | [`110`](../_plan/260717_non_openai_provider_chase/110_databricks_provider.md) |
| 12 | Amazon Bedrock Mantle | `ADAPT`, OpenAI-compatible first | [`120`](../_plan/260717_non_openai_provider_chase/120_bedrock_mantle.md) |
| 13 | Vertex ADC/OAuth setup UX | existing auth productization | [`130`](../_plan/260717_non_openai_provider_chase/130_vertex_adc_oauth.md) |
| 14 | Native Bedrock Runtime | Mantle-gap only; optional SigV4 | [`140`](../_plan/260717_non_openai_provider_chase/140_bedrock_runtime_sigv4.md) |
| 15 | integration and chase closure | final gate | [`150`](../_plan/260717_non_openai_provider_chase/150_integration_closeout.md) |

## opencodex 선행 (유지·회귀 방지)

Kiro 풀세트, Codex WS, xAI OAuth/replay/live discovery는 따라잡을 대상이 아니라 현재 OpenCodex 소유 경로다. 이 로드맵은 해당 경로를 건드리지 않는다.

## 갱신 규칙

각 work-phase의 P에서 현재 source/official contract를 재검증하고, D에서 decade 문서와 model chase 표를 함께 갱신한다. 전체 종료 시 `150`이 이 인덱스와 일반 문서를 최종 동기화한다.
