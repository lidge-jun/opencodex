# 010 — 모노레포 Git Blobless 최적화 로드맵

Date: 2026-08-01  
Work phase: roadmap / decision-locked  
Target: 실 소스 코드 패치 없이 문서 및 CI 가이드 반영 단계 정리

---

## Architectural Decision Record (ADR) Summary
- **전략 선택**: Hermes Agent 방식 (단일 모노레포 + Blobless Clone) 고정
- **핵심 이유**: `devlog/_plan/` 문서, `src/` 소스, `tests/` 회귀 테스트의 단일 커밋 원자성 유지 & 서브모듈 포인터 충돌 예방

---

## 로드맵 단계

### Phase 1: 리서치 및 문서 스캐폴딩 (완료)
- [x] `000_git_repo_size_inventory.md`: 로컬 저장소 및 npm 배포 패키지 용량 전수 분석
- [x] `005_blobless_clone_strategy.md`: OpenClaw, Hermes 등 사례 비교 및 Hermes 방식 확정 기록
- [x] `006_contributor_and_ci_guidelines.md`: `CONTRIBUTING.md` 및 GitHub Actions 적용 문구 작성

### Phase 2: 기여 가이드 문서 보강 (제언 단계)
- [ ] `CONTRIBUTING.md`에 Blobless Clone (`git clone --filter=blob:none`) 안내 및 `git gc` 팁 추가
- [ ] 필요 시 `README.md` 기여 섹션에 해당 가이드 링크 보강

### Phase 3: CI 체크아웃 최적화 (제언 단계)
- [ ] `.github/workflows/ci.yml` 체크아웃 단계에 `filter: blob:none` 적용 고려

---

## 핵심 변경 없음 (Explicitly Not Changed)
- 프로덕션 소스 코드(`src/`) 및 회귀 테스트(`tests/`) 수정 없음
- 기존 Git 커밋 히스토리를 강제로 파괴하거나 재작성(`git filter-repo` 등)하지 않음 (기존 커밋 및 PR 추적 가능성 온전히 보존)
