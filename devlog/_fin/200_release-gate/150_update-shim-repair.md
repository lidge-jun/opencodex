# 150 — ocx update 후 Windows shim repair 호출 (Medium)

## 문제

`ocx update`(`runUpdate()`)는 npm/bun으로 패키지를 업데이트한 뒤 끝남.
Windows에서 npm global install은 `codex.cmd` shim을 재생성할 수 있으며, 이 경우 opencodex가 설치한 wrapper shim이 덮어씌워짐.

Phase 190에서 exe 재등장 감지 로직은 구현됐지만, `ocx update` 후 자동으로 shim repair를 호출하는 hook이 없음.

## 수정

### MODIFY `src/update.ts` — update 성공 후 shim repair 호출

```diff
  if (r.status === 0) {
-   console.log(`\n✅ Updated${latest ? ` to v${latest}` : ""}. Restart the proxy:  ocx stop && ocx start`);
+   console.log(`\n✅ Updated${latest ? ` to v${latest}` : ""}.`);
+   // On Windows, the update may overwrite our Codex wrapper shim. Repair it.
+   if (process.platform === "win32") {
+     try {
+       const { ensureCodexShim } = await import("./codex-shim");
+       ensureCodexShim();
+       console.log("🔧 Codex shim verified.");
+     } catch (e) {
+       console.warn(`⚠️  Shim repair skipped: ${e instanceof Error ? e.message : e}`);
+     }
+   }
+   console.log("Restart the proxy:  ocx stop && ocx start");
  }
```

### 설계 결정

- Windows에서만 실행 (`process.platform === "win32"`)
- `ensureCodexShim()`은 이미 존재하는 함수 — shim이 정상이면 no-op
- 실패해도 update 자체는 성공으로 처리 (warn만 출력)
- rollback 메커니즘은 이 패치 범위 밖 — 향후 별도 phase로

## 검증

1. Windows에서 `ocx update` 후 `ensureCodexShim()` 호출 확인
2. macOS/Linux에서 shim repair 스킵 확인
3. shim 함수 import 실패 시 graceful warn 확인
