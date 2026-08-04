# 041 — wp4 receipt: 라이프사이클 프로덕션 하드닝

Date: 2026-07-23 (KST), commits `8ddeab8f` + `7c521a6c`

**전제(오딧 합의): 본 라이브 검증은 non-service 경로 한정.** service-installed 환경의 `ocx restart`는 service manager를 중지하고 unmanaged child로 대체하여 persistence(자동 재시작/로그인 시작)를 잃는 **기존 restart 결함**이 있으며, unmanaged child 사망 시 grok fence가 다음 start/ensure까지 **무기한** dead proxy를 가리킬 수 있다. → wp5 문서 known-limitations에 release-known-limitation으로 명기. **후속 acceptance criterion(고정):** "service-installed `ocx restart`는 service manager를 통해 재시작하고 재시작 후 fence를 재보장한다" — restart 재설계는 본 goal 스코프 밖, 별도 이슈 대상.

## c1 — ensure 재주입 (라이브, :10190 격리)

1. live 분기: fence 수동 strip → `ocx ensure` → `+ Grok Build config updated` + fence 1 복원. `live.hostname` 전달 (proxy-liveness 런타임 기록).
2. spawned 분기: `ocx restart`(stop→ensure) 후 부모가 waitForProxy 성공 직후 직접 주입 — readiness race 해소 (오딧 블로커 1).
3. `codexAutoStart=false`면 ensure가 조기 리턴하는 기존 게이트 확인 (grok과 무관, 기존 동작).

## c2 — restart 왕복 (라이브)

- 1회차 restart에서 **기존 결함 발견**: service-manager stop throw(home-mismatch)가 `stopFailed`→`process.exit(1)`로 이어져 ensure에 도달 못 하고 프록시가 죽은 채 종료. → `7c521a6c`: 경고는 유지하되 stopFailed로 승격하지 않음 (로컬 teardown/ensure는 service manager와 독립).
- 수정 후: `restart` → 구 pid stop + fence strip → 새 pid 기동 + fence 1 재주입. 연속 2회 왕복 모두 성공 (pid 56377→57004, uptime 리셋 확인).

## c3 — heartbeat 결정 (코드+테스트 증거)

- 결정: bridge keep-alive 유지 (codex-rs 계약 최적). 주입 경로는 전 모델 `chat_completions` — `responsesSseToChatCompletionsSse`가 raw `response.heartbeat` 프레임을 절대 전달하지 않음(최대 유효 role chunk).
- 회귀 고정: `tests/chat-completions-endpoint.test.ts` "consumes response.heartbeat without forwarding a raw frame" — 모든 data 프레임이 `chat.completion.chunk`임을 어서션.
- responses 백엔드 직결 사용자는 known-limitation (wp5 문서).

## Verifiers

- typecheck clean, privacy scan pass
- `tests/grok-sync.test.ts` 4 pass (catalog fold, hostname override, 실패 표면화, 멱등), `tests/grok-config-inject.test.ts` 11 pass, chat 엔드포인트 22 pass
- full suite **3721 pass / 1 fail** (기존 anthropic-thinking-signature full-run 플레이크 — wp1부터 동일, stash 검증 완료된 건)
