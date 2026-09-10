# PRD: Grok Reset Coupons — Phase 3 Delivery, Documentation & Release Runbook

This document details Phase 3 of the Grok reset coupons feature: documentation site updates across the relevant page families, devlog lifecycle transition to `devlog/_fin`, pre-commit verification runbooks, and GitHub PR delivery protocols targeting the `dev` branch.

---

## 010 Documentation Site Updates

The Grok reset coupons capability introduces both a new CLI command under `ocx account` and new Management API endpoints. These must be documented within the existing documentation site structure under `docs-site/src/content/docs/`.

### 1. File: `docs-site/src/content/docs/reference/cli/providers-accounts.md`

#### Section: `## Accounts and key pools` (heading at providers-accounts.md:137) -> `### ocx account <subcommand>`
- **Line Anchor:** After line 221 (`reset-credits <id|main>`).
- **Update Content:** Add description of `grok-reset-coupons`:
  ```markdown
  grok-reset-coupons [<id>] [--consume --yes] [--token-id <token-id>] [--operation-id <uuid>]  Inspect or redeem Grok reset coupons.
  ```

#### Section: Detailed Subcommand Entry (after line 457; backtick-fenced heading pattern `### \`ocx account reset-credits <id|main> [--consume --yes]\`` at line 446; the entry must also be added to the `Usage:` enumeration inside the code block at line 210 and the usage list at line 221)
- **Update Content:** Add comprehensive usage instructions mirroring `reset-credits`:
  ```markdown
  ### `ocx account grok-reset-coupons [<account-id>] [--consume --yes [--token-id <id>] [--operation-id <uuid>]] [--json]`

  Inspects remaining reset coupons or redeems one for an xAI / Grok account.

  When invoked without `--consume`, returns the available coupon tokens and validity windows:

  ```bash
  ocx account grok-reset-coupons
  ocx account grok-reset-coupons acc_xai_01 --json
  ```

  Redeeming a reset coupon mutates billing state and permanently exhausts one coupon token. `--consume` strictly requires `--yes`:

  ```bash
  ocx account grok-reset-coupons --consume --yes
  ocx account grok-reset-coupons --consume --yes --token-id <token-id>
  ```

  Pass `--operation-id <uuid>` (must be a valid UUIDv4) to guarantee idempotent settlement. If the network drops or the command is retried, identical operation IDs replay the durably recorded outcome instead of consuming a second coupon.
  ```

---

### 2. File: `docs-site/src/content/docs/reference/management-api.md`

#### Section: Endpoint Table — under `### Agent and client settings` (line 69); the existing `/api/grok` rows live at lines 78-80 and the new rows stay adjacent to them (the dedicated `### Providers` section at line 343 is NOT the target)
- **Update Content:** Register both HTTP control plane endpoints:
  ```markdown
  | `GET /api/grok/reset-coupons?accountId=...` | Read remaining Grok billing reset tokens and validity windows for the active or specified xAI account | 400 missing account; 401 unauthenticated; 502 upstream gRPC-Web error |
  | `POST /api/grok/reset-coupons/consume` | Redeem an eligible reset coupon. Body `{ accountId?, tokenId?, operationId? }`. Optional `operationId` (UUIDv4) makes redemption idempotent: repeating the same ID replays the durable result without double-redemption. | 400 invalid JSON/UUID; 401 unauthenticated; 409 `identity_mismatch`; 502 upstream error; 503 ledger capacity |
  ```

---

### 3. File: `structure/providers/xai-grok.md` (structure SoT for the xAI grok provider)

#### Section: append under `## xAI Grok hardening (official Grok Build contract parity)` (the file's only section heading; gate with `bun run structure:check`)
- **Update Content:** Document the gRPC-Web transport and reset coupon mechanics:
  ```markdown
  ### Grok Reset Coupons (Billing API Parity)
  - **Upstream RPCs:** `prod_mc_billing.ConsumerUiSvc/GetRemainingResets` (inspection) and `prod_mc_billing.ConsumerUiSvc/RedeemReset` (redemption).
  - **Transport:** Binary gRPC-Web over HTTP/1.1 or HTTP/2 with 5-byte frame envelope (`0x00` data / `0x80` trailers) and protobuf wire format. Plain JSON is rejected with empty responses upstream.
  - **Authentication:** `Authorization: Bearer <xai OIDC access token>` + `X-XAI-Token-Auth: xai-grok-cli`. No cookies required.
  - **Safety & Idempotency:** Managed via `src/grok/reset-coupon-ledger.ts` using UUIDv4 operation tracking before upstream dispatch to prevent duplicate consumption during network flakes.
  ```

---

## 020 Devlog Lifecycle & Promotion Note

Upon landing all Phase 1 and Phase 2 changes on `dev`, promote the planning directory to finished status:

- **Source:** `devlog/_plan/260912_grok_reset_coupons/`
- **Destination:** `devlog/_fin/260912_grok_reset_coupons/`
- **Action:** Move the directory and add `000_fin_summary.md` documenting:
  1. Live verification against `grok.com/prod_mc_billing.ConsumerUiSvc`.
  2. gRPC-Web binary client and framing implementation.
  3. CLI parity with `ocx account grok-reset-coupons`.
  4. Test suite validation under `tests/providers/xai/grok-reset-coupons.test.ts`.

---

## 025 Locale Sync Scope (docs-sync rule)

