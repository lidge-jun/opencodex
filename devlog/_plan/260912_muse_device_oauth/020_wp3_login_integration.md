# wp3 — login integration and fallback order

Three files change. After this phase `ocx login meta-muse` can complete a device grant,
and an existing user's login behaves exactly as it does today.

**MODIFY** `src/oauth/meta-muse.ts` — selection order, deps forwarding, refresh metadata
**MODIFY** `src/oauth/index.ts` — registration
**MODIFY** `src/providers/registry.ts` — the user-visible note

`src/oauth/types.ts` moved to `010` during the A-phase fold: the module that returns the
field cannot compile without it.

> **Audit folds carried into this document (A-phase):** three of this phase's original
> claims were wrong, all found by reading the existing test file rather than trusting the
> plan. They are marked **[fold N]** below. The claim "the existing 351-line test file
> passes unmodified" survives only because of them.

## The selection order, and why

| Invocation | Order |
|---|---|
| Plain `ocx login meta-muse` | Keychain import (darwin, if a credential is there) -> device grant -> manual paste |
| Add-account or reauth (`forceLogin`) | Device grant -> manual paste. **Never** import |

Import stays first for a plain login for two reasons, and both are about not making things
worse. A user who already ran `muse login` gets the current zero-interaction path. And a
device grant ends in a mint call against a rate-limited endpoint (`001` §B), so starting
one when a working credential is already on disk spends a request to arrive at the same key.

`forceLogin` must skip import, because reimporting is how an add-account silently
re-adds the account the user already has. That is not a new rule: `src/oauth/index.ts:220`
applies exactly this mapping to `command-code`, and
`src/oauth/command-code.ts:25-31` documents the reason.

Device now precedes paste on every platform, which is the real user-visible win: a Windows
or Linux host currently has no login at all, only a paste field
(`src/oauth/meta-muse.ts` non-darwin branch).

## The credential field

Declared in `010` alongside the module that returns it. wp3 only consumes it, in
`refreshMetaMuseToken` below.

**Resolved during the A-phase fold** (it was an open verification item): `muse` stays out
of every outbound response because those projections are hand-built allowlists, not
redactors. `OAuthAccountSummary` is constructed field by field at
`src/oauth/index.ts:1839-1850`; `projectOAuthAccountHealth` and `oauthAccountHealthFields`
(`src/oauth/health.ts:59-66,166-178`) take scalar inputs and never receive a credential.
Logging is separately safe: `src/oauth/log.ts:31-33` refuses any field whose normalized
name ends in `_token`, and `oauthAccessToken` normalizes to `oauth_access_token`.

The rule this imposes on wp3 and wp4 is therefore explicit, and `010` states it in the
type's own docstring: never add `muse` to `OAuthAccountSummary` or `OAuthAccessSnapshot`.

## `src/oauth/meta-muse.ts`

### 1. Header comment

The module docstring currently opens "Meta Muse Code credential import." It becomes
"Meta Muse Code login: device grant, CLI import, or pasted key." Its two measured facts
stay; a third is added, pointing at `001` for the grant and at `002` §A for why the
account token is stored separately.

### 2. Consent warning

`CONSENT_WARNING` gains one sentence, and it is the sentence that must not be softened:

```ts
  "A device login authenticates as Meta's own Muse Code client, which is a stronger claim than reusing a key your CLI already minted.",
```

It is inserted as the second element, before the "Using it here is UNSUPPORTED" line, so
the CLI prints it before any credential is read. The existing test that the warning fires
before the first read (`tests/providers/meta-muse-oauth.test.ts:115-123`) keeps passing
unchanged.

### 3. Deps

```ts
export interface MuseImportDeps {
  platform?: string;
  readPointer?: () => Promise<string | null>;
  readKeychain?: (signal?: AbortSignal) => Promise<string | null>;
  fetchImpl?: typeof fetch;
  /** Injected so login tests exercise the order without running a grant. */
  loginDevice?: (ctrl: OAuthController) => Promise<OAuthCredentials>;
  /** [fold 1] Forwarded into the device grant so no test can reach the network. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}
```

### 4. `loginMetaMuse` options and body

Signature gains a third parameter rather than changing the first two, so every existing
caller and test compiles unchanged:

```ts
export interface MuseLoginOptions {
  /** `"off"` skips the Keychain import; add-account and reauth pass it. */
  importLocal?: "fallback" | "off";
}

export async function loginMetaMuse(
  ctrl: OAuthController = {},
  deps: MuseImportDeps = {},
  options: MuseLoginOptions = {},
): Promise<OAuthCredentials> {
```

