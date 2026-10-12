# wp2 — GUI popup, CLI instructions, and delivery

Depends on: wp1's initialModelSelection state and safe read DTO. Re-read signatures
after wp1 before editing. Do not change the completed policy or widen eligibility.

## Design read

Quiet developer dashboard onboarding, reusing existing modal-card/buttons/tokens.
One primary action: Models; secondary: close. No new imagery, dependency, wizard,
browser auto-launch, or page redesign. Variance 2/10, motion 1/10 (feedback only),
density D8. Existing screenshot establishes the target model-switch control.
Use semantic dialog/aria-modal, focus trap and restoration, Escape/explicit close,
readable wrapping, mobile containment and existing i18n conventions.

## Exact file change map

### NEW gui/src/components/ProviderModelsNotice.tsx

Props: provider name, initial-selection read state (pending/ready/all-off/absent),
onClose, onOpenModels. Render real state, not successful OFF before discovery:

- pending: provider registered and active; checking models, exposure held; retry
  guidance stays truthful if provider discovery fails.
- all-off: count models, initial switches all OFF; choose needed models in Models.
- ready/absent (including OAuth): registration complete; adjust models in Models.

Use existing modal classes and focus behavior from AddProviderModal. All visible
copy goes through t(); provider/model strings and CLI code remain technical text.
No interval in the component: consume the existing Providers config refresh result.
Require an explicit discovery-settled callback that refreshes
config AFTER the model fetch/finalization completes, not only before it. Pending
to all-off must update the same mounted notice; a successful finalization must not
leave stale pending copy. Reuse the workspace model fetch completion signal.
Retry is supplemental manual recovery, never a substitute for the completion callback.

### MODIFY gui/src/pages/Providers.tsx and providers-page-modals.tsx

Own render-local notice provider state. Registration completion at onAdded closes
Add, keeps existing refresh calls and opens the notice (replace the success-only
toast for new registration). Capture whether provider existed before add/login.
Wire modal-local OAuth and catalog OAuth completion through the same notice owner;
existing account management/relogin continues Accounts navigation and does not
reset selections. For initial Codex provider creation, onCodexAdded also shows
Models guidance. Explicit account/login completion also receives generic guidance
(including the pre-seeded OpenAI provider); it never resets model choices. Existing
Accounts navigation remains underneath the notice. Historical all-OFF copy is
shown only for a newly created provider, not as a claim that re-login reset switches.

Implementation owners after source recheck: NEW
gui/src/pages/use-provider-models-notice.ts owns the operation token and render-local
notice lifecycle. ProviderWorkspaceShell's existing /api/selected-models completion
invokes a stable onModelsSettled callback; only an active notice triggers a later
config refresh. Reuse its existing refresh token for Retry, with no duplicate model
fetch and no new poll timer. useProvidersFetch adds a latest-request guard so an
earlier pending config response cannot overwrite the post-discovery snapshot.
The refresh result is explicit (applied/failed/superseded), with one bounded retry
for supersession. Failed config reads never become success guidance. API-base
changes clear both the active operation and render state, including A→B→A.

### MODIFY gui/src/pages/use-providers-oauth.ts as needed

Forward an existing new-provider boolean/name at completion through its callback,
without touching credential polling, reauth identity rules or secrets. Code
submission is not success; popup waits for existing login-settled signal.

Embedded/standalone Codex account add/reauth is a separate completion owner.
Reuse the same ProviderModelsNotice renderer directly in CodexAccountPool for
generic forward-auth guidance, preserving its pool state and catalog-refresh
warning. It does not need a model-count fetch or four callback-prop forwarding
layers. Cover this path as well as Providers' top-level modal completion.

The JSON editor reports newly added provider names to Providers after successful
save; show one generic notice for a batch and the normal per-provider notice for
a single new row. It also strips initialModelSelection from editor payloads; that
two-line compatibility fix is carried in core c5ad48c19, already an ancestor of
this branch. Core final CI must validate that updated head before merge.

### MODIFY gui/src/pages/providers-shared.ts

Add the sanitized initialModelSelection read-only field to ProvidersConfig. Keep
API contracts aligned, no duplicated private credential or runtime fields.

### Reuse Models navigation; MODIFY gui/src/pages/Models.tsx only for pending state

Use existing `navigateHash("models")`; no new route or provider-deeplink protocol.
The user requested Models-tab guidance, not URL-filtering semantics. This removes
an unnecessary app-routing change and its stale-selection race. Pending rows show
their pending state and cannot be mistaken for enabled rows; after final count,
actual existing switches show all-OFF or current defaults. Disable provisional
visibility controls while initialization is pending, matching the API contract.

