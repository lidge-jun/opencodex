# Workspace Design Parity — PR #139 디자인 누락분 복원

## 문제

PR #139/#140 rebuild에서 소스 모놀리스(ProviderWorkspace.tsx 2,791줄)를 분해할 때
세 가지 디자인 영역이 placeholder로 대체된 채 빠졌다:

1. **집계 Overview 대시보드** — 프로바이더를 선택하지 않았을 때 보이는 화면
2. **디테일 헤더 액션** — 선택된 프로바이더의 Test connection / 삭제 / Enabled 토글
3. **Overview 탭 2-column 레이아웃** — ConnectionCard + Auth 좌측, Stats + Notes 우측

## Phase map

| Phase | 산출물 | 핵심 변경 | 예상 diff |
|-------|--------|-----------|-----------|
| 010 | 집계 대시보드 | NEW `ProviderOverviewDashboard.tsx` + shell 와이어링 + CSS + locale | ~250 |
| 020 | 디테일 헤더 액션 | MODIFY `ProviderDetails.tsx` + shell props 추가 + locale | ~200 |
| 030 | 2-column Overview + Notes | MODIFY `ProviderOverview.tsx` + CSS grid + Notes 편집 | ~180 |

## 범위 경계

- IN: 위 3개 phase의 프레젠테이션 컴포넌트 + CSS + locale
- OUT: 백엔드 변경 없음 (WP040 connectivity probe, WP040 PATCH, quota API는 이미 존재)
- OUT: QuotaBars.tsx 전면 교체 (별도 scope)
- OUT: push/PR (명시적 승인 필요)
