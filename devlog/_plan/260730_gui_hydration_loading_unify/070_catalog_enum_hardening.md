# 070_catalog_enum_hardening — WP8 카탈로그 enum 경계 완결 (#759)

작성 2026-07-31. WP3 도중 발생한 실제 사고에서 나온 유닛이므로, 로드맵 사이클에 없던 문서를
여기서 append한다(LOOP-UNIT-CHAIN-01). 이슈: https://github.com/lidge-jun/opencodex/issues/759

## 사고 재구성

로컬 symlink 본이 `~/.codex/opencodex-catalog.json`을 쓰면서 `zenmux/meta-muse-spark-1.1`에
`input_modalities: [..., "video"]`를 넣었다. Codex는 이 필드를 `text|image|audio` **닫힌 enum**으로
파싱하므로 파일 하나를 통째로 거부했다.

```
failed to reload config: failed to parse model_catalog_json path
`/Users/…/.codex/opencodex-catalog.json` as JSON:
unknown variant `video`, expected one of `text`, `image`, `audio` at line 2013 column 15
```

결과는 모델 하나의 메타데이터 때문에 **플러그인·앱·MCP가 전부 0개**가 되는 것이었다. Codex 앱은
"Unable to load apps"만 보여주고 원인이 opencodex의 카탈로그라는 단서를 주지 않는다.

이미 착지한 수정(WP3 커밋에 포함):

- `provider-fetch.ts`의 프로바이더 메타데이터 필터에서 `"video"` 제거.
- `parsing.ts`의 `ensureStrictCatalogFields`에서 enum 정규화. 살아남는 값이 없으면 `["text"]`로
  떨어뜨린다 — modality가 아예 없는 엔트리는 text-only보다 나쁘다.
- `tests/catalog-input-modality-enum.test.ts` 5건.

내부적으로 `"video"`는 정당하다. xAI 비디오 브리지(`images.videoBridgeEnabled`)와 vision-sidecar
modality 배관이 비디오를 다루므로 `catalog-vision-sidecar-modalities.test.ts`(12건)의 내부 추론은
건드리지 않는다. 결함은 그 값이 **Codex가 읽는 파일로 새어 나가는 것**뿐이다.

## 이 WP에서 확인한 잔여 구멍

`ensureStrictCatalogFields`는 정규화 지점으로서 맞다. `sync.ts`의 엔트리 생성 경로 4곳
(152, 222, 244, 455)이 모두 이 함수를 통과한다. 그런데 **디스크 쓰기 경로는 그보다 많다.**

| 쓰기 지점 | 정규화 통과? | 판정 |
|---|---|---|
| `sync.ts:540` 정상 sync | 예 (엔트리가 4곳 중 하나를 거침) | 안전 |
| `sync.ts:559` `restoreCodexCatalog` 백업 복원 | **아니오** | **구멍** |
| `sync.ts:567` `restoreCodexCatalog` 네이티브만 남기기 | **아니오** | **구멍** |
| `parsing.ts` 백업 기록 | 아니오 (원본 보존이 목적) | 의도됨 |
| `bundled.ts` 번들 카탈로그 기록 | 확인 필요 | 조사 대상 |

`restoreCodexCatalog`가 특히 나쁘다. 백업에서 복원하는 경로인데
[sync.ts:555-559](/Users/jun/Developer/new/700_projects/opencodex/src/codex/catalog/sync.ts:555)가
`backup.models`와 기존 사용자 네이티브 엔트리를 **그대로 디스크에 쓴다**. 사고 당시의 카탈로그가
백업으로 남아 있었다면, 복원 명령이 오염된 값을 그대로 다시 써서 Codex를 또 죽인다. 즉 사용자가
문제를 고치려고 실행할 가장 자연스러운 명령이 문제를 재생산한다.

## 범위

**IN**

1. 디스크로 나가는 모든 카탈로그 쓰기 경로가 enum 정규화를 통과하게 한다. 특히
   `restoreCodexCatalog`의 두 경로.
2. Codex가 enum으로 읽는 **다른 필드**를 전수 확인한다(P에서 완료, 아래 결과).
3. 오염된 카탈로그를 읽을 때 전체 거부가 아니라 제자리 복구를 시도한다(읽기 측 방어).
4. 위 각각에 대한 회귀 테스트.

**OUT**

- 내부 비디오 브리지 로직(`images.*`, `xai-video-client`)과 vision-sidecar modality 추론.
- 카탈로그 스키마 재설계, 새 필드 추가.
- GUI 변경. 이 유닛은 `src/codex/catalog/`와 `tests/`만 만진다.
- npm publish / 릴리스.

