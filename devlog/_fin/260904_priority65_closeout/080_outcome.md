# 080 — 결과 기록

base `2421e44ce` → 최종 `origin/dev` `413227888`.

## 랜딩

| PR | squash | 내용 | 트레일러 |
|----|--------|------|----------|
| #3471 | `4968d0f26` | wp2 responses 경계 + wp4 combo context cap | RHODIZ IT |
| #3474 | `00834d710` | wp3 combo metadata + wp5 reset-credit + wp6 게이트 해제 | full999, olddonkey, Abhishek Sharma |
| #3477 | `413227888` | wp7 롤백 저널 삭제 CRUD | — (자체 작성) |

세 SHA 모두 `git merge-base --is-ancestor <sha> origin/dev`로 조상 확인.

## wp3 — #3332 carry

커밋 `c691c2565`. PR 원안이 `metadata.maxTokens`(OUTPUT 상한)를 `maxInputTokens`에
매핑해 combo 입력창을 1M → 128k로, `autoCompactTokenLimit`을 900k → 128k로 무너뜨리는
것을 실측으로 확인한 뒤 `maxOutputTokens`로 교정했다.

검증이 3단계였던 것이 이 phase의 값이다. 무수정 코드에서 2 fail을 본 뒤,
**PR의 결함 매핑을 적용한 중간 상태**에서 저격 단언이 여전히 red로 남는 것을 확인하고,
그 다음에야 고쳤다. 초록으로만 끝나는 테스트는 무엇을 겨냥하는지 증명하지 못한다.

원 PR 테스트가 이 결함을 못 잡은 이유도 기록해 둔다. `toMatchObject`는 열거한 키만 보고
`contextWindow`는 1M으로 살아남는다. 붕괴는 한 필드 옆에서 일어난다.
