# 040 — Composable Logs filters (#3625)

## Loop specification and scope

- Class: C2 product slice, developer-console dashboard, global/i18n, existing dense visual language, feedback-only motion. This file is a docs-only deliverable in the main agent's roadmap P cycle; implementation is a later, separate PABCD work-phase.
- Archetype: spec-satisfaction repair and integration. Trigger: #3625 exposes the already-landed rich Logs predicate through usable controls.
- Goal: combine surface, intercepted-request, provider, exact model, time, speed, status and conversation filters over the loaded log ring, with clear result counts, reset, and accessible keyboard controls.
- Non-goals: new log API parameters, persistence/URL schema, retention/export, incremental polling #3250, request transport changes, provider/model configuration, new dependencies, redesign of the Logs table, unrelated locale cleanup.
- Verifier: current-head hosted CI covering the tests below, GUI lint/build/typecheck, privacy and repository gates; rendered screenshot/interaction evidence from an isolated same-head Vite preview, CI-built artifact or hosted preview. No local tests, suites, typecheck, or build that invokes typecheck. No verification was executed during this planning task.
- Stop: implemented behavior, all acceptance rows, docs sync, fresh screenshots, author credit, current-head CI and main-owned dev ancestry proof. An author comment or green intake check is not completion evidence.
- Outcomes: DONE only with those receipts; NOOP only if current dev independently contains equivalent behavior and evidence; BLOCKED for an unavailable CI/preview/required review; NEEDS_HUMAN for an unresolved external scope decision. Never mark an incomplete slice done.
- Memory artifact: this document plus main-owned 000 roadmap/evidence ledger. No goal or orchestration mutations by this document owner.
- Bounds: this delegate reads local source refs and the supplied metadata and writes only this document; zero paid provider requests, zero local test/build processes, zero Git/GitHub mutation. Implementation inherits main's resource bound and credentials; no separate cost allocation is invented here.
- Escalation: main reclaims a packet after two distinct failed workers. Further implementation delegation is a P amendment with inherited user model settings; no mid-B widening.

## P stale check, provenance and exact source patch

Planning tree: `81871b3fa7034250b8d5ba2cbbfde44e40f0e69c` (read 2026-09-06 KST).
Source ref: `origin/d-source-3625` = `4f79746b4cedffeb61700113977cd72adf25c51f`.
Source base: `be81013fab6d83ff630ca5f38e7881678a303871`.
Metadata: `.tmp/d-delivery/pr-3625.json`; recorded PR author `yansigit`, display name **SB Yoon**. The JSON head agrees with the source ref; its mergeable/readiness fields are a captured snapshot, not fresh merge authorization. Its body still cites `232e324...`; the later author comment cites `4f79746...`. Both test reports are contributor claims, not integration-head proof.

The complete baseline implementation is the exact four-commit sequence below. Read/apply its patch at the later B, then apply the explicit amendments in this document. Do not restore whole historical files over current files.

| Order | Source commit | Authored change |
| --- | --- | --- |
| 1 | `6602c5610c6d7d8a1179b05c9f86598c4acd8fee` | Initial composable controls, state wiring, locales, styles and tests |
| 2 | `e053045e9a2d49b8d70546223b0d02313d4031fe` | Exact identities, option invalidation, relative clock, keyboard navigation and review corrections |
| 3 | `232e324b45afa617ccabb97374137c9faf7654ae` | Turkish copy and assertion refinements |
| 4 | `4f79746b4cedffeb61700113977cd72adf25c51f` | Test-global cleanup in finally |

All four commits identify `SB Yoon <44089734+yansigit@users.noreply.github.com>`.
Preserve authored commits where feasible. A carried/reimplemented or squash commit and its PR description must retain:

```text
Co-authored-by: SB Yoon <44089734+yansigit@users.noreply.github.com>
```

Read-only patch locator (not an instruction to execute tests or mutate Git):

