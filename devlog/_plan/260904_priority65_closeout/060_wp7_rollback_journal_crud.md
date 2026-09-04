# WP7 — 롤백 저널 항목 삭제 CRUD (#3379 중 1/3)

대상 이슈: #3379 "dashboard management gaps" (우선순위 57).
base: `origin/dev` = 2421e44ce, package 2.43.0, 브랜치 `codex/priority65-closeout`.

이 문서는 **copy-paste 실행용 PRD**다. 아래 모든 코드 인용은 위 base에서 실제로 읽은
현재 라인이다. 라인 번호는 그 시점 기준이며, 구현 시 앵커 문자열로 다시 찾을 것.

---

## 0. 스코프 경계

### IN

1. 롤백 저널 항목 **하나**를 대시보드에서 삭제하는 경로.
   - `DELETE /api/client-integrations/journal` (opId 지정)
   - `RollbackHistory.tsx` 행 단위 삭제 어포던스 + 확인 다이얼로그
   - 삭제 시 남아 있던 스냅샷 파일도 함께 제거
2. 위 라우트가 통과해야 하는 기존 게이트 4종: 라우트 레지스트리, CLI capability 패리티,
   저널 불변식, locale 키 패리티.
3. i18n 9개 로케일 신규 키 전량.

### OUT (이 work-phase에서 건드리지 않음)

