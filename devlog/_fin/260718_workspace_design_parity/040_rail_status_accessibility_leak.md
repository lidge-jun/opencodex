# Phase 040 — Rail 상태 텍스트 시각 누출 수정

## Loop spec

- Archetype: spec-satisfaction repair
- Trigger: 프로바이더 Rail의 상태 점 옆에 `Ready`가 큰 텍스트로 반복 노출됨
- Goal: 상태 점만 시각적으로 남기고, 상태명은 Rail 버튼의 접근성 이름에서 계속 제공
- Non-goals: Rail 정보 구조 재설계, 상태 색상/문구 변경, 백엔드 수정
- Verifier: GUI typecheck/build + 프록시 워크스페이스의 agbrowse 스크린샷
- Stop condition: 모든 Rail 행에서 `Ready` 텍스트가 사라지고 상태 점/chevron/기본 별은 정상 유지
- Memory artifact: 이 문서와 C-phase 스크린샷
- Terminal outcomes: DONE / BLOCKED / NEEDS_HUMAN

## 원인

`ProviderRail.tsx`는 상태 점 안에 `<span className="sr-only">{status}</span>`을 넣지만,
프로젝트에 `.sr-only` 유틸리티 정의가 없다. 따라서 접근성 전용 문구가 일반 텍스트로 렌더링된다.

Rail 버튼 자체는 이미 `pws.rail.selectAria`로 provider name, status, suffix를 모두 제공하므로
상태 점 내부 텍스트는 중복이다.

## Diff plan

### MODIFY `gui/src/components/provider-workspace/ProviderRail.tsx`

```diff
- <span className={railStatusCls(item)} title={status}>
-   <span className="sr-only">{status}</span>
- </span>
+ <span className={railStatusCls(item)} title={status} aria-hidden="true" />
```

## Acceptance criteria

- Rail 버튼의 `aria-label`에는 상태명이 계속 포함된다.
- 상태 점은 시각적으로 유지된다.
- `Ready` / `Needs setup` / `Disabled` 텍스트가 Rail 안에 별도 노출되지 않는다.
- `bunx tsc -b --noEmit` 및 `bun run build`가 exit 0이다.
- agbrowse 스크린샷에서 상태 점, 기본 별, chevron 배치가 정상이다.

## Verification evidence

- `bunx tsc -b --noEmit` — exit 0
- `bunx eslint src/components/provider-workspace/ProviderRail.tsx` — exit 0
- `bun run build` — exit 0, Vite 67 modules transformed
- agbrowse: `/Users/jun/.browser-agent/screenshots/screenshot_1784337650464.png`
  - 모델 수 로드 후에도 `Ready` 텍스트가 별도 노출되지 않음
  - 상태 점, 기본 provider 별, chevron 유지
  - 접근성 스냅샷은 `Select <provider> — Ready`를 계속 제공
