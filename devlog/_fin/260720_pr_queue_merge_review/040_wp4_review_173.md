# 040 — WP4: #173 (Storage 진단 페이지, 외부 첫 기여) 딥리뷰

## 목표 verdict

스펙 정합성은 1차에서 높게 확인됨. 남은 것: GUI 품질, "3142 테스트 통과"
주장의 검증 가능 범위, CI 미실행 상태의 병합 리스크 평가.

## 변경 인벤토리 (12 files)

신규: `src/storage/scanner.ts`(1차 확인), `gui/src/pages/Storage.tsx`,
`gui/src/format-bytes.ts`, `tests/api-storage.test.ts`,
`tests/storage-scanner.test.ts`. 수정: `src/server/management-api.ts`
(1차 확인), `gui/src/App.tsx`, `gui/src/icons.tsx`, i18n 4.

## 딥리뷰 포커스

레인 A — Storage.tsx 전수(179라인): error envelope(`scan_failed`) 렌더 분기,
rows === undefined vs null 구분(미스캔 vs 잠김), 로케일 포맷, disclosure
접근성, App.tsx nav 배치와 라우팅.
레인 B — tests 두 파일: 8개 스캐너 테스트 + API 테스트가 주장대로 존재하고
통과하는지 로컬 실행. read-only 불변식 테스트(mtime+inode 스냅샷)의 결함
허용치(디렉터리 mtime 갱신 없이 통과하는지).
레인 C — scanner.ts 잔여 리스크: 동기 스캔의 이벤트 루프 블로킹(계획서 31이
"cheap"으로 감수 — verdict에 원문 인용), `Database(readonly)`가 라이브 WAL
DB에서 null로 자주 빠지는지 실측.

## Activation (C-ACTIVATION-GROUNDING-01, 직접 실행)

> **NOTE (A-gate fold #3):** 두 테스트 파일(`tests/storage-scanner.test.ts`,
> `tests/api-storage.test.ts`)은 #173 신규이므로 main에 없음. 반드시 PR head를
> scratch worktree에 checkout 후 실행.

```
git fetch origin pull/173/head
git worktree add /tmp/ocx-pr173 FETCH_HEAD --detach
cd /tmp/ocx-pr173
bun install
bun test tests/storage-scanner.test.ts tests/api-storage.test.ts
# 실기 activation: PR 헤드에서 스캐너를 실제 ~/.codex에 대해 실행
bun -e 'import { scanStorage } from "./src/storage/scanner.ts";
  const r = scanStorage("/Users/jun/.codex");
  console.log(JSON.stringify({ total: r.total, buckets: r.buckets.map(b =>
    ({ key: b.key, bytes: b.bytes, files: b.fileCount, rows: b.rows })) }, null, 1));'
cd /Users/jun/developer/new/700_projects/opencodex
git worktree remove --force /tmp/ocx-pr173
```
기대: `state_db.rows`와 `logs_db.rows`가 숫자(라이브 WAL에서 null이면 그것이
발견사항), total.bytes > 0. **(A-gate fold #6):** "스캔 전후 ~/.codex 무수정"은
fixture 테스트(`storage-scanner.test.ts` read-only invariant)에서 검증됨.
실기 실행 시에는 결과 출력만으로 판단하고, 실기 read-only 불변식이 필요하면
`/tmp`에 전후 `find ~/.codex -printf '%p %s %T@\n'` 스냅샷을 저장해 diff한다.

## CI 미실행 리스크 평가 (verdict 문서 필수 항목)

- first-time contributor → Actions 승인 전까지 체크 0개. 머지 전 요구 사항:
  (1) maintainer가 Actions 승인하여 전체 매트릭스 그린 확인, 또는
  (2) 로컬에서 PR 헤드 체크아웃 후 `bun run prepush` 상당 실행.
- 커밋 co-author가 Claude Fable 5 — 리포의 AI 기여 정책 관점에서 maintainer
  판단 필요 사항으로 표기(코드 품질과 별개).

## 판정 규칙

- 로컬 테스트+activation 그린 & GUI 블로커 0 → `approve-after-ci`
  (CI 승인/실행 후 머지 권고).
- activation에서 rows가 전부 null (라이브 DB 판독 불가) → 기능상 치명은
  아니나 "DB rows" 컬럼이 항상 unknown이면 기획 가치 훼손.
  실측 결과에 따라: rows 일부라도 숫자면 `approve-after-ci`(잔여 리스크 명시),
  전부 null이면 `needs-work`(immutable=1 폴백 요청).

---

## Verdict (WP4 결과) — `approve-after-ci` (4 non-blocking findings)

sol reviewer Archimedes(gpt-5.6-sol priority): 11/11 targeted + 3142/3142 full
suite pass, tsc+gui build+lint+i18n lint+privacy scan 그린.

### Activation 결과 (실기 ~/.codex)

```
total.bytes:    26,827,894,984 (25GB)
total.fileCount: 25,621
state_db.rows:   4,886    (숫자 ✓)
logs_db.rows:    1,009,585 (숫자 ✓)
```

rows 둘 다 숫자 반환 — "전부 null" 시나리오 해당 없음. `approve-after-ci` 조건 충족.

### P1 발견사항 1건 (non-blocking for Phase 1)

- **동기 스캔 이벤트 루프 블로킹** — 25K 파일 홈에서 1.12s 초회, 501ms 재실행.
  `management-api.ts:407`, `scanner.ts:79`. 계획서 31이 "Phase 1은 매번 스캔,
  cheap"으로 감수한 사양이나, 실측은 cheap이 아님. Phase 2에서 비동기 전환 또는
  캐싱 권고. **Phase 1 read-only 진단 목적상 블로커로 취급하지 않음.**

### P2 발견사항 3건

- `null` rows가 lock/corruption/missing schema를 미구분 (`Storage.tsx:76`,
  `scanner.ts:128`). reason code 반환 또는 "unavailable" 문구 권고.
- largest-file 테이블에 `<thead>` 없음 (`Storage.tsx:97`) — 접근성.
- read-only invariant 테스트가 inode 미검증 (`storage-scanner.test.ts:68`).
  size+mtime만 비교. PR body의 "mtime+inode 스냅샷" 주장과 불일치.

### P3 발견사항 3건

- 버킷 fileCount에 locale 포맷 누락 (`Storage.tsx:72`).
- sub-KB formatBytes에 locale 미적용 (`format-bytes.ts:5`).
- 테스트 수 9+2 실제 vs PR body 8+2 주장 — 메타데이터 stale.
- plan의 `mode=ro&immutable=1` 대비 `{ readonly: true }` 구현 — 의도적 이탈
  (기존 secondary-reader 패턴 일치, 실측 정상 작동).

### CI 미실행 리스크

First-time contributor → Actions 승인 전 체크 0개. 로컬에서 전체 스위트
3142/3142 + tsc + gui build + lint + privacy scan 통과 확인됨.
**머지 전 필수: maintainer가 Actions 승인 후 전체 매트릭스 그린 확인.**
Co-author Claude Fable 5 — AI 기여 정책은 maintainer 판단 사항.
