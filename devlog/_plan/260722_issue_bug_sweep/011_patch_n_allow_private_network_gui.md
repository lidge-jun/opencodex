# 011 — 패치 계획 N (보안 격리 단위): built-in preset의 allowPrivateNetwork opt-in 노출 (#212)

- 소스 RCA: `003_rca_n_allow_private_network.md` (리뷰어 검증 완료)
- 위험도: **security-sensitive** — SSRF 방어 우회 옵션의 GUI 활성화 표면 확대. 백엔드 능력 추가 없음.
- 선행 조건: 없음 (독립 패치 단위). #175 백엔드(109b7672)는 이미 랜딩.
- **구현 완료 (2026-07-22)**: AddProviderModal.tsx:478 가드 `!isReservedForward` + hint 렌더; provider-payload.ts:53 조건부 포함(불변); tests/provider-payload.test.ts +2 케이스. 보안 불변식(기본 false :54/:147, reserved 제외 :303, metadata 차단 불변) 트리 재확인. 검증: `bun test tests/provider-payload.test.ts` 10 pass, `bun x tsc --noEmit` exit 0. 커밋: WP-impl-2.

## 보안 불변식 (구현·리뷰 필수 체크리스트)

1. 기본값 false 유지 — 초기 custom 폼 `AddProviderModal.tsx:54`, preset 선택 리셋 `:147` 둘 다.
2. benchmark/private 에러 후 자동 활성화 금지 (에러 핸들러가 이 필드를 만지지 않음).
3. reserved forward preset(`openai`) 제외 유지 — canonical seed 강제(`auth-cors.ts:206,238`).
4. metadata 목적지 차단 무영향 (`destination-policy.ts:117,163`).
5. POST payload는 체크 시에만 포함 (`provider-payload.ts:53` 유지).
6. 기존 보안 경고 문구 렌더 (미사용 `modal.allowPrivateNetworkHint` 활성화).

## 파일 변경 맵

| 파일 | 작업 | 내용 |
|------|------|------|
| `gui/src/components/AddProviderModal.tsx` | MODIFY | 렌더 가드 완화 + 힌트 렌더 |
| `tests/` (신규 or 기존 GUI 테스트 파일) | NEW/MODIFY | 가시성 predicate + POST body 회귀 |

## Diff 1 — `AddProviderModal.tsx:478` 가드 완화 + 힌트

Before (현행 실측):

```tsx
                {(isCustom || isLocal) && (
                  <label className="modal-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <input type="checkbox" checked={form?.allowPrivateNetwork ?? false} onChange={e => setForm(f => f ? { ...f, allowPrivateNetwork: e.target.checked } : f)} />
                    <span className="muted text-control">{t("modal.allowPrivateNetwork")}</span>
                  </label>
                )}
```

After:

```tsx
                {!isReservedForward && (
                  <label className="modal-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <input type="checkbox" checked={form?.allowPrivateNetwork ?? false} onChange={e => setForm(f => f ? { ...f, allowPrivateNetwork: e.target.checked } : f)} />
                    <span className="muted text-control">{t("modal.allowPrivateNetwork")}</span>
                  </label>
                )}
                {!isReservedForward && (form?.allowPrivateNetwork ?? false) && (
                  <p className="muted text-hint">{t("modal.allowPrivateNetworkHint")}</p>
                )}
```

참고: `isReservedForward`는 파일 내 기존 정의 사용(`provider-payload.ts:19` 판별과 동일 소스).
i18n 키는 5개 로케일 모두 현존(en.ts:481, ko.ts:443, zh.ts:443, de.ts:426, ru.ts:483) — 추가 번역 작업 없음.

## 테스트 (회귀 커버리지)

- built-in cloud preset(DeepSeek) 선택 시: 체크박스 렌더 + 기본 unchecked.
- 체크 시 `buildProviderPostBody` 결과에 `allowPrivateNetwork: true` 포함, 미체크 시 미포함.
- custom/local preset: 체크박스 유지 (기존 동작 비회귀).
- reserved `openai` preset: 체크박스 미렌더 + canonical payload에 필드 유입 불가.
- preset 전환 시 값이 false로 리셋되는지 (`:147` 경로).
- 힌트 문구가 체크 시 렌더되는지.
- 백엔드 회귀는 기존 `tests/server-auth.test.ts:664,724,754` + `tests/destination-policy-resolved.test.ts` 유지 확인만.

## 수용 기준 / 검증

- [ ] `bun test` GUI/서버 관련 스위트 통과
- [ ] `bun run typecheck` 통과
- [ ] 위 보안 불변식 6항 전부 리뷰 체크
- [ ] fake-IP DNS 시나리오 수동 확인(선택): built-in preset + opt-in 체크 → POST 성공