### NEW src/cli/model-selection-guidance.ts

Pure shared guidance builder taking a validated provider name and optional state.
Return human lines plus structured command descriptors for JSON callers. Use
existing syntax, never invent `models list` or treat selected --clear as all-OFF:

```text
ocx models live --provider <provider>
ocx models enable <provider/model-id>
ocx models disable <provider/model-id>
ocx models provider <provider> on
```

Use the exact ID printed by `live` (native or namespaced), represented in examples
by an explicitly labeled, quoted placeholder. Include `ocx start` prerequisite when the proxy is absent,
and `ocx sync` retry guidance when discovery remains pending. No credentials in
commands or messages. No shell execution from the builder.
Rows marked native also receive explicit enable/disable --native command variants
in both human and JSON output, so account-qualified native IDs containing a slash
are not misparsed as routed provider/model selectors.

### MODIFY CLI completion owners

- src/cli/provider.ts: human completion prints helper lines; JSON completion adds
  structured guidance inside the existing one document. Preserve JSON's current
  early return/no implicit sync behavior.
- src/cli/init.ts: final registration completion prints same instructions.
- src/oauth/login-cli.ts: both legacy OAuth and key-login success print guidance,
  including exempt providers; preserve live-reload warnings and no JSON invention.
- src/cli/account-auth.ts: both Codex and generic OAuth successful completion
  include commands; JSON includes structured next steps. --no-wait remains pending
  and never claims a completed login; any advice is explicitly pending next steps.
  Keep the credential-containing auth-start block and its synchronous flush intact.

### MODIFY locale and public-doc sources

- gui/src/i18n/{en,ko,ja,zh,zh-TW,fr,ru,tr,de}.ts:
  identical new keys for notice title/body/state/buttons, pending model notice.
- docs-site/src/content/docs/reference/configuration/providers.md and translated
  equivalents: initial selection versus later-arrival policy, new registrations
  only, active provider with model switches OFF, reliable-count pending behavior.
- Relevant CLI guide/help page documents actual model-management commands.
- structure/03_catalog-and-subagents.md and 05_gui-and-management-api.md record
  policy ownership and registration guidance; no duplication of runtime schema.

## Test and rendered evidence map

- NEW gui/tests/provider-models-notice.test.tsx: title/body for pending/all-off/
  exempt, correct Models action, close/Escape/focus, no provider-disable action.
- Pending notice mounted before discovery completes updates after the completion
  callback and config reread; retries do not create a second modal or poll timer.
- Extend gui/tests/providers-codex-completion-toast.test.tsx and
  providers-hash-history.test.tsx for new-registration notice versus existing
  account completion and normal Models navigation; extend
  models-empty-provider.test.tsx for pending rows and controls.
- Extend tests/cli/cli-provider.test.ts and cli-account.test.ts for actual commands,
  one valid JSON document, no-wait no false completion, names safely quoted.
- NEW tests/cli/model-selection-guidance.test.ts with both layout manifests.
- Preserve existing auth URL/credential tests; no network/API-key requirements.

P recheck: core state shape is version1 + registrationId + status + modelCount;
safeConfigDTO exposes it read-only. Public threshold docs already landed in the core
layer, so this phase adds only registration-guidance text, not a second policy rewrite.
Core exact-head CI33947171242 passed at2cc90b447 before this cycle began.

Local checks: TypeScript, GUI lint/i18n, GUI build, docs build, whitespace. All
test suites run remotely in GitHub CI, not locally. Runtime UI proof is a manual
isolated fake-provider scenario, not a repository test suite: new 20-model key
provider → popup → Models → switches all OFF/provider active → enable one →
refresh retains it. Also inspect OAuth/ready notice with an isolated fixture
without real OAuth login, and pending state with fake delayed discovery.

Capture clean light/dark/mobile-sized evidence as needed; one clean observation
per unchanged state. Screenshot contains no user homes, keys, emails or account
identities. Attach the actual screenshot to any PR mentioning GUI. Stop the
isolated server and preserve user's live service untouched.

## Final delivery gate

Independent implementation and fresh final audits, exact-head CI green, no
unresolved blockers, truthful PR template/checklist, --no-verify push, recorded
owner-authorized admin approval bypass (NOT CI bypass), bottom-up merge if stacked,
retarget child to dev and verify latest checks, fetch dev and prove ancestry.
Archive this unit only after terminal outcome is recorded. No release/deployment.
