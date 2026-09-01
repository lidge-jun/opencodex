# 121 — 머지 후 남은 리뷰 스레드

머지 시점에 `isResolved=false`로 남은 스레드가 있다. 숫자는 이렇다:
#2771 15건, #2776 2건, #2781 4건, #2789 3건.

이걸 "정리 안 함"으로 적는 게 정직하다. 그리고 왜 지금 정리하지 않는지도.

## 왜 지금 닫지 않나

머지된 PR의 스레드를 사후에 resolve 표시하는 건 기록을 바꿀 뿐 코드를 바꾸지
않는다. 미해결 표시를 지우면 "닫혔다"는 신호만 남고 실제로 무엇이 처리됐는지는
오히려 흐려진다. 남겨두면 최소한 다음 사람이 스레드를 읽을 수 있다.

실질 내용은 이미 처리됐다. P1 6건(T1, T20, T22, T25, T26, T31)은 소유 단계의
코드 수정으로 닫혔고 그 수정과 함께 랜딩했다 — `003_review_thread_ledger.md`의
배정표와 각 `0X1_wpN_outcome.md`가 어느 커밋이 어느 스레드를 닫았는지 적고
있다. 남은 다수는 #2771의 마크다운 린트(MD018/MD022, 테이블 파이프
이스케이프)와 문서 계약 지적이다.

## 무엇이 진짜 남았나

P2 중 코드가 필요한 건들:

- T2 — 연결된 GUI에 인증된 models 경로. `/v1/models`가 데이터플레인으로 간다.
- T3 — 관리 ingress에서 GUI health 엔드포인트 보존.
- T19 — 확장된 readiness 응답을 `docs-site/.../cli/lifecycle.md`에 문서화.
- T21 — `hub.managementPublicOrigin`, `remoteGui.allowedTailscaleUsers`,
  `remoteGui.allowInsecure*` 문서화.

이건 새 유닛의 일이지 이 유닛의 잔업이 아니다. 스택은 머지됐고, 위 넷은
`dev` 위에서 각자의 PR로 처리하는 게 맞다.

**추적: #3158.** 머지된 PR의 스레드는 닫히면 사실상 사라지므로, 위 넷과 아래
플레이크를 이슈로 옮겨 적었다. 스레드를 resolve 표시하는 것보다 이쪽이 다음
사람에게 실제로 도달한다.

## 별도로 남은 플레이크

`ocx launcher graceful shutdown > SIGINT to the launcher tears down the Bun
proxy` (`tests/shutdown-launcher.test.ts`)가 #2789 macOS에서 20069ms 워치독
타임아웃으로 한 번 졌다. 재실행으로 통과했으므로 머지를 막지 않았지만, 근본
원인은 보지 않았다. `dev`에 남아 있는 플레이크로 취급해야 한다.