```sh
git diff be81013fab6d83ff630ca5f38e7881678a303871 4f79746b4cedffeb61700113977cd72adf25c51f -- gui
git log --format='%H %an <%ae> %s' be81013fab6d83ff630ca5f38e7881678a303871..4f79746b4cedffeb61700113977cd72adf25c51f
```

Current `Logs.tsx`, `logs-filter.ts`, `logs-auto-refresh.test.tsx`, and `logs-filter.test.ts` have no delta from that source base. All nine locale catalogs and `styles.css` do have intervening dev changes. Recheck these facts at implementation P and rebase the patch semantically against the actual stacked parent. Do not import source-base package versions, lockfiles, locale-wide rewrites or old CSS.

## Exact implementation file map

The immutable range above is the exact before/after source patch for all 17 carried files. “MODIFY” below means apply that path's hunks to the current parent, preserving unrelated edits; “NEW” means take the source blob and the test amendments specified below.

| Path | Operation | Before → after and immutable source locator |
| --- | --- | --- |
| `gui/src/pages/Logs.tsx` | MODIFY | At current lines 376–380 replace five independent states with `filters: LogFilterState` and `filterClockNow`; import `useMemo`, bar and existing engine. Replace line 475's fresh empty array with module-level `EMPTY_LOGS`. Replace lines 502–521 with the source clock/hash/options/predicate block. Replace lines 600–659 toolbar with `LogsFilterBar`; distinguish filtered empty state at line 717; detail conversation action updates the shared state. Exact diff: the range above, this path. |
| `gui/src/pages/logs-filter-bar.tsx` | NEW | Source-head lines 1–127: controlled `LogsFilterBar`, no global store. Native labeled selects, intercepted checkbox, conversation input, active count/reset. Surface radios have roving tabIndex and keydown helper. Speed values map to `[−∞,15)`, `[15,50)`, `[50,+∞)` bounds. |
| `gui/src/pages/logs-surface-keydown.ts` | NEW | Source-head lines 1–24: ordered all/claude/codex/grok; wrapping ArrowLeft/Right/Up/Down, Home/End, preventDefault only for handled keys, select then focus matching radio id. |
| `gui/src/pages/logs-filter.ts` | MODIFY | Current lines 119–126: `value?.includes(modelQuery)` → `value === modelQuery` for requested, resolved and attempted model identities. Keep whitespace/case normalization. Standalone `logs-model-filter.ts` retains substring semantics. |
| `gui/src/styles.css` | MODIFY | Add source two selectors after current `.logs-toolbar` at 2145, then the bounded responsive amendment below. Keep table widths/clipping and all Models rules. |
| `gui/src/i18n/en.ts` | MODIFY | Add source's 20 keys after current `logs.filter.surface.label` at 700; English owns `TKey`. |
| `gui/src/i18n/de.ts` | MODIFY | Same 20 source locale keys after current line 667. |
| `gui/src/i18n/fr.ts` | MODIFY | Same keys after line 681; preserve final number-neutral `Affichage de {count} sur {total}`. |
| `gui/src/i18n/ja.ts` | MODIFY | Same keys after line 643. |
| `gui/src/i18n/ko.ts` | MODIFY | Same keys after line 686; source copy includes `필터 초기화`, `{total}개 중 {count}개 표시`. |
| `gui/src/i18n/ru.ts` | MODIFY | Same keys after line 684. |
| `gui/src/i18n/tr.ts` | MODIFY | Same keys after line 691, final `jeton/sn` speed wording; update `logs.metric.tokPerSecTitle` at 723 to `Tam istek süresince saniye başına çıktı jetonu`. |
| `gui/src/i18n/zh.ts` | MODIFY | Same keys after line 679 (GUI Simplified Chinese). |
| `gui/src/i18n/zh-TW.ts` | MODIFY | Same keys after line 536 (GUI Traditional Chinese). |
| `gui/tests/logs-filter.test.ts` | MODIFY | Source patch lines 49 onward replaces substring expectations with complete identities; adds partial/stale negative cases; preserve status/time/speed/malformed-attempt cases at current 80–143. |
| `gui/tests/logs-auto-refresh.test.tsx` | MODIFY | Source patch confines intercepted-row assertions at 542–570 to `.logs-table tbody`, since select options legitimately retain hidden model names. Add behavioral integration cases below using this file's existing renderer/cache/fake-clock harness. |
| `gui/tests/logs-filter-bar.test.ts` | NEW | Source-head 115-line file as baseline; replace its first three source-string “wiring” checks with observable controls/interaction coverage. Retain and expand the actual keyboard/reset tests, with cleanup on assertion failure. |

