# 040 — wp5: PR 게시와 머지

## docs-site 동기화 (감사 추가)

`deepseek-v4-pro`는 9개 로케일의 `guides/providers.md`, `guides/sidecars.md`, `guides/model-ordering.md`, `reference/configuration/providers.md`와 `docs-site/src/data/frontier-benchmarks.json`에 등장한다. 코드에서 모델을 지우면서 문서가 그대로면 영문 원문과 로케일이 동시에 거짓이 된다.

범위: 제거된 모델을 **사용 가능한 모델로 제시하는** 문장만 고친다. 벤치마크 데이터(`frontier-benchmarks.json`)는 과거 측정 기록이므로 손대지 않는다 — 생성 메타데이터를 남기는 것과 같은 이유다.

## 순서

1. #4258 머지 (wp2에서 완료) → `dev` fetch → 내 브랜치 리베이스
2. #4274(Zen 프리셋 안정화) CI green 확인 후 머지
3. V4.1 전환 변경을 새 PR로 게시하고 CI green 확인 후 머지

#4274를 먼저 머지하는 이유: 이미 리뷰가 끝났고 CI가 거의 다 통과했다. V4.1 변경과 같은 파일(`registry.ts`)을 건드리므로, 뒤에 올리는 쪽이 리베이스한다.

## 머지 조건 (MAINTAINERS.md)

- base `dev`
- exact-head CI green — 머지 직전 `gh pr checks`로 확인하고 커밋 SHA와 함께 기록
- 유지관리자 단독 통합 시 결정 근거를 남긴다
- `main`/`preview` 승격과 릴리스는 이번 범위 밖

## PR 본문에 반드시 들어갈 것

- V4.1 전환 근거와 출처 링크
- 조사 결과가 갈렸다는 사실과 어느 해석을 택했는지 (001 참조)
- id 분기 이유: 네이티브 `deepseek-flash` vs 게이트웨이 `deepseek-v4.1-flash`
- v4-pro 제거를 두 커밋으로 나눈 이유와, 벤더 호스팅 커밋만 되돌리는 방법
- 생성 메타데이터를 손대지 않은 이유 (과거 사용량 원가 계산)
- 전체 스위트를 로컬에서 돌리지 않았다는 사실
