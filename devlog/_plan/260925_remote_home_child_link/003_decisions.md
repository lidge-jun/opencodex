# 003 — 로드맵 교차 결정 (wp0, auto 모드)

decade 문서(020-060) 작성 중 올라온 계약 편차와 열린 질문에 대한 메인 결정. 각 decade 문서의 해당 부분은 이 문서가 우선한다. 각 사이클의 P가 자기 문서를 재검증할 때 이 표를 반영한다.

| ID | 질문 (출처) | 결정 | 영향 레이어 |
|---|---|---|---|
| K1 | `ocx link issue` 권한과 D18 충돌 (040) | D18은 대시보드 조작에만 적용한다. CLI는 별도 주체다. `POST /api/link/issue`는 관리자 토큰(`x-opencodex-api-key`, 루프백 요청만)을 요구하고 대시보드 세션으로는 호출할 수 없다. SSH로 들어와 실행하는 CLI는 그 기계의 OS 사용자로 인증된 것이며, 기존 `ocx` 관리 CLI와 같은 신뢰 수준이다 | wp4, wp6 |
| K2 | `/api/link/issue` 부재 (040) | 추가한다. 응답 `{linkId, apiKeyId, key, listenerPort}`. 허브 시작 apply는 같은 로직을 in-process 헬퍼로 호출한다 | wp4 |
| K3 | 클라이언트 시작 링크의 hostKeyFingerprint 생성 주체 (040, 060) | 허브는 클라이언트에 SSH로 접속하지 않으므로 허브 쪽 LinkRecord.hostKeyFingerprint는 `null`을 허용한다(`direction: "client-initiated"`일 때만). 클라이언트가 확인한 허브 키 지문은 클라이언트 쪽 `client-link.json`에 저장한다 | wp1 store, wp4, wp6 |
| K4 | probe의 ocxVersion 이중 접속 (040) | 수용. probe로 지문을 받고, 사용자가 확인한 뒤 링크 known_hosts로 옮긴 다음 `buildExecArgv(["ocx","--version"])`를 실행한다. 확인 전에는 원격 명령 결과를 쓰지 않는다 | wp4 |
| K5 | 리스너 첫 바인드 실패 (020) | 경고 + 상태 `failed{bind}`, 공용 리스너 롤백 없음. 링크는 선택 기능이다 | wp2 |
| K6 | 마지막 링크 제거 뒤 리스너 종료 (020) | DELETE 처리 끝에서 즉시 닫는다. 키 허용은 레코드 삭제 즉시 실패로 닫힌다 | wp2, wp4 |
| K7 | 링크 입구 `/readyz` 인증 (020, 030) | 키 필요. wp3의 클라이언트 readiness 호출은 link 모드에서 링크 키를 보낸다 | wp2, wp3 |
| K8 | HEAD 허용 (020) | `/v1/catalog`, `/v1/hub-state`는 GET과 HEAD 허용(기존 핸들러 계약 유지). `/readyz`는 기존 핸들러대로 GET 전용이며 링크 입구에서도 HEAD는 404 (src/server/index/serve-options.ts:596-601). wp2 테스트: 키 있는 HEAD /v1/catalog 200, 키 있는 HEAD /readyz 404 | wp2 |
| K9 | WebSocket (030) | v1은 HTTP만. wp3 테스트가 link 라우팅 대상에서 Codex websocket이 꺼져 있음을 확인한다(src/codex/inject/plan.ts:113). 필요로 밝혀지면 별도 decade 문서를 추가 | wp3 |
| K10 | config.port=0 테스트 (030) | 실제 바인드된 machine listener 포트를 주입하는 테스트 seam을 둔다 | wp3 |
| K11 | 클라이언트 시작 재시작 복구용 허브 L (060) | `<configDir>/link/client-link.json`에 `{linkId, alias, hubHostKeyFingerprint, peerListenerPort, tunnelPort}` 저장, 0600. `links.json`과 분리 | wp6 |
| K12 | 로컬 connect 실패 후 롤백 (060) | wp4에 `ocx link revoke --link-id <id>`(관리자 토큰, `DELETE /api/link/{id}`의 CLI 경로) 추가. wp6 join 실패 시 SSH로 허브에서 실행 | wp4, wp6 |
| K13 | 원격 connect 성공 판정 (040) | 원격 명령 exit 0 + 15초 안에 허브 링크 리스너가 그 키로 인증된 첫 요청을 관찰(카탈로그 조회). 둘 다 만족해야 connected | wp4 |
| K14 | supervisor와 listener 종료 순서, ensureStarted 경합 (040) | optional-listeners.stop()에서 supervisor 먼저, listener 다음. ensureStarted는 단일 promise로 직렬화 | wp2, wp4 |
| K15 | `ocx link status` 소스 (040) | 프록시가 실행 중이면 `/api/link/status`(관리자 토큰), 아니면 store 직접 읽기 | wp4 |
| K16 | status/candidates 응답 모양 (050) | `GET /api/link/status` → `{role: "standalone"|"home"|"child", listener: {state: "off"|"listening"|"failed", port: number|null}, links: [{id, alias, direction, state: "connecting"|"connected"|"reconnecting"|"failed"|"idle", since: string, reason: string|null, tunnelPort: number}], child: null | {alias, state, since, reason}}`. `GET /api/link/candidates` → `{candidates: [{alias, source: "ssh_config"|"tailscale"}]}`. `POST /api/link/probe` → `{alias, fingerprint, keyType}`. `POST /api/link/confirm-host` → `{alias, fingerprint, ocxVersion}`. `POST /api/link/apply` → 202 `{linkId}` 후 status 폴링. 오류는 `{error: {code, message}}` | wp4, wp5, wp6 |
| K17 | GUI locale 수 (050) | gui/src/i18n의 실제 locale 파일 전부(050 확인: 10개). docs-site는 영어 원문 + 기존 번역 locale에 같은 페이지를 추가하되 번역이 없으면 영어 원문 링크를 두지 않고 해당 locale 생략 | wp5 |