New documentation changes beyond the source PR: `structure/05_gui-and-management-api.md`, and all eight existing `docs-site/src/content/docs/{,ko/,fr/,ja/,ru/,tr/,zh-cn/,zh-tw/}guides/web-dashboard.md` paths, specified below. No German dashboard page exists at this head; do not create an unrelated locale tree. No root test-layout manifest change is required for tests under `gui/tests/`; preserve the repository's `tests/` manifests unchanged.

### Existing state and behavior to preserve

- `gui/src/pages/Logs.tsx:463` owns the resource fetch, cache, 2-second poll and backoff. Filters consume this ring; they do not fetch a new dataset. Keep stale/cold/loading states at 482–499 and the table/details transport untouched.
- `Logs.tsx:526` virtualizes `filteredLogs`, rendering newest first by reverse indexing. Retain stable request keys, column schema and detail behavior. Do not sort the input merely for filter selection.
- `logs-filter.ts:95` remains the sole predicate. Model/provider option extraction at 162 includes failover attempts, normalized duplicate handling and stable code-point ordering. Options derive from the full loaded ring, not the filtered subset.
- All filters compose with AND at row level. A requested model and a provider appearing on another attempt can both match that same row; do not silently introduce same-attempt pairing.
- Clock refresh is 30 seconds only while `timeWindow !== 'all'` and tab is Logs. It is independent of auto-refresh, so paused network refresh does not freeze time-relative filtering. Cleanup on window changes, Debug tab and unmount.
- If the loaded ring loses the selected model/provider, clear only each vanished identity; leave status/time/conversation and still-present identities intact. No permanent state persistence is introduced.
- Conversation hashing retains cancellation against obsolete input; reset clears both input and hash. Preserve the existing opaque-id path, and verify delayed hash completion cannot restore a reset filter.

### Responsive CSS amendment (bounded to this toolbar)

The source's two rules alone do not address current `.logs-filter-field .input { min-width:220px; max-width:360px; }` at `styles.css:2174`, or the four 64px-minimum surface buttons. At narrow widths labels plus 220px controls can exceed the content area. Add these rules adjacent to the two source additions; never change global `.select-sm`, `.input` or `.btn`:

```css
.logs-filter-container { min-width: 0; }
.logs-filter-container .logs-filter-field { min-width: 0; max-width: 100%; flex-wrap: wrap; }
.logs-filter-container .logs-filter-field .input { min-width: 0; max-width: 100%; }
.logs-filter-container .logs-filter-status { flex-wrap: wrap; max-width: 100%; }
.logs-filter-container .logs-segmented { max-width: 100%; flex-wrap: wrap; }
```

Keep source `.logs-filter-status` flex alignment/gap/margin-left and `.logs-toolbar-secondary` spacing. Controls may wrap by field and radios may wrap as a group; native select identity remains readable from its option menu. The table keeps its independent horizontal scroller and 1100px minimum width. Browser acceptance, not CSS-string presence, decides containment. If these narrowly scoped rules are insufficient in the measured screenshot, amend only this block and document the measured overflow before the repair.

### Locale and B3659 ownership handshake

