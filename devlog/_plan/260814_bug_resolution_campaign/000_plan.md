# 000 — Bug Resolution Campaign Plan

감사 기준일: 2026-08-14
감사 출처: ChatGPT Work 세션 (GitHub API 기반 전수 감사, 26분 작업)
ZIP SHA-256: 6de06eaf62f3527a523afa4e67b7d8accdfb68fadca86a8b12d9d7097bdd5f70

## 목표

lidge-jun/opencodex의 열린 bug 이슈 28개와 bug PR 22개를 6개 Wave로 나눠
의존 순서대로 dev에 커밋하고 머지하는 실행 계획.

이 유닛의 첫 사이클(Phase 0)은 문서 전용이다. 구현은 다음 사이클부터 시작한다.

## 제약

- PR 루프가 아니라 커밋 + 머지 루프: 각 Wave는 dev에 직접 커밋하고 머지한다.
- 이슈도 같은 방식으로 커밋 쌓아서 머지.
- git push는 사용자 승인 후에만 (DEV-GIT-PUSH-01).
- 프로덕션 코드 변경은 docs 사이클에서 금지.

## 현재 스냅샷

| 지표 | 수량 |
|------|------|
| 감사 후 열린 bug 이슈 | 28 |
| 감사 중 닫은 이슈 | 2 (#1683, #1684) |
| 열린 bug PR | 22 |
| PR 승인 | 1 (#1674) |
| 변경 요청 | 7 |
| 조건부 리뷰 | 14 |
| 새 bug 라벨 | 4 (#1483, #1573, #1601, #1683) |

## 핵심 관찰

현재 큐에는 세 종류가 섞여 있다:

1. 바로 병합 가능한 focused fix — #1674, CI만 승인하면 되는 #1677/#1680
2. rebase/test fixup이 필요한 PR — #1678, #1636, #1673, #1638, #1656, #1675, #1617
3. 분할 또는 제품 결정이 먼저 필요한 대형 PR — #1412, #1623, #1634, #1625, #1609

작은 P0 fix를 대형 아키텍처 충돌에 묶이지 않게 하려면
작은 불변식부터 dev에 고정하고, 그 위에 나머지를 rebase하는 순서가 필요하다.

## 의존 순서 Work-Phase Map

| Phase | Wave | 핵심 내용 | 선행 | Decade Doc |
|-------|------|-----------|------|------------|
| 0 | -- | docs-only roadmap (이 문서) | 없음 | 000-003 |
| 1 | Wave 1 | 작은 P0/P1 불변식 고정 | 없음 | 010 |
| 2 | Wave 2 | Windows 서비스와 ownership | Wave 1 (#1674) | 020 |
| 3 | Wave 3 | Cursor fixes | Wave 1 (#1680, #1673) | 030 |
| 4 | Wave 4 | OAuth/Config/보안 | Wave 1 (#1656) | 040 |
| 5 | Wave 5 | Provider와 Capability | Wave 1 완료 | 050 |
| 6 | Wave 6 | CI와 Bun 1.4 준비 | 전체 안정화 | 060 |

## Merge Train 그래프

#1674 -> #1678 -> #1647, #1626 (Windows chain)
#1677 -> dev (독립)
#1680 -> dev (독립)
#1673 -> #1634 splits (Cursor chain)
#1656 -> #1663 (OAuth chain)
#1636 -> #1601 close
#1638 -> #1580 close
#1412 -> 3-way split (history dedupe -> context guard -> deep input)

## 이 유닛의 파일 구조

| 파일 | 내용 |
|------|------|
| 000_plan.md | 이 문서 |
| 001_audit_inventory.md | 전수 이슈/PR 인벤토리 |
| 002_merge_train_analysis.md | 의존 그래프와 병합 순서 |
| 003_pr_split_decisions.md | 대형 PR 분할 계획 |
| 010_wave1_small_p0_invariants.md | Wave 1 diff-level 계획 |
| 020_wave2_windows_service.md | Wave 2 diff-level 계획 |
| 030_wave3_cursor.md | Wave 3 diff-level 계획 |
| 040_wave4_oauth_config_security.md | Wave 4 diff-level 계획 |
| 050_wave5_provider_capability.md | Wave 5 diff-level 계획 |
| 060_wave6_ci_bun14.md | Wave 6 diff-level 계획 |

## 완료 정의

이 로드맵의 성공은 열린 issue 수를 빠르게 줄이는 것이 아니다.
다음 불변식을 dev에 순서대로 고정하는 것이다:

- Windows identity와 localized path가 서로의 fix를 되돌리지 않는다
- client-controlled request 크기/깊이/queue가 실제 행동 테스트로 bounded 된다
- Cursor tool/continuation/edit 경로의 작은 correctness fix가 대형 architecture PR에 묶이지 않는다
- OAuth identity와 add-account semantics가 provider별로 증명된다
- CI가 flake 재실행이 아니라 반복 가능한 release signal을 제공한다
- resolved/partial/upstream/needs-info가 명확히 구분된다
