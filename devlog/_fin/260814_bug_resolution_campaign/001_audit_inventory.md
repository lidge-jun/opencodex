# 001 — Bug Audit Inventory

감사 기준일: 2026-08-14
출처: opencodex-bug-audit-2026-08-14.zip

## 이슈 인벤토리 (28 open + 2 closed)

### P0 (4 open)

| # | 제목 | 분류 | 워크스트림 | 관련 PR |
|---|------|------|-----------|---------|
| 1573 | Windows Korean user paths UTF-8 decoding | 확정 결함 | Windows/서비스 | #1678 (선행 #1674) |
| 1582 | openai-chat doubles /chat/completions on custom baseUrl | 확정 소형 결함 | Provider/URL | 새 PR 필요 |
| 1589 | PowerShell -WindowStyle Hidden EACLIDENTITY | 확정 결함 | Windows/서비스 | #1674 |
| 1601 | Bun.serve maxRequestBodySize 128MiB 413 | 확정 결함 | 요청 경계 | #1636 |

### P1 (16 open)

| # | 제목 | 분류 | 워크스트림 |
|---|------|------|-----------|
| 1059 | Windows test suite dispatch-only | 릴리스 품질 부채 | Windows CI |
| 1296 | Windows ACL -> 401 authentication_error | 확정 진단 결함 | Windows/오류 분류 |
| 1302 | Linux CI shard hang + orphan bun | 확정 CI 신뢰성 | CI/Bun |
| 1388 | Cursor apply_patch exact-match/drift | 부분 해결 | Cursor/편집 |
| 1419 | Bun 1.3.14 SIGTRAP after TLS reset | 런타임 의심 | Bun/네트워크 |
| 1483 | MiMo v2.5 invalid tool calls | 확정 provider 호환 | Provider/어댑터 |
| 1524 | preflight fallback context-window | 라우팅 정확성 | Fallback/Capability |
| 1527 | Cursor large-context collapse | 확정 경로 결함 | Cursor/Continuation |
| 1533 | V2 compatibility UX | UX 후속 | Dashboard |
| 1562 | V2 mode ENOENT GUI silent fail | 확정 UX | Dashboard/CLI |
| 1580 | Usage dashboard token history loss | 확정 결함 | Usage/Dashboard |
| 1587 | routed first-turn tool catalog 3-5x tokens | 확정 성능 | 도구 카탈로그 |
| 1612 | Docker foreground systemd ownership | 확정 회귀 | 서비스/컨테이너 |
| 1635 | Non-json config depth/numeric rounding | 확정 데이터 | Config/보안 |
| 1661 | Cursor subagents drop unified exec | 확정 결함 | Cursor/도구 |

### P2 (6 open)

| # | 제목 | 분류 |
|---|------|------|
| 92 | V2 cross-provider sub-agent NEW_TASK loss | 상류 추적 |
| 904 | U+FFFD Korean file corruption | 정보 대기 |
| 1024 | Custom-provider vision ambiguity | Capability 계약 |
| 1049 | Pre-substrate Codex home adoption | 마이그레이션 부채 |
| 1478 | Config rebase provenance | 아키텍처 |
| 1594 | DeepSeek openai-response error | 정보 대기 |
| 1651 | terminal continuation guard extension | 버그 인접 설계 |
| 1672 | Codex sync incomplete | 정보 부족 |

### P3 (2 open)

| # | 제목 |
|---|------|
| 417 | Korean realtime voice U+FFFD (upstream) |
| 1533 | V2 compatibility UX |

### Closed during audit

| # | 제목 | 근거 |
|---|------|------|
| 1683 | gemini-3.7-flash Antigravity drop | #1658 병합으로 해결 |
| 1684 | Luna shadow call intercept leak | #1685 병합으로 해결 |

## PR 인벤토리 (22 open)

### APPROVE (1)

| # | 제목 | CI | Wave |
|---|------|----|------|
| 1674 | PowerShell WindowStyle argv | green | Wave 1 첫 번째 |

### REQUEST_CHANGES (7)

| # | 제목 | 핵심 차단점 | Wave |
|---|------|------------|------|
| 1412 | responses replay history compounding | 3-way 분할 필요 | Wave 특별 |
| 1623 | routed apply_patch contracts | architecture 분할 | Wave 3 |
| 1634 | structured-edit apply_patch | 3-way 분할 필요 | Wave 3 |
| 1636 | maxRequestBodySize 256MiB | 행동 테스트 보강 | Wave 1.5 |
| 1639 | Cline/MiMo/xAI discovery | scope 수정 | Wave 5 |
| 1647 | service wrapper exit 0 | behavior test 추가 | Wave 2 |
| 1678 | localized profile paths | #1674 선행 + rebase | Wave 1 |

### COMMENT (14)

| # | 제목 | Wave |
|---|------|------|
| 1608 | upstream websocket buffering | Wave 6 |
| 1609 | preserved rollback snapshots | Wave 4 |
| 1617 | packaging symlink skip | Wave 1 |
| 1625 | unprobeable launcher shim | Hold |
| 1626 | native service on scheduler install | Wave 2 |
| 1638 | usage 7d/30d calendar alignment | Wave 1 |
| 1640 | Antigravity fingerprint 1.1.12 | Wave 5 |
| 1653 | token estimate context cap | Wave 4 |
| 1656 | exact accountId credential import | Wave 4 |
| 1663 | legacy account add-account | Wave 4 |
| 1673 | unified exec tool filtering | Wave 1 |
| 1675 | Responses body-read timeout | Wave 1 |
| 1677 | recursive encrypted traversal | Wave 1 |
| 1680 | malformed Cursor tool args | Wave 1 |