1. **커스텀 사용량 범위** (#2748 흡수분). `gui/src/pages/Usage.tsx`, `src/usage/summary.ts`,
   시간 단위 버킷팅, 범위 스코프 비용 추정 — 전부 다른 work-phase.
2. **계정 셀렉터 이름 변경** (#3017 흡수분). `gui/src/components/CodexAccountPickerSetting.tsx`,
   `src/server/management/config-routes.ts`, `PATCH /api/config/codex/accounts/<id>` — 전부 다른
   work-phase.
3. **일괄 삭제 / "전체 비우기"**. 아래 §2에서 설명하는 최신 행 보호 규칙 때문에 일괄
   삭제는 별도 정책 결정이 필요하다. 이번엔 단건만.
4. 저널 보존 기간(TTL) 정책, 자동 만료. `SNAPSHOT_RETENTION`은 그대로 10.
5. `ocx` CLI 신규 서브커맨드 구현. §4.4에서 capability 게이트를 **exemption으로** 해소하며,
   verb 자체는 후속 phase 소유로 명시한다.

---

## 1. 현재 상태 — 실제 코드에서 확인한 공백

### 1.1 라우트는 GET 전용

`src/server/management/integration-routes.ts:322-323`:

```ts
  if (url.pathname === "/api/client-integrations/journal") {
    if (req.method !== "GET") return null;
```

`return null`이므로 다른 메서드는 이 핸들러를 그냥 통과해 `management-api.ts:236`의
`??` 체인 다음 후보로 넘어간다. 405도 아니고 404로 끝난다.

### 1.2 GUI에 삭제 어포던스 없음

`gui/src/pages/integrations/RollbackHistory.tsx:44-57` — 행이 그리는 것은 두 가지뿐이다:
`expired` 배지, 아니면 복원 버튼 하나.

```tsx
      {row.snapshot === "expired" ? (
        // The only genuinely impossible case: the bytes are gone.
        <span className="badge badge-muted">{t("integrations.action.snapshotExpired")}</span>
      ) : (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRestore(row)}>
```

즉 만료된 행은 **아무 버튼도 없는 죽은 행**이다. 이번 변경의 사용자 가치 대부분이 여기 있다.

### 1.3 저널 줄은 일부러 남긴다 — 이유 원문 인용

지시받은 대로 "일부러"의 근거를 코드에서 찾았다. 두 군데다.

`src/integrations/journal.ts:216-218` (`pruneSnapshots` 독스트링):

> Keep the newest N snapshot files per client; journal rows always survive.
> Structured rather than throwing or swallowing: a swallowed failure would let
> credential-bearing snapshots pile up while every operation reported success.

그리고 왜 살아남아야 하는지는 라우트 쪽 주석이 말한다.
`src/server/management/integration-routes.ts:339-346`:

> Resolved against the DISK, not read off the row.
> Retention deletes snapshot files and deliberately leaves the row's persisted tag saying
> `stored`, so copying that tag advertised undo for bytes that no longer exist — the GUI
> would offer the button and the restore route would answer 410.

**이 불변식의 정체를 정확히 규정한다.** 두 인용을 합치면 설계 의도는 이것이다:

- 스냅샷 파일(= 사용자 자격증명을 담을 수 있는 바이트)은 **양이 위험**하므로 10개로 깎는다.
- 저널 줄(= 무슨 일이 언제 있었는지의 메타데이터)은 **기록이 가치**이므로 남긴다.
  `tests/integrations-invariants.test.ts:123-143`이 "저널은 파일 사본이 아니라 메타데이터"를
  강제한다 — 사용자 config의 sentinel 문자열이 `journal.jsonl`에 절대 들어가지 않는다.
- 따라서 `stored` 태그는 **거짓말이 될 수 있는 값**이고, 그래서 아무도 태그를 믿지 않고
  `readSnapshot`으로 디스크를 다시 본다.

**정당한가? 정당하다.** 그래서 이 불변식을 깨지 않는 설계가 필요하다.
깨지 않는다는 것의 의미를 §2에서 정의한다.

---

## 2. 설계 결정 — 왜 `journal.jsonl`을 다시 쓰지 않는가

### 2.1 순진한 구현이 깨뜨리는 것

"해당 opId 줄만 빼고 `journal.jsonl`을 다시 쓴다"는 방식은 세 가지를 동시에 깬다.

1. **append-only 쓰기 순서 보장.** `journal.ts:1-14` 헤더가 규정한 규칙 1은
   "`appendOperation` commits the row and NOTHING else"다. 현재 이 파일에 대한 유일한
   쓰기는 `appendFileSync`(journal.ts:139)이다. 전체 재작성을 도입하면 append 중인 다른
   프로세스와 read-modify-write 경합이 생긴다.
2. **찢어진 줄 허용 규약.** `listOperations`(journal.ts:150-169)는 crash 중 잘린 마지막
   줄을 조용히 건너뛴다. 재작성 중 죽으면 잘리는 것이 **마지막 줄이 아니라 파일 전체**다.
3. **동시성.** `withIntegrationWriterLock`(writer-lock.ts:54-60)이 잠그는 것은
   `<configPath>.lock` — 즉 **클라이언트 설정 파일** 옆이지 저널 옆이 아니다. 저널 자체를
   보호하는 락은 이 저장소에 존재하지 않는다. append-only라서 필요가 없었다.

### 2.2 채택안 — 툼스톤 append

삭제도 **append**로 표현한다. 저널은 끝까지 append-only로 남는다.

```
{"opId":"...","clientId":"hermes","kind":"apply",...}      ← 원래 줄, 그대로 남음
{"tombstone":"<deleted-opId>","at":"2026-09-04T...","by":"gui-session"}  ← 새 줄
```

- 쓰기는 `appendFileSync` 한 번. 규칙 1 유지.
- crash 시 잘리는 것은 여전히 마지막 줄 하나뿐. 규칙 2 유지.
- 파일 재작성이 없으므로 다른 프로세스의 append와 경합하지 않는다. §6에서 상술.
- 스냅샷 파일은 별개로 `rmSync`한다 — 이건 이미 `pruneSnapshots`가 하던 일이라 새 위험이 아니다.

**불변식 위반 여부:** 위반하지 않는다. "journal rows always survive"는 *retention이 행을
지우지 않는다*는 약속이다. 사용자가 명시적으로 요청한 삭제는 retention이 아니다. 그리고
물리적 줄은 실제로 살아남는다 — 툼스톤이 그 위에 판정을 덮을 뿐이다.

**대안 기각 사유:**

| 대안 | 기각 이유 |
|---|---|
| `journal.jsonl` 재작성 | §2.1의 세 가지를 전부 깬다 |
| `deletedAt` 필드를 원래 줄에 in-place 수정 | JSONL 줄 길이가 바뀌어 결국 재작성 |
| 별도 `deleted.json` 파일 | `integrations-invariants.test.ts:719`가 저장소 루트 엔트리를 정확히 `["journal.jsonl","records.json","snapshots"]`로 고정. 새 파일은 이 테스트를 깬다 |

마지막 행은 중요하다. 실제로 확인한 단언이다:

```ts
    expect(readdirSync(storeRoot).sort()).toEqual(["journal.jsonl", "records.json", "snapshots"]);
```

새 사이드카 파일을 만들면 이 테스트가 빨개진다. 툼스톤 방식은 파일을 늘리지 않으므로 통과한다.

### 2.3 최신 행은 삭제 금지

라우트의 `undoable` 계산(`src/server/management/integration-routes.ts:368-373`)은
세 조건의 AND다:

```ts
          undoable: (() => {
            if (snapshot === "expired") return false;
            if (newestByClient.get(operation.clientId) !== operation.opId) return false;
            const current = currentConfigText(operation.configPath);
            return current === undefined ? false : matchesOperationResult(operation, current);
          })(),
```

최신 행이라는 것은 **필요조건이지 충분조건이 아니다.** 따라서 최신 행을 지우면 그
클라이언트의 되돌리기 진입점이 사라지지만, 최신 행이라고 해서 항상 되돌릴 수 있는 것은
아니다. 그래도 409 거절의 근거는 유지된다 — 진입점을 없애는 것과 진입점이 지금 쓸 수
있는지는 다른 질문이고, 사용자가 실수 직후 가장 필요로 하는 행을 지울 수 있게 두면
안 된다.

`records.json`의 `lastOpId`(`src/integrations/state.ts:492`)는 이 결정과 **무관하다.**
소유권 레코드에서 오는 값이고 저널 행 선택에 쓰이지 않는다. 혼동을 막기 위해 명시해 둔다.

**서버가 409로 거절한다.** UI는 그 행에 삭제 버튼을 아예 그리지 않는다(§5.2).
서버 거절이 진실의 원천이고, UI는 그 미러다. admin-token 직접 호출자에게는 GUI가
없으므로 규칙이 서버에 있어야 한다.

### 2.4 만료된 최신 행 — 아무 액션도 없는 행이 생긴다

`snapshot === "expired"`이면서 동시에 클라이언트 최신인 행은 `undoable: false`이고,
§2.3 규칙에 따라 `deletable: false`이기도 하다. 즉 **되돌릴 수도 지울 수도 없는 행**이
목록에 남는다. §1.2가 이 기능의 존재 이유로 든 상태가 정확히 이것이다.

이 유닛은 그 행을 지울 수 있게 만들지 않는다. 만료 여부와 최신 여부는 서로 다른 축이고,
"만료됐으면 최신이어도 삭제 허용"으로 예외를 파면 되돌리기 진입점 보호 규칙이
스냅샷 만료 타이밍에 의존하게 된다. 대신 그 행에 왜 액션이 없는지를 UI가 설명해야 한다 —
`refusal-copy.ts`에 사유 문자열을 추가하고 §5.3 i18n 키에 포함한다.

다음 클라이언트 작업이 새 행을 만들면 이 행은 자동으로 최신이 아니게 되어 삭제 가능해진다.
영구 교착이 아니다.

---

## 3. 필드 체인 (PLAN-FIELD-CHAIN-01)

이번 변경은 타입에 필드를 **두 개** 추가한다. 각각 creation → serialization →
deserialization → 모든 consumer를 전부 열거한다.

### 3.1 `JournalTombstone` (신규 타입, `journal.jsonl`의 두 번째 줄 종류)

| 단계 | 위치 | 내용 |
|---|---|---|
| creation | `src/integrations/journal.ts` `appendTombstone()` (신규) | `{ tombstone, at, by }` |
| serialization | 같은 함수의 `appendFileSync(..., JSON.stringify(record))` | 기존 append와 동일 경로 |
| deserialization | `listOperations` 내부 파싱 루프 (journal.ts:157-166) | `isTombstone(parsed)`로 분기 |
| consumer 1 | `listOperations` 반환값 | 툼스톤된 opId 행을 **제외**하고 반환 |
| consumer 2 | `findOperation` (journal.ts:174-176) | `listOperations` 위에 얹혀 있으므로 자동 제외 → 삭제된 행 복원은 404 |
| consumer 3 | `pruneSnapshots` (journal.ts:222-250) | `listOperations`로 keep 집합 계산 → 삭제된 행의 스냅샷은 keep에서 빠져 다음 prune에 정리됨. **보존 창이 한 칸 밀린다 — 아래 참조** |

**consumer 3의 파급을 명시한다.** `pruneSnapshots`의 keep 계산은
`journal.ts:228-233`에서 이렇게 만들어진다:

```ts
  const keep = new Set(
    listOperations(clientId, Number.MAX_SAFE_INTEGER, dir)
      .filter(row => row.snapshot.kind === "stored")
      .slice(0, SNAPSHOT_RETENTION)
      .map(row => row.opId),
  );
```

`listOperations`가 툼스톤 처리된 행을 감추므로, 삭제 하나가 `slice(0, 10)` 창을
한 칸 밀어낸다. 직전까지 11번째여서 정리 대상이던 행이 keep에 들어온다.

방향은 안전한 쪽이다 — 스냅샷이 **더 오래** 보존되지 사라지지 않는다. 그러나
`journal.ts:225-226`이 "The docs say ten backups per client, and this is the code that
has to make that true"라고 적은 그 계약의 의미가 미묘하게 달라진다. 삭제 후의 "10개"는
"살아 있는 행 기준 10개"이지 "발생한 작업 기준 10개"가 아니다.

이 유닛은 그 동작을 그대로 둔다. 사용자가 행을 지웠으면 그 행의 백업이 보존 카운트를
차지하지 않는 쪽이 오히려 기대에 맞고, 반대로 만들려면 툼스톤을 세는 별도 경로가 필요해
append-only 단순성을 잃는다. 다만 `docs-site`의 "ten backups per client" 문구를 읽는
사람이 오해하지 않도록, 구현 시 `pruneSnapshots` 독스트링에 이 한 줄을 덧붙인다:
"A user-deleted row no longer occupies a retention slot."
| consumer 4 | `store.listOperations` / `store.findOperation` (store.ts:81-82) | 순수 위임, 변경 없음 |
| consumer 5 | `GET /api/client-integrations/journal` (routes:330) | 목록에서 사라짐 |
| consumer 6 | `POST /api/client-integrations/restore` (routes:404) | `findOperation` → null → 기존 404 경로 재사용 |
| consumer 7 | `writer.ts:582` `store.findOperation(input.opId)` | 동일하게 null → 기존 거절 경로 |
| consumer 8 | `readIntegrationState`의 `retentionOf` (state.ts:402-413) | `countSnapshots`는 디스크를 세므로 삭제 후 감소. `retentionDegraded` 판정 자동 정합 |
| consumer 9 | GUI `IntegrationJournalRow[]` (integration-api.ts:54-62) | 행이 응답에 없으므로 타입 변경 불필요 |
| consumer 10 | `IntegrationsOverview.tsx:419` `history[0]?.at` (요약의 "마지막 변경") | 최신 행은 삭제 불가(§2.3)이므로 값이 사라지지 않음 |

**주의:** `listOperations`는 `JournalEntry[]`를 반환하는 공개 API다. 툼스톤은 **절대 이
반환 타입에 새지 않는다** — 내부에서 필터링하고 버린다. 이것이 consumer 4~10이 전부 무변경인
이유다. 툼스톤을 `JournalEntry` 유니온에 넣으면 위 열 곳이 전부 새 분기를 갖게 되고, 그중
하나라도 빠뜨리면 툼스톤이 UI에 알 수 없는 종류의 행으로 렌더된다.

### 3.2 `OperationKind`는 건드리지 않는다

`delete`를 `OperationKind`에 추가하고 싶은 유혹이 있으나 **하지 않는다.**
`tests/integrations-journal.test.ts:356-377`이 세 트리의 유니온 일치를 강제한다:

```ts
    expect(store).toEqual(["apply", "disable", "overwrite", "refresh", "restore"]);
    expect(route).toEqual(store);
    expect(gui).toEqual(store);
```

그리고 379-386의 두 번째 테스트는 모든 kind가 `JOURNAL_KIND_KEY`에 렌더 문구를 가질 것을
요구한다(overview-clients.ts:165-176). 즉 kind를 늘리면 **세 파일 + 9개 로케일**이 연쇄된다.
삭제는 "표시되는 작업"이 아니라 "행을 사라지게 하는 것"이므로 kind가 아니다.

### 3.3 `IntegrationJournalRow.deletable` (신규 boolean, 서버 → GUI)

UI가 삭제 가능 여부를 스스로 추측하면 §2.3의 최신 행 규칙이 두 곳에 중복된다.
서버가 계산해서 내려보낸다.

| 단계 | 위치 |
|---|---|
| creation | `integration-routes.ts` 저널 매핑 (routes:348-374)에서 `undoable` 옆에 계산 |
| serialization | `IntegrationJournalEnvelope`의 `operations[]` (routes:67-79) — JSON 그대로 |
| deserialization | GUI `readResponse<IntegrationJournalEnvelope>` (integration-api.ts:214) — 구조적 타입, 파서 없음 |
| 타입 선언 1 | `src/server/management/integration-routes.ts` `IntegrationJournalRow` (routes:71-79) |
| 타입 선언 2 | `gui/src/pages/integrations/integration-api.ts` `IntegrationJournalRow` (api:54-62) |
| consumer 1 | `RollbackHistory.tsx` `RollbackRow` — 버튼 렌더 여부 |
| consumer 2 | `IntegrationsOverview.tsx:646` — prop 전달 |
| consumer 3 | `FileIntegrationPage.tsx:273` — prop 전달 |

두 타입 선언은 **서로 import하지 않는 별개 트리**다(journal.ts:26-33 주석이 명시).
한쪽만 고치면 타입 에러 없이 `undefined`가 되어 버튼이 조용히 사라진다. 반드시 둘 다.

---

## 4. 파일 변경 맵

### 4.1 MODIFY `src/integrations/journal.ts`

**(a) 툼스톤 타입 + append 함수 추가.** `SNAPSHOT_RETENTION` 선언(현재 line 62) 아래.

before:

```ts
export const SNAPSHOT_RETENTION = 10;
```

after:

```ts
export const SNAPSHOT_RETENTION = 10;

/**
 * A deletion, expressed as an APPEND.
 *
 * The alternative — rewriting journal.jsonl without the row — breaks all three
 * things this file's header promises. `appendOperation` commits and nothing
 * else, so a read-modify-write would race any concurrent append; a torn write
 * would truncate the whole log rather than one trailing line, which
 * `listOperations` is built to tolerate; and no lock covers this file, because
 * append-only never needed one (writer-lock.ts guards `<configPath>.lock`,
 * which is a client config, not this).
 *
 * "journal rows always survive" (pruneSnapshots below) is a promise about
 * RETENTION, not about the user. An operator deleting their own row is not
 * retention, and the physical line does in fact survive — this record is laid
 * over it.
 */
export interface JournalTombstone {
  /** opId this row retires. */
  tombstone: string;
  at: string;
  /** Management principal that asked. Never a token, never a path. */
  by: string;
}

function isTombstone(value: unknown): value is JournalTombstone {
  return typeof value === "object" && value !== null
    && typeof (value as { tombstone?: unknown }).tombstone === "string";
}

/** Retire one operation. Append-only, exactly like `appendOperation`. */
export function appendTombstone(
  record: JournalTombstone,
  dir: string = integrationsDir(),
): void {
  ensureDir(journalPath(dir));
  appendFileSync(journalPath(dir), `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}
```

**(b) `listOperations`가 툼스톤을 소비하고 감춘다.** 현재 line 150-169.

before:

```ts
  const rows: JournalEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as JournalEntry;
      if (!clientId || parsed.clientId === clientId) rows.push(parsed);
    } catch {
      // Torn line from an interrupted append; the rest of the log is still good.
    }
  }
  return rows.reverse().slice(0, limit);
