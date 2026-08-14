# 003 — Large PR Split Decisions

## #1412: responses replay history compounding

### 문제

full-history를 다시 보내는 stateless provider 요청에 저장된 history를
또 prepend하면서 1x -> 2x -> 3x로 커지는 메모리/context 문제.
하지만 현재 PR에 4가지가 한꺼번에 들어 있다:

- previous-response overlap dedupe
- model-aware context admission
- 413 정책
- deep JSON/input hardening + bridge/image-video 변경 + 문서

### 분할 계획

1. fix/responses-replay-overlap (최우선)
   - 실제 sticky memory growth를 가장 빠르게 줄이는 최소 diff
   - history append 시 overlap 감지 + dedupe만 포함
   
2. fix/responses-context-admission
   - model-aware context window admission guard
   - 413 정책 통합

3. fix/responses-deep-input-followups
   - deep JSON/input hardening
   - bridge/image-video 관련 변경
   - 광범위 문서 변경

### 실행 방법

기존 branch를 통째로 merge하지 않는다.
commit 또는 patch 단위로 새 branch를 만든다.

## #1623: routed apply_patch contracts

### 문제

adapter registry authority, factory rewiring, Azure/MiMo injection,
conformance harness, apply_patch behavior hardening이 한 PR에 섞여 있다.

### 분할 계획

1. refactor/adapter-registry-authority
   - behavior 변화 없는 registry/factory authority 정리
   
2. test/adapter-conformance-harness
   - registry-derived generic conformance
   
3. fix/apply-patch-production-hardening
   - 실제 apply_patch production hardening

### 주의

Cursor structured-edit 세부 동작은 #1634와 분리해야 한다.

## #1634: structured-edit apply_patch conversion

### 문제

grammar normalization, sequential multi_edit, indentation repair,
add/delete mapping, recoverable rejection이 한 PR에 섞여 있다.
#1388의 host-owned exact-match 및 mid-turn drift 문제는 남는다.

### 분할 계획

1. fix/cursor-envelope-path-normalization
   - envelope/path normalization만

2. fix/cursor-sequential-edit-folding
   - sequential edit folding

3. fix/cursor-recoverable-converter-rejection
   - recoverable converter rejection

### 주의

이 PR이 병합돼도 #1388을 닫아서는 안 된다.
stale context, already-applied, ambiguous old_string, nearest-match diagnostics는
#1388에서 계속 처리한다.

## #1609: preserved rollback snapshots

### 문제

branch 전체를 무작정 리베이스하면 안 된다.
이전 #1605 병합 당시 포함되지 않은 security commit이 있다.

### 실행 방법

#1605 merge commit의 ancestry와 branch 후속 security commit을 비교한다.
이미 dev에 있는 코드는 제외하고 다음 불변식만 남긴다:

- replacement B 생존
- preserved copy 검증 후 source claim
- claimed read/harden/restore 실패 시 secret-bearing path 보존
- residual-secret 오류의 정확한 분류

cherry-pick으로 최소 누락 commit만 가져온다.