Body changes, in order:

```
  ctrl.onProgress?.(CONSENT_WARNING);                     // unchanged, still first
  const platform = deps.platform ?? process.platform;

+ const importAllowed = options.importLocal !== "off" && platform === "darwin";
+ if (importAllowed) {
+   // [fold 5] ctrl is passed, not just deps: the helper must keep handing ctrl.signal to
+   // the Keychain reader, which tests/providers/meta-muse-oauth.test.ts:168-178 asserts.
+   const imported = await importFromKeychain(ctrl, deps);   // extracted, see below
+   if (imported) return imported;
+ }
+
+ // [fold 1] fetchImpl/sleep/now are FORWARDED. Without this, any existing test that
+ // reaches the device path would call auth.meta.com for real: the injected fetch stops
+ // at loginMetaMuse today, and the device module carries its own deps object.
+ const device = deps.loginDevice
+   ?? (c => loginMetaMuseDevice(c, {
+     ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
+     ...(deps.sleep ? { sleep: deps.sleep } : {}),
+     ...(deps.now ? { now: deps.now } : {}),
+   }));
+ try {
+   ctrl.onProgress?.("Starting the Meta device login...");
+   return await device(ctrl);
+ } catch (error) {
+   if (isCancellation(error)) throw error;
+   const reason = deviceFailureReason(error);
+   const pasted = await manualKeyCredential(ctrl, reason);
+   // [fold 3] No paste surface, or an empty paste. The refusal must KEEP the guidance
+   // the current code gives; a device error must not replace it. Composed, not substituted.
+   if (pasted === null) throw noPasteSurfaceError(platform, error);
+   return await validatedMetaMuseCredential(pasted, ctrl, deps, undefined, "manual");
+ }
```

The existing non-darwin and pointer/Keychain branches are not deleted. They move into
`importFromKeychain`, which returns `null` — rather than throwing — only for the two
conditions that genuinely mean "there is nothing here to import". **[fold 2]** A Keychain
read that TIMES OUT is not one of them: a credential probably exists and the user simply
needs to approve a prompt, so silently starting a browser grant would create a second
login to solve a permissions dialog. `tests/providers/meta-muse-oauth.test.ts:159-166`
already pins that refusal, and it is right.

| Condition | Today | After |
|---|---|---|
| No pointer file | throws `Muse Code CLI credential not found` | returns `null`, device grant runs |
| Pointer has no signed-in Meta account | throws | returns `null`, device grant runs |
| Keychain read times out | throws `within 5s` | **[fold 2] still throws**, message extended with the device alternative |
| Pointer is not valid JSON | throws | **still throws** — a corrupt file is a real fault, not an absence |
| Unsupported storage backend | throws | **still throws** — an unmeasured shape must not be guessed past |
| Keychain entry carries no usable key | throws | **still throws** — the import found a credential and it was bad |
| Keychain entry is not valid JSON | throws | **[fold 4] still throws** — same class as a corrupt pointer; the wp3 audit caught this row missing |

`isCancellation` returns true for `MuseDeviceLoginError` with `kind === "cancelled"`, for
`AbortError`, and for `ctrl.signal?.aborted`. A cancelled login must not be answered with
a paste prompt.

`deviceFailureReason` maps an error kind to the one-line reason `manualKeyCredential`
already renders (`src/oauth/meta-muse.ts` `manualKeyCredential`), so the paste field says
why it appeared:

| kind | Reason shown above the paste field |
|---|---|
| `subscription-inactive` | "This Meta account has no active Muse Code subscription." |
| `entitlement-required` | The message, including Meta's action URL |
| `mint-rate-limited` | "Meta rate-limited the key request." |
| `device-denied` | "The browser approval was denied." |
| `device-expired` | "The device code expired before approval." |
| anything else | "The Meta device login did not complete." |

**[fold 3]** `noPasteSurfaceError(platform, deviceError)` composes one message from three
parts: the device failure reason, the platform explanation on a non-darwin host, and the
existing pointers to https://dev.meta.ai and `META_MODEL_API_KEY`. It exists because three
current tests assert that guidance, and they assert the right thing: a host that cannot
paste and cannot finish a device grant needs to be told where the key lives, not just that
a grant failed.

