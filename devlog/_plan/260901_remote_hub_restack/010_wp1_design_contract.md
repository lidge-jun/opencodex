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

수정(감사 A8 반영): "HTTPS로 업그레이드"만으로는 부족하다. 평문 부트스트랩이
HTTPS 엔드포인트를 알려주는 구조는 on-path 공격자가 자기 소유의 유효한 HTTPS
origin을 끼워넣을 수 있다 — 업그레이드 대상이 의도한 허브라는 신뢰 앵커가 없으면
업그레이드는 보안이 아니라 의식이다.

계약:

1. 기본은 **비-loopback 평문 HTTP 전면 거부**다. opt-in 플래그로 뚫을 수 없다.
2. 사전에 알려진 HTTPS origin이 있는 경우에 한해 동일 호스트 scheme 업그레이드만
   허용한다. 정상 인증서 검증을 요구하고, 리다이렉트에서 권위를 파생하지 않는다.
3. 브라우저 origin은 검증된 출처에서 와야 하며 config에서 파생하지 않는다
   (#2771 미해결 스레드 요구사항).

문서에 "평문 HTTP에서 전송 가능한 것"의 화이트리스트를 명시하고, 그 목록에
credential류가 없음을 계약으로 못박는다.

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

수정(감사 A7 반영): "애매하면 재개"로는 부족하다. `pendingOperation`은 어느
파일이 새 시크릿을 담았는지 식별하지 못하고, 그 시크릿은 마커 저장 이후에도
유실될 수 있다. 계약을 다음 순서로 못박는다:

1. probe **이전에** 두 후보의 identity를 비교한다.
2. 두 후보가 동일하면 교체 이전 상태다 — 절대 commit하지 않는다.
3. abort/restore는 확인된 권위가 있을 때만 수행한다.
4. abort가 불확실하게 실패하면 증거를 보존한다(조용한 복원 금지).

회귀 테스트 3종: 동일-구세대 후보, abort 실패, 진행 중 백업을 지우는 동시
status 실행. 뒤 두 개는 #2789의 열린 스레드(T31/T32)와 같은 사안이다.

### D5 — 릴레이 응답이 validator를 보존한다

위치: `080_phase6_hardening.md:496-503` (8.3 응답 규칙).

응답 규칙이 "safe content type, cache control, ETag ... 만 보존"이라고 적어,
릴레이된 세션/부트스트랩/관리 응답에 validator가 살아남는 것을 허용한다.
D2와 같은 결함이 릴레이 경로에 한 번 더 있는 셈이다.

수정: 릴레이된 세션/부트스트랩/관리 응답은 기본이 `Cache-Control: no-store`이고
validator(ETag/Last-Modified)를 제거한다. 구현은 릴레이를 처음 갖는 wp5/p4에
배정하고, p6에서 적대적 커버리지를 추가한다.

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
- D1~D5의 구현 정합은 각각 wp3(D1), wp2(D2), wp5(D3), wp7(D4), wp5(D5)에서
  처리한다. 이 단계는 계약만 고친다.
- `003` 원장의 T1(미공개 보안 분석이 공개 devlog에 있음, P1)을 함께 처리한다.
  `AGENTS.md` 보안 규정상 미수정 결함의 분석은 추적 디렉터리에 있으면 안 된다.
  해당 문단을 판정해 제거하거나, 이미 공개 diff로 드러난 사안임을 확인한다.
- #2771의 마크다운 린트 6건(MD018/MD022/테이블 파이프)과 미래 날짜 1건도
  이 단계에서 닫는다.