D owns the 20 new Logs keys plus Turkish speed-title correction; B3659 owns its Models Hide/Delete/cleanup/sync keys. Exact D key set:

```text
logs.filter.model.all
logs.filter.provider.label / .all
logs.filter.status.label / .all / .success / .errors
logs.filter.time.label / .all / .15m / .1h / .24h
logs.filter.speed.label / .all / .slow / .medium / .fast
logs.filter.reset
logs.filter.showingCount
logs.noMatchingRequests
```

The source range supplies the exact translated values for every key, including both `{count}` and `{total}` placeholders. Retain now-unused `logs.filter.model.placeholder` and conversation-clear keys; deleting them is unrelated churn.

Before B starts, main exchanges the actual B3659 head and changed-key/selector inventory. No B3659 source ref was supplied to this delegate, so no fresh claim of hunk disjointness is made. B confirmed on this run that source #3659 changes nine locale files but no stylesheet, and its implementation has not started. Preserve both lanes by keys; recheck any later B style additions rather than assuming a current stylesheet overlap. B preserves `.logs-*`; D preserves `.models-*` and B's shared control fixes. Shared `.select-sm` or global token changes belong to main's integration review. Re-read the final union after either lower stack layer changes; CI must run against that union. Public dashboard docs can also overlap: D inserts the Logs subsection and preserves B's Models wording.

## Behavioral regression amendments and acceptance

Use existing `gui/tests/logs-auto-refresh.test.tsx:1–164`: Happy DOM, `mountLogs`, virtualizer layout stubs, isolated resource stores, mocked `/api/settings` and `/api/logs`, `act`, fake timers and explicit microtask settlement. All execution is CI-only. Do not add a new test runner or assert only source substrings. Expected row ids/counts must be hardcoded independently of `filterLogs`.

| ID | Reachable activation | Required observable result / owner |
| --- | --- | --- |
| L01 defaults | Mock loaded ring containing Codex, Claude and Grok entries, no filters | All rows remain newest-first; no active count/reset; existing loading/error/detail tests still pass. `logs-auto-refresh.test.tsx`. |
| L02 composition | Rows differ independently in surface, provider, exact model, status and intercepted marker; select controls sequentially | Only the hand-selected intersection row remains; displayed count uses filtered length and unfiltered ring length. Model/provider options still include excluded rows. `logs-auto-refresh.test.tsx`. |
| L03 identities | Include `model-a`, `model-a-plus`, requested/resolved/fallback-only identities and case/space variants | `model-a` does not match `model-a-plus`; full fallback/resolved identity matches; normalized duplicates produce one stable option. Preserve standalone substring helper tests. `logs-filter.test.ts`. |
| L04 status/speed | Include 200, 299, 300, 400, 599 and malformed status; finite rates 14.99, 15, 49.99, 50 plus unavailable | Success only 2xx; errors only 4xx/5xx; slow <15, medium >=15 and <50, fast >=50; unavailable excluded only with speed bound. UI maps every speed option to these bounds. Engine file plus bar rendered events. |
| L05 time expiry | Fake now T; timestamp T−15m+1s; select 15m, disable auto-refresh, retain identical log snapshot | Row initially visible, disappears on first 30s clock tick; fetch count stays unchanged after pause. Repeat predicate boundaries for 1h and 24h with injected clock. No real sleep. `logs-auto-refresh.test.tsx` plus existing engine windows. |
| L06 clock lifecycle | Activate 15m then change 1h, switch Debug, return Logs, finally unmount | Track the 30,000ms interval handle via spies on window setInterval/clearInterval; old handle cleared on each deactivation; one live filter interval after reactivation; none after unmount. Do not count unrelated Happy DOM/virtualizer timers. |
| L07 ring rollover | Select model/provider from snapshot A; refresh with B lacking only selected model, then C lacking selected provider | Missing select resets to All; still-present selection and unrelated status/time/conversation remain. Labels never become blank while a hidden stale value excludes rows. |
| L08 reset/hash | Enter conversation, allow hash resolve; combine with status/time; click reset. Repeat with first hash resolution deferred until after reset | All controls default, full ring visible, count/reset disappear; late old hash does not resurrect filtering. Detail “filter conversation” action updates shared state and closes dialog. |
| L09 empty/error distinction | Cold empty API ring; separately populated ring excluded by status; separately cold failure and stale failed poll | Empty ring shows no-requests, filtered ring shows no-matching, cold failure retains error, stale failure keeps rows/banner. No empty-state flash during refresh. |
| L10 keyboard | Focus selected surface radio; ArrowRight from Grok, ArrowLeft from All, Up/Down, Home/End and unrelated key | Selection and focus wrap correctly; exactly one radio tab stop; unrelated key neither changes selection nor prevents default. Test actual rendered `aria-checked`/tabIndex plus helper; reset remains keyboard reachable. |
| L11 presentation | EN/KO/FR/DE, dark/light, widths 1440/768/390/320; long model and provider labels | Toolbar remains within page; count/reset wrap; focus visible; no clipped functional labels. Table scrolls inside its wrapper, not whole page. Browser receipts below. |

