# 040 — wp4: 라이프사이클 프로덕션 하드닝

Date: 2026-07-23. Goal-mode (HOTL) 사이클 1/3. QA 직전까지 프로덕션급.

## Scope

### 1. `ocx ensure` live-proxy 분기 grok 재주입 (c1)

현황: `handleEnsure()` live 분기(src/cli/index.ts:290-299)는 `syncModelsToCodex`+`injectSystemEnv`만 수행 — grok config는 start 경로에서만 주입됨. 리뷰어(Socrates R1) 수용 잔여.

계획(오딧 반영): `src/grok/sync.ts` 신설 — `codex/sync.ts:19`의 deps-주입 패턴을 미러링한 `syncGrokConfig(port, config, opts)`. handleStart와 handleEnsure **양쪽 분기**(live 분기 + spawned-child readiness 후 부모)에서 호출.

- **오딧 블로커 1 (readiness race):** ensure의 spawned-child 경로는 `/healthz` 응답 직후 부모가 리턴하는데 자식의 grok 주입은 그보다 늦음 → ensure 부모가 `waitForProxy()` 성공 후 **직접** `syncGrokConfig(port, ...)`를 호출해 결정론적으로 주입 완료를 보장 (자식 주입과 멱등 충돌 없음 — 동일 블록 교체).
- **오딧 블로커 3 (live hostname):** live 분기에서는 `config.hostname`이 아니라 `live.hostname`(proxy-liveness 런타임 기록)을 hostname으로 전달. spawned 분기는 방금 띄운 config 기준이므로 config.hostname 사용.
- **오딧 제안 4 (관측성):** `syncGrokConfig`는 `GrokInjectResult`를 반환(테스트 가능); 명시적 `ocx ensure`에서 ok:false를 경고로 표면화. 테스트: `tests/grok-sync.test.ts` — deps 주입으로 fetch 목킹, ensure-경로 재주입/hostname 선택/실패 표면화 검증.

### 2. `ocx restart` 왕복 검증 (c2)

restart = handleStop → handleEnsure. stop이 strip, ensure가 자식 spawn(start) 또는 live 재주입. 격리 환경(:10190)에서 start→restart 후 펜스 1개·모델 반영 확인.

- **오딧 블로커 2 (service-installed restart) — 유예의 정확한 범위:** 이 결함은 grok 신규 코드가 아니라 **기존 `ocx restart` 자체의 결함**이다: handleStop이 설치된 service manager를 중지한 뒤 handleEnsure가 unmanaged detached child로 대체하므로, service-installed 환경에서 restart는 **자동 재시작/로그인-시작 보장(service persistence)을 상실**한다. 또한 그 unmanaged child가 죽으면 grok fence는 dead proxy를 가리킨 채 **다음 start/ensure가 호출될 때까지 무기한** 남는다 (짧다는 보장 없음). 이 환경에서 라이브 재현 불가(실 launchd 서비스가 프로덕션 :10100 소유). 유예 조건(오딧 합의): ① 이번 wp4 verifier는 **non-service 경로 전제**임을 receipts에 명시, ② service-installed `ocx restart`의 persistence 손실 + 무기한 stale-fence 가능성을 wp5 문서 known-limitations에 **release-known-limitation으로 명기**, ③ 후속 acceptance criterion("service-installed restart는 service manager를 통해 재시작하고 fence를 재보장한다")을 receipts에 후속 과제로 고정. 기존-결함 수정 자체는 goal 파일 스코프(restart 재설계)가 아니므로 별도 이슈 대상.

### 3. heartbeat 결정 (c3)

증거: grok strict Responses 디코더는 `response.heartbeat` unknown variant에서 즉사(011 R2). 반면 **chat_completions 인바운드는 안전** — `src/chat/outbound.ts:211`이 `response.heartbeat`를 소비하며 **raw heartbeat 프레임은 전달하지 않고** 최대 유효한 Chat Completions role chunk(`ensureRole`)만 방출한다. 자동 주입 경로는 전 모델 `api_backend="chat_completions"`이므로 strict-디코더 crash에 도달 불가.

결정(기록, 오딧 확인 6 반영): bridge의 `response.heartbeat`는 codex-rs keep-alive 계약(어떤 이벤트든 idle 타이머 re-arm, unknown 무시)에 최적이므로 **유지**. 대안(SSE comment는 eventsource 파서가 이벤트로 안 올려 codex idle 타이머 미갱신 위험, `response.in_progress`는 strict 스키마상 전체 response 스냅샷 페이로드 필요)은 기각. chat 인바운드는 **raw heartbeat를 전달하지 않음** — `ensureRole()`로 유효한 role chunk만 방출(스트림·논스트림 fold 모두, 오딧이 chat-completions.ts:182/197 확인). 조치: ① chat 경로 heartbeat 소비 회귀 테스트 추가, ② responses 백엔드 직결 사용자용 known-limitation을 wp5 문서에 명기.

## Verifier
- 신규/기존 테스트 + typecheck + full test + privacy scan
- live: 격리 :10190에서 ensure(live 분기) 재주입 로그, restart 왕복 후 펜스/모델 상태
- receipts: 041

## Out of scope
- bridge.ts 수정 (결정상 불필요), docs(wp5), 스모크(wp6)
