# 구현 계획 — 원격 연결 v1 (스택 PR)

PRD: 000_prd.md (r2). GitHub native stack이 아닌 수동 브랜치 체인. 각 레이어는 아래 레이어 브랜치를 base로 하고, 아래부터 머지한다.

| 레이어 | 브랜치 | 내용 | 독립 검증 |
|---|---|---|---|
| L1 | codex/remote-link-1-core | 이 문서 + `src/link/` 순수 모듈: ssh 인자 생성(BatchMode, 호스트 키 정책, -R/-L 모양), ~/.ssh/config 호스트 후보 파서, 터널 상태 기계, 링크 저장소(권한 600) + structure 문서 | 단위 테스트(탐색/터널 옵션 분리, known_hosts 정책). S6 실제 확인 흐름은 L4 |
| L2 | codex/remote-link-2-hub-listener | 허브 링크 리스너(127.0.0.1:L, /v1/*만, 클라이언트 키 필수, 루프백 신뢰 미적용), 링크가 있을 때만 동기 활성 | S7, S8(코어 경계) |
| L3 | codex/remote-link-3-client | `ocx connect --link --key-stdin`, machine listener의 /v1 중계(키는 테스트용 스텁), 기존 복구 기록 재사용 | S3, S4 |
| L4 | codex/remote-link-4-api | 허브 관리 API: 후보, 프로브(지문), 적용, 목록, 해제·키 회수, `ocx link issue` / `ocx link port`, 터널 감독자를 허브 프로세스에 연결 | 라우트 테스트, D18 권한 |
| L5 | codex/remote-link-5-gui | `#remote` 화면(꺼짐 스위치, 역할 선택, 자식 추가 시트, 상태 점), 원격 워크스페이스 분리, 10개 GUI 로케일, docs-site | GUI 테스트, 스크린샷 |
| L6 | codex/remote-link-6-client-initiated | 자식 대시보드의 "홈 찾기"(standalone일 때만), 자식 소유 -L 터널 | S1-S5 자식 방향 |

위험: L2 인증 경계(보안 검토), L4 터널 수명과 재시작, L5 재시작 후 세션 유지(A2). 실제 두 대 검증(S1, S2, S5)은 L5 이후.
