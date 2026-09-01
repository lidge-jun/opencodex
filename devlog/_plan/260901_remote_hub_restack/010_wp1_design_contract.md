# wp1 — design(#2771) 재스택 + 문서 트러스트 경계 4건

브랜치 `codex/remote-hub-design`, 현재 head `bad162407`.
시험 재스택 결과 충돌 없음(`f17605021`). 문서 12파일 전용.

## 수정 대상 4건

리뷰어가 `bad1624075c75592115ab92f9e49ebcf0c525ce6` exact head에 대해 제기했다.
전부 `devlog/_plan/260827_remote_hub/` 안의 설계 계약 문서다.

### D1 — 평문 HTTP로 재사용 가능한 credential이 건너간다

위치: `040_phase2_remote_session.md:11-25`, `050_phase3_connect.md:324-340`.

현재 계약은 config 플래그 두 개를 켜면 비-loopback 평문 HTTP 위로 재사용 가능한
pairing grant가 오가고 재사용 가능한 GUI 세션이 반환되는 것을 허용한다.
운영자 opt-in은 수동적 자격증명 탈취나 on-path 교환을 막지 못한다.

수정: HTTP를 credential-free 부트스트랩으로 강등한다. grant / 세션 /
admin token / client key 중 어느 것도 전송되기 전에 인증된 HTTPS로의 업그레이드가
강제되어야 한다. 문서에 "평문 HTTP에서 전송 가능한 것"의 화이트리스트를 명시하고,
그 목록에 credential류가 없음을 계약으로 못박는다.

### D2 — identity-varying 응답에 공유 strong ETag

위치: `030_phase1_protocol_catalog.md:29-40`.

인증된 카탈로그 응답이 키마다 내용이 다른데도 공유 strong ETag를 갖고
`private, no-cache`로 나간다. `x-opencodex-key-id`로 vary한다고 적혀 있지만,
identity로 파티션된 validator/캐시 키가 실제로 테스트되지 않은 상태에서
저장된 200/304 표현이 키 타입과 키 id를 넘나들 수 있다.

수정: identity를 실은 응답에 `Cache-Control: no-store`를 쓰고 ETag/304를
제거한다. 파티션을 유지하려면 파티션이 증명되어야 하는데, 증명 비용보다
no-store가 싸다. 이 결정을 문서에 근거와 함께 기록한다.

### D3 — Origin이 한 엔드포인트에만 전달된다

위치: `060_phase4_two_plane.md:298-307`.

브라우저 `Origin`을 정확히 `POST /opencodex-session`에만 전달한다.
그런데 발급된 GUI 세션은 origin에 바인딩되고 관리 API 변경은 Origin/CSRF 검사를
한다. 릴레이된 `/api/*`의 POST/PUT/PATCH/DELETE는 허브가 필요로 하는 증거를
잃고 실패한다. 즉 이건 보안 결함이자 기능 결함이다.

수정: 허용된 모든 세션 인증 mutation에 대해 브라우저 Origin을 verbatim
전달한다. 합성 fallback을 두지 않는다(합성 Origin은 CSRF 검사를 무의미하게
만든다). 허용 메서드마다 테스트를 건다.

### D4 — 키 로테이션 크래시 복구가 잘못된 증거를 신뢰한다

위치: `080_phase6_hardening.md:318-323`.

"current와 backup 둘 다 probe 성공"을 current 파일이 새 키를 담고 있다는
증거로 취급한다. `pendingOperation` 저장 직후 크래시가 나면 두 파일이 모두
옛 키를 담은 채로 둘 다 probe에 성공할 수 있다. 그러면 복구 로직은 이미
끝났다고 판단하고 로테이션을 유실한다.

수정: probe 성공 쌍을 완료 증거로 쓰지 않는다. 어느 파일이 어느 세대를
담고 있는지 구별하는 증거(세대 마커 또는 pendingOperation 레코드 자체)로
판정하고, 구별이 불가능한 상태는 미완료로 취급해 재개한다.

## 작업 순서

1. `origin/dev` 위로 `rebase --onto` (충돌 없음 확인됨).
2. D1~D4를 설계 문서에 반영. 각 수정은 "무엇이 틀렸는지 → 새 계약" 형태로
   기존 문단을 대체한다. 리뷰 코멘트를 인용만 하고 계약을 안 바꾸면 무의미하다.
3. `--no-verify` 푸시.
4. PR #2771 설명 갱신 — 4건 각각 어디서 어떻게 해소됐는지 파일:줄로 지목.

## 검증

- `git range-diff origin/dev..bad162407 origin/dev..<new>` 로 9커밋 보존 확인
  (D1~D4 수정 커밋은 추가분).
- 문서 전용이므로 로컬 테스트 대상 없음. exact-head CI 그린으로 판정.
- D1~D4의 구현 정합은 각각 wp3(D1), wp2(D2), wp5(D3), wp7(D4)에서 처리한다.
  이 단계는 계약만 고친다.
