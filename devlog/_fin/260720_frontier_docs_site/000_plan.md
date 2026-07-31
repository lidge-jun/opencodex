# 260720_frontier_docs_site — PR #144 Frontier 벤치마크를 docs-site로 이식

## Objective

PR #144(GUI Frontier 페이지, +5,421줄)를 GUI에 머지하는 대신, 정적 데이터
특성에 맞는 docs-site(Astro Starlight, GitHub Pages)의 Benchmarks 페이지로
이식한다. GUI에는 React+ECharts 런타임과 수동 데이터 갱신 부담을 남기지 않는다.

## 결정 근거

- diff의 절반(2,665줄)이 정적 스냅샷 JSON — 문서 사이트가 자연스러운 거처.
- docs-site는 업데이트 주기가 느려도 되는 표면(사용자 결정, 2026-07-20).
- GUI 런타임에 echarts 의존성 추가 회피. docs-site에만 echarts 추가(번들,
  React 없이 바닐라 API).

## 범위

- IN: `frontier-benchmarks.json` 복사, i18n(en/ko/zh) 추출, FrontierBoards.astro
  (보드별 산점도 차트 + provenance/costKind 정직성 표기 + 측정 통일 시에만 점수/$
  컬럼), 3개 로캘 MDX, 사이드바, 갱신 절차 문서, astro build + 렌더 검증.
- OUT: GUI 변경 일체, PR #144의 react-doctor 워크플로우 변경, 5종 차트 중
  산점도 외(cost stack/score/efficiency/reasoning), 도메인/필터 UI.
- 데이터 출처: PR #144 (Wibias) — 이식 사실을 #144에 코멘트로 남긴다.

## Amendment 1 (2026-07-20): 단일 페이지 → 별도 카테고리 분할

사용자 피드백: 한 페이지에 10개 보드를 다 넣지 말고 별도 카테고리로 분리.

- 사이드바에 top-level **Benchmarks** 카테고리(collapsed), Guides 아래 단일
  항목은 제거.
- 구조: Overview(`benchmarks/`) + 도메인별 페이지 5개(coding/frontend/terminal/
  security/intelligence) × 3 로캘. 도메인 매핑은 PR의 frontier-domains.ts 그대로
  (coding 6보드, 나머지 1보드씩).
- FrontierBoards.astro에 `boards`(보드 id 필터) + `intro`(서브타이틀 표시 여부)
  prop 추가. Overview는 차트 없이 도메인 링크 인덱스만.

## 검증

- `bun run build` (docs-site) 성공.
- `astro preview` + 브라우저로 #benchmarks 페이지 렌더 확인(차트 표시, 3 로캘).
- 배포: dev → preview → main FF 머지(deploy-docs가 main push 시 자동 배포).
