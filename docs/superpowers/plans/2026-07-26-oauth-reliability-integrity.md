# OAuth Reliability and Client Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize cross-process OAuth refresh locking and generation CAS, expose a shared OAuth health projection through status/doctor/dashboard, and harden Codex client-metadata integrity tests — without changing Codex affinity policy A or adding impersonation/limit-bypass behaviour.

**Architecture:** Reuse `createOAuthRefreshIntentLock` + `mergeAccountCredential` (already proven for xAI/Anthropic) for remaining OAuth providers behind the existing in-process `tokenRefreshes` map. Project existing `needsReauth` / Codex cooldown / conflict signals into one `OAuthAccountHealth` type consumed by CLI, management API, and GUI. Keep Codex pool 401/403 quarantine and 429 affinity-clear/rotate behaviour unchanged.

**Tech Stack:** Bun, TypeScript, existing `src/oauth/*`, `src/codex/*`, `src/cli/*`, React GUI, Bun test runner, docs-site (Astro/Starlight).

**Spec:** `docs/superpowers/specs/2026-07-26-oauth-reliability-integrity-design.md`

## Global Constraints

- Target branch: `feat/oauth-reliability-integrity` (worktree); PRs target `dev`
- TDD: write failing test → confirm fail → minimal implementation → confirm pass → commit
- No new dependencies
- Never log access tokens, refresh tokens, authorization headers, OAuth codes, or full account identifiers
- Redact account IDs in CLI/UI (`maskAccountId`)
- Do not claim ban protection; describe reliability, integrity, diagnostics only
- Affinity policy A: keep current Codex clear-on-401/403/429 behaviour
- Do not persist `threadAccountMap` to disk
- Do not fabricate official Codex client metadata
- Avoid unrelated refactors

## File map

| Path | Role |
|------|------|
| `src/lib/privacy.ts` | Add `maskAccountId` |
| `src/oauth/log.ts` | Structured redacted OAuth transition logs |
| `src/oauth/health.ts` | Shared health projection + aggregators |
| `src/oauth/index.ts` | Generalized locked refresh for non-xAI/Anthropic providers |
| `src/oauth/store.ts` | Only if tiny helpers needed for incomplete-credential detection |
| `src/cli/status.ts` / `src/cli/index.ts` | Status OAuth health block |
| `src/cli/doctor.ts` | Doctor OAuth checks |
| `src/server/management/oauth-account-routes.ts` | Expose health on account DTOs |
| `src/codex/auth-context.ts` / `src/adapters/openai-responses.ts` | Metadata integrity (tests; code only if gap found) |
| `gui/src/lib/privacy.ts` or shared import path | GUI redaction helper if GUI cannot import runtime privacy directly |
| `gui/src/components/provider-workspace/*` | Health badge + explanation |
| `docs-site/src/content/docs/**` | User-facing docs |
| `tests/*.test.ts` | Behaviour tests per task |

---

### Task 1: Account ID redaction helper

**Files:**
- Modify: `src/lib/privacy.ts`
- Test: `tests/privacy-mask-account.test.ts`
- Modify (if CLI already prints raw IDs in oauth summary paths later): none in this task beyond helper

**Interfaces:**
- Consumes: none
- Produces: `maskAccountId(value: string | null | undefined): string | null`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { maskAccountId } from "../src/lib/privacy";