In `logs-filter-bar.test.ts`, replace the source-oracle tests at source-head lines 10–36 with real rendered field/change assertions; move clock behavior proof to L05/L06. Expand reset fixture to several active fields rather than status only. Ensure every root unmounts in `finally` before restoring globals, including the existing rendered-reset test; restore property descriptors where practical. Keep the final source commit's keyboard-test `finally` fix. These changes strengthen observable oracles, not lower coverage to obtain green.

## Documentation exact additions

`docs-site/src/content/docs/guides/web-dashboard.md:87` retains the existing Logs overview row (it remains true); insert a new subsection immediately before `### Linking to a section` at line 92. Add the corresponding localized subsection immediately before the existing translated section-link heading in each of the seven translated guides. The following is the exact new English block:

```md
### Filtering request logs

Logs filters combine surface, intercepted requests, provider, exact model, status, time,
speed, and conversation ID over the currently loaded request ring. Provider and model
choices also include fallback attempts; model matching ignores case and surrounding spaces
but does not match partial names. Choices that disappear from the ring reset to All.

Time windows cover the last 15 minutes, hour, or day and refresh every 30 seconds while the
Logs tab is active, even with auto-refresh off. Speed uses output tokens per second over the
full request duration: below 15, 15 to below 50, or at least 50. Unavailable speed values are
excluded when a speed filter is active. Success means 2xx; errors mean 4xx or 5xx.

Active filters show the matching count out of the loaded total. Reset filters restores all
rows; “No matching requests” differs from an empty log ring. Use arrow keys or Home/End in
the surface selector. These controls do not query historical records beyond the loaded ring.
```

Translations must preserve every threshold, exact-identity rule and loaded-ring scope. Use the following exact localized summary blocks at the same insertion seam; they cover the same contract without rewriting the rest of each page:

