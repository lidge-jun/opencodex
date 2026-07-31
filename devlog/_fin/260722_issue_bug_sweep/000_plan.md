# 000 — Issue Bug Sweep: 목표 / 제약 / 워크페이즈 맵 (MOC)

- 날짜: 2026-07-22
- 브랜치: `dev` (origin/dev ahead 4 기준)
- 유닛: `devlog/_plan/260722_issue_bug_sweep/`
- 성격: **docs-only** — 이 유닛의 산출물은 조사 문서(000–009)와 diff-level 패치 계획 decade docs(010/011/020/021/022/030/031)이다. 코드 패치·push·이슈 코멘트는 범위 밖.

## 목표

오픈 이슈 중 **버그성 이슈 전수**를 수집·분류하고, 클러스터별 RCA 조사 문서와
copy-paste-executable 패치 계획(DIFFLEVEL-ROADMAP-01)을 하나의 devlog 유닛으로 남긴다.
후속 구현 사이클이 010/011/020/021/022/030/031 각 문서만 읽고 바로 패치에 들어갈 수 있는 정밀도가 기준.

## 입력 (2026-07-22 gh 실측)

오픈 이슈 18건 중 버그성 10건 (전수 분류는 `001_issue_inventory.md`):

| # | 제목 요약 | 클러스터 |
|---|-----------|----------|
| 216 | Windows non-EN/Bun: probeScmRegistration이 1060 미탐지 → service/update abort | W (Windows service) |
| 199 | localized sc.exe 1060 → WinSW conflict 오분류 | W |
| 212 | built-in cloud preset에서 allowPrivateNetwork opt-in 숨김 (fake-IP DNS) | N (network policy, **security-sensitive**) |
| 175 | localhost provider 경고가 미노출 옵션 안내 — **dev에 이미 해결**(109b7672: GUI/PATCH/CLI opt-in 노출, `src/cli/provider.ts:146` `--allow-private-network` 실재). 이슈는 open이나 잔여 패치 대상 아님. #212 잔여 갭만 N에서 다룸 | N (resolved-in-dev, 추적만) |
| 209 | Windows 재부팅 후 Anthropic OAuth needsReauth + 모델 소실 | O (OAuth persistence) |
| 183 | codex-auth 계정 추가 모달에 수동 코드 붙여넣기 입력창 누락 | O |
| 202 | Google Vertex AI 모델이 /v1/models·대시보드에 미노출 | R (registry/routing) |
| 186 | 첫 502 이후 같은 세션 502 빈발 (PR #194/#195/#205 이후에도 잔존 보고) | S (session affinity) |
| 179 | Cursor effort 미지원 모델에 effort 강제 → 요청 파손 | R |
| 92 | V2 cross-provider 자식이 NEW_TASK 본문을 encrypted_content로 소실 — maintainer 코멘트상 **upstream(Codex CLI) client-side** 원인 우세. 007에서 책임 경계 판정 후 로컬 완화 가능성이 증명될 때만 패치 계획 포함, 아니면 명시적 no-patch/upstream-tracking 결론 | V (V2 multi-agent, **conditional**) |

기능성(범위 밖, 인벤토리에만 기록): 210, 208, 206, 201, 178, 177, 95, 42.

## 클러스터 → 문서 맵

| 문서 | 내용 | 이슈 |
|------|------|------|
| 000 | 본 문서 (MOC/로드맵) | — |
| 001 | 이슈 전수 인벤토리 + 분류 근거 | 전체 18건 |
| 002 | W: Windows 서비스 1060 오분류 RCA | 216, 199 |
| 003 | N: allowPrivateNetwork built-in preset 노출 갭 RCA (#175 해결 범위와의 경계 명시) | 212 (+175 추적) |
| 004 | O: OAuth 지속성/수동코드 입력 RCA | 209, 183 |
| 005 | R: 모델 레지스트리/어댑터 capability RCA | 202, 179 |
| 006 | S: sticky 502 잔존 경로 RCA | 186 |
| 007 | V: V2 encrypted_content NEW_TASK RCA + 책임 경계(ours/upstream) 판정 | 92 |
| 010 | 패치 계획 A: W — Windows 1060 탐지 수정 | 216, 199 |
| 011 | 패치 계획 A-보안: N — built-in preset opt-in 노출 (security-sensitive 별도 단위) | 212 |
| 020 | 패치 계획 B: O-1 — Anthropic OAuth 지속성 (persistence 전용) | 209 |
| 021 | 패치 계획 B-2: R — Vertex 레지스트리 + Cursor effort capability | 202, 179 |
| 022 | 패치 계획 B-3: O-2 — codex-auth 수동 코드 API+GUI (020에서 분리, 별도 위협 모델) | 183 |
| 030 | 패치 계획 C: S — sticky 502 잔존 경로 | 186 |
| 031 | 패치 계획 C-2: V — #92 처분(로컬 완화가 007에서 증명된 경우에만 diff, 아니면 upstream-tracking 결론 문서) | 92 |

**순서 성격 (PHASE-SPLIT-01 명시):** W/N/O/R/S/V 클러스터는 상호 파일/API 의존이 없는
**독립 패치 단위**다. decade 번호는 의존성 사슬이 아니라 문서 그룹핑이며, 각 단위는
개별적으로 구현·검증 가능하다. 유일한 실제 순서 제약은 (a) 007의 책임 경계 판정이
031에 선행한다는 것, (b) 011(N)은 SSRF 방어 경계를 넓히는 security-sensitive 변경이므로
독립 단위로 격리하고 아래 위협 경계 요건을 충족해야 한다는 것뿐이다.

**N(011) 보안 요건:** reserved preset 제외, 기본값 false 유지, 자동 활성화 금지,
기존 security warning 문구 유지, metadata endpoint 차단 유지, DNS/fake-IP 시나리오와
PATCH/POST 경로 회귀 테스트를 수용 기준에 포함.

## 워크페이즈 로드맵 (1 work-phase = 1 PABCD 사이클)

- **WP1 (본 사이클)**: 전수 수집·분류 — 000 + 001 확정. sol 리뷰어 분류 검증.
- **WP2**: 클러스터별 RCA — sol 서브에이전트 병렬 조사(클러스터당 1 lane, 읽기 전용) → 002–007 작성 → sol 리뷰어 검증.
- **WP3**: 클러스터별 decade docs(010/011/020/021/022/030/031) diff-level 패치 계획 작성 → sol 리뷰어 최종 adversarial 검증(VERDICT) 후 반영.

## 제약 / 스코프

- IN: `devlog/_plan/260722_issue_bug_sweep/**` 신규 md, `.codexclaw/goalplans/**` 상태.
- OUT: `src/**`·`gui/**` 코드 수정, git push, GitHub 이슈/라벨/코멘트 변경, 릴리즈.
- 증거 원칙: 이슈 주장은 `gh issue view` 원문으로, 코드 주장은 현재 `dev` 트리의 파일:라인으로만 인용 (cxc-search 소스프루프).
- 이미 랜딩한 수정(#194, #195, #205, #175→109b7672 등)은 "잔존 여부"를 현재 트리에서 재검증한 뒤에만 RCA에 반영.

## 수용 기준 (goalplan criteria와 1:1)

- cr1: 001이 오픈 이슈 전수를 다루고 버그/기능 분류 근거가 명시된다.
- cr2: 002–007 각 문서에 로컬 코드 근거(파일:라인)·재현 경로·원인 가설이 있다.
- cr3: 패치 계획 decade docs(010/011/020/021/022/030/031)가 diff-level 정밀도(경로, NEW/MODIFY/DELETE, before/after, 검증 커맨드)로 작성되고 sol 리뷰어 검증을 통과한다. 031은 007 판정에 따라 diff 또는 명시적 no-patch 결론 문서로 성립한다.
