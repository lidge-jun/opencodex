# 020 — WP2: `02_config-and-codex-home.md` + `03_catalog-and-subagents.md`

선행: WP0만. A 감사 R1 블로커 14와 R3 블로커 4에 따라 선행 주장을 모두 철회했다 — 이 phase는
다른 phase의 산출물을 소비하지 않고, 다른 phase도 이 phase를 소비하지 않는다.
용어 일관성은 순서가 아니라 `000_plan.md`의 서술 계약 6항이 담보한다.

## 편집 대상

- MODIFY `structure/02_config-and-codex-home.md`
- MODIFY `structure/03_catalog-and-subagents.md`

## D1. `02` Config injection 절 재작성 (S3 — 최우선)

문서는 주입을 한 가지 형태로 서술하지만 코드에는 두 가지가 있고, **기본 경로가 문서에 없는 쪽**이다.

근거:
- `src/codex/inject.ts:550-565` — `shouldInjectApiAuthHeader(config)`가 참(legacy, non-loopback)일 때만
  `setRootModelProvider` + `buildProviderTableBlock`. 거짓(loopback, 기본)일 때는
  `setRootOpenaiBaseUrl`만 쓰고 Codex의 네이티브 `openai` 프로바이더 id를 그대로 둔다.
- `src/codex/inject.ts:119-134` — 프로바이더 표는 `env_http_headers`로 `x-opencodex-api-key`를 실어야 하는
  경우를 위해 존재한다.
- 코드 주석이 이유를 남겼다: 루프백에서 프로바이더 id를 바꾸면 스레드 히스토리가 재매핑된다.

BEFORE (`:57-79`)
```
`src/codex/inject.ts` inserts root-level keys and an opencodex provider table:

```toml
model_provider = "opencodex"
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"

