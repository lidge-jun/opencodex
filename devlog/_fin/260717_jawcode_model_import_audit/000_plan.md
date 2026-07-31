# 000 — jawcode model import audit plan

## Loop specification

- **Archetype:** spec-satisfaction / documentation audit
- **Trigger:** jawcode의 model/provider chase와 실제 로직·모델명을 OpenCodex와 대조해 이식 대상을 기록한다.
- **Goal:** 각 차이를 `IMPORT`, `ADAPT`, `NOOP`, `REJECT`, `RESEARCH` 중 하나로 분류하고, 정확한 모델 ID·소유 경로·검증 조건을 `_model` 기준 문서에 남긴다.
- **Non-goals:** production code 변경, jawcode 수정, generated metadata 재생성, 외부 provider 호출, 모델 가용성 추정.
- **Verifier:** source anchor 재검색, provider/model set 비교, generated snapshot diff, Markdown link/path 검사, `git diff --check`.
- **Stop condition:** 조사한 후보마다 결정·근거·후속 검증이 있고 문서 링크와 파일 경로가 유효하다.
- **Memory artifact:** `devlog/_chase/_model/006_jawcode_import_matrix.md`, `007_model_id_delta.md`, `008_logic_delta.md`와 이 실행 단위.
- **Terminal outcomes:** `done` 또는 실제 endpoint 증거가 필요한 항목을 명시한 `deferred`; 코드 구현으로 자동 확장하지 않는다.

## Evidence boundary

- jawcode 근거는 2026-07-17 로컬 working tree의 **미커밋 스냅샷**이다.
- jawcode chase 문서의 upstream range와 로컬 소스를 함께 읽되, upstream에 병합됐다고 간주하지 않는다.
- OpenCodex 판단은 현재 `dev` 소스와 테스트를 기준으로 한다.

## Planned documentation changes

| 경로 | 작업 | 목적 |
|---|---|---|
| `devlog/_chase/_model/README.md` | 수정 | 새 비교 문서의 읽는 순서와 상태 어휘 추가 |
| `devlog/_chase/_model/005_upstream_delta_backlog.md` | 수정 | 기존 넓은 backlog를 실제 대조 결과와 새 상세 문서에 연결 |
| `devlog/_chase/_model/006_jawcode_import_matrix.md` | 신규 | 로직 후보별 최종 판정·OCX owner·검증 gate |
| `devlog/_chase/_model/007_model_id_delta.md` | 신규 | provider namespace, 모델 ID, context/max-output 차이 |
| `devlog/_chase/_model/008_logic_delta.md` | 신규 | Cursor, retry, reasoning, auth, metadata 등 로직 차이 |
| `devlog/_plan/260717_jawcode_model_import_audit/001_research_snapshot.md` | 신규 | 재현 가능한 조사 스냅샷 |
| `devlog/_plan/260717_jawcode_model_import_audit/010_docs_update.md` | 신규 | 문서별 acceptance criteria와 검증 명령 |

## Acceptance criteria

1. jawcode가 미커밋 상태라는 경계가 모든 결론의 전제에 표시된다.
2. provider 이름의 단순 집합 차이와 의미상 alias를 분리한다.
3. GPT-5.6 tier, OpenRouter 신규 ID, Antigravity retired alias, OpenCode Go Kimi를 정확한 모델명으로 기록한다.
4. Cursor version drift, bounded 429, Anthropic disabled-thinking, metadata bridge를 line-level 근거로 판정한다.
5. 이미 OCX가 충족하는 동작은 `NOOP`, 제품 경계 밖은 `REJECT`, live proof가 필요한 것은 `RESEARCH`로 남긴다.
6. 코드 변경 없이 문서만 커밋하고 jawcode working tree는 건드리지 않는다.

## A-phase audit amendments

Independent audit verdict: `GO-WITH-FIXES (blockers=7)`. All seven medium findings are folded into the build contract:

1. Pin the mutable jawcode snapshot with per-file SHA-256 values and rerun the source/generated comparison at closeout.
2. Split Cursor into `ADAPT` for one shared owner and `RESEARCH` for the canonical version value.
3. Show jawcode GPT-5.6 pre-policy and post-policy values separately from each OCX transport; classify cost ingestion separately because OCX has no cost consumer.
4. Split Antigravity picker retirement from inbound/wire alias compatibility. Do not delete the alias without authenticated proof.
5. Treat `kimi-k2.7-code` and `kimi-k2.7-code-highspeed` as separate evidence rows.
6. Classify all 17 OpenRouter IDs by exposure path; distinguish standalone Fugu/Sakana ownership from `openrouter/sakana/fugu-ultra` discovery.
7. Add an evidence-kind column (`local-source`, `chase-only`, `live-unverified`) and cap chase-only/live-unverified decisions at `RESEARCH`.

## Closeout

- Completed as a documentation-only work phase on 2026-07-17.
- Final artifacts: `devlog/_chase/_model/005_upstream_delta_backlog.md` through `008_logic_delta.md` plus this archived implementation unit.
- No production source, generated metadata, or jawcode file was changed.