```

after:

```ts
  const rows: JournalEntry[] = [];
  /*
   * Collected in the SAME pass, before any filtering. A tombstone carries no
   * clientId — it names an opId — so a pass that filtered by client first would
   * drop the tombstone and resurrect the row on the per-client route while the
   * global route hid it. The two routes read the same log and must agree.
   */
  const retired = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isTombstone(parsed)) {
        retired.add(parsed.tombstone);
        continue;
      }
      const entry = parsed as JournalEntry;
      if (!clientId || entry.clientId === clientId) rows.push(entry);
    } catch {
      // Torn line from an interrupted append; the rest of the log is still good.
    }
  }
  /*
   * Filter AFTER the whole file is read, never during. A tombstone is always
   * appended after the row it retires, so an in-loop check would miss every one.
   */
  const live = retired.size === 0 ? rows : rows.filter(row => !retired.has(row.opId));
  return live.reverse().slice(0, limit);
```

> 위 주석 두 개는 장식이 아니다. "필터를 루프 안에서"와 "클라이언트 먼저 필터링"은
> 이 구현에서 실제로 발생 가능한 두 가지 오답이고, 둘 다 타입 에러 없이 통과한다.

### 4.2 MODIFY `src/integrations/store.ts`

저장소 시임에 노출한다. 라우트는 모듈 레벨 함수를 직접 부르지 않는다 —
integration-routes.ts:165-173 주석이 "ONE store per request"를 강제한다.

인터페이스(store.ts:44 `appendJournal` 아래):

```ts
  appendJournal(entry: JournalEntry): void;
  /** Retire one operation. Append-only; see journal.ts `appendTombstone`. */
  retireOperation(record: JournalTombstone): void;