Both documentation targets exist in **seven translated locales**: `fr`, `ja`, `ko`, `ru`, `tr`, `zh-cn`, `zh-tw`
(verified by direct file-existence check this session). Per the repository docs-sync rule, every update made to
`docs-site/src/content/docs/reference/cli/providers-accounts.md` and
`docs-site/src/content/docs/reference/management-api.md` must be applied to all seven locale variants of both files:
same sections (Usage enumeration line, usage list line, detailed subcommand entry; endpoint matrix rows), translated
prose kept consistent with each locale's existing register. The guide page `guides/grok-build.md` (root + locales)
gains a short "Reset coupons" pointer only if its current content already covers account quota surfaces.

---

## 030 Verification Runbook

Before opening the GitHub Pull Request, run the complete verification suite locally:

```bash
# 1. Typecheck entire workspace
bun run typecheck

# 2. Test layout validation (ensures layout.json matches expected fixtures)
bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts

# 3. Core-lab boundary test (ensures no eager imports in management-api.ts)
bun test tests/lab/core-lab-boundary.test.ts

# 4. Domain & management test suite for Grok reset coupons
bun test tests/providers/xai/grok-reset-coupons.test.ts

# 5. Full test suite execution
bun run test

# 6. Privacy and secret leakage scanner
bun run privacy:scan

# 7. Structure SSOT gate (structure/providers/xai-grok.md)
bun run structure:check
```


All commands must exit `0` cleanly with zero type errors, zero layout mismatches, and zero secrets detected.

---

## 040 GitHub Delivery Runbook

### 1. Issue Creation: Feature Request
Create an issue using `.github/ISSUE_TEMPLATE/feature_request.yml`. Must strictly include the exact section headings:

```markdown
### Area
Provider adapters

### What are you trying to accomplish?
Allow operators and CLI users to inspect and redeem Grok billing reset coupons directly through OpenCodex. When an xAI / Grok account reaches rate limits or quota boundaries, eligible reset tokens can be inspected and redeemed without leaving the terminal or dashboard.

### What prevents this today?
Currently, OpenCodex only provides quota reset credit inspection and consumption for Codex/ChatGPT accounts (`/api/codex-auth/reset-credits` and `ocx account reset-credits`). Grok reset coupons use gRPC-Web binary framing against `prod_mc_billing.ConsumerUiSvc` and have no management API or CLI interface.

### What should OpenCodex do?
1. Expose `GET /api/grok/reset-coupons` to inspect available reset tokens and validity windows.
2. Expose `POST /api/grok/reset-coupons/consume` to redeem coupons with durable UUIDv4 operation idempotency.
3. Provide `ocx account grok-reset-coupons [--consume --yes]` CLI command matching the behavior and safety flags of `reset-credits`.

### Example usage or interface
```bash
# Inspect available Grok reset tokens
ocx account grok-reset-coupons

# Redeem coupon with confirmation and idempotency
ocx account grok-reset-coupons --consume --yes --operation-id 9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d
```

### Alternatives or workarounds
Manually inspecting and redeeming coupons in a web browser using devtools network payloads.

### Additional context
Verified against live `grok.com` endpoints:
- `prod_mc_billing.ConsumerUiSvc/GetRemainingResets`
- `prod_mc_billing.ConsumerUiSvc/RedeemReset`
Requires gRPC-Web binary framing (`application/grpc-web+proto`) with `X-XAI-Token-Auth: xai-grok-cli`.

### Checks
- [x] I searched existing issues and documentation.
- [x] This request describes a concrete OpenCodex workflow rather than merely naming a desired technology.
- [x] I removed secrets and personal data.
```

---

### 2. Pull Request: Submission & Template
Submit PR using `.github/PULL_REQUEST_TEMPLATE.md` targeting branch **`dev`** (NEVER target `main` directly).

```markdown
## Summary

- Adds Grok billing reset coupon inspection and redemption support via gRPC-Web upstream client.
- Implements `GET /api/grok/reset-coupons` and `POST /api/grok/reset-coupons/consume` with lazy on-demand route loading in `src/server/management-api.ts`.
- Adds `ocx account grok-reset-coupons` CLI command mirroring `reset-credits` with required `--yes` on `--consume` and UUIDv4 `--operation-id` journaling.
- Adds test coverage in `tests/providers/xai/grok-reset-coupons.test.ts` and updates test layout registrations.

Closes #<ISSUE_NUMBER>

## Verification

- `bun run typecheck` passed cleanly.
- `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts` verified test suite mappings.
- `bun test tests/lab/core-lab-boundary.test.ts` passed (no lazy import leaks).
- `bun run structure:check` passed (structure/providers/xai-grok.md anchor).
- `bun test tests/providers/xai/grok-reset-coupons.test.ts` passed all read, redeem, and replay cases.
- `bun run privacy:scan` passed with no secrets detected.

## Checklist

- [x] Scope stays focused and avoids unrelated cleanup.
- [x] Docs or release notes were updated when needed.
- [x] Security-sensitive changes were reviewed for secrets, auth, and unsafe defaults.
```

---

### 3. Maintainer Landing & Issue Closure Policies

- **Target Branch:** PR must target `dev`. OpenCodex CI triggers on PRs against `dev`.
- **Exact-Head CI Requirement:** Maintainers require all CI checks on the exact tip of the PR branch to pass green before merging.
- **Merge Policy:** Merges into `dev` are performed by maintainers using squash-and-merge or rebase per project conventions.
- **Manual Issue Closure Note:** Because GitHub only auto-closes issues referenced in commit messages (`Closes #N`) when merged into the repository default branch (`main`), merging into `dev` does **not** automatically close the issue. Maintainers or authors must manually close the issue after verifying the commit has landed on `dev`.
