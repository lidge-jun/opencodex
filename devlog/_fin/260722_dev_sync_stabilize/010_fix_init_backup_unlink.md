# 010 — `ocx init` 백업 무조건 삭제 수정 (sol BLOCKER)

## 문제

`src/cli/init.ts:143`이 `saveConfig` 직후 `.pre-openai-tiers-v2.bak`을 무조건 `unlinkSync`한다.
`src/config.ts:183-204`(`backupConfigBeforeOpenAiTierMigration`)는 백업을 분류해서
"유효한 v1(pre-migration) 롤백 스냅샷"이면 절대 덮어쓰지 않고 collision error를 던지는데,
init 경로는 이 정책을 우회하고 사용자 의도 롤백 포인트를 조용히 삭제한다(비가역 데이터 손실).

#257의 원래 의도: init이 fresh v2 config를 쓰면 이전 backup은 orphan이 되어 다음
`ocx start`가 stale-backup collision으로 크래시하므로 제거 — 하지만 "orphan" 판정 없이
전부 삭제한 게 결함.

## 수정 설계 (diff-level)

`src/cli/init.ts`:

- `unlinkSync` 무조건 호출 제거.
- config.ts의 stale 분류와 동일한 규칙 적용:
  - backup 파일이 없으면 no-op.
  - backup이 JSON 파싱 불가 → stale → 삭제 (기존 #257 동작 유지).
  - backup의 `openaiProviderTierVersion === 2` → post-migration orphan → 삭제 (기존 #257 동작 유지).
  - 그 외(유효 v1 롤백 스냅샷) → 삭제하지 않고 `.pre-openai-tiers-v1-rollback.<ts>.bak`으로 rename 회전 +
    콘솔 경고로 보존 위치 안내. init 이후 config는 v2이므로 다음 start의 projection은
    `changed: false`가 되어 backup 경로 자체를 타지 않아 collision 크래시도 없음
    (openai-tiers.ts:233-241 확인) — 하지만 사용자가 나중에 legacy provider를 다시 추가하는
    엣지에 대비해 v2 경로에서 치우는 rename이 안전.
- 구현은 config.ts에 `classifyOpenAiTierBackup(bytes): "stale" | "rollback"` 헬퍼를 export해
  두 경로가 같은 분류를 공유하게 한다 (정책 이중화 방지).

`tests/openai-provider-option-startup.test.ts` 또는 신규 테스트:

- init 시 stale(v2) backup 삭제 유지 확인.
- init 시 유효 v1 backup은 삭제되지 않고 rename 보존 확인.

## 범위 외 (follow-up 기록만)

- MAJOR: `login/cancel`이 flowId 없이 provider-global cancel + 전체 pending flow 만료
  (`auth-api.ts:808`, `expireCodexAuthFlow(null)`, GUI `AddCodexAccountModal.tsx:117-127`).
  단일 사용자 로컬 프록시 특성상 실사용 충돌 빈도는 낮고, 소유권 토큰 설계가 필요해
  별도 이슈/워크페이즈로 분리.
- MINOR: `ja.ts` custom-model/cost-breakdown 영어 폴백 — 크래시 없음, 번역 PR 대상.