```

구현(store.ts:80 아래):

```ts
    appendJournal: entry => appendOperation(entry, dir),
    retireOperation: record => appendTombstone(record, dir),
```

import 블록(store.ts:13-27)에 `appendTombstone`, `type JournalTombstone` 추가.

### 4.3 MODIFY `src/server/management/integration-routes.ts`

**(a) 응답 행에 `deletable` 추가.** routes:71-79.

before:

```ts
export interface IntegrationJournalRow {
  opId: string;
  clientId: IntegrationClientId;
  kind: "apply" | "disable" | "refresh" | "restore" | "overwrite";
  at: string;
  configPath: string;
  snapshot: "none" | "stored" | "expired";
  undoable: boolean;
}
```

after:

```ts
export interface IntegrationJournalRow {
  opId: string;
  clientId: IntegrationClientId;
  kind: "apply" | "disable" | "refresh" | "restore" | "overwrite";
  at: string;
  configPath: string;
  snapshot: "none" | "stored" | "expired";
  undoable: boolean;
  /**
   * May the operator retire this row?
   *
   * Computed HERE, not in the GUI, because the DELETE route enforces the same
   * rule and two copies of it would drift. False for a client's newest row: it
   * is the undo entry point (`undoable` above keys off exactly this), and it is
   * what a user reaches for right after the mistake.
   */
  deletable: boolean;
}
```

매핑(routes:368-373 `undoable` 즉시 뒤)에 추가:

```ts
          deletable: newestByClient.get(operation.clientId) !== operation.opId,
```

**(b) DELETE 메서드 수용.** routes:322-323.

before:

```ts
  if (url.pathname === "/api/client-integrations/journal") {
    if (req.method !== "GET") return null;
```

after:

```ts
  if (url.pathname === "/api/client-integrations/journal" && req.method === "DELETE") {
    return handleJournalDelete(ctx);
  }

  if (url.pathname === "/api/client-integrations/journal") {
    if (req.method !== "GET") return null;
```

**(c) 핸들러 신규.** `handleIntegrationRoutes` 위에 배치.

```ts
/**
 * Retire one journal row at the operator's request.
 *
 * The opId travels in the QUERY STRING, matching `DELETE
 * /api/codex-auth/accounts?id=` (auth-api.ts:1842-1844) — the repository's only
 * other DELETE-by-identifier. A body on DELETE is legal but unevenly handled by
 * intermediaries, and there is nothing here a query cannot carry.
 */
async function handleJournalDelete(ctx: ManagementContext): Promise<Response> {
  const { req, url } = ctx;
  const opId = url.searchParams.get("opId")?.trim();
  if (!opId) {
    return jsonResponse({
      error: "opId must be a non-empty string",
      code: "invalid_op_id",
    }, 400, req, ctx.config);
  }
  try {
    const store = integrationStore();
    const operation = store.findOperation(opId);
    if (!operation) {
      // Already retired, or never existed. Both are 404: the tombstone hides
      // the row from `findOperation`, so a double-click is idempotent here
      // rather than a second deletion of something.
      return jsonResponse({
        error: "integration operation not found",
        code: "integration_operation_not_found",
        opId,
      }, 404, req, ctx.config);
    }
    /*
     * The newest row per client is refused, and refused by the SERVER even
     * though the GUI already hides its button. The button is a courtesy; this
     * is the rule. An admin-token caller has no GUI at all.
     *
     * Re-read immediately before the write: a restore that landed while this
     * dialog was open appends a new row and changes which opId is newest.
     */
    const newest = store.listOperations(operation.clientId, 1)[0];
    if (newest?.opId === opId) {
      return jsonResponse({
        error: "the newest operation for a client cannot be deleted",
        code: "integration_journal_newest_protected",
        clientId: operation.clientId,
        opId,
      }, 409, req, ctx.config);
    }

    store.retireOperation({
      tombstone: opId,
      at: new Date().toISOString(),
      by: journalDeletePrincipal(ctx),
    });

    /*
     * Snapshot bytes go too, and go AFTER the tombstone — the same post-commit
     * ordering `appendOperation` uses (journal.ts:1-9, rule 1). If this fails,
     * the row is still retired and `retentionDegraded` will disclose the
     * leftover file; the reverse order would delete a user's backup for a
     * deletion that then failed to record.
     */
    const pruned = store.pruneSnapshots(operation.clientId);
    if (!pruned.ok) store.markPruneFailure(operation.clientId, pruned.error);

    return jsonResponse({
      ok: true,
      opId,
      clientId: operation.clientId,
      snapshotRemoved: pruned.ok,
    }, 200, req, ctx.config);
  } catch (error) {
    return internalErrorResponse(error, ctx);
  }
}
```

**구현자 주의.** `journalDeletePrincipal(ctx)`는 아직 존재하지 않는 헬퍼다.
`ManagementContext`에 principal 필드가 있으면 그것을 반환하고, 없으면
`managementPrincipal()`(management-auth.ts:501-508)로 해석한다. 그 배선이 이 phase 범위를
넘는다고 판단되면 `"management"` 상수를 반환하고 §11에 결정을 기록할 것. 어느 경우든
**토큰 값·세션 ID·파일 경로는 반환하지 않는다**(§6.2).

### 4.4 MODIFY `src/server/management/route-registry.ts`

선언하지 않으면 `tests/management-route-registry.test.ts`가 실패한다.
routes:171 뒤에 추가:

```ts
  {
    method: "DELETE",
    path: "/api/client-integrations/journal",
    module: "server/management/integration-routes",
    mutates: true,
    exempt: {
      reason: "deferred-verb",
      why: "Retiring one rollback row is a dashboard-local cleanup; the CLI verb that would drive it is owed by a later work-phase and is not implemented here.",
      owner: "260904_priority65_closeout WP7",
      ownerDoc: "devlog/_plan/260904_priority65_closeout/060_wp7_rollback_journal_crud.md",
    },
  },
```

**이 exemption은 선택이 아니다.** `tests/cli-capabilities.test.ts:344-357`은 모든 라우트가
capability로 덮이거나, `exempt`를 갖거나, 2026-08-28 ratchet 목록에 있을 것을 요구한다.
ratchet은 **줄어들기만 해야 하므로**(같은 파일 359-372) 새 항목을 거기 넣을 수 없다.
또한 `why`는 40자 미만이면 실패한다(management-route-registry.test.ts:170-175) — 위 문장은
충분히 길다. `ownerDoc`은 실존 파일이어야 한다(같은 파일 177-191) — 이 문서가 그 파일이다.

### 4.5 MODIFY `gui/src/pages/integrations/integration-api.ts`

**(a) 행 타입.** api:54-62의 인터페이스에 `deletable: boolean;` 추가 (§3.3).

**(b) 호출 함수.** `restoreIntegration`(api:240-254) 뒤에 추가:

```ts
export async function deleteJournalEntry(
  apiBase: string,
  opId: string,
  signal?: AbortSignal,
) {
  return readResponse<{
    ok: true;
    opId: string;
    clientId: FileIntegrationClientId;
    snapshotRemoved: boolean;
  }>(
    await fetch(`${apiBase}/api/client-integrations/journal?opId=${encodeURIComponent(opId)}`, {
      method: "DELETE",
      signal,
    }),
  );
}
```

CSRF 헤더는 손대지 않는다. `gui/src/api.ts:199`가 GET/HEAD 외 모든 메서드에 자동 부착한다:

```ts
    if (method !== "GET" && method !== "HEAD") headers.set("X-OpenCodex-CSRF-Token", state.session.csrfToken);
```

DELETE는 이미 CORS 허용 메서드다(auth-cors.ts:214).

### 4.6 MODIFY `gui/src/pages/integrations/RollbackHistory.tsx`

기존 시각 언어를 그대로 쓴다. 새 컴포넌트 없음, 새 디자인 시스템 없음.
`btn btn-ghost btn-sm`은 이 파일이 이미 쓰는 클래스이고, 확인 다이얼로그는
**기존 `ConsequenceDialog`를 재사용**한다(§5.1).

before (44-57):

```tsx
      {row.snapshot === "expired" ? (
        // The only genuinely impossible case: the bytes are gone.
        <span className="badge badge-muted">{t("integrations.action.snapshotExpired")}</span>
      ) : (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRestore(row)}>
          {row.undoable ? t("integrations.action.undo") : t("integrations.action.restorePoint")}
        </button>
      )}
    </li>
```

after:

```tsx
      {row.snapshot === "expired" ? (
        // The only genuinely impossible case: the bytes are gone.
        <span className="badge badge-muted">{t("integrations.action.snapshotExpired")}</span>
      ) : (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRestore(row)}>
          {row.undoable ? t("integrations.action.undo") : t("integrations.action.restorePoint")}
        </button>
      )}
      {/*
        Delete sits AFTER restore, and only when the server says so. An expired
        row keeps its badge and gains this button — that pairing is the point of
        the feature: a row whose bytes are gone was previously a dead entry with
        no action at all.
      */}
      {row.deletable && onDelete && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => onDelete(row)}
          aria-label={t("integrations.rollback.deleteAria", { at: new Date(row.at).toLocaleString() })}
        >
          {t("integrations.rollback.delete")}
        </button>
      )}
    </li>