| Locale path segment | Heading and paragraph to insert |
| --- | --- |
| `ko/` | `### 요청 로그 필터` — `Logs에서 화면 종류, 가로챈 요청, 공급자, 정확한 모델명, 상태, 시간, 속도, 대화 ID를 함께 필터링합니다. 현재 불러온 로그만 대상이며 공급자·모델 선택지에는 폴백 시도도 포함됩니다. 모델명은 대소문자와 앞뒤 공백을 무시하지만 부분 이름은 일치하지 않습니다. 로그에서 사라진 선택지는 전체로 돌아갑니다. 시간 범위는 최근 15분·1시간·1일이며 Logs 탭에서는 자동 새로고침을 꺼도 30초마다 갱신됩니다. 속도는 전체 요청 시간 기준 초당 출력 토큰으로, 15 미만·15 이상 50 미만·50 이상입니다. 속도 필터를 켜면 측정값 없는 요청은 제외됩니다. 성공은 2xx, 오류는 4xx·5xx입니다. 일치 건수와 불러온 전체 건수를 표시하며 필터 초기화로 모든 행을 복원합니다. 일치하는 요청이 없는 상태와 빈 로그는 구분합니다. 화면 종류 선택은 방향키와 Home/End로 조작할 수 있습니다. 불러온 범위 밖의 과거 로그는 조회하지 않습니다.` |
| `fr/` | `### Filtrer les requêtes` — `Les filtres combinent interface, requêtes interceptées, fournisseur, modèle exact, statut, période, vitesse et identifiant de conversation dans le journal chargé. Les choix incluent les tentatives de repli ; les modèles ignorent la casse et les espaces externes, sans correspondance partielle. Un choix disparu revient à Tous. Les périodes de 15 minutes, une heure et un jour évoluent toutes les 30 secondes dans l’onglet Logs, même sans actualisation automatique. La vitesse mesure les jetons de sortie par seconde sur toute la durée : moins de 15, de 15 à moins de 50, ou au moins 50 ; les valeurs indisponibles sont exclues quand ce filtre est actif. Réussite : 2xx ; erreur : 4xx/5xx. Le compteur compare les résultats au total chargé ; la réinitialisation restaure toutes les lignes. Aucun résultat diffère d’un journal vide. Flèches et Home/End pilotent le sélecteur d’interface. Aucun historique au-delà du journal chargé n’est interrogé.` |
| `ja/` | `### リクエストログの絞り込み` — `Logsではサーフェス、インターセプトされたリクエスト、プロバイダー、完全なモデル名、ステータス、時間、速度、会話IDを組み合わせて、読み込み済みログを絞り込みます。選択肢にはフォールバック試行も含まれます。モデル名は大文字小文字と前後の空白を無視しますが、部分一致ではありません。ログから消えた選択肢は全件に戻ります。時間は直近15分・1時間・1日で、Logsタブでは自動更新をオフにしても30秒ごとに更新します。速度はリクエスト全体の時間あたりの毎秒出力トークン数で、15未満、15以上50未満、50以上です。速度フィルター中は測定不能な行を除外します。成功は2xx、エラーは4xx/5xxです。一致件数と読み込み総数を表示し、リセットで全行を復元します。一致なしと空ログを区別します。サーフェスは矢印キーとHome/Endで操作できます。読み込み範囲外の履歴は検索しません。` |
| `ru/` | `### Фильтрация запросов` — `Фильтры объединяют источник, перехваченные запросы, провайдера, точную модель, статус, время, скорость и ID диалога в загруженном журнале. Варианты включают резервные попытки; модель сравнивается без учёта регистра и крайних пробелов, но не по подстроке. Исчезнувший вариант сбрасывается на все записи. Периоды 15 минут, час и сутки обновляются каждые 30 секунд на вкладке Logs даже при выключенном автообновлении. Скорость — выходные токены в секунду за полную длительность запроса: меньше 15, от 15 до менее 50, не менее 50; недоступные значения исключаются при активном фильтре скорости. Успех — 2xx, ошибки — 4xx/5xx. Счётчик показывает совпадения из загруженного общего числа; сброс возвращает все строки. Нет совпадений и пустой журнал различаются. Источник выбирается стрелками и Home/End. История вне загруженного журнала не запрашивается.` |
| `tr/` | `### İstek günlüklerini filtreleme` — `Filtreler yüklü günlükte yüzey, yakalanan istekler, sağlayıcı, tam model adı, durum, zaman, hız ve konuşma kimliğini birleştirir. Seçenekler yedek denemeleri de içerir; model eşleşmesi büyük/küçük harfi ve dış boşlukları yok sayar, kısmi adları eşleştirmez. Kaybolan seçenek tüm kayıtlara döner. Son 15 dakika, saat ve gün pencereleri Logs sekmesinde otomatik yenileme kapalıyken de 30 saniyede bir güncellenir. Hız, tam istek süresindeki saniyelik çıktı jetonudur: 15 altı, 15 dahil 50 altı, en az 50; hız filtresi açıkken ölçülemeyenler dışlanır. Başarı 2xx, hata 4xx/5xx anlamındadır. Sayaç eşleşen ve yüklü toplam sayıları gösterir; sıfırlama tüm satırları geri getirir. Eşleşme olmaması boş günlükten ayrılır. Yüzey seçimi oklar ve Home/End ile çalışır. Yüklü günlüğün dışındaki geçmiş sorgulanmaz.` |
| `zh-cn/` | `### 筛选请求日志` — `Logs 可组合界面、被拦截请求、提供商、完整模型名、状态、时间、速度和会话 ID，筛选当前已加载的日志。选项包含回退尝试；模型匹配忽略大小写及首尾空格，但不做部分匹配。日志中消失的选项恢复为全部。时间范围为最近 15 分钟、1 小时或 1 天；Logs 标签页每 30 秒更新一次，即使关闭自动刷新也会更新。速度按完整请求耗时计算每秒输出 token，分为小于 15、15 至小于 50、至少 50；启用速度筛选时排除无测量值的请求。成功为 2xx，错误为 4xx/5xx。显示匹配数与已加载总数；重置恢复全部行，并区分无匹配与空日志。界面选择支持方向键及 Home/End，不查询已加载范围之外的历史记录。` |
| `zh-tw/` | `### 篩選請求日誌` — `Logs 可組合介面、被攔截請求、供應商、完整模型名稱、狀態、時間、速度和對話 ID，篩選目前已載入的日誌。選項包含回退嘗試；模型比對忽略大小寫及頭尾空白，但不做部分比對。日誌中消失的選項恢復為全部。時間範圍為最近 15 分鐘、1 小時或 1 天；Logs 分頁每 30 秒更新一次，即使關閉自動重新整理也會更新。速度按完整請求耗時計算每秒輸出 token，分為小於 15、15 至小於 50、至少 50；啟用速度篩選時排除無測量值的請求。成功為 2xx，錯誤為 4xx/5xx。顯示符合數與已載入總數；重設恢復全部列，並區分無符合結果與空日誌。介面選擇支援方向鍵及 Home/End，不查詢已載入範圍以外的歷史記錄。` |

