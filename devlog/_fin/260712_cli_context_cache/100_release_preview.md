# 100 — preview 릴리스 기록 (v2.7.9-preview.20260712)

- bump: e99a23ce `release: v2.7.9-preview.20260712` (claudecode)
- PR #111 (claudecode→dev, CI 트리거용): 1차 CI FAIL 2건 — privacy-scan이 테스트 픽스처
  `sk-ant-oat01-test-token`을 token-looking으로 검출(스캐너 정상 동작, 픽스처를 패턴 밖으로
  단축) + Windows 경로 구분자 단언(join(homedir(),".claude")로 교정) → 75c9ec4a 후 9/9 pass
  (runs 29183107295 / 29183107296).
- preview 머지: 임시 worktree(/tmp/ocx-preview-merge)에서 merge commit 34539136, push.
- release.yml 디스패치: 입력명은 tag/dry-run (dist_tag/dry_run 아님 — 422로 학습).
  1차 dry-run은 가드에 막힘("No successful Cross-platform CI run found for 34539136") —
  preview push CI 완료 대기 후 dry-run 29183261694 success → 실배포 29183282123 success.
- 검증: npm dist-tags = { preview: 2.7.9-preview.20260712, latest: 2.7.8(불변) },
  GitHub Pre-release v2.7.9-preview.20260712 생성 (2026-07-12T06:52Z).
- 잔여: PR #111은 dev 승격용으로 열어둠 (main/dev 승격은 범위 외, 사용자 결정 대기).
