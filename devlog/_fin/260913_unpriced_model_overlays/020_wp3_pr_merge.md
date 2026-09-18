# 020 — wp3: PR → 호스티드 CI → 머지

## 절차

1. 브랜치 codex/260913-unpriced-model-overlays를 origin에 push --no-verify.
2. gh pr create --base dev, 템플릿 전 섹션 충족(Summary/Verification/Checklist).
   Verification에는 "로컬 스위트 NOT RUN(사용자 지시), 호스티드 CI만" 명시.
3. PR head SHA의 호스티드 CI를 gh run list / checks로 감시. 실패 시 원인 분석 후
   수정 커밋 → 재푸시.
4. Codex/CodeRabbit 리뷰 확인, 정당한 finding 반영.
5. CI 그린 확인 후 머지(스쿼시). dev로의 머지는 MAINTAINERS 정책 범위 내에서 진행 —
   사용자가 "머지까지 완료해줘"로 명시 승인.

## 완료 조건

- PR merged 상태, dev에 커밋 반영.
- goalplan criteria c-1..c-4 전부 met.
