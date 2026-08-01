# 000 — Plan: Expose allowPrivateNetwork opt-in (Issue #175)

## Loop spec
- **Archetype:** Spec-satisfaction repair (pass/fail, locally verifiable)
- **Trigger:** GitHub #175 — the SSRF hardening added `allowPrivateNetwork` to the backend but left all user-facing input surfaces blocked
- **Goal:** Users can register localhost/private-network providers through the GUI, CLI, or PATCH API
- **Non-goals:** Re-enable PUT /api/config; change destination-policy.ts SSRF logic; modify registry defaults
- **Verifier:** `bun test` for affected suites + curl probes against running proxy
- **Stop condition:** All 8 criteria met with captured evidence
- **Memory artifact:** This devlog unit + goalplan ledger
- **Expected terminal:** DONE
- **Escalation:** NEEDS_HUMAN if security review reveals the opt-in design is insufficient

## Diff-level plan

### 1. Server: PATCH field mask (management-api.ts:600-650)
- **File:** `src/server/management-api.ts`
- **Action:** MODIFY — add `allowPrivateNetwork` boolean handler in the PATCH field-mask block (after the `note` handler, before the `!touched` guard)
- **Before:** PATCH rejects `allowPrivateNetwork` as "no recognized fields to update"
- **After:** `{ allowPrivateNetwork: true|false }` accepted, persisted on the provider object, `touched = true`
- **Security note:** The destination-policy validation at line 658-662 already runs on the merged `next` object, so the SSRF check covers the PATCH path automatically — no additional guard needed

### 2. CLI: --allow-private-network flag (cli/provider.ts)
- **File:** `src/cli/provider.ts`
- **Action:** MODIFY — add `consumeFlag(restArgs, "--allow-private-network")` in `handleAdd`, set `provConfig.allowPrivateNetwork = true` when the flag is present
- **Before:** `--allow-private-network` rejected as unknown flag
- **After:** Flag accepted; config saved with `allowPrivateNetwork: true` when present

### 3. GUI payload type + builder (provider-payload.ts)
- **File:** `gui/src/provider-payload.ts`
- **Action:** MODIFY
  - Add `allowPrivateNetwork?: boolean` to `ProviderPayload` interface (line ~30)
  - In `buildProviderPayload()`: if a new form field `allowPrivateNetwork` is truthy, include it in the payload

### 4. GUI Add Provider Modal toggle (AddProviderModal.tsx)
- **File:** `gui/src/components/AddProviderModal.tsx`
- **Action:** MODIFY
  - Add `allowPrivateNetwork: false` to the form state initialization
  - Add a checkbox below the baseUrl field, visible when `isCustom || isLocal`
  - Label: warned text about SSRF implications (i18n key `modal.allowPrivateNetwork`)
  - Wire the checkbox to the form state; the submit path already calls `buildProviderPostBody` which calls `buildProviderPayload`

### 5. GUI Workspace Settings toggle (ProviderSettings.tsx + types.ts)
- **File:** `gui/src/components/provider-workspace/types.ts`
- **Action:** MODIFY — add `allowPrivateNetwork?: boolean` to `ProviderUpdatePatch`
- **File:** `gui/src/components/provider-workspace/ProviderSettings.tsx`
- **Action:** MODIFY — add a checkbox for `allowPrivateNetwork`, wire it to the PATCH payload
  - Read initial value from `item.allowPrivateNetwork` (already returned by GET /api/providers)
  - Include in dirty check and save payload

### 6. GUI JSON editor error surfacing (Providers.tsx:310-326)
- **File:** `gui/src/pages/Providers.tsx`
- **Action:** MODIFY — in the `saveConfig` catch block (line ~318-325), read the response body on failure and display the actual error message instead of the generic "prov.saveFailed"
- **Before:** `notify(t("prov.saveFailed"), false)`
- **After:** `const d = await res.json().catch(() => ({})); notify(d.error || t("prov.saveFailed"), false)`

### 7. i18n locale keys
- **Files:** `gui/src/i18n/en.ts`, `gui/src/i18n/ko.ts`, `gui/src/i18n/zh.ts`
- **Action:** MODIFY — add keys:
  - `modal.allowPrivateNetwork`: "Allow local/private network (SSRF opt-in)" / "로컬/사설 네트워크 허용 (SSRF 옵트인)" / "允许本地/私有网络（SSRF 选择加入）"
  - `modal.allowPrivateNetworkHint`: warning hint text
  - `pws.allowPrivateNetwork`: label for workspace settings toggle

### 8. Tests
- **File:** `tests/server-auth.test.ts`
- **Action:** MODIFY — add test: "provider PATCH can toggle allowPrivateNetwork"
  - Create a provider with allowPrivateNetwork:true via POST
  - PATCH to toggle it off
  - Verify GET reflects the change
- **File:** `tests/cli-provider.test.ts` (NEW if not exists, or add to existing)
- **Action:** ADD — test: "ocx provider add --allow-private-network sets the flag"

## Scope boundary
- IN: The 8 files/actions above
- OUT: destination-policy.ts, registry.ts, config.ts schema (already supports the field), auth-cors.ts (already returns the field in GET)

## Activation scenarios (C-ACTIVATION-GROUNDING-01)
1. PATCH with allowPrivateNetwork — triggered by curl; observable: HTTP 200 + flag persisted
2. CLI --allow-private-network — triggered by running the CLI; observable: exit 0 + config.json has flag
3. GUI toggle → POST with flag — triggered by code path in buildProviderPayload; observable: field present in payload
4. JSON editor error surfacing — triggered by the existing PUT 405; observable: error message displayed instead of generic