describe("maskAccountId", () => {
  test("redacts long account ids to account-…suffix", () => {
    expect(maskAccountId("acct_abcdefghijklmnopqrstuvwxyz")).toBe("account-…wxyz");
  });

  test("returns null for empty", () => {
    expect(maskAccountId(null)).toBeNull();
    expect(maskAccountId("")).toBeNull();
  });

  test("short ids still redact without leaking full value when length > 4", () => {
    expect(maskAccountId("abcdef")).toBe("account-…cdef");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/privacy-mask-account.test.ts`

Expected: FAIL — `maskAccountId` is not exported

- [ ] **Step 3: Write minimal implementation**

In `src/lib/privacy.ts`:

```ts
export function maskAccountId(value: string | null | undefined): string | null {
  if (!value) return null;
  const id = value.trim();
  if (!id) return null;
  const suffix = id.length <= 4 ? id : id.slice(-4);
  return `account-…${suffix}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/privacy-mask-account.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/privacy.ts tests/privacy-mask-account.test.ts
git commit -m "$(cat <<'EOF'
feat(privacy): add maskAccountId for OAuth diagnostics

EOF
)"
```

---

### Task 2: Structured OAuth logger

**Files:**
- Create: `src/oauth/log.ts`
- Test: `tests/oauth-log.test.ts`

**Interfaces:**
- Consumes: `maskAccountId` from `src/lib/privacy.ts`
- Produces:
  - `logOAuthEvent(event: string, fields: { provider: string; accountId?: string; [k: string]: unknown }): void`
  - Events must never include keys: `access`, `refresh`, `authorization`, `code`, `token`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { logOAuthEvent } from "../src/oauth/log";

describe("logOAuthEvent", () => {
  test("emits redacted account and never prints a token-looking field value", () => {
    const lines: string[] = [];
    const original = console.info;
    console.info = (msg?: unknown) => { lines.push(String(msg)); };
    try {
      logOAuthEvent("OAuth refresh started", {
        provider: "kiro",
        accountId: "acct_abcdefghijklmnopqrstuvwxyz",
        until: "2026-07-23T14:30:00.000Z",
      });
    } finally {
      console.info = original;
    }
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("[opencodex]");
    expect(lines[0]).toContain("provider=kiro");
    expect(lines[0]).toContain("account=account-…wxyz");
    expect(lines[0]).not.toContain("acct_abcdefghijklmnopqrstuvwxyz");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/oauth-log.test.ts`

Expected: FAIL — module missing

- [ ] **Step 3: Write minimal implementation**

```ts
// src/oauth/log.ts
import { maskAccountId } from "../lib/privacy";

const FORBIDDEN = /^(access|refresh|authorization|code|token|accessToken|refreshToken)$/i;

export function logOAuthEvent(
  event: string,
  fields: { provider: string; accountId?: string; [key: string]: unknown },
): void {
  const parts = [`[opencodex] ${event}`, `provider=${fields.provider}`];
  if (fields.accountId) parts.push(`account=${maskAccountId(fields.accountId)}`);
  for (const [key, value] of Object.entries(fields)) {
    if (key === "provider" || key === "accountId") continue;
    if (FORBIDDEN.test(key)) continue;
    if (value === undefined) continue;
    parts.push(`${key}=${String(value)}`);
  }
  console.info(parts.join(" "));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/oauth-log.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/oauth/log.ts tests/oauth-log.test.ts
git commit -m "$(cat <<'EOF'
feat(oauth): add redacted structured OAuth event logger

EOF
)"
```

---

### Task 3: Generalized locked refresh + CAS for generic OAuth providers

**Files:**
- Modify: `src/oauth/index.ts` (`refreshAndPersistAccessToken` generic branch ~352–400)
- Test: `tests/oauth-refresh-generic-lock.test.ts` (new; mirror patterns from `tests/xai-refresh-lock.test.ts` / `tests/oauth-refresh.test.ts`)

**Interfaces:**
- Consumes: `createOAuthRefreshIntentLock`, `mergeAccountCredential`, `credentialGeneration`, `markAccountNeedsReauthIfGeneration`, `getAccountCredential`, `logOAuthEvent`
- Produces: generic path behaviour equivalent to:
  1. lock → reload → skip if already fresh → refresh → CAS persist → unlock
  2. in-process `tokenRefreshes` still coalesces callers
- Keep xAI / Anthropic / Kiro special branches unchanged in behaviour

- [ ] **Step 1: Write the failing tests**

Create `tests/oauth-refresh-generic-lock.test.ts` covering at least:

1. Ten concurrent `getValidAccessTokenForAccount("kimi", id)` (or another non-xAI/Anthropic provider with injectable `refresh`) trigger **one** IdP refresh; all get same access token
2. Failed refresh clears single-flight so a later call can retry
3. After lock acquire, a newer disk credential is adopted without a second IdP call
4. Older refresh result cannot overwrite newer stored token (`mergeAccountCredential` superseded path)
5. Rotated refresh token is persisted on disk

Use the existing test helpers that point `OPENCODEX_HOME` at a temp dir and stub `OAUTH_PROVIDERS[provider].refresh` / fetch. Follow `tests/oauth-refresh.test.ts` setup patterns for auth store isolation.

Sketch for concurrent refresh:

```ts
test("ten concurrent generic refreshes share one IdP call and same credential", async () => {
  let refreshCalls = 0;
  // arrange expired kimi (or github-copilot) credential in temp auth store
  // stub provider refresh to increment refreshCalls and return rotated tokens
  const results = await Promise.all(
    Array.from({ length: 10 }, () => getValidAccessTokenForAccount(provider, accountId)),
  );
  expect(new Set(results).size).toBe(1);
  expect(refreshCalls).toBe(1);
  const stored = getAccountCredential(provider, accountId);
  expect(stored?.refresh).toBe("rotated-refresh");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/oauth-refresh-generic-lock.test.ts`

Expected: FAIL — generic path still uses unlocked `saveAccountCredential` / can double-refresh under injected dual locks or pre-persist races (assert the specific failure your test constructs)

- [ ] **Step 3: Write minimal implementation**

Replace the generic branch in `refreshAndPersistAccessToken` with a shared helper, e.g. `refreshGenericAccountWithLock`, modeled on xAI/Anthropic but without Grok/Claude local-cli logic:

```ts
async function refreshGenericAccountWithLock(
  provider: string,
  accountId: string,
  def: OAuthProviderDef,
  callerCredential: OAuthCredentials,
): Promise<string> {
  logOAuthEvent("OAuth refresh started", { provider, accountId });
  const guard = await createOAuthRefreshIntentLock(provider, accountId).acquire();
  try {
    const stored = getAccountCredential(provider, accountId);
    if (!stored) throw new OAuthLoginRequiredError(provider);
    if (
      credentialGeneration(stored) !== credentialGeneration(callerCredential)
      && stored.expires > Date.now() + REFRESH_SKEW_MS
    ) {
      logOAuthEvent("OAuth refresh joined existing operation", { provider, accountId });
      return stored.access;
    }
    const generation = credentialGeneration(stored);
    try {
      const fresh = merged(await def.refresh(stored.refresh), stored);
      const outcome = await mergeAccountCredential(provider, accountId, fresh, {
        expectedGeneration: generation,
      });
      if (outcome.superseded) {
        if (outcome.stored.expires > Date.now() + REFRESH_SKEW_MS) return outcome.stored.access;
        throw new OAuthLoginRequiredError(provider);
      }
      logOAuthEvent("OAuth credentials rotated and persisted", { provider, accountId });
      return fresh.access;
    } catch (error) {
      if (!isTerminalRefreshError(error)) throw error;
      await markAccountNeedsReauthIfGeneration(provider, accountId, generation);
      throw new OAuthLoginRequiredError(provider);
    }
  } finally {
    guard.release();
  }
}
```

Wire it from the generic branch (still after Kiro active-import and xAI/Anthropic special cases). Ensure `tokenRefreshes` finally-clear behaviour remains so failed refreshes allow retry.

Also log `"OAuth refresh joined existing operation"` when `tokenRefreshes.get(key)` hits an existing promise.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
bun test tests/oauth-refresh-generic-lock.test.ts tests/oauth-refresh.test.ts tests/xai-refresh-lock.test.ts
```

Expected: PASS (no regressions on xAI/Anthropic)

- [ ] **Step 5: Commit**

```bash
git add src/oauth/index.ts tests/oauth-refresh-generic-lock.test.ts
git commit -m "$(cat <<'EOF'
feat(oauth): lock and CAS generic provider token refresh

EOF
)"
```

---

### Task 4: Shared OAuth health projection

**Files:**
- Create: `src/oauth/health.ts`
- Test: `tests/oauth-health.test.ts`
- Modify: export from `src/oauth/index.ts` if that is the public surface used by CLI

**Interfaces:**
- Consumes:
  - OAuth store `needsReauth` / credential presence via existing getters
  - Codex cooldown via exported read helpers — if none exist, add a **read-only** `getCodexAccountCooldown(accountId): { until: number; source: string } | null` in `src/codex/routing.ts` without changing write policy
- Produces:

```ts
export type OAuthAccountHealth =
  | { status: "healthy" }
  | { status: "cooldown"; until: string; reason: "rate_limit" | "quota" }
  | { status: "reauth_required"; reason: "unauthorized" | "forbidden" | "refresh_failed" }
  | { status: "warning"; reason: "refresh_conflict" | "metadata_mismatch" | "stale_credentials" };

export type OAuthHealthEntry = {
  provider: string;
  accountId: string;
  health: OAuthAccountHealth;
  action?: string;
};

export function projectOAuthAccountHealth(input: {
  needsReauth?: boolean;
  reauthReason?: "unauthorized" | "forbidden" | "refresh_failed";
  cooldownUntilMs?: number;
  cooldownReason?: "rate_limit" | "quota";
  warningReason?: "refresh_conflict" | "metadata_mismatch" | "stale_credentials";
  now?: number;
}): OAuthAccountHealth;

export function collectOAuthHealthEntries(now?: number): OAuthHealthEntry[];
```

Priority when multiple signals exist: `reauth_required` > `cooldown` > `warning` > `healthy`.

- [ ] **Step 1: Write the failing tests**

```ts
test("reauth beats cooldown", () => {
  expect(projectOAuthAccountHealth({
    needsReauth: true,
    reauthReason: "refresh_failed",
    cooldownUntilMs: Date.now() + 60_000,
  })).toEqual({ status: "reauth_required", reason: "refresh_failed" });
});

test("active cooldown projects until ISO timestamp", () => {
  const until = Date.parse("2026-07-23T14:30:00.000Z");
  expect(projectOAuthAccountHealth({
    cooldownUntilMs: until,
    cooldownReason: "rate_limit",
    now: until - 1000,
  })).toEqual({
    status: "cooldown",
    until: "2026-07-23T14:30:00.000Z",
    reason: "rate_limit",
  });
});
```

Also test `collectOAuthHealthEntries` with a temp auth store marking one account `needsReauth`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/oauth-health.test.ts`

Expected: FAIL — module missing

- [ ] **Step 3: Write minimal implementation**

Implement `projectOAuthAccountHealth` and `collectOAuthHealthEntries`. For Codex pool accounts, read cooldown via a new thin getter in `src/codex/routing.ts`:

```ts
export function getCodexAccountHealthSnapshot(accountId: string, now = Date.now()): {
  cooldownUntil?: number;
  cooldownSource?: "retry-after" | "reset-derived" | "default";
} | null
```

Map `retry-after` → `rate_limit`, others → `quota` for health reason. Do **not** change `recordCodexUpstreamOutcome`.

Set `action` strings:
- reauth: `run \`ocx login <provider>\``
- cooldown: `wait until <local time> or start a new session with another eligible account`
- warning refresh_conflict: `re-run \`ocx doctor\` after ensuring only one proxy process writes the credential store`

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/oauth-health.test.ts tests/codex-routing.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/oauth/health.ts src/oauth/index.ts src/codex/routing.ts tests/oauth-health.test.ts
git commit -m "$(cat <<'EOF'
feat(oauth): add shared account health projection

EOF
)"
```

---

### Task 5: `ocx status` OAuth health output

**Files:**
- Modify: `src/cli/index.ts` (status human printer that currently calls `oauthLoginSummary`)
- Modify: `src/cli/status.ts` only if JSON status should gain a redacted health summary (prefer human-first; add JSON only if existing tests/docs allow a non-secret block)
- Test: `tests/cli-status-oauth-health.test.ts`

**Interfaces:**
- Consumes: `collectOAuthHealthEntries`, `maskAccountId`
- Produces: human-readable block matching the spec examples (warning / rate limited)

- [ ] **Step 1: Write the failing test**

Drive `collectOAuthHealthEntries` via store fixtures, then call a new pure formatter:

```ts
import { formatOAuthHealthForStatus } from "../src/cli/status-oauth";

test("formats reauthentication required", () => {
  const text = formatOAuthHealthForStatus([{
    provider: "openai",
    accountId: "acct_abcdefghijklmnopqrstuvwxyz",
    health: { status: "reauth_required", reason: "refresh_failed" },
    action: "run `ocx login openai`",
  }]);
  expect(text).toContain("OAuth health: warning");
  expect(text).toContain("account-…wxyz");
  expect(text).not.toContain("acct_abcdefghijklmnopqrstuvwxyz");
  expect(text).toContain("reauthentication required");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli-status-oauth-health.test.ts`

Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Create `src/cli/status-oauth.ts` with `formatOAuthHealthForStatus`. Wire into `handleStatus` human output after the existing OAuth logins summary (or replace sparse summary with health-aware block when non-healthy entries exist). Keep emails masked; never print tokens.

- [ ] **Step 4: Run tests**

Run: `bun test tests/cli-status-oauth-health.test.ts tests/cli-status-json.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/status-oauth.ts src/cli/index.ts tests/cli-status-oauth-health.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): show OAuth health in ocx status

EOF
)"
```

---

### Task 6: `ocx doctor` OAuth checks

**Files:**
- Modify: `src/cli/doctor.ts`
- Test: `tests/doctor-oauth.test.ts` (or extend `tests/doctor.test.ts`)

**Interfaces:**
- Consumes: `collectOAuthHealthEntries`, auth store writability checks, refresh lock path helpers if exported
- Produces: doctor rows like:
  - `[OK] OAuth credential storage is writable.`
  - `[OK] Token refresh single-flight is active.`
  - `[WARN] Account account-…42 requires reauthentication. Action: run \`ocx login <provider>\``
  - `[WARN] Account account-…17 is rate limited until … Action: …`
  - `[OK] No fabricated official-client metadata detected.` (static OK for Codex forward path unless a runtime detector exists; do not invent a false positive scanner)

- [ ] **Step 1: Write the failing test**

Seed a temp account with `needsReauth`, run the new `collectOAuthDoctorChecks()` (pure), assert WARN + action present and account id redacted.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/doctor-oauth.test.ts`

Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Add `collectOAuthDoctorChecks(): Array<{ level: "OK" | "WARN"; message: string }>` and append in `runDoctor()` output. Observe-only: no mutations, no auto-repair.

- [ ] **Step 4: Run tests**

Run: `bun test tests/doctor-oauth.test.ts tests/doctor.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/doctor.ts tests/doctor-oauth.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add OAuth reliability checks to ocx doctor

EOF
)"
```

---

### Task 7: Management API + dashboard health

**Files:**
- Modify: `src/server/management/oauth-account-routes.ts` (and Codex auth DTO path in `src/codex/auth-api.ts` if Codex accounts are the primary UI)
- Modify: `gui/src/components/provider-workspace/ProviderAuthPanel.tsx`
- Modify: `gui/src/components/CodexAccountPool.tsx` (if showing Codex cooldown/reauth)
- Possibly: `gui/src/provider-workspace/catalog.ts` / types for account DTO
- Test: `tests/oauth-accounts-api.test.ts` (extend)
- Test: GUI unit/render test if the repo already has a pattern; otherwise a pure formatter test for badge labels in `gui/src/...` plus API contract test

**Interfaces:**
- API account objects gain:

```ts
health: OAuthAccountHealth
healthLabel: "Healthy" | "Rate limited" | "Reauthentication required" | "Refresh failed" | "Metadata mismatch" | "Credential conflict"
```

Map warning reasons to labels (`refresh_conflict` → Credential conflict, etc.).

- [ ] **Step 1: Write the failing API test**

Assert `/api/oauth/accounts?provider=...` includes `health` and redacted display helpers never return full raw id in `healthSummary` strings.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/oauth-accounts-api.test.ts`

Expected: FAIL on missing `health`

- [ ] **Step 3: Minimal API + UI implementation**

Attach projected health to account DTOs. In GUI, show badge + short explanation (what happened, provider/account redacted, blocked?, next action). Actions: Reauthenticate button (existing), copy `ocx doctor`, disable probe messaging during cooldown. No “anti-ban” copy.

- [ ] **Step 4: Run tests**

Run:

```bash
bun test tests/oauth-accounts-api.test.ts
bun run lint:gui
```

Expected: PASS / lint clean for touched files

- [ ] **Step 5: Commit**

```bash
git add src/server/management/oauth-account-routes.ts src/codex/auth-api.ts gui/src/components/provider-workspace/ProviderAuthPanel.tsx gui/src/components/CodexAccountPool.tsx tests/oauth-accounts-api.test.ts
git commit -m "$(cat <<'EOF'
feat(gui): surface OAuth account health diagnostics

EOF
)"
```

---

### Task 8: Codex metadata integrity regressions + 401 replay invariants

**Files:**
- Test: `tests/codex-metadata-integrity.test.ts` (new)
- Modify only if a real gap is found: `src/codex/auth-context.ts`, `src/adapters/openai-responses.ts`
- Confirm existing: `tests/server-xai-oauth-401-replay.test.ts`, `tests/server-kiro-oauth-401-replay.test.ts`, `tests/codex-routing.test.ts` (policy A)

**Interfaces:**
- Consumes: `headersForCodexAuthContext`, `FORWARD_HEADERS`
- Produces: tests proving:
  1. Genuine `originator` / `session_id` / `thread-id` preserved
  2. Missing `originator` is not filled with `codex_cli_rs`
  3. Outgoing `chatgpt-account-id` matches selected pool credential
  4. Policy A: 429 clears affinity (existing tests remain green) — do not invert

- [ ] **Step 1: Write failing tests for any missing assertion**

```ts
test("does not fabricate originator when absent", () => {
  const incoming = new Headers({
    "x-codex-parent-thread-id": "thread-1",
  });
  // resolve auth context with pool account A
  const headers = headersForCodexAuthContext(incoming, authContext);
  expect(headers.get("originator")).toBeNull();
  expect(headers.get("chatgpt-account-id")).toBe(accountA.chatgptAccountId);
});

test("preserves genuine originator", () => {
  const incoming = new Headers({
    originator: "codex_cli_rs",
    "x-codex-parent-thread-id": "thread-1",
  });
  const headers = headersForCodexAuthContext(incoming, authContext);
  expect(headers.get("originator")).toBe("codex_cli_rs");
});
```

- [ ] **Step 2: Run tests**

Run: `bun test tests/codex-metadata-integrity.test.ts`

Expected: FAIL only if implementation gap exists; if PASS immediately, keep tests as regressions and skip code changes.

- [ ] **Step 3: Fix only real gaps**

If fabrication or account-id mismatch is found, fix the minimal header path. Do not add fake official metadata.

- [ ] **Step 4: Run related suite**

```bash
bun test tests/codex-metadata-integrity.test.ts tests/codex-auth-context.test.ts tests/codex-routing.test.ts tests/session-affinity.test.ts tests/server-xai-oauth-401-replay.test.ts tests/server-kiro-oauth-401-replay.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/codex-metadata-integrity.test.ts src/codex/auth-context.ts src/adapters/openai-responses.ts
git commit -m "$(cat <<'EOF'
test(codex): lock metadata pass-through and non-fabrication

EOF
)"
```

---

### Task 9: Documentation

**Files:**
- Modify: `docs-site/src/content/docs/guides/providers.md`
- Modify: `docs-site/src/content/docs/reference/cli.md`
- Modify: `docs-site/src/content/docs/reference/architecture.md` (brief)
- Update translated locales only enough to avoid contradictions if they mirror the changed English sections; prefer English-first + short note if locale sync is heavy

Content to add (factual, concise):

- How OAuth refresh coordination works (in-process single-flight + per-account file lock + generation CAS)
- How cooldowns work (Retry-After / reset headers / backoff; no probe during Retry-After cooldowns)
- Session affinity is process-local; policy on errors (policy A)
- Which Codex client metadata is preserved; what is not fabricated
- How to use `ocx status` and `ocx doctor` for OAuth health
- How to reauthenticate
- Explicit: this does not guarantee protection from provider enforcement

- [ ] **Step 1: Update English docs**

- [ ] **Step 2: Skim locales for contradictory statements; fix only contradictions**

- [ ] **Step 3: Commit**

```bash
git add docs-site/src/content/docs
git commit -m "$(cat <<'EOF'
docs: document OAuth reliability and diagnostics

EOF
)"
```

---

### Task 10: Full verification and handoff

- [ ] **Step 1: Run verification commands**

```bash
bun test tests/privacy-mask-account.test.ts tests/oauth-log.test.ts tests/oauth-refresh-generic-lock.test.ts tests/oauth-health.test.ts tests/cli-status-oauth-health.test.ts tests/doctor-oauth.test.ts tests/oauth-accounts-api.test.ts tests/codex-metadata-integrity.test.ts
bun test tests/oauth-refresh.test.ts tests/xai-refresh-lock.test.ts tests/codex-routing.test.ts tests/session-affinity.test.ts tests/codex-auth-context.test.ts
bun run test
bun run typecheck
bun run lint:gui
bun run privacy:scan
bun run build:gui
```

- [ ] **Step 2: Inspect final diff for**

- duplicated OAuth state
- token leakage
- weak locking left on generic path
- accidental affinity policy changes
- fabricated official-client metadata
- unrelated changes

- [ ] **Step 3: Write handoff summary** covering findings, files changed, behaviours, tests, command results, limitations, and confirmation that no impersonation/fingerprint spoofing/limit-bypass was added

---

## Spec coverage checklist

| Spec item | Task |
|-----------|------|
| Refresh single-flight + cross-process lock | 3 |
| Atomic CAS persistence / no stale overwrite | 3 |
| 401 replay where existing providers support it | 8 (regression) |
| 403/429 policy A unchanged | 8 + existing routing tests |
| Affinity process-local, policy A | 8 + design decision |
| Client metadata integrity | 8 |
| Health model | 4 |
| `ocx status` | 5 |
| `ocx doctor` | 6 |
| Dashboard | 7 |
| Structured logs | 2 (+ hooks in 3) |
| Account redaction | 1 (+ consumers 5–7) |
| Docs | 9 |
| Verification | 10 |

## Placeholder / consistency self-review

- No TBD/TODO left in tasks
- `OAuthAccountHealth` shape is identical in Tasks 4–7
- `maskAccountId` / `logOAuthEvent` / `collectOAuthHealthEntries` names are stable across tasks
- Policy A is restated wherever affinity/429 tests are mentioned so implementers do not “fix” it to pin-through-429
