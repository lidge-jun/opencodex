# 구현 계획 — 원격 연결 v1

PRD: 000_prd.md (r1). U1-U3 확인 뒤 Plan 단계로 넘긴다.

## PR 1 — 허브 링크 리스너와 SSH 터널 (보안 검토 필요)

- `src/link/` 새 영역: ssh 실행기(시스템 OpenSSH, BatchMode, 호스트 키 정책), 터널 감독자(백오프, D13 상태), 링크 저장소(권한 600).
- 링크 리스너 127.0.0.1:L: `/v1/*`만, 클라이언트 키 필수, 루프백 신뢰 미적용. 링크가 있을 때만 활성화하고 `src/server/index.ts` 활성화 블록에 동기로 붙인다.
- 테스트: S6, S7, S8(core-lab-boundary와 같은 방식으로 import 그래프 검사), 상태 기계 전이.
- structure/ 새 문서 + manifest 소유 등록.

## PR 2 — 클라이언트 link 모드

- `ocx connect --link --key-stdin --server-url http://localhost:<P>`: 페어링 없이 키 수락, 기존 복구 기록 재사용.
- machine listener: link 모드에서 `/v1/*`를 P로 중계, 대시보드는 읽기 전용 상태.
- 테스트: S3, S4(연결 전후 파일 비교), 중계 실패 시 503.

## PR 3 — 관리 API와 `#remote` 화면

- 허브 API: 호스트 후보(ssh config + Tailscale), 프로브(지문 반환), 적용(키 발급 → SSH exec → 터널 시작), 목록·해제·키 회수. 정식 대시보드 세션만.
- GUI: 꺼짐 스위치 + 흐린 미리보기, 역할 선택, 클라이언트 추가 시트, 목록 상태 점, 해제 확인. 원격 워크스페이스는 별도 경로로 분리.
- 22개 로케일 문자열, docs-site 안내 문서, PR 설명에 스크린샷.
- 검증: 실제 두 대(mini 등)로 S1, S2, S5 수동 확인. 재시작 후 세션 유지(A2).

## 순서와 위험

PR1 → PR2 → PR3 순서로 쌓는다. 가장 큰 위험은 PR1의 인증 경계이고, 그다음은 PR3의 재시작 후 세션 연속성이다.