At `structure/05_gui-and-management-api.md:130`, in the Logs & Debug row replace only `Logs tab: request/runtime logs for local diagnosis.` with:

```text
Logs tab: request/runtime logs for local diagnosis. `LogsFilterBar` owns controls over the shared `LogFilterState`; `filterLogs` composes filters over the loaded ring without changing the log API. Provider/model options include attempts, model choices match normalized complete identities, and relative-time filtering refreshes every 30 seconds while the Logs tab is active, independently of network auto-refresh.
```

Keep Debug/API/auth sections and Models content intact. The user guide is the behavior source of truth; the structure row records ownership rather than duplicating every label.

## CI-only verification and screenshot receipt

Commands below are a handoff to hosted CI, not permission to run locally. This roadmap task runs none of them. `gui build` runs `tsc -b`, so it is also prohibited locally.

1. Current `.github/workflows/ci.yml:416–446` runs GUI lint, root typecheck, `cd gui && bun test --isolate tests`, privacy scan and GUI build. Require those steps to execute on the implementation head, plus required repository/platform jobs; an aggregate success with skipped tests is insufficient.
2. Focused CI receipts identify `gui/tests/logs-filter.test.ts`, `gui/tests/logs-filter-bar.test.ts`, `gui/tests/logs-auto-refresh.test.tsx`, `gui/tests/logs-model-filter.test.ts`, `gui/tests/logs-surface-filter.test.ts`, `gui/tests/logs-tab-keydown.test.ts`, and `gui/tests/logs-table-overflow.test.ts`. Full GUI test execution may supply these receipts; avoid redundant unchanged reruns.
3. Verify visible-copy checking in hosted CI: `cd gui && bun run lint:i18n`. This exact script is not a separate step in the inspected CI workflow; main must prove equivalent lint coverage or arrange a hosted run. Do not claim it ran merely because general CI is green.
4. Docs validation is `cd docs-site && bun install --frozen-lockfile && bun run build` on CI, per docs-site instructions. Confirm actual job/step coverage rather than assume a workflow filename. If absent, main arranges a narrowly scoped hosted verifier before readiness.
5. Screenshots come from the final candidate in an isolated Vite dev preview (bundling only; no typecheck/test command), a CI-built artifact, or a hosted preview. Do not use the existing live port 10100 to claim this patch works; that service is not this candidate. Use native in-app browser inspect → act → inspect; do not install Playwright or run any local suite.
6. Use synthetic request metadata in the isolated preview: distinct surface/provider/model/status/rate combinations and opaque conversation ids, no real accounts, secrets or request bodies. Capture 1440×1000 EN/light and KO/dark with combined filters and count/reset, 768×1024 DE, and 390×844 plus 320×800 FR/KO. Include one no-matches state, one empty-ring state and keyboard-focused radio/reset state. The 320px capture must show toolbar containment separately from intended table scrolling.
7. Main stores screenshots under its ignored evidence directory (suggested `.tmp/d-delivery/screenshots/3625/`), with a manifest naming head SHA, preview URL, viewport, locale/theme, scenario, observed result and file. Inspect each actual image. Publish a durable screenshot URL in the integration PR description; the old source PR screenshot is reference only, not final-head proof.
8. For L05/L06 use deterministic CI test output for elapsed-time proof, not a screenshot or timed sleep. For browser flows record console/network state and check filter changes add no new request parameters or extra fetches beyond existing polling.