## 병행 세션 주의

## 다른 enum 필드 조사 결과 (P에서 완료)

`ensureStrictCatalogFields`가 기본값을 채우는 enum 모양 문자열 필드는 네 개다:
`default_reasoning_summary`("none"), `default_verbosity`("low"), `apply_patch_tool_type`("freeform"),
`truncation_policy.mode`("tokens"). 전부 **프로바이더 데이터가 도달하지 않는다** — `src/` 전체에서
`parsing.ts` 밖의 쓰기 지점이 없고, 값은 코드에 하드코딩된 유효값뿐이다.

업스트림 스냅샷(`src/codex/data/upstream-models.json`)의 `input_modalities`도 `image`, `text`뿐이라
오염원이 아니다.

따라서 "다음 프로바이더가 다른 필드로 같은 사고를 낸다"는 우려는 현재 코드에서 근거가 없다.
`input_modalities`가 유일하게 프로바이더 문자열을 그대로 실어 나르는 enum 필드다. WP8은 그래서
**필드 전수 검사가 아니라 쓰기 경로 봉합**으로 좁힌다. 새 프로바이더 메타데이터 필드를 추가할 때
이 검사를 다시 하도록 문서에 남기는 것으로 대신한다.

다른 세션이 지금 `src/codex/catalog/parsing.ts`의 `applyMultiAgentMode`와 `sync.ts`를 커밋하지 않은
상태로 수정 중이다(multi-agent v2 pinning). 같은 파일이지만 **다른 함수**다. 스테이징을 파일 단위로
쪼개서 내 hunk만 커밋하고, 그쪽 변경은 워크트리에 그대로 남긴다.

## 감사 반영 (A, 2026-07-31) — blocker 3건, 내 주장 하나는 반박됨

리뷰어가 FAIL을 냈다. **첫 번째는 내가 틀렸다.** 소스에서 전부 확인했고 아래가 정본이다.

### B1 — restore가 이 사고를 재생산한다는 내 주장은 거짓이다

`writePristineCatalogBackup`은 **routed 엔트리가 있는 카탈로그를 백업하지 않는다**
([parsing.ts:428-437](/Users/jun/Developer/new/700_projects/opencodex/src/codex/catalog/parsing.ts:428),
`catalogHasRoutedEntries`는 slug에 `/`가 있는지로 판정). `zenmux/meta-muse-spark-1.1`은 routed
슬러그이므로 오염된 행은 새 백업에 애초에 담기지 않는다. 즉 "복원 명령이 오염을 다시 쓴다"는
시나리오는 이 사고에서 **발생할 수 없다**.

수정: restore 하드닝을 이 프로바이더 사고의 복구 경로로 팔지 않는다. 남는 정당한 근거는
**이미 존재하던/외부에서 온 백업**과 **사용자 native 추가 엔트리**가 유효하지 않을 수 있다는
것뿐이고, 그건 별개의 약한 동기다. 대신 실제 시퀀스를 테스트로 고정한다: 오염된 routed 카탈로그
→ `syncCatalogModels()` → 정리된 출력.

### B2 — 읽기 측 제자리 복구를 `readCatalog`에 넣으면 안 된다

`readCatalog`는 pristine 백업과 `models_cache.json`도 읽는다
([parsing.ts:186](/Users/jun/Developer/new/700_projects/opencodex/src/codex/catalog/parsing.ts:186)).
거기에 쓰기를 넣으면 **들여다보기만 해도 복구 증거와 사용자 파일이 변형된다.** 게다가 어떤
opencodex 명령이 돌기 전까지는 Codex 앱을 고쳐주지도 못한다.

수정: 범용 읽기 경로의 변형은 **취소**한다. sync merge가 이미 나가는 엔트리를 전부 정규화하므로
([sync.ts:451](/Users/jun/Developer/new/700_projects/opencodex/src/codex/catalog/sync.ts:451))
`ocx sync`가 명시적 복구 경로다. 필요하면 `readCodexCatalogPath()`만 대상으로 하는 별도 이름의
명령 호출형 복구 함수를 두지, 읽기에 숨기지 않는다.

### B3 — enum 전수 조사가 불완전했다. 그래서 "모든 쓰기 정규화" 약속은 위험하다

내가 놓친 닫힌 enum이 더 있다: `visibility`(`hide`/`list`), `shell_type`(`shell_command`),
`web_search_tool_type`(`text`/`text_and_image`). 기존 헬퍼는 네 필드를 **비문자열일 때만** 기본값으로
채우고, **유효하지 않은 문자열은 검증하지 않는다.**

