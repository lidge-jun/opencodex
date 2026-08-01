# 001 -- Cursor header hardening implementation

## Commit
3e243c1 on dev, pushed to origin/dev

## Changes
- live-transport.ts: added `sessionId` field (crypto.randomUUID at construction),
  `x-session-id` header in HTTP/2 run requests
- live-models.ts: added `x-session-id` header (per-call UUID) in discovery requests
- protobuf-request.ts: imported RequestContextSchema/RequestContextEnvSchema,
  added `runtimeTimeZone()` (Intl API + UTC fallback), `buildRequestContext()`,
  attached to UserMessageAction and ResumeAction

## Audit
- Reviewer: Meitner (gpt-5.5 explorer)
- Verdict: GO-WITH-FIXES (blockers=1)
- Blocker folded: fabricated version string dropped, keep existing verified versions
- Non-blocking: proto path confirmed, crypto/Intl confirmed in Bun 1.3.14

## Scope amendment
- Version freshening deferred until a real CLI build hash is captured
- x-cursor-checksum and client-type change remain out of scope

## Gates
- tsc: exit 0
- bun test: 1673 pass / 0 fail

## Terminal outcome: DONE