[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://127.0.0.1:10100/v1"
wire_api = "responses"
requires_openai_auth = true
```

Root TOML keys must be written before the first `[table]`. Re-injection strips stale opencodex
blocks, stale root context-window overrides, and stale opencodex catalog paths before rewriting.
```
AFTER
```
`src/codex/inject.ts` writes one of two forms. The choice is not cosmetic: it decides whether
Codex keeps its native provider id, which decides whether existing thread history still resolves.

**Loopback (default).** A single marker-owned root override, no provider table:

```toml
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
openai_base_url = "http://127.0.0.1:10100/v1"
```

Codex keeps the native `openai` provider id, so new threads stay under that identity instead of
being re-tagged. History that an earlier legacy injection re-tagged as `opencodex` is migrated back
to `openai` once, as restore machinery — a no-op when there is nothing to migrate. A user-owned root
`openai_base_url` is preserved instead of overwritten, and that case also blocks managed sub-agent
defaults rather than fighting the user for ownership.
```

근거: `src/codex/inject.ts:601` — loopback 경로는 `migrateHistoryToOpenai()`를, legacy 경로는
`syncCodexHistoryProvider("opencodex")`를 호출한다. 서술 계약 1항: "never remapped"는
이 마이그레이션이 반례다(A 감사 R2 블로커 4).
```

**API auth header (non-loopback).** The built-in `openai` provider cannot carry the
`x-opencodex-api-key` env header, so this form re-tags the root provider and appends the table:

```toml
model_provider = "opencodex"
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"

[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://<host>:<port>/v1"
wire_api = "responses"
requires_openai_auth = true
env_http_headers = { "x-opencodex-api-key" = "OPENCODEX_API_AUTH_TOKEN" }
```

Root TOML keys must be written before the first `[table]`. Re-injection strips the stale form of
both shapes — opencodex blocks, injected root base-url overrides, stale root context-window
overrides, and stale catalog paths — before rewriting, so switching between forms leaves no residue.
```

`supports_websockets = true` 문장은 프로바이더 표 형태에 붙는 것이므로 위 두 번째 블록 뒤로 옮긴다.

## D2. `02` CODEX_HOME 폴백 (I6)

`:5-16`은 미설정과 무효를 같이 폴백으로 묶는다. 코드는 다르다:
`src/codex/paths.ts:7-23`은 미설정 시 `~/.codex`(+ WSL 탐색), 명시된 읽기 불가/비디렉터리 경로는 throw.

추가할 문장:
```
An unset `CODEX_HOME` falls back to `~/.codex`, including WSL discovery. An explicitly set path
that is unreadable or not a directory is an error, not a fallback: silently using a different home
than the operator named would write provider state where nobody is looking for it.
```

## D3. `02` Config 표면 절 신설 (§C)

`## Config injection` 앞에 새 절 `## Config surface` 삽입:
```
## Config surface

`src/types.ts` is the shape and `src/config.ts` is the loader; neither is reproduced here. What
matters for maintainers is which groups exist and who resolves them:

| Group | Keys | Resolution rule |
| --- | --- | --- |
| Listener | `port`, `hostname` | The listener owns the port; `runtime-port.json` reports where it actually landed. |
| Routing | `defaultProvider`, `providers`, per-provider `selectedModels` | Explicit `provider/model` wins over `defaultProvider`. |
| Catalog | `disabledModels`, `customModels`, `modelCacheTtlMs`, `providerContextCaps`, `contextCapValue` | Catalog state is derived; config only records intent. |
| Transport | stream mode, timeouts, proxy settings, `websockets` | `streamMode` persists in config.json because Windows services do not inherit shell env. |
| Credentials | `apiKeys` | Data-plane only; never admitted to `/api/*`. |
| Lifecycle | `codexAutoStart`, shim/start behavior, resume-history sync, storage cleanup | Startup safety reads these; see `05`. |

Env values are resolved through `src/config.ts`, so a config value naming an env var never persists
the secret itself.
```

## D4. `02` 진단 절 보강 (§C)

Restore 절 뒤에 추가:
```
## Codex-home diagnostics

Two diagnostics report Codex-home conditions opencodex must not silently fix:

- Bundled-plugin marketplace state on Windows (`src/codex/plugins-doctor.ts`), surfaced by
  `ocx doctor`.
- Project-level Codex config that bypasses managed routing
  (`src/codex/project-config-warnings.ts`), surfaced as a warning rather than an override —
  a project file is a deliberate user choice.
```

## D5. `03` 네이티브 passthrough 조건 (I7)

`:30-36`은 네이티브 passthrough가 항상 존재하는 것처럼 읽힌다. 실제 조건은 두 갈래다
(`src/codex/catalog/sync.ts:507-512`): `includeNativeOpenAi = enabledProviders.length === 0 || hasCanonicalOpenai`.
활성 프로바이더가 하나라도 있으면 canonical OpenAI forward 프로바이더가 있어야 하고,
활성 프로바이더가 0이면 부트스트랩을 위해 남긴다(#636 — kimi만 설정한 사용자에게 잘못된 광고를
막으면서도 빈 카탈로그를 만들지 않기 위한 것).

추가할 문장:
```
Native passthrough entries depend on the enabled provider set. With at least one enabled provider,
they appear only while an enabled canonical OpenAI forward provider exists — disabling every such
provider removes the native rows rather than leaving entries that resolve to no credential. With no
enabled provider at all, the native rows remain as bootstrap so a fresh install still has something
to route.
```

API 키 가상 모델 서술은 같은 문장에 섞여 있으므로 별 문단으로 분리한다(문장 이동만, 내용 유지).

## D6. `03` 계정·풀 절 신설 (§D)

`## Subagents` 앞에 새 절:
A 감사 블로커 5 반영: `@main`은 공개 selector가 아니라 config 전용 sentinel이다
(`src/codex/account-namespace-match.ts:3-4`). 메인 계정의 **공개 selector**는
`claimNamespace("main", used)`가 만든 `main`(충돌 시 접미사 변형)이고, 그것이 `@main` 타깃으로
매핑된다(`src/codex/account-namespaces.ts:93`). generation 경합은 항상 재시도가 아니라
`CodexCredentialGenerationConflictError`를 던질 수 있다(`src/codex/account-store.ts:420-423`).

```
## Accounts, namespaces, and pool rotation

Pool mode routes across main plus added Codex credentials. Three rules bound it:

- **A namespace is a public selector mapped to an internal target.** Generated selectors are how a
  caller names an account — the main login's selector is `main` (collision-suffixed if taken),
  which maps to the config-only sentinel `@main`; the sentinel deliberately sits outside the
  pool-account id grammar. Selectors must not collide with provider or combo ids
  (`src/codex/account-namespaces.ts`, `src/codex/account-namespace-match.ts`).
- **Rotation is sticky.** A conversation stays on its selected account while that account is
  usable; failure moves it, success does not (`src/codex/pool-rotation.ts`).
- **The credential store is generation-guarded.** A refresh takes a lock and persists only if the
  generation it started from still holds; a lost race raises a generation-conflict error rather
  than overwriting the newer credential (`src/codex/account-store.ts`). Callers handle that error;
  they do not assume a silent retry.

Warmup issues a bounded request with a fallback model so a cold account reports usability before a
real turn depends on it (`src/codex/warmup.ts`).
```

## D7. `03` 카탈로그 캐시·effort 상한·V2 (§D)

Shared catalog 절 끝에 추가:
```
Backups are per catalog: the pristine copy is keyed by a hash of the catalog path
(`catalog-backup-<id>.json`), and the legacy unsuffixed `catalog-backup.json` is retained in
addition for the default catalog (`src/codex/catalog/parsing.ts`). A restore must therefore resolve
the backup for the catalog it is restoring rather than assuming a single file.
```

근거: `src/codex/catalog/parsing.ts:40` (`catalogBackupPathFor`, sha256 앞 16자),
`:36` (`legacyCatalogBackupPath`), `:427` (`ensureCatalogBackup`).
A 감사 R2 블로커 14: 이 정정이 담당 phase에 없었다.

같은 절에 이어서 추가:
```
Provider live-model lists are cached with a configured TTL and invalidated by provider mutations
(`src/codex/model-cache.ts`); a mutation that changes routing clears the cached list rather than
letting the dashboard show models the provider no longer serves.
```

Ultra reasoning level 절 끝에 추가:
```
`effortCap` and `subagentEffortCap` are hard ceilings applied on the V2 path
(`src/server/effort-policy.ts`); they clamp requests rather than rejecting them.
```

Multi-agent surface mode 절 끝에 추가:
```
The `multi_agent_v2` feature flag and the logical maximum thread count are separate from
`multiAgentMode` (`src/codex/features.ts`): the mode decides which surface Codex advertises, the
flag and thread count decide what the native runtime allows.
```

Subagents 절 끝에 추가:
```
Quota-aware fallback walks a configured chain when the featured model is exhausted, probing
availability on a bounded interval (default 60 s, `src/codex/subagent-model-fallback.ts`). The
chain lowers or preserves the requested effort; it does not raise it.
```

## 검증

```bash
rg -n "shouldInjectApiAuthHeader|setRootOpenaiBaseUrl|buildProviderTableBlock" src/codex/inject.ts
rg -n "x-opencodex-api-key" src/codex/inject.ts
for p in src/codex/plugins-doctor.ts src/codex/project-config-warnings.ts \
         src/codex/account-namespaces.ts src/codex/account-namespace-match.ts \
         src/codex/pool-rotation.ts src/codex/account-store.ts src/codex/warmup.ts \
         src/codex/model-cache.ts src/codex/features.ts src/codex/subagent-model-fallback.ts \
         src/server/effort-policy.ts; do [ -e "$p" ] || echo "MISSING $p"; done
bun x tsc --noEmit && bun test tests/codex-inject*.test.ts && bun run privacy:scan && git diff --check
```

## 수용 기준

- 주입 절이 loopback 기본형과 API-auth-header 형태를 분리해 서술하고, 어느 쪽이 기본인지 명시한다.
- `02`에 config 표면 절이 있고, 열거한 키가 `src/types.ts`에서 확인된다.
- `03`이 네이티브 passthrough의 활성 조건을 명시한다.
- 계정/풀/캐시/effort/V2/폴백 서술이 각각 코드 파일을 지목한다.
- 게이트 통과, 커밋 1개.

## 서술 계약 자기점검

- 절대어: `never persists the secret itself`(근거 `src/config.ts` env 해석), `never admitted to /api/*`
  (근거 `src/server/management-auth.ts:115-119`)만 유지. `never remapped`는 제거했고
  `never silently upgrades effort`는 `lowers or preserves`로 낮췄다(`src/server/effort-policy.ts:142,168`).
- 셋 크기 주장: config 표면 표는 그룹만 나열하고 키 개수를 주장하지 않는다.
- 경로: 완전 경로만 사용.
- 조건: 네이티브 passthrough는 `sync.ts:507-512`의 두 갈래를 그대로 옮겼다.
