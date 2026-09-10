# 020 — wp2: 스타트업 마이그레이션 (`devin-cli` → `devin` 리라이트)

## 포스처

자격 스토어(auth.json)를 건드리므로 `model-rename-startup`의 무(無)백업 포스터가 아니라
**Alibaba/OpenAI-tier의 fail-closed + 백업** 포스터를 따른다
(`src/providers/alibaba-region-startup.ts:12-35`, `alibaba-region-backup.ts`).

## NEW: `src/providers/devin-provider-merge-migration.ts` (가칭)

순수 프로젝션 + 적용 분리:

1. **config.providers 키 이동**: `providers["devin-cli"]` → `providers["devin"]`.
   - 충돌 규칙: `devin` 키가 이미 있으면 Alibaba식 refuse(원본 유지 + 경고)가 기본값.
     양쪽 다 같은 벤더/어댑터지만 계정 슬롯이 다를 수 있어 merge는 금지.
   - `codexAccountNamespaceProviderCollisionError` 가드 동일 적용.
   - 행 내부 `authMode`/`adapter`/`baseUrl`은 기존 `projectDevinCliAuthMode`가 이미 정규화.
2. **cross-config 참조**: `rewriteProviderReferences(config, "devin-cli", "devin")` 재사용.
   - **갭 보강**: `routingProfiles[].candidates[].provider`를 리라이터에 추가
     (`src/types/config.ts:1090-1095`, 검증은 `src/routing/profile.ts:233-245`).
     추가 자체가 별개 동작 변경이므로 rewriter 테스트와 함께.
3. **auth.json 자격 슬롯 rekey**: `store["devin-cli"]` → `store["devin"]`.
   - 신규 store 헬퍼 (예: `rekeyProviderCredentials(from, to)`) — `mutateStore` 기반.
   - 양쪽 슬롯 다 있으면 merge 금지: refuse + 경고 (config 규칙과 일치).
   - orphaned refresh-intent 파일(`store.ts:64-70`)은 무해 — 문서화만.
4. **체인 위치**: auth.json을 쓰므로 별도 스타트업 단계(백업 경계 포함)로:
   `runDevinProviderMergeStartupMigration(...)`을 Alibaba 마이그레이션과 같은 층에 배치
   (`src/server/index.ts:1002` 체인, `reconcileOAuthProviders`보다 앞).

## alias 잔존 처리

- 마이그레이션 후에도 사용자가 `ocx login devin-cli` / config에 수동으로 `devin-cli`를
  쓸 수 있다. 수용 범위:
  - OAUTH_PROVIDERS 얇은 alias def (wp1)
  - `resolveDevinApiServer`/`credentialProviderId` 정규화
  - usage 오버레이 양쪽 유지
- `ocx login devin-cli`는 deprecation 경고를 찍고 `devin`으로 라우트.

## 테스트 (wp2 범위)

- 신규 `tests/providers/devin-provider-merge-migration.test.ts`:
  - providers 키 이동 + 참조 리라이트 + routingProfiles 갭
  - 충돌 시 refuse 정책
  - auth.json rekey (양쪽 슬롯 있는 경우 포함)
  - 멱등성 (두 번 돌려도 no-op)
- `rewriteProviderReferences` 기존 테스트 파일에 routingProfiles 케이스 추가.
- 레이아웃 양쪽 등록.