## Stack, attribution and closure handoff

Main owns branch creation, cherry-pick/reimplementation, commit, `--no-verify` push, PR template, review, merge and closure. This delegate performs none. Place this logical slice after the preceding D stack layer chosen in 000; its GUI/source changes have no semantic dependency on the earlier Cursor/tool-call work, but inherit that parent for stack topology. Re-read the actual parent at P, and cascade lower-layer updates before pushing upper layers.

Merge bottom-up. Before landing, require current-head CI, screenshot URL, contributor trailer and applicable maintainer review. Retarget children before deleting a parent branch. After merge, main fetches dev and proves the integration merge commit is its ancestor. Close original #3625 immediately after that proof if a carry PR superseded it, linking the landing. No issue is linked in the supplied source PR metadata; do not close another D issue or #3659 as a side effect.

## Open gates and document verification

- No blocker to writing this roadmap. Implementation remains pending.
- B3659's actual current changed-key/selector inventory must be checked by main before merging shared files; no coordination message was sent by this delegate.
- Source tests lack behavioral clock/rollover coverage; L05–L08 are required amendments, not verified results.
- Source PR has no docs-site delta; the explicit documentation additions above are required.
- Current integrated CI, hosted preview/screenshots, independent review and final dev ancestry are not yet available from this document's read-only snapshot.
- Author's green local reports and cached readiness state do not satisfy these gates.
- Verification for this docs-only deliverable: inspected the source range, current consumers/styles/test harness and supplied PR JSON; read back this document and checked only its own diff/paths. No production code, peer document, Git state, GitHub state, tests, typecheck, goal or orchestration was changed.

## Roadmap lock clarification

The implementation cycle certifies its current-head published candidate. Final dev-ancestry and original-closeout requirements remain in the separate landing work-phase; lower layers may land early after all gates pass. An isolated Vite preview is permitted for UI evidence; local test/typecheck commands remain forbidden.