| Existing test | Asserts | Satisfied because |
|---|---|---|
| `meta-muse-oauth.test.ts:220-224` | rejects with `/dev\.meta\.ai/` and `/META_MODEL_API_KEY/` on win32 and linux | Both strings stay in the composed message |
| `meta-muse-oauth.test.ts:226-231` | an empty paste rejects with `/no credential to import/` | The platform clause, which contains that phrase, is retained for non-darwin |
| `meta-muse-oauth.test.ts:159-166` | a blocked Keychain read rejects with `/within 5s/` in under 5s | fold 2 keeps that throw; the message is only appended to |
| `meta-muse-oauth.test.ts:185-204` | win32 paste field, `source === "manual"`, onAuth text contains `dev.meta.ai` | The device attempt fails on the injected fetch first, then the unchanged paste path runs |


### 5. `refreshMetaMuseToken`

It must stop dropping the account token. Refresh writes into the slot it refreshes, so a
refresh that returns no `muse` field silently removes the on-demand quota capability
(`030`) from a device-logged-in account:

```
  return {
    access: apiKey,
    refresh: apiKey,
    expires: Number.MAX_SAFE_INTEGER,
-   source: credential?.source === "manual" ? "manual" : "local-cli",
+   // Preserve the provenance the slot already recorded. A device login is "oauth";
+   // relabelling it "local-cli" would misreport where the credential came from, which
+   // is the same failure this function's existing comment warns about for "manual".
+   source: credential?.source === "manual" || credential?.source === "oauth"
+     ? credential.source
+     : "local-cli",
+   // The account token is not re-derivable: there is no refresh grant (001 §A). Losing
+   // it here would cost the quota probe with no way back except a full re-login.
+   ...(credential?.muse ? { muse: credential.muse } : {}),
  };
```

## `src/oauth/index.ts`

```
  "meta-muse": {
-   login: ctrl => loginMetaMuse(ctrl),
+   // Add-account/reauth must not reimport the credential already on disk; it starts the
+   // device grant instead, the same mapping command-code uses above.
+   login: (ctrl, opts) => loginMetaMuse(ctrl, {}, { importLocal: opts?.forceLogin ? "off" : "fallback" }),
    refresh: refreshMetaMuseToken,
    providerConfig: oauthConfig("meta-muse"),
    defaultModel: oauthDefaultModel("meta-muse"),
    defaultRefreshPolicy: "disabled",
  },
```

`defaultRefreshPolicy: "disabled"` and its comment stay exactly as they are. The device
grant does not change the posture: there is still no refresh endpoint, and unattended
traffic on a vendor-restricted credential is still the thing we refuse to generate.

## `src/providers/registry.ts`

The `meta-muse` `note` (`registry.ts:1746-1764`) currently opens by describing the provider
as macOS-only and CLI-dependent. Two of its clauses become false in this phase and must
change with the code:

| Current clause | Replacement |
|---|---|
| "Reuses the API key the Muse Code CLI stores after `muse login` (macOS only; requires the CLI installed and signed in)." | "Signs in to Meta with a browser device code on any platform, then mints the Muse Code subscription key. If the Muse Code CLI is already signed in on macOS, the existing key is imported instead of starting a new grant." |
| "Meta ships no native Windows CLI and the Linux credential storage has not been measured, so on those platforms OpenCodex asks you to paste the Muse Code API key..." | "A pasted key from https://dev.meta.ai still works as a fallback if the device login cannot complete, and faces the same format check and live validation." |

The UNSUPPORTED-use paragraph and the billing warning are kept verbatim, plus one added
sentence: "A device login authenticates as Meta's own Muse Code client." The quota
sentence is rewritten in `030`, not here, because that is the phase that makes it false.

## Verification for this phase

`bun run test tests/providers/meta-muse-oauth.test.ts tests/providers/meta-muse-device.test.ts`
plus the order assertions listed in `040` §B. The existing 351-line test file must pass
**unmodified except for additions** — if an existing case needs editing, the no-regression
claim is false and that is a wp3 blocker, not a test to adjust.

## wp3 audit note: the unmodified-tests claim

The reviewer challenged the claim that the existing 351-line test file passes unmodified,
noting that several non-darwin cases inject `okFetch` (200 for any URL) with no `loginDevice`
stub, so a device grant now runs inside them. That is true, and the claim is not settled by
argument: `okFetch` returns a body with no `device_code`, so `requestMuseDeviceAuthorization`
should fail and every one of those cases should fall through to the paste path it already
exercises. Should is not evidence. The B phase runs that file UNMODIFIED and the result
decides: any failure there is a wp3 blocker and the selection order gets reconsidered, per
this document own rule. Result recorded in the wp3 D summary.
