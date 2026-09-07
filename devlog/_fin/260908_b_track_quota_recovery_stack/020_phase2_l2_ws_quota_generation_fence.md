# 020_phase2_l2_ws_quota_generation_fence.md — L2 (#3934) tip 레이어

## 목적
pool 자격증명이 교체된 뒤 이전 WebSocket 연결에서 늦게 도착한 quota 프레임이,
새 자격증명을 위해 비워둔 quota 상태를 되살리지 못하게 막는다.

## 브랜치
`codex/b-stack-l2-ws-quota-generation`, base = `codex/b-stack-l1-continuation-recovery` (L1 위에 쌓음).
이 브랜치가 스택의 tip이며, **PR은 여기에만 연다.**

## 커밋 계약
```
git cherry-pick -x e5c01f44e9736baba5b3a993c7f489f6b60d5ddd
```
원저자 luvs01 <luvs01@hanmail.net> 보존 + `Co-authored-by: luvs01 <luvs01@hanmail.net>` 트레일러.

## 정확한 변경 (before → after)
`src/server/responses/core.ts` 약 1004행:

```diff
+import { isCodexAccountGenerationLive } from "../../codex/account-store";

 function codexWsQuotaObserver(authCtx, provider): CodexWsQuotaObserver | undefined {
   if (!isCanonicalOpenAiForwardProvider(provider) || !usesCodexForwardPoolAuth(authCtx, provider)) return undefined;
   const { accountId, writerGeneration } = authCtx;
+  const credentialGeneration = authCtx.kind === "pool" ? authCtx.generation : undefined;
   const mainWriter = authCtx.kind === "main-pool" ? authCtx.mainQuotaWriter : undefined;
-  return headers => applyCapturedCodexQuota(accountId, headers, writerGeneration, mainWriter);
+  return headers => {
+    if (credentialGeneration !== undefined && !isCodexAccountGenerationLive(accountId, credentialGeneration)) return;
+    applyCapturedCodexQuota(accountId, headers, writerGeneration, mainWriter);
+  };
 }
```

`credentialGeneration === undefined`면 기존 동작을 그대로 유지한다(main-pool·비pool 경로 무변경).

테스트: `tests/responses/responses-account-label.test.ts`
- quota 10 전달 → 자격증명 교체 → quota clear → 옛 연결에서 quota 100 전달 → 최종 상태가 null인지 확인.

## L1과의 관계
같은 파일이지만 서로 다른 함수(약 2600줄 간격)라 텍스트 충돌이 없다.
체인 순서는 리뷰 단위를 나누기 위한 것이며, L2 diff는 이 변경만 보여준다.

## CI 계약
`.github/workflows/ci.yml`의 `on.pull_request`는 base 필터가 없어 PR 생성 즉시 CI가 붙는다.
따라서 L1에는 PR을 열지 않고, tip인 L2에만 PR을 연다 → CI run 정확히 1개.
`changes` 필터가 `src/**`, `tests/**`, `docs-site` 외 경로를 보므로 이 변경 세트는 `ci=true`가 되어
4개 Linux shard, Windows, macOS lane, gates가 모두 돈다.

## 머지 후 처리
- tip PR 머지 → `git merge-base --is-ancestor`로 dev 조상 확인
- #3889, #3934: 내용이 dev에 들어갔으므로 원저자 크레딧을 명시하며 닫는다
- 연결 이슈: dev 머지 시점에 닫는다 (PR base가 dev라 GitHub 자동 종료가 안 됨 — AGENTS.md 명시)
