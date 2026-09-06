# Claude compatibility carry

Depends on roadmap and an independent source/security audit. Class C3 with C4 review of admission and persisted diagnostics. Public source is PR #3730 at 18d64748ade8001e05327726b2ae4b22e8393418.

## Published scope and file map

- NEW src/claude/compatibility.ts: opt-in analysis for translated Messages; no Lab imports, source envelope, credential access or adapter execution.
- MODIFY src/server/claude-messages.ts: gate translated requests after real native passthrough returns and before inference. Preserve existing auth/origin and logging ownership.
- MODIFY src/types/config.ts: compatibility mode property.
- MODIFY src/server/request-log.ts and src/usage/log.ts: bounded optional metadata, persisted-row normalization and hydration.
- NEW tests/claude-integration/claude-compatibility.test.ts and MODIFY existing endpoint/usage tests; register new filename in both test-layout inventories.
- MODIFY server configuration reference and Claude guide only where current scope needs clarification.

The source PR needs substantial classifier corrections before adoption. Detailed security-sensitive findings, official feature matrix, exact corrections and review evidence are held in task scratch space. The parent accepts a uniform conservative translated-path contract; no per-adapter exemption based on preliminary routing. Existing unset/native behavior remains unchanged. Shadow is observational and enforce is endpoint compatibility admission, not a global security boundary.

## Field chain and acceptance

Mode: typed config -> persisted JSON -> existing loader -> translated Messages gate. Present invalid mode must produce a fixed visible configuration failure rather than silently disable checking. No global config fallback change.
Evidence: gate -> request context -> ring -> usage row -> normalized disk row -> hydration. Only closed protocol codes may be stored; no body/header/credential/signature material. Old rows remain valid.

Test unset/shadow/enforce/invalid modes, real native bypass versus translated Anthropic, zero-inference rejected requests, normal tools versus hosted feature declarations, nested supported content positions, large headers, persistence and reload. Exact behavior follows the private reviewed feature matrix. No local test/typecheck/build/install; final remote CI and explicit independent security review required.

Co-authored-by: SB Yoon <44089734+yansigit@users.noreply.github.com>