```

props 확장 — `RollbackRow`와 `RollbackHistory` **양쪽**:

```tsx
  onRestore: (row: IntegrationJournalRow) => void;
  /** Optional: a surface that cannot refresh the journal must not offer it. */
  onDelete?: (row: IntegrationJournalRow) => void;
```

`RollbackHistory`는 `onDelete`를 두 `RollbackRow` 호출부(현재 82행, 89행) 모두에 전달한다.
82행은 최신 행이라 서버가 `deletable: false`를 주지만, prop을 빠뜨리면 §2.3 규칙이
*prop 누락*이라는 우연에 의존하게 된다. 규칙은 데이터가 강제한다.

**CSS 변경 없음.** `gui/src/styles-integrations.css:151`의 모바일 규칙
`.integration-history-row .btn { margin-left: auto; }`은 버튼이 둘일 때 첫 버튼만 밀어낸다.
420px 이하에서 두 버튼이 나란히 오른쪽 정렬되므로 새 규칙이 필요 없다.
구현 후 좁은 폭에서 눈으로 확인할 것.

**색상.** `btn-danger`(styles.css:677)를 **쓰지 않는다.** D4-D5 밀도의 운영 도구에서 행마다
빨간 버튼이 반복되면 목록 전체가 경고처럼 읽힌다. VARIANCE 2-4 범위를 지켜 `btn-ghost`로 두고,
파괴성은 확인 다이얼로그에서 전달한다. 다이얼로그 확인 버튼은 `ConsequenceDialog`가 이미
`btn-primary`로 렌더한다(ConsequenceDialog.tsx:96) — 그것도 바꾸지 않는다.

**MOTION 1-2.** 새 트랜지션·애니메이션 없음. 행 제거는 목록 재조회로 자연 반영된다.

### 4.7 MODIFY `gui/src/pages/integrations/IntegrationsOverview.tsx`

삭제 확인 상태 추가(179행 `restoring` 옆):

```tsx
  const [deleting, setDeleting] = useState<IntegrationJournalRow | null>(null);
```

646행:

```tsx
        <RollbackHistory rows={history} showClient onRestore={setRestoring} onDelete={setDeleting} />
```

`RestoreDialog` 블록(649-655) 뒤에 확인 다이얼로그 추가:

```tsx
      {deleting && (
        <ConsequenceDialog
          copy={{
            titleKey: "integrations.dialog.deleteEntry.title",
            changesKey: "integrations.dialog.deleteEntry.changes",
            breakageKey: "integrations.dialog.deleteEntry.breakage",
            undoKey: "integrations.dialog.deleteEntry.undo",
            confirmKey: "integrations.dialog.deleteEntry.confirm",
            vars: { path: deleting.configPath },
          }}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            // ConsequenceDialog keeps the dialog open and renders a thrown
            // message as a Notice (ConsequenceDialog.tsx:54-59), which is the
            // error path this feature needs: not a dead end, and the confirm
            // button re-enables so the same press is the retry.
            await deleteJournalEntry(apiBase, deleting.opId);
            setDeleting(null);
            await historyResource.refresh();
          }}
        />
      )}
