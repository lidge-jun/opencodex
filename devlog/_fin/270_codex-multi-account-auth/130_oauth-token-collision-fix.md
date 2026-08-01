# 130 OAuth Token Collision Fix

> Superseded security note (2026-06-25): This document predates the 280 security patch plan and Phase 10-60 hardening. Treat release-readiness, full-email UI, ordinal request-log labels, unauthenticated management API, fail-open fallback, and earlier account-boundary claims here as historical only. Current merge/deploy evidence is tracked under `devlog/280_codex-multi-auth-security-patch-plan/` and `devlog/_plan/260624_codex-multi-auth-security-implementation/`.

## Problem

Pool account OAuth login can invalidate the main Codex CLI token (`~/.codex/auth.json`).

**Root Cause** (confirmed via openai/codex#10332 + hermes-agent#22903):
- OpenAI uses **single-use refresh token rotation**: each refresh token can only be used once
- When the browser is already logged into ChatGPT as the main account and the user clicks "Add pool account", the OAuth flow auto-completes with the main account's session
- Result: opencodex gets tokens for the SAME account as codex-rs
- When either process refreshes its token, the other's refresh token is permanently invalidated
- codex-rs sees `token_invalidated` on `codex_apps` MCP startup

**Secondary risk**: Even with different accounts, `fetchPoolAccountQuota()` actively refreshes pool tokens via `getValidCodexToken()`, increasing refresh frequency and potential for timing issues.

## Solution

Three-layer defense:

### Layer 1: Force fresh login (prevent same-account collision)
- Add `prompt: "login"` to OAuth authorize params in `chatgpt.ts`
- This forces a fresh login screen instead of auto-consenting with the current session
- User must explicitly choose which account to log in with

### Layer 2: Email collision detection
- After OAuth token exchange, extract email from JWT
- Compare against main account email (from `~/.codex/auth.json` via `fetchMainAccountInfo()`)
- Compare against existing pool account emails
- Reject with clear error if collision detected

### Layer 3: Graceful token failure handling
- When `getValidCodexToken()` fails (revoked/expired), return a typed error instead of throwing
- `fetchPoolAccountQuota()` catches the error and returns `null` (quota bar hidden)
- API response includes `needsReauth: true` flag for failed accounts
- GUI shows "Re-login needed" badge instead of hiding quota silently

## Files

### MODIFY: `src/oauth/chatgpt.ts`
- Add `prompt: "login"` to authorize URL params (line 77-87)

### MODIFY: `src/codex-auth-api.ts`
- Add `checkEmailCollision()` function: reads main email from `fetchMainAccountInfo()`, compares against pool list
- In POST `/api/codex-auth/accounts` handler: after OAuth completes, validate email uniqueness
- In login flow completion (line 193-250): extract email, check collision before saving
- `fetchPoolAccountQuota()`: catch token errors, return null gracefully

### MODIFY: `src/codex-account-store.ts`
- `getValidCodexToken()`: catch refresh failures, return typed error with reason
- Add `isTokenValid(id)` helper that checks without refreshing

### MODIFY: `gui/src/pages/CodexAuth.tsx`
- Handle `needsReauth` flag on pool accounts
- Show "Re-login" badge and re-auth button
- Pool account card shows "Token expired" state instead of empty

## Classification

C3 → C4 care (security-adjacent: auth tokens, session management)
Verification: STANDARD (focused on auth flow correctness)
