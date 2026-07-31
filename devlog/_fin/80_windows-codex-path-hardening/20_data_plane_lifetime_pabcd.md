# 80.20 — Data-Plane Lifetime Hardening PABCD

## Purpose

Fix the most likely Windows interruption source first: long-lived `/v1/responses` SSE and WebSocket traffic can go quiet while Bun on Windows still has finite request/runtime lifetime behavior. This phase makes the data plane explicit about request timeout, transport keepalive, close logging, and the native relay path.

## Source Evidence

- `devlog/80_windows-codex-path-hardening/15_final_gpt_pro_plan.md`
- GPT Pro conclusion: Patch 1 is release-blocking.
- Important correction: audit `trackStreamLifetime(...)` / `relayWithAbort(...)` so native passthrough SSE is not accidentally wrapped in an async-pull `ReadableStream` on the Windows hot path.

## PABCD Work Unit

Use this file as one full PABCD cycle. Do not combine it with service or scheduler work.

### P — Plan

Scope:

- MODIFY `src/server.ts`
- MODIFY `src/ws-bridge.ts` if WebSocket idle policy is centralized there
- MODIFY the module containing `trackStreamLifetime(...)` / `relayWithAbort(...)`
- ADD or MODIFY focused tests under `tests/` for SSE lifetime and passthrough relay shape

Non-goals:

- Do not change provider routing semantics.
- Do not add Cursor provider behavior.
- Do not change Windows service installation.

Planning checklist:

- Locate Bun `serve` fetch signature and confirm whether the request-scoped server object is available.
- Locate every `/v1/responses` code path: HTTP POST and WebSocket bridge.
- Locate passthrough native relay path for ChatGPT/OpenAI Responses.
- Locate all async `ReadableStream` wrappers applied after passthrough response creation.

### A — Audit

Ask a read-only auditor to verify:

- The Bun request timeout API usage matches the repository's Bun version constraint.
- The proposed timeout override is only applied to `/v1/responses`, not the GUI/API surfaces.
- Native passthrough remains native on the intended path.
- Tests can fail without the patch.

### B — Build

Implementation checklist:

- For `/v1/responses` POST, call the Bun-supported per-request timeout disable API before awaiting upstream work.
- Add explicit transport-close logging with request id, provider, model, stream start, first upstream byte, client abort, upstream abort, terminal event, and close reason where available.
- Keep heartbeat behavior at the Responses bridge layer, but do not rely on heartbeat alone for Bun request lifetime.
- Audit native passthrough SSE and avoid async-pull wrappers where the native relay workaround is intended.
- For WebSocket, document and enforce idle/heartbeat policy explicitly.

Suggested commit:

```bash
git add src/server.ts src/ws-bridge.ts tests && git commit -m "fix(windows): harden responses stream lifetime"
```

### C — Check

Required commands:

```bash
bun test tests/ws-endpoint.test.ts tests/bridge-lifecycle.test.ts tests/error-fidelity.test.ts
bun x tsc --noEmit
```

Add whichever new focused tests are created, for example:

```bash
bun test tests/responses-lifetime.test.ts tests/passthrough-relay.test.ts
```

Manual Windows smoke:

```powershell
ocx start
# Send a streaming /v1/responses request that stays quiet longer than the old failure window.
# Confirm the stream continues and service/process logs show no unintended close.
```

### D — Done Criteria

- Slow SSE remains open through a quiet period.
- Passthrough native relay path is not wrapped by an async-pull `ReadableStream` on the intended hot path.
- WebSocket idle policy is explicit and tested.
- Typecheck and targeted tests pass.
- Devlog evidence references exact test output and changed files.
