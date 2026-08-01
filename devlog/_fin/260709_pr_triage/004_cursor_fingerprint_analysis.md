# 004 — Cursor Bridge Fingerprint/Header Profile Analysis

## Our bridge (opencodex) header profile

### live-transport.ts (run requests, line ~584)
```
":method": "POST"
":path": /aiserver.v1.AiService/StreamAgentRun
"content-type": "application/connect+proto"
"connect-protocol-version": "1"
"te": "trailers"
"authorization": "Bearer <token>"
"x-ghost-mode": "true"
"x-cursor-client-version": "cli-2026.01.09-231024f"
"x-cursor-client-type": "cli"
"x-request-id": "<uuid>"
```

### live-models.ts (discovery, line ~67)
```
":method": "POST"
":path": /aiserver.v1.AiService/GetUsableModels
"content-type": "application/proto"
"connect-protocol-version": "1"
"authorization": "Bearer <token>"
"x-ghost-mode": "true"
"x-cursor-client-version": "cli-2026.02.13-41ac335"
"x-cursor-client-type": "cli"
```

## IDE profile (eisbaw/cursor_api_demo + ccs#517 + forum reports)
```
"authorization": "Bearer <token>"
"x-cursor-client-version": "<ide-version, e.g. 0.50.x>"
"x-cursor-client-type": "ide"           # we send "cli"
"x-cursor-checksum": "<Jyh cipher>"     # WE DO NOT SEND THIS
"x-session-id": "<persistent-uuid>"     # WE DO NOT SEND THIS
"x-request-id": "<uuid>"
"x-cursor-timezone": "<tz>"             # WE DO NOT SEND THIS
"x-ghost-mode": "true"
```

## Gap analysis

| Header | Ours | IDE | Risk |
|--------|------|-----|------|
| x-cursor-checksum | ABSENT | Jyh cipher (time-XOR) | HIGH: most differentiating signal |
| x-cursor-client-type | "cli" | "ide" | MEDIUM: server may apply different rate tiers |
| x-session-id | ABSENT | persistent UUID | LOW: session tracking, not auth |
| x-cursor-timezone | ABSENT | present | LOW: analytics only |
| client-version freshness | cli-2026.01.09 | 0.50.x (latest) | MEDIUM: stale version |
| timeZone in protobuf body | NOT SET (schema field 10 exists) | set | LOW |

## Peer bridge comparison
- pi-cursor-sdk (217 stars): sends client-version + client-type: cli + ghost-mode. NO checksum. Works.
- composer-api (251 stars): similar minimal header set. Periodic resource_exhausted reports.
- cursor-api-proxy (131 stars): adds x-cursor-checksum via ccs#517 reverse-engineered cipher.
- eisbaw/cursor_api_demo: full IDE mimicry including checksum.

## Verdict

### resource_exhausted root cause
The resource_exhausted error is primarily server-side rate limiting, confirmed by:
1. Cursor forum reports (Dec 2025 ~ Mar 2026): happens in official IDE with credits remaining
2. Cursor staff acknowledged server-side throttling
3. Peer bridges with AND without checksum both report the same error

Our missing x-cursor-checksum is NOT the primary cause, but x-cursor-client-type: cli
MAY subject us to a stricter (or separate) rate-limit bucket compared to IDE clients.

### Recommendations

Do (low risk, high signal):
1. Freshen CURSOR_CLIENT_VERSION to a recent CLI build hash (monthly cadence)
2. Add x-session-id (stable UUID per session) -- trivial, aids server-side correlation
3. Populate timeZone in protobuf request body -- field already in schema

Consider carefully (medium risk):
4. Flip x-cursor-client-type from "cli" to "ide" -- may change rate bucket but risks
   triggering different server-side validation paths

Avoid for now (high risk):
5. x-cursor-checksum (Jyh cipher) -- reverse-engineered, maintenance burden, ToS risk,
   and peer evidence shows it's not required for basic operation. cursor-api-proxy ships it
   but the cipher changes without notice. Not worth the churn.

### Can we solve this by stacking commits on top?
Yes. Recommendations 1-3 are purely additive header changes in live-transport.ts and
protobuf-request.ts. No breaking changes, no schema modifications needed. Each can be
a single focused commit on dev.
