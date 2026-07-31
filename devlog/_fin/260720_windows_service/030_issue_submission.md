# 030 — GitHub 이슈 등록 결과

2026-07-20, `gh issue create` (계정 lidge-jun, repo lidge-jun/opencodex).

| # | 종류 | 제목 | URL |
|---|------|------|-----|
| 165 | Bug (`bug`) | [Bug]: Windows 서비스 설치 시 콘솔 창이 표시되고, 창을 닫으면 프록시가 죽어 모든 모델 연결이 끊김 | https://github.com/lidge-jun/opencodex/issues/165 |
| 166 | Feature (`enhancement`) | [Feature]: Windows에서 창 없는 백그라운드 서비스 실행 모드 | https://github.com/lidge-jun/opencodex/issues/166 |

- 본문은 각각 010/020 초안의 `---` 이후 전문을 사용 (bug_report.yml / feature_request.yml 템플릿 섹션 준수).
- #166의 "연관 Bug 이슈" 자리에는 #165 URL을 삽입해 등록.
- 감사 이력: sol 리뷰어(gpt-5.6-sol/high) 라운드1 GO-WITH-FIXES(blockers=3) → fold-back → 라운드2 GO-WITH-FIXES(blockers=1, S4U 증거 과대해석) → fold-back 후 등록.
- 코드 수정은 이 유닛 범위 밖 — 후속 유닛에서 #166의 옵션 A(S4U 검증 매트릭스) 우선 검증 예정.
