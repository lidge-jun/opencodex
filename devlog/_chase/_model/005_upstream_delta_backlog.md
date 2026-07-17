# 005 — Upstream model/provider delta backlog

> Re-triaged: 2026-07-17 against OpenCodex `0167b415` and the fingerprinted local jawcode snapshot in `devlog/_fin/260717_jawcode_model_import_audit/001_research_snapshot.md`

초기 후보는 jawcode의 로컬 미커밋 `struct_har/chase/model/`과 실제 `packages/ai` 변경을 함께 대조했다. 이 문서는 실행 우선순위만 요약하며, 판정 근거는 [006](./006_jawcode_import_matrix.md), 모델명은 [007](./007_model_id_delta.md), 로직은 [008](./008_logic_delta.md)를 정본으로 삼는다.

## 현재 분류

| 항목 | 상태 | 현재 OCX 근거 | 다음 행동 |
|---|---|---|---|
| Fugu/Sakana | `REJECT` standalone / `PARTIAL` OpenRouter | standalone registry/auth는 없고, `sakana/fugu-ultra`는 jawcode OpenRouter metadata에 존재한다. metadata만으로 OCX row가 추가되지는 않는다. | standalone provider는 수요·endpoint·auth가 생길 때 재검토. OpenRouter는 live discovery 결과를 따른다. |
| Z.AI weekly-limit taxonomy | `PARTIAL` | `zai` registry/model metadata는 있음 (`src/providers/registry.ts:556`). exact weekly-exhaustion classifier는 없음 | 실제 Z.AI error body를 확보해 provider-scoped 분류가 필요한지 결정한다. |
| Cursor shared version owner | `OPEN` | discovery와 run의 상수가 갈라져 있다. jawcode는 한 owner를 사용한다. | owner 통합은 `ADAPT`; 사용할 버전 값은 인증된 discovery/run probe 후 결정한다. |
| OpenAI/Azure bounded 429 retry | `REJECT` direct port | generic retry가 429를 재시도하지 않고 key pool만 별도로 회전한다. jawcode wrapper는 OpenAI SDK 내부 retry를 막기 위한 코드다. | 현 구조에서는 복사하지 않는다. retry 정책이 바뀌면 quota fixture로 재검토한다. |
| OpenCode Go Kimi effort | `RESEARCH` | OCX는 `kimi-k2.7-code`와 `-highspeed` reasoning을 모두 숨긴다. jawcode는 기본 모델의 일부 effort를 허용·보정한다. | 두 모델을 별도 live probe해 지원표가 확인될 때만 `ADAPT`. |
| Anthropic disabled-thinking omission | `VERIFIED` / `NOOP` | 일반 adapter는 non-`none`일 때만 thinking을 보낸다. web-search sidecar의 explicit disabled는 별도 계약이다. | 일반 경로 이식 없음. sidecar를 함께 바꾸지 않는다. |
| LiteLLM rich/vision metadata 보존 | `PARTIAL` | keyless/self-hosted route와 live discovery는 있음. parser는 context, reasoning boolean, vision boolean을 읽지만 임의 rich metadata를 보존하지 않음 (`src/codex/catalog.ts:990-1124`) | OMP가 보존하는 필드와 Codex가 실제 소비하는 필드의 교집합을 정한다. |
| Codex credential rotation/self-heal | `VERIFIED` 기반, delta 확인 필요 | multi-account affinity, cooldown, generation-safe OAuth persist가 이미 별도 구현됨 | OMP 변경을 auth/account outcome 단위로 비교하고 중복 추상화를 피한다. |
| response terminal/replay 호환 | `PARTIAL` | Responses parser/bridge에 기존 terminal handling이 있으나 OMP `response.done`, Anthropic replay commit과 line-by-line 대조하지 않음 | `src/responses/`, `src/adapters/openai-responses.ts`, Anthropic replay test를 함께 비교한다. |
| Antigravity `gemini-3.1-pro-high` | `RESEARCH` | jawcode는 picker에서 retire하지만 OCX는 `gemini-pro-agent` 호환 alias로 노출·테스트한다. | picker 제거와 inbound alias 보존을 분리해 인증된 가용성 probe 후 결정한다. |
| GPT-5.6 context/cost | `RESEARCH` | 세 ID는 이미 존재한다. jawcode 1.05M→373K 정책과 OCX native/API 372K, OpenRouter 1.05M이 다르며 OCX는 jawcode cost를 소비하지 않는다. | transport별 live contract를 확인. 모델명이나 비용을 무조건 복사하지 않는다. |

## 우선순위

### Tier 1 — 작고 명확한 drift

1. Cursor client-version 공용 owner 설계와 discovery/run probe.
2. Antigravity picker 가용성 확인 및 alias 호환성 분리.
3. jawcode metadata generator refresh가 실제 소비 필드에 미치는 영향 확인.

### Tier 2 — provider 정책 비교

4. OpenCode Go `kimi-k2.7-code`와 `-highspeed` effort probe.
5. LiteLLM metadata field diff와 소비자 확인.
6. Z.AI weekly-limit 실제 error fixture 확보 및 분류 결정.
7. response terminal/replay parity.

### Tier 3 — 제품 결정이 먼저인 항목

8. Fugu/Sakana standalone provider 수요 여부.
9. jawcode native provider 변화의 sibling sync를 자동화할지 결정.

## 갱신 절차

1. jawcode `struct_har/chase/model/005_upstream_model_delta.md`의 source range와 현재 HEAD를 확인한다.
2. candidate commit의 실제 diff를 연다. commit 제목만으로 import하지 않는다.
3. OCX owner를 registry, auth, router, adapter, catalog, docs-only 중 하나로 분류한다.
4. 현재 focused test가 이미 같은 계약을 증명하는지 먼저 찾는다.
5. 구현하거나 `REJECT` 근거를 남기고 이 표의 상태를 갱신한다.

## 재검증 검색

```bash
rg -n -i "fugu|sakana|fish_|weekly limit|client-version|litellm|response.done|thinking.*disabled" src tests
rg -n "isTransientUpstreamStatus|rotateKeyOn429|CURSOR_DISCOVERY_CLIENT_VERSION|CURSOR_CLIENT_VERSION" src tests
git -C ../jawcode status --short struct_har/chase/model
git -C ../jawcode log -1 --oneline
```
