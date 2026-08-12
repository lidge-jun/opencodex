# 006 — 기여 가이드라인 및 CI 적용 제언

Date: 2026-08-01  
Work phase: recommendations  
Target: `CONTRIBUTING.md`, `README.md`, 및 `.github/workflows/` 적용할 구체적 가이드 문구

---

## 1. `CONTRIBUTING.md` 추가 제언 문구

기여자가 프로젝트를 시작할 때 빠르게 클론하고 로컬 용량을 가볍게 유지할 수 있도록 `CONTRIBUTING.md`에 다음 안내 섹션을 추가하는 것을 권장합니다.

```markdown
## Repository Size & Cloning

opencodex is a docs-first monorepo with extensive devlog history. To keep your local checkout fast and compact, use a **Blobless Clone**:

```sh
git clone --filter=blob:none https://github.com/lidge-jun/opencodex.git
```

This downloads all commit history and branches while skipping historical file blobs, keeping your local `.git` directory under 100MB. Historical files are fetched transparently on demand when needed.

### Local Maintenance

If your local `.git` directory grows over time due to frequent active development, you can clean up unreferenced local objects:

```sh
git gc --prune=now
```
```

---

## 2. `.github/workflows/ci.yml` 적용 제언

CI 파이프라인에서 저장소를 체크아웃할 때 대용량 블롭 다운로드를 방지하기 위해 `actions/checkout` 단계에 `filter: blob:none` 옵션을 지정합니다.

```yaml
- name: Checkout repository
  uses: actions/checkout@v4
  with:
    fetch-depth: 0
    filter: blob:none
```

---

## 3. Git Ignore 관리 원칙

- `devlog/_chase/` 하위의 타사 비교용 레퍼런스 소스는 이미 `.gitignore`에 등록되어 관리되고 있습니다.
- 런타임 성능 및 RSS 모니터링 로그(`.tmp/`)도 기존과 같이 `.gitignore`로 철저히 격리하여 메인 Git 히스토리에 포함되지 않도록 유지합니다.
