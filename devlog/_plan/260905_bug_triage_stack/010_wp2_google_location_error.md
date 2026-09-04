# 010 — Google location-not-supported classification (#3467)

Work-phase: one full PABCD cycle. Closes #3467. Carries PR #3469 (supersedes; Co-authored-by: agentHits <zvercombat26rus@icloud.com>).
Source evidence lane output is reproduced below verbatim (diff-level). Stale-check
against the current tree at this cycle's P before implementing.

---

## Amendments from audit round 1 (binding over the lane text below)

- **Precedence (blocker 1):** in `classifyGoogle` insert the location branch *after* the
  existing auth (`status === 401 || enumStatus === "UNAUTHENTICATED"`), permission
  (403/`PERMISSION_DENIED`), quota and rate-limit (429/`RESOURCE_EXHAUSTED`) branches, and
  *before* the generic 400/`INVALID_ARGUMENT` fallthrough — not at line 62 as the lane
  text proposes. Same rule in `src/lib/errors.ts`: keep authentication / rate-limit
  classification ahead of `isLocationUnsupportedMessage`.
- **Tests:** add enum-driven cases: `{status:400, enumStatus:"UNAUTHENTICATED", message:
  "...location is not supported..."}` → `authentication failed` (adapter) →
  `authentication_error` (envelope); `RESOURCE_EXHAUSTED` + location wording → quota/rate
  limit; plain `FAILED_PRECONDITION` + location wording → `location not supported` →
  `permission_error`/`location_not_supported`.

---

## 1) VERDICT: CARRY_EXISTING_PR

Not fixed on the checked checkout or inspected `origin/dev`.