```

`ConsequenceDialog`는 이 파일이 이미 import한다(pendingToggle/pendingOverwrite에서 사용 중).
`deleteJournalEntry`만 28행 import 블록에 추가한다.

### 4.8 MODIFY `gui/src/pages/integrations/FileIntegrationPage.tsx`

동일 패턴. 87행 옆에 `deleting` 상태, 273행에 `onDelete={setDeleting}`,
`RestoreDialog` 블록(276-282) 뒤에 §4.7과 같은 `ConsequenceDialog` 블록.
이 파일도 `ConsequenceDialog`를 이미 import하고 있다(overwriting에서 사용).

### 4.9 MODIFY `gui/src/pages/integrations/refusal-copy.ts`

`CODE_KEYS`(refusal-copy.ts:12-14)에 두 코드 등록. 근거는 §5.2.

before:

```ts
const CODE_KEYS: Record<string, TKey> = {
  integration_mutation_busy: "integrations.error.busy",
};
```

after:

```ts
const CODE_KEYS: Record<string, TKey> = {
  integration_mutation_busy: "integrations.error.busy",
  integration_journal_newest_protected: "integrations.rollback.deleteNewest",
  integration_operation_not_found: "integrations.rollback.deleteGone",
};
```

### 4.10 MODIFY `gui/src/i18n/en.ts` + 8개 로케일

§5.3 참조. 신규 키 9개 × 로케일 9개 = 81개 항목.

### 4.11 NEW `tests/management-integration-journal-delete.test.ts`

§7의 분기 1~6. 기존 `tests/management-integration-routes.test.ts`의 픽스처 패턴
(`setIntegrationMutationFlightTestHooks`로 임시 store 바인딩,
`setIntegrationPathTestHooks`로 임시 home 바인딩)을 그대로 따른다.

### 4.12 DELETE

없음.

---

## 5. UX 명세 (cxc-dev-uiux-design)

### 5.1 확인 단계 — UX-LAZY-01 STRICT 예외

삭제는 비가역이다. 스냅샷 바이트가 사라지고 툼스톤을 되돌리는 UI는 없다.
**magic default로 흡수 금지.** 반드시 확인 다이얼로그를 거친다.

재사용 컴포넌트: `gui/src/pages/integrations/ConsequenceDialog.tsx`.
이 저장소가 이미 파괴적 액션에 쓰는 컴포넌트이며 4개 슬롯(변경/파급/되돌리기/확인)을 강제한다.
새 모달을 만들면 포커스 트랩·백드롭·pending 처리를 다시 구현하게 된다.

**정확한 문구:**

| 슬롯 | English | 한국어 |
|---|---|---|
| title | Delete this rollback entry? | 이 롤백 기록을 삭제할까요? |
| changes | This entry disappears from the rollback list, and any backup it still holds for {path} is deleted from disk. | 이 기록이 롤백 목록에서 사라지고, {path}에 대해 남아 있던 백업 파일도 디스크에서 삭제됩니다. |
| breakage | You will no longer be able to restore the file to this point. Newer entries and the file itself are untouched. | 이 시점으로는 더 이상 파일을 되돌릴 수 없습니다. 더 최근 기록과 파일 자체는 그대로입니다. |
| undo | This cannot be undone. The most recent entry for each client is kept and cannot be deleted. | 되돌릴 수 없습니다. 클라이언트별 가장 최근 기록은 삭제되지 않고 남습니다. |
| confirm | Delete entry | 기록 삭제 |

`undo` 슬롯이 최신 행 보호를 말하는 것이 중요하다. 사용자가 "그럼 최근 것도 실수로
지워지나?"를 묻기 전에 답한다.

행 버튼 라벨: **Delete** / **삭제**. `aria-label`은 스크린리더 사용자가 어느 행인지
구분할 수 있도록 시각을 포함한다: "Delete the rollback entry from {at}" /
"{at} 롤백 기록 삭제".

### 5.2 상태별 화면 (UX-STATE-01)

| 상태 | 무엇을 보여주는가 | 근거 |
|---|---|---|
| **empty** (저널 0행) | 변경 없음. 기존 `integrations.rollback.empty` + `emptyBody`를 그대로 쓴다. Overview는 `integration-empty` 블록(640-644행), 클라이언트 탭은 `page-sub` 한 줄(270-271행). | 삭제 기능은 빈 상태에 새 문구를 요구하지 않는다. 새 문구를 넣으면 "방금 지워서 비었다"와 "원래 비었다"가 구분되는 척하게 되는데, 응답은 그 구분을 담지 않는다. 그리고 최신 행은 삭제 불가이므로 **삭제만으로 목록이 비는 일은 애초에 없다**. |
| **삭제 진행 중** (loading) | `ConsequenceDialog`의 기존 pending 동작: 확인 버튼 `disabled`(96행), 닫기·백드롭 비활성(80·90행). 목록은 그대로 두고 스켈레톤으로 바꾸지 않는다. | optimistic 제거는 실패 시 행을 되살려야 해서 깜빡임을 만든다. 다이얼로그가 열려 있는 동안 목록이 안정적으로 남는 편이 D4-D5 밀도에 맞다. |
| **삭제 실패** (error) | 다이얼로그가 **열린 채로** 남고 `Notice tone="err"`에 사유가 뜬다(ConsequenceDialog.tsx:93). 확인 버튼은 다시 활성화된다(58행 `setPending(false)`). → **재시도 = 같은 버튼 다시 누르기.** 포기하려면 Close. | dead-end 금지. 실패가 다이얼로그를 닫아버리면 사용자는 무엇이 남았는지 모른 채 목록으로 돌아간다. |
| **409 최신 행 보호** | 정상 경로에서는 버튼이 없어 도달 불가. 탭 두 개를 열어두면 도달 가능하며 위 error 상태로 표시된다. 문구는 `integrations.rollback.deleteNewest`. | 서버가 진실이므로 UI가 뒤처져도 안전하게 실패한다. |
| **404 이미 삭제됨** | 같은 error 표시, 문구는 `integrations.rollback.deleteGone`. Close하면 갱신된 목록을 본다. | 탭 두 개 시나리오. 재시도해도 같은 404이므로 문구가 "목록을 새로 불러옵니다"로 다음 행동을 지정한다. |

**실패 사유 문구 연결.** `describeRefusal`(refusal-copy.ts:78-109)은 `reason` 필드가 있는
writer refusal만 로컬라이즈한다. 이 라우트의 409/404는 `reason`이 없으므로 refusal이 아니다.
그래서 §4.9에서 `CODE_KEYS`에 두 코드를 등록한다. 등록하지 않으면 서버의 영어 `error`
문자열이 모든 로케일에 그대로 노출된다 — refusal-copy.ts:5-11 주석이 정확히 그 사고를 기록한다.

단, `ConsequenceDialog`의 catch는 `error.message`를 쓴다(57행). 따라서 둘 중 하나를 택한다:

- **(권장)** `onConfirm` 안에서 잡아 `new Error(describeRefusal(t, error))`로 다시 던진다.
  다른 다이얼로그 3곳에 영향이 없다.
- `ConsequenceDialog`가 `describeRefusal`을 직접 쓰게 한다. 영향 범위가 넓다.

선택을 §7 시나리오 10의 테스트로 고정할 것.

### 5.3 i18n 키 전량

이 저장소는 로케일을 `gui/src/i18n/<locale>.ts` 9개 파일로 관리하고
`gui/src/i18n/catalogs.ts:24-34`가 등록한다. `en`이 `TKey`의 원천이고(en.ts:8),
나머지는 `Record<TKey, string>`(예: ko.ts:6)이므로 **키를 빠뜨리면 타입 에러**가 난다.
추가로 `gui/tests/i18n-locales.test.ts:33-40`이 키 집합 완전 일치를 강제한다.

대상 파일 9개: `en.ts`, `ko.ts`, `ja.ts`, `zh.ts`, `zh-TW.ts`, `de.ts`, `fr.ts`, `ru.ts`, `tr.ts`.
삽입 위치는 기존 `integrations.rollback.*` 블록 옆(en.ts:1636-1642 부근).

신규 키 **9개** (en 값):

```ts
  "integrations.rollback.delete": "Delete",
  "integrations.rollback.deleteAria": "Delete the rollback entry from {at}",
  "integrations.rollback.deleteNewest": "The most recent entry for this client is kept so you can still undo it.",
  "integrations.rollback.deleteGone": "This entry was already deleted. The list will refresh.",
  "integrations.dialog.deleteEntry.title": "Delete this rollback entry?",
  "integrations.dialog.deleteEntry.changes": "This entry disappears from the rollback list, and any backup it still holds for {path} is deleted from disk.",
  "integrations.dialog.deleteEntry.breakage": "You will no longer be able to restore the file to this point. Newer entries and the file itself are untouched.",
  "integrations.dialog.deleteEntry.undo": "This cannot be undone. The most recent entry for each client is kept and cannot be deleted.",
  "integrations.dialog.deleteEntry.confirm": "Delete entry",
```

ko 값:

```ts
  "integrations.rollback.delete": "삭제",
  "integrations.rollback.deleteAria": "{at} 롤백 기록 삭제",
  "integrations.rollback.deleteNewest": "이 클라이언트의 가장 최근 기록은 되돌리기를 위해 남겨 둡니다.",
  "integrations.rollback.deleteGone": "이미 삭제된 기록입니다. 목록을 새로 불러옵니다.",
  "integrations.dialog.deleteEntry.title": "이 롤백 기록을 삭제할까요?",
  "integrations.dialog.deleteEntry.changes": "이 기록이 롤백 목록에서 사라지고, {path}에 대해 남아 있던 백업 파일도 디스크에서 삭제됩니다.",
  "integrations.dialog.deleteEntry.breakage": "이 시점으로는 더 이상 파일을 되돌릴 수 없습니다. 더 최근 기록과 파일 자체는 그대로입니다.",
  "integrations.dialog.deleteEntry.undo": "되돌릴 수 없습니다. 클라이언트별 가장 최근 기록은 삭제되지 않고 남습니다.",
  "integrations.dialog.deleteEntry.confirm": "기록 삭제",
