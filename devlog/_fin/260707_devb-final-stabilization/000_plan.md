# dev-B 최종 안정화 전수검사 (260707)

Session 019f34f2-3c06-7250-a2ee-dd3707f8130d. 대상: 오늘 델타 22561a4..HEAD (~24커밋).

## WP1 — 현상태 실측 (DONE, NOOP)

CI@2c149fa success, 로컬 1597/0 + tsc 0 + privacy passed, dev==dev-B, 카탈로그 glm-5.2 [text,image] 유지.

## WP2 — 전수검사 (gpt-5.5 xhigh 2명 병렬)

James(적대 diff 리뷰): P0 0, P1 3건 전부 재현 기반 —
1. 동시 429 오냉각 레이스: rotateKeyOn429가 live apiKey 기준으로 실패키 식별 → 2키 풀 전멸 가능.
   수정: attemptedKey CAS — 실패한 키만 냉각, 레이스 패배 시 건강한 live 키로 무회전 재시도.
2. compaction 턴이 pre-compaction 히스토리를 continuation cache에 기록 → 이후
   previous_response_id 확장이 방금 교체된 거대 체인을 재수화. 수정: compaction 턴은
   routed(stream/json/cursor)·passthrough 모두 기록 스킵.
3. 네이티브 /v1/responses/compact가 풀 계정 auth-context 우회(raw header 포워딩) → 잘못된
   계정으로 compaction. 수정: resolveCodexAuthContext + 계정 오버라이드 적용, 실패 시 기존
   raw 포워딩으로 강등(compact 에러는 세션 페이탈이므로 fail-open).
P2: 관리 API JSON 무제한 파싱 → POST/PUT content-length 2MB 캡.
무발견 확인: guardian은 config.json 무기록, 프로바이더명 traversal 차단, adaptive×signature
공존, tail nudge 순서 정상, 426이 HTTP 패스스루 미차단, 구경로 런타임 import 없음.

Maxwell(커버리지/위생): top8 갭 중 1·2위(서버 429 루프 e2e, fail-closed 서버 분기 e2e) 테스트
추가(tests/server-key-failover-e2e.test.ts). 위생: lifecycle console.log→warn. 잔여 갭·위생은
아래 백로그.

## 통합 P2/백로그 (다음 사이클 후보, 릴리스 블로커 아님)

커버리지: ws-loop on429/timeout 직접 테스트, WS 426→HTTP 재협상 e2e, compact 패스스루/에러
경로, /api/stop 실패 JSON, gatherRoutedModels 무변조 단언, cursor deriveEntry 풀패스.
위생: server 분할 후 자기참조-only export 정리(responses.ts/auth-cors.ts), jsonResponse·
isPlainObject 중복 헬퍼 통합, pre-split 파일명 언급 주석 5곳.
기능 백로그(260707_vision-sidecar-emergency 백로그 승계): ws-loop usage 집계, 반복실패
forceAnswer, structured-output JSON 클램프, ws턴 previous_response_id 연속성, file_id 사이드카
미커버, compaction v1 이미지 탈락, grok-build-0.1 역드리프트, parallel_tool_calls interleave 엣지.

## 릴리스 전 체크리스트

- [ ] sol 브랜치(codex/gpt-56-sol-terra-luna-rollout, fd558eb) 머지 전: codex-rs ReasoningEffort에
      Max 추가됐는지 확인 — 현행은 "max" 카탈로그 광고가 invalid (sanitizer가 스트립 중)
- [ ] 다음 ocx 재시작 후: GUI "Sync models" 버튼이 새 코드로 카탈로그 재작성하는지 확인
      (재시작 전엔 구코드가 비전 수정 되돌림)
- [ ] 재시작 후 라이브 스모크: glm-5.2 이미지 첨부(비전 사이드카), 429 페일오버, compact 턴

## Evidence ledger

- WP1: CI success 실측, 로컬 그린, 원격 동기, 카탈로그 정합
- WP2: 수정 후 1600 pass/0 fail(+3 신규 테스트) + tsc 0 + privacy passed
- 후속 사이클(b75718a): 커버리지 백로그 3·4·6위 마감 — ws-loop on429/timeout 직접 테스트,
  WS 426→HTTP 폴백 e2e(codex-rs FallbackToHttp 계약 실증), compact v1 서머라이저 실패 전파.
  전량 1605/0 + tsc 0, CI success 실측(b75718a). 중복 헬퍼 통합은 무행동 근거 기록 후 스킵.
- sol 재리베이스: fd558eb(base 810fa11) → 6b7c94b(base b75718a), 충돌 0(rerere 재사용),
  sol 브랜치 전량 1619/0 + tsc 0, force-with-lease push. 머지는 여전히 릴리스 전
  codex-rs max 레벨 확인 뒤.
- 최종 마이그레이션 감사 사이클(6948376): 3렌즈 gpt-5.5 xhigh 병렬 감사 → P0 1(레거시
  oauth id 비결정성) + P1 2(src/cli.ts 좌초 런처, 이미지 가드 미상 치수) 수정, freeform
  input 스트리밍 패리티 추가. 상세: 010_final-migration-audit.md. 1609/0 + tsc 0.
- 최종 게이트(7ec1c9a): 신규 gpt-5.5 xhigh 독립 리뷰어 평결 "ABSOLUTE PASS — no P0/P1
  blockers for merging dev-B" (리뷰어 자체 실측: 1609/0, tsc 0, 엔트리포인트 3종 버전
  출력 확인). CI Service lifecycle success 실측(28837431710). sol 브랜치 재리베이스
  6b7c94b→14da0fd(base 7ec1c9a), 1623/0 + tsc 0, force-with-lease push.