더 중요한 함정: `truncation_policy.mode`는 업스트림 스냅샷에 **`bytes`와 `tokens` 둘 다** 정당하게
존재한다([upstream-models.json](/Users/jun/Developer/new/700_projects/opencodex/src/codex/data/upstream-models.json:15)).
`"tokens"`로 하드코딩하는 sanitizer는 유효한 엔트리를 **손상시킨다**.

수정: 두 선택지 중 전자를 택한다 — **WP8을 프로바이더 유래 `input_modalities`로 좁히고**, 읽기·복원
전역 정규화를 범위에서 뺀다. 버전 인식 스키마 sanitizer는 이 유닛의 크기가 아니고, 잘못 만들면
정당한 값을 깨뜨린다.

### 비차단

- `preserveExactInputModalities`는 우회로가 아니다. 배열 누락 기본값만 억제하고 enum 필터는 그대로
  통과한다. 기존 테스트가 이미 증명한다.
- 복원 시 `ensureStrictCatalogFields`를 통째로 돌리면 안 된다. 기본값을 추가해서
  `codex-catalog-restore.test.ts:92`의 의도적 exact-restore 단정을 깨뜨린다.
- 쓰기 인벤토리에 `models_cache.json`([sync.ts:584](/Users/jun/Developer/new/700_projects/opencodex/src/codex/catalog/sync.ts:584))이 빠졌다.
- `bundled.ts`는 소스가 `codex debug models --bundled`이고 프로바이더 메타데이터가 아니며, 이후 정상
  sync가 정규화한다. **신뢰 가능한 런타임 산출물로 분류**하고 "조사 대상"에서 뺀다.

## 수정된 WP8 범위

1. 프로바이더 유래 `input_modalities`만 다룬다. 착지한 두 수정(필터 + `ensureStrictCatalogFields`
   정규화)이 이 경로를 이미 봉합한다.
2. 실제 사고 시퀀스를 회귀 테스트로 고정한다: 오염된 routed 카탈로그 → `syncCatalogModels()` →
   출력에 enum 밖 값 없음. 이것이 이 WP의 실질 산출물이다.
3. 읽기 측 자동 복구, 복원 경로 전역 정규화, 버전 인식 sanitizer는 **범위에서 제외**. 근거를
   문서에 남겨 다음 사람이 같은 유혹에 빠지지 않게 한다.
4. 새 프로바이더 메타데이터 필드를 추가할 때 닫힌 enum 여부를 확인하라는 지침을 남긴다.

### 감사 2라운드 (blockers=0)

테스트 전용 유닛으로 정당하다는 확인을 받았다. NOOP이 아니다 — 착지한 테스트는 **엔트리 생성
시점의 필터링**을 증명하지만, **디스크에 이미 존재하는 오염된 routed 행이 sync를 거쳐 정규화되는지**는
증명하지 않는다. 별개의 계약이다.

**테스트가 반드시 잡아야 하는 것: 모델이 살아남아야 한다.** "출력에 enum 밖 값이 없다"만 단정하면,
미래의 sync가 오염된 행을 정규화하는 대신 **버려도** 테스트가 통과한다. 프로바이더 모델이 조용히
사라지는 것을 성공으로 읽는 셈이다. 그래서 단정을 이렇게 쓴다:

1. `zenmux/meta-muse-spark-1.1`을 `["text", "image", "video"]`로 심는다.
2. sync 실행.
3. **같은 슬러그가 여전히 존재하고**, 그 modalities가 정확히 `["text", "image"]`다.

하네스는 `tests/codex-catalog-restore.test.ts:18`의 `runScript`가 가장 가깝다. `CODEX_HOME`과
`OPENCODEX_HOME`을 모두 격리하고, 125·155행의 sync 케이스가 이미 실제 `syncCatalogModels()`를
쓰기 가능한 카탈로그에 대해 호출한다. 프로바이더가 없으면 sync는 stale routed 행을 의도적으로
보존하고([sync.ts:418](/Users/jun/Developer/new/700_projects/opencodex/src/codex/catalog/sync.ts:418))
451행에서 정규화한다 — 이 조합이 정확히 테스트하려는 경로다.

읽기 자동 복구를 뺀 것도 옳다는 확인을 받았다. 정직한 최소 복구 수단은 기존 `ocx sync`이고, 파싱은
되는 오염 JSON을 Codex 시작과 무관하게 고칠 수 있다. 다만 **발견성이 약하다** — Codex 오류 메시지가
그 명령을 알려주지 않는다. 그건 별도의 CLI/문서 진단 결정이고 이 유닛에서 숨은 변형으로 풀 문제가
아니다. 후속 항목으로 남긴다.