- HEAD: `6d9639165581546cdcebe96bc911446caabdd7d0`
- `origin/dev` advanced to `980a9fbede123f411f52c8b061a05fb995ae159d`; all six relevant source/test files are unchanged between those refs.
- [PR #3469](https://github.com/lidge-jun/opencodex/pull/3469): OPEN, APPROVED, **CONFLICTING / DIRTY**, head `e11089af85f8c1da4e67fe388b768d09078e8dcb`.

## 2) EVIDENCE

Current-dev anchors:

- [src/adapters/google-errors.ts:74](/Users/jun/.codex/worktrees/ef41/opencodex/src/adapters/google-errors.ts:74): `if (status === 400 || …)` immediately returns `` `${label} invalid request` ``. No location-specific branch.
- [src/adapters/google-errors.ts:87](/Users/jun/.codex/worktrees/ef41/opencodex/src/adapters/google-errors.ts:87): `classifyGoogle(label, status, enumStatus, …)` receives the upstream message/status.
- [src/lib/errors.ts:273](/Users/jun/.codex/worktrees/ef41/opencodex/src/lib/errors.ts:273): `text.includes("invalid request")` maps to `invalid_request_error`; line 286 independently does the same for HTTP 400.
- [src/bridge.ts:2100](/Users/jun/.codex/worktrees/ef41/opencodex/src/bridge.ts:2100): `const error = classifyError(status, type, message);` establishes the public-envelope consumer.
- [tests/adapters/google/google-errors.test.ts:79](/Users/jun/.codex/worktrees/ef41/opencodex/tests/adapters/google/google-errors.test.ts:79): final existing case is `"non-RESOURCE_EXHAUSTED status is not quota exhaustion even with quota keyword"`; no location regression.

`git log origin/dev -- src/adapters/google-errors.ts` identifies the latest change as `bfe2cb5a1` / **#2573**, a quota-classification fix, not this issue.

**Conflict evidence:** all runtime preimage blobs in `gh pr diff 3469` exactly match HEAD:

| File | PR preimage = current blob |
|---|---|
| `src/adapters/google-errors.ts` | `d78ee1fb9b…` |
| `src/adapters/google-http.ts` | `f7b90de87e…` |
| `src/lib/errors.ts` | `624917507c…` |

The three old root-level tests moved. Comparing their PR preimages against current files shows **only import-depth changes**, including dynamic imports. Moves landed through `b20af6668` / **#3513** and `79e03643d` / **#3518**. Preserve current paths/imports; transplant test additions, not whole files.

## 3) DIFF-LEVEL CARRY PLAN

All changes below are **MODIFY**; no new files.

### Runtime: minimal functional carry

**`src/lib/errors.ts`**, after `isPermissionMessage`:

```diff
+const LOCATION_UNSUPPORTED_PATTERNS = [
+  "location is not supported",
+  "location not supported",
+  "unsupported location",
+  "region is not supported",
+  "unsupported region",
+  "country is not supported",
+  "not supported in your country",
+  "not supported in your region",
+] as const;
+
+export function isLocationUnsupportedMessage(text: string): boolean {
+  const lower = text.toLowerCase();
+  return LOCATION_UNSUPPORTED_PATTERNS.some(needle => lower.includes(needle));
+}
```

At current line 254, **after authentication/subscription handling**, before generic permission:

```diff
+  if (type === "location_not_supported" || isLocationUnsupportedMessage(text)) {
+    return { message, type: "permission_error", code: "location_not_supported" };
+  }
   if (
     status === 403 ||
```

**`src/adapters/google-errors.ts`**:

```diff
+import { isLocationUnsupportedMessage } from "../lib/errors";
```

At current line 62, preserving the PR’s insertion point:

```diff
   if ((!enumStatus || enumStatus === "RESOURCE_EXHAUSTED") && quotaExhausted) return `${label} quota exhausted`;
+  if (isLocationUnsupportedMessage(lower)) return `${label} location not supported`;
   if (status === 429 || enumStatus === "RESOURCE_EXHAUSTED" || lower.includes("rate limit")) {
```

**Deliberate reductions from #3469:** omit unused pattern/alias re-exports and leave `src/adapters/google-http.ts` unchanged. Its existing formatter already uses the changed classifier at lines 22–26. The VPN/TUN diagnostic warning is unnecessary to fix classification and makes an unproven remediation claim.

Do **not** classify every `FAILED_PRECONDITION` as geographic denial.

### Regression tests

**`tests/adapters/google/google-errors.test.ts`** — carry PR phrase cases for Antigravity and Vertex; preserve `../../../src/…` imports. Add negative generic-precondition coverage:

```ts
const body = JSON.stringify({
  error: {
    code: 400,
    status: "FAILED_PRECONDITION",
    message: "User location is not supported for the API use.",
  },
});
expect(safeAntigravityHttpErrorMessage(400, body))
  .toBe("Antigravity location not supported: User location is not supported for the API use.");
expect(safeVertexHttpErrorMessage(400, body))
  .toContain("Vertex AI location not supported");
```

Also assert unrelated `"Precondition check failed"` remains `invalid request`.

**`tests/server/error-fidelity.test.ts`** — carry the PR’s raw-message, normalized-message, explicit-type, mixed-case, and negative matcher assertions. Keep `../../src/lib/errors`. Add public-envelope coverage:

```ts
const response = formatErrorResponse(
  400, "upstream_error",
  "Antigravity location not supported: User location is not supported for the API use.",
);
expect(response.status).toBe(400);
expect((await response.json()).error).toMatchObject({
  type: "permission_error",
  code: "location_not_supported",
});
```

Add precedence cases: HTTP 401 remains authentication; HTTP 429 remains rate-limit despite location wording.

**`tests/adapters/google/google-vertex-http.test.ts`** — replace the proposed warning tests with behavior coverage:

```ts
const mock = mockFetch([new Response(
  vertexError(400, "FAILED_PRECONDITION",
    "User location is not supported for the API use."),
  { status: 400 },
)]);
const res = await fetchAntigravityWithRetry(request, { timeoutMs: 5_000 });
expect(res.status).toBe(400);
expect(await res.text()).toContain("Antigravity location not supported");
expect(mock.calls).toHaveLength(1);
```

Keep existing redaction and raw-pass-through tests.

Layout is already registered:

- `scripts/test-layout/layout.json:596,632,640`
- `tests/fixtures/test-layout-expected.json:433,469,477`

No registry edits needed when extending these files. Any new test filename would require **both** registries.

Focused commands for implementation:

```bash
bun test tests/adapters/google/google-errors.test.ts
bun test tests/adapters/google/google-vertex-http.test.ts
bun test tests/server/error-fidelity.test.ts
```

### Docs, attribution, risk

- **MODIFY `docs-site/src/content/docs/reference/adapters.md`**, Google section at line 159: document location denial → `permission_error` / `location_not_supported`, unchanged transport status, and that this does not remove Google’s restriction. Existing translated adapter sections contain no contradictory location contract.
- Required trailer, verified from both contributor commits via `gh pr view --json commits`:

```text
Co-authored-by: agentHits <zvercombat26rus@icloud.com>
```

- Risk: shared error taxonomy affects providers beyond Antigravity. Preserve auth/quota precedence, redaction, raw-mode behavior, and transport status.
- No credential storage, OAuth flow, credential destination, or access-control change. Nevertheless, explicitly review the shared authentication/permission classification boundary under [MAINTAINERS.md:60](/Users/jun/.codex/worktrees/ef41/opencodex/MAINTAINERS.md:60).

## 4) OPEN QUESTIONS / RESIDUAL UNCERTAINTY

- No implementation or tests executed; this is source-backed triage, not merge readiness.
- All six PR files reviewed. The warning and its warning-specific assertions are deliberately excluded from the minimal carry.
- Parent must refresh the integration SHA before implementation; `origin/dev` moved during triage. No Git writes, GitHub comments, or file edits performed.



## wp2 P stale-check (2026-09-04T22:50Z, origin/dev 980a9fbed)

- `src/adapters/google-errors.ts` `classifyGoogle` and `src/lib/errors.ts` `classifyError`
  unchanged vs the lane snapshot (verified by re-reading lines 58-79 / 240-290).
- PR #3469's own diff places the location branch *directly after* the quota-exhausted check,
  i.e. before rate-limit and auth — exactly the precedence defect audit blocker 1 named.
  The carry therefore moves the branch to after the 403/access-denied branch (before 503),
  and in `classifyError` keeps it after the auth block but *before* the subscription /
  permission blocks so `location_not_supported` wins over generic `permission_denied`.
- Drop the `google-http.ts` console.warn (unproven VPN/TUN advice) and the alias re-exports.
- Parallel-task note: a separate maintainer session opened carry PRs #3539-#3546 against
  `dev` while this loop ran; **#3542 is a carry of #3525** (this unit's 040 / wp5). wp5
  will therefore not open a duplicate PR — its cycle re-verifies #3542's exact head and
  stacks 050 on top of it (see 040 amendment at wp5's P). No carry exists yet for #3469
  or #3407.


## wp2 audit round 1 — GO-WITH-FIXES (1 blocker, folded)

Blocker: message-only adapter paths (`inferHttpStatusFromAdapterMessage`, `src/lib/errors.ts:~360`)
would infer **502** for the new `… location not supported: …` message (no `invalid`/`unsupported`
cue), while classified envelopes infer **403** via `permission_error`.

Decision: a location denial is a permission-class rejection. `inferHttpStatusFromAdapterMessage`
returns **403** when `isLocationUnsupportedMessage(lower)` — placed directly after the
authentication check so 401 still wins — making message-only and envelope paths agree.
Docs wording: "direct upstream HTTP status is preserved (400); message-only/terminal paths
classify it as 403 permission." Tests: `adapterFailureFromMessage` + `httpStatusFromError`
cases added to error-fidelity.