```

나머지 7개 로케일은 같은 의미로 번역한다. 영어를 복사해 넣지 말 것 —
`i18n-locales.test.ts`는 키 존재만 보므로 영어 복붙을 잡지 못한다.
`{path}`와 `{at}` 자리표시자는 모든 로케일에서 유지해야 한다.

---

## 6. 권한 · 감사 · 동시성

### 6.1 권한

이 저장소에는 admin/editor 같은 **역할(role) 모델이 없다.** 실제 principal 유니온은
`src/server/management-auth.ts:282-289`:

```ts
export type ManagementPrincipal =
  | "admin-token"
  | "gui-session"
  | "gui-pair-capability"
  | "local-read-capability"
  | "local-provider-reload-capability"
  | "system-restart-capability";
```

따라서 "admin이냐 editor냐"에 대한 이 저장소에서의 답은 다음과 같다:

- **DELETE에 별도 권한 게이트를 추가하지 않는다.** `requireManagementAuth`
  (management-auth.ts:507-521)가 관리 API 전체를 덮고, 이 라우트는 `admin-token`과
  `gui-session` 둘 다 허용한다 — `PUT /api/client-integrations/{clientId}`(실제 클라이언트
  설정 파일을 고쳐 쓰는, 훨씬 파괴적인 라우트)와 같은 수준이다. 메타데이터 한 줄 삭제에
  더 높은 문턱을 두는 것은 일관성이 없다.
- **`session-only`로 좁히지 않는다.** 그 exemption은 사용자의 계정·평판을 쓰는 경계
  (GitHub star, AGENTS.md "User-consent actions")에 쓰인다. 저널 삭제는 로컬 파일 정리이므로
  해당 없다.
- **`local-read-capability`는 자동으로 배제된다.** 그 principal은 정확한 두 개의 GET
  경로에서만 인정된다(management-auth.ts:277-280, 330행 `req.method !== "GET"`).
  DELETE는 도달하지 못한다.
- **CSRF는 자동 적용된다.** `gui-session`은 origin + per-session CSRF 토큰 일치를 요구한다
  (management-auth.ts:274-277). GUI 쪽은 api.ts:199가 GET/HEAD가 아닌 모든 메서드에 헤더를
  붙이므로 DELETE도 포함된다. 기존 테스트 `management-integration-routes.test.ts`의
  "a GUI-session mutation without CSRF is rejected before integration dispatch"가 이 계층을
  이미 지킨다.

### 6.2 감사 로그

**전용 감사 로그를 새로 만들지 않는다.** §2.2의 툼스톤 자체가 감사 기록이다:
누가(`by`) 언제(`at`) 어느 opId를 은퇴시켰는지가 저널에 영구히 남는다. 툼스톤은 append-only
파일에 있으므로 이후 삭제 요청으로도 지워지지 않는다 — 삭제는 `JournalEntry`만 대상으로 한다.

- `by`에는 **principal 이름만** 넣는다(`"gui-session"` / `"admin-token"`).
  토큰·세션 ID·경로는 절대 넣지 않는다. `tests/integrations-invariants.test.ts:123-143`이
  저널을 "메타데이터일 뿐 파일 사본이 아님"으로 고정하고, `bun run privacy:scan`이
  자격증명 유출을 막는다.
- 별도 파일을 만들지 않는 이유는 §2.2 표 마지막 행과 같다 — 저장소 루트 엔트리 목록이
  테스트로 고정되어 있다.
- `console.error` 등 stdout 로깅도 추가하지 않는다. 정상 동작이지 실패가 아니다.

### 6.3 동시성

네 가지 경합을 구분해 다룬다.

**(a) 다른 프로세스가 저널에 append 중일 때.**
안전하다. 툼스톤도 append이고, `appendFileSync`는 `O_APPEND`로 열어 쓰므로 줄 단위 추가가
서로를 덮지 않는다 — append-only 설계가 이미 이 경우를 위해 존재한다. 재작성 방식이었다면
여기서 줄이 유실된다. 이것이 §2.2를 채택한 첫 번째 이유다.

**(b) 삭제와 복원이 동시에.**
`restoreIntegrationCoordinated`는 `writer.ts:582`에서 `store.findOperation(input.opId)`로
행을 다시 읽는다. 툼스톤이 먼저 커밋되면 그 조회가 null이 되어 복원은 기존 거절 경로를 탄다.
반대 순서면 복원이 끝난 뒤 삭제된다 — 둘 다 일관된 결과다.
**중요:** 복원이 성공하면 새 `restore` 행이 append되어 그 클라이언트의 최신 행이 바뀐다.
따라서 삭제 대상이 그 사이 최신 행이 될 수 있고, 그때는 409가 정답이다. 핸들러가
`listOperations(clientId, 1)`을 **툼스톤 쓰기 직전에** 다시 읽는 이유가 이것이다.
다이얼로그가 열려 있던 동안의 상태를 신뢰하지 않는다.

**(c) 삭제와 apply/disable 토글이 동시에.**
`runIntegrationMutationFlight`(mutation-flight.ts:27-64)에 **넣지 않는다.**
그 비행은 클라이언트당 하나이며 설정 파일 쓰기를 직렬화하기 위한 것이다.
저널 삭제는 설정 파일을 만지지 않으므로 토글을 막을 이유가 없고, 막으면 사용자가 토글 중에
목록 정리를 못 하게 된다. 대신 (b)의 재조회가 정합성을 책임진다.
**결과적으로 이 라우트는 409 `integration_mutation_busy`를 절대 반환하지 않는다.**

**(d) 스냅샷 삭제와 prune이 동시에.**
`pruneSnapshots`(journal.ts:222-250)를 그대로 재사용하므로 새 경합이 없다.
`rmSync(..., { force: true })`라 이미 사라진 파일은 성공으로 처리된다.
실패하면 `markPruneFailure` → `retentionDegraded`로 사용자에게 드러난다(state.ts:402-413).

---

## 7. 조건 분기 activation 시나리오

이 변경이 추가하는 분기와, 각 분기를 **무엇이 발화시키고 무엇이 관측되는지**.

| # | 분기 | C(호출자)가 어떻게 발화시키는가 | 관측되는 것 |
|---|---|---|---|
| 1 | `isTombstone(parsed)` = true | 저널에 `{"tombstone":"X",...}` 줄이 존재 | `listOperations`가 opId X 행을 반환하지 않음 |
| 2 | `retired.size === 0` 빠른 경로 | 툼스톤이 하나도 없는 기존 저널 | 반환 배열이 필터 전과 동일 — 기존 동작 무변경 |
| 3 | `!opId` → 400 | `DELETE /api/client-integrations/journal` (쿼리 없음) | `{code:"invalid_op_id"}`, 400 |
| 4 | `!operation` → 404 | 없는 opId, 또는 이미 삭제된 opId로 두 번째 DELETE | `{code:"integration_operation_not_found"}`, 404 |
| 5 | `newest?.opId === opId` → 409 | 클라이언트 최신 행 opId로 DELETE | `{code:"integration_journal_newest_protected"}`, 409, 저널에 툼스톤이 **추가되지 않음** |
| 6 | `pruned.ok === false` | 스냅샷 디렉터리를 읽을 수 없게 만든 뒤 DELETE | 200 + `snapshotRemoved:false`, 이후 상태 응답의 `retentionDegraded:true` |
| 7 | `row.deletable === false` | 최신 행 렌더 | 그 행에 삭제 버튼 DOM 없음 |
| 8 | `row.deletable && onDelete` | 과거 행 렌더 + prop 전달 | 삭제 버튼 존재, aria-label에 시각 포함 |
| 9 | `snapshot === "expired"` + `deletable` | 스냅샷 파일 제거 후 목록 조회 | 만료 배지 **와** 삭제 버튼이 함께 존재 — 이 기능의 핵심 가치 |
| 10 | `ConsequenceDialog` catch 경로 | 서버가 409를 반환하도록 최신 행 삭제 시도 | 다이얼로그 유지 + `Notice tone="err"` + 확인 버튼 재활성, 문구가 영어 원문이 아닌 로케일 문구 |

분기 1~6은 §4.11의 새 테스트가, 7~10은 GUI 테스트(`gui/tests/`)가 담당한다.

---

## 8. Accept criteria

전부 관측 가능한 조건으로 쓴다.

1. `bun run typecheck` exit 0.
2. `bun test tests/integrations-journal.test.ts` exit 0 — 툼스톤 append 후
   `listOperations`가 해당 행만 감추고, 나머지 행 순서(newest first)가 보존됨.
3. `bun test tests/management-integration-journal-delete.test.ts` exit 0 — §7 분기 1~6.
4. `bun test tests/management-integration-routes.test.ts` exit 0 — 기존 30개 회귀 없음.
5. `bun test tests/management-route-registry.test.ts` exit 0 — 신규 DELETE가 레지스트리에
   선언되고 exemption `why`가 40자 이상, `ownerDoc`이 실존.
6. `bun test tests/cli-capabilities.test.ts` exit 0 — ratchet이 커지지 않음.
7. `bun test tests/integrations-invariants.test.ts` exit 0 — 저장소 루트가 여전히
   `["journal.jsonl","records.json","snapshots"]`.
8. `cd gui && bun test tests/i18n-locales.test.ts` exit 0 — 9개 로케일 키 집합 일치.
9. `bun run lint:gui` exit 0 — 하드코딩 UI 문자열 규칙(`local-i18n/no-hardcoded-ui-strings`) 통과.
10. `bun run privacy:scan` exit 0 — 툼스톤의 `by`가 자격증명을 담지 않음.
11. 수동: 만료된 롤백 행에 삭제 버튼이 보이고, 최신 행에는 보이지 않는다.
12. 수동: 420px 폭에서 복원·삭제 두 버튼이 겹치지 않는다(§4.6).
13. PR 설명에 GUI 스크린샷 첨부 — `enforce-target`이 gui 언급 PR에 요구한다(AGENTS.md).

---

## 9. Verifier 커맨드 (PLAN-VERIFIER-REAL-01)

아래는 **이 문서를 작성하며 base 2421e44ce에서 실제로 실행한** 결과다.
전부 변경 전 상태이므로 green이며, 구현 후에도 green이어야 한다.
금지된 `bun run test` / bare `bun test`는 사용하지 않았다.

| # | 커맨드 | exit | 실제 결과 | 이 커맨드가 변경 대상을 실제로 읽는가 |
|---|---|---|---|---|
| 1 | `bun test tests/management-integration-routes.test.ts` | 0 | 30 pass / 0 fail, 5.85s | 읽는다 — `integration-routes.ts`의 저널·복원 라우트를 실서버로 호출하고 CSRF 없는 gui-session 변경 거절까지 통과시킨다(§4.3 수정 대상). |
| 2 | `bun test tests/integrations-journal.test.ts` | 0 | 21 pass / 0 fail, 133ms | 읽는다 — `journal.ts`의 append/list/prune을 직접 호출하고, §3.2 근거인 3-트리 kind 유니온 일치를 소스 파싱으로 검사한다(§4.1 수정 대상). |
| 3 | `bun test tests/management-route-registry.test.ts` | 0 | 13 pass / 0 fail, 72ms | 읽는다 — `route-registry.ts`를 import하고 라우트 소스를 스캔해 대조한다. §4.4에서 DELETE를 선언하지 않으면 여기서 실패한다. |
| 4 | `bun test tests/cli-capabilities.test.ts` | 0 | 17 pass / 0 fail, 122ms | 읽는다 — `MANAGEMENT_ROUTES`를 동적 import해 capability/exemption/ratchet 3자를 대조한다. §4.4의 exemption이 없으면 실패한다. |
| 5 | `bun test tests/integrations-invariants.test.ts` | 0 | 40 pass / 0 fail, 250ms | 읽는다 — 저장소 루트 엔트리 목록을 고정해 §2.2의 "사이드카 파일 금지" 결정을 강제한다. |
| 6 | `cd gui && bun test tests/i18n-locales.test.ts` | 0 | 9 pass / 0 fail, 50ms | 읽는다 — `DICTS`와 `en`을 import해 9개 로케일 키 집합 동일성을 검사한다. §4.10에서 로케일 하나라도 빠지면 실패한다. |

아직 실행하지 않은 것(구현 후 최초 실행):

- `bun run typecheck` — 이번 세션 미실행. 변경 전 green을 가정하지 않았다.
- `bun run lint:gui`, `bun run privacy:scan` — 동일.
- `bun test tests/management-integration-journal-delete.test.ts` — §4.11에서 새로 만드는 파일.

**`bun run test` / bare `bun test`는 이 work-phase에서 실행 금지.**
PR-ready 게이트에서만 유지관리자가 돌린다(AGENTS.md "Commands").

---

## 10. 구현 순서

1. §4.1 `journal.ts` (툼스톤 + listOperations) → verifier 2
2. §4.2 `store.ts` 시임
3. §4.3 라우트 + §4.4 레지스트리 → verifier 1, 3, 4
4. §4.11 신규 테스트 → §7 분기 1~6 고정
5. §4.5 GUI API + §4.9 refusal-copy + §4.10 i18n → verifier 6
6. §4.6~4.8 GUI 렌더 → `lint:gui`
7. §8 전체 통과 후 PR (스크린샷 필수, `Closes #3379`는 **쓰지 않는다** — #3379는 셋 중
   하나만 해결되므로 열린 채로 둔다)

---

## 11. 미해결 — 구현자가 결정해야 할 것

1. **`journalDeletePrincipal` 구현** (§4.3). `ManagementContext`에 principal 필드가
   있는지 먼저 확인하고, 없으면 `managementPrincipal()` 호출로 해석할지 `"management"`
   상수로 둘지 선택. 후자를 고르면 감사 가치가 줄어드므로 §6.2에 그 사실을 남길 것.
2. **`ConsequenceDialog`의 에러 포맷터** (§5.2 마지막). `onConfirm`에서 감싸 던지는 쪽을
   권한다 — 다른 다이얼로그 3곳에 영향이 없다.
