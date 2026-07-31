# PR #8 Code Review — Autostart Ensure Fallback

> PR: https://github.com/lidge-jun/opencodex/pull/8
> Author: 이완우 (Ingwannu)
> Reviewed: 2026-06-21
> Status: Draft / +450 -53 / 19 files

## 변경 요약

shim 스크립트의 인라인 bash 로직(30줄+)을 `ocx ensure` 단일 명령어로 통합.
포트 충돌 시 자동 fallback, `codexAutoStart` 대시보드 토글, `ocx uninstall` 일괄 정리 추가.

## 수정 필요 (Must Fix)

### 1. server.ts — 불필요한 dynamic import

`src/server.ts`의 `/api/settings` PUT 핸들러에서 `saveConfig`를 dynamic import로 다시 불러오고 있으나,
파일 상단에 이미 static import 되어 있음.

```typescript
// PR 현재 (line ~654):
const { saveConfig: save } = await import("./config");
save(config);

// 수정안:
saveConfig(config);
```

`saveConfig`는 같은 파일 line 16에서 `import { ..., saveConfig, ... } from "./config"`로 이미 가져옴.
dynamic import는 불필요한 런타임 비용 + 코드 혼동을 유발함.

### 2. handleEnsure — sync 실패 무음 처리

`src/cli.ts`의 `handleEnsure()` 내 두 곳에서 `syncModelsToCodex().catch(() => {})`로
에러를 완전히 삼키고 있음.

```typescript
// line ~388:
await syncModelsToCodex(config.port).catch(() => {});

// line ~406:
await syncModelsToCodex(config.port ?? port).catch(() => {});
```

`ensure`는 "프록시가 준비되었음을 보장"하는 명령어인데, 모델 sync가 실패하면
Codex가 stale 캐시로 동작할 수 있음. 최소한 stderr 경고를 찍어야 디버깅 가능:

```typescript
await syncModelsToCodex(config.port).catch(e => {
  console.error(`⚠️  Model sync skipped: ${e instanceof Error ? e.message : String(e)}`);
});
```

## 개선 권장 (Should Fix)

### 3. Dashboard 토글 실패 시 에러 미표시

`gui/src/pages/Dashboard.tsx`의 `toggleCodexAutoStart` catch 블록에서
토글을 조용히 원복만 하고 사용자에게 에러를 알리지 않음.

```typescript
} catch {
  setSettings(prev => prev ? { ...prev, codexAutoStart: !next } : prev);
  // ← 에러 toast나 상태 표시 없음
}
```

네트워크 오류나 서버 다운 시 사용자는 토글이 왜 안 먹히는지 알 수 없음.

### 4. uninstall/startup-prompt 테스트가 소스 문자열 매칭

`tests/uninstall.test.ts`와 `tests/startup-prompt.test.ts`의 일부 테스트가
소스 파일을 텍스트로 읽어서 함수명/문자열 포함 여부만 확인:

```typescript
expect(cli).toContain("async function handleUninstall()");
expect(cli).toContain("uninstallServiceIfInstalled");
```

리팩토링(함수명 변경, 추출)하면 기능은 그대로인데 테스트가 깨짐.
`ports.test.ts`처럼 실제 동작을 테스트하는 방식이 더 견고함.

## 참고 (Note)

### 5. 포트 선점 경쟁 조건 (TOCTOU)

`src/ports.ts`의 `findAvailablePort`가 포트를 확인한 뒤 서버를 닫고 포트 번호를 반환.
`startServer()`가 실제로 bind하기 전에 다른 프로세스가 끼어들 수 있음.
이는 포트 검사의 본질적 한계이므로 blocking은 아니나,
`startServer` 내부에서 `EADDRINUSE` 발생 시 재시도 로직이 있으면 더 안전함.

## 긍정 포인트

- shim 스크립트 간소화가 핵심 성과 — bash/batch 30줄 → `ensure` 1줄
- 죽은 PID 감지 후 자동 정리 (기존: 에러 내고 종료)
- `waitForProxy`가 매 루프마다 config를 다시 읽어서 자식 프로세스의 포트 변경 반영
- `uninstallServiceIfInstalled` — 서비스 없어도 process.exit 안 하는 quiet helper
- i18n 3개 언어(en/ko/zh) 모두 업데이트
- `codexAutoStart` 기본값 `!== false`로 안전한 opt-out 패턴
